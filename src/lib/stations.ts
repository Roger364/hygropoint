// Mesures réelles : stations d'aérodromes (METAR) diffusées par l'Iowa Environmental
// Mesonet (IEM, Iowa State University). Accès libre, CORS ouvert, quasi temps réel.
// Le service limite le débit : on met en cache et on enchaîne les requêtes une à une.

import { describeError, getJson, getText, HttpError, isAbort } from "./http";
import { haversineKm, regionCode } from "./geo";

const IEM = "https://mesonet.agron.iastate.edu";

export const SEARCH_RADIUS_KM = 80;
const MAX_CANDIDATES = 5;
const HISTORY_HOURS = 50;
const HISTORY_TTL_MS = 4 * 60 * 1000;

export interface Obs {
  /** Instant de la mesure (ms epoch). */
  t: number;
  temp: number;
  dew: number;
}

export interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
  elev: number | null;
  network: string;
  distanceKm: number;
  obs: Obs[];
}

export interface StationSearch {
  stations: Station[];
  /** Explication lisible lorsqu'aucune station n'est exploitable. */
  note: string | null;
}

type StationMeta = Omit<Station, "distanceKm" | "obs">;

// ---------------------------------------------------------------- réseaux IEM

const US_STATES: Record<string, string> = Object.fromEntries(
  (
    "alabama:AL,alaska:AK,arizona:AZ,arkansas:AR,california:CA,colorado:CO,connecticut:CT,delaware:DE," +
    "district of columbia:DC,florida:FL,georgia:GA,hawaii:HI,idaho:ID,illinois:IL,indiana:IN,iowa:IA," +
    "kansas:KS,kentucky:KY,louisiana:LA,maine:ME,maryland:MD,massachusetts:MA,michigan:MI,minnesota:MN," +
    "mississippi:MS,missouri:MO,montana:MT,nebraska:NE,nevada:NV,new hampshire:NH,new jersey:NJ," +
    "new mexico:NM,new york:NY,north carolina:NC,north dakota:ND,ohio:OH,oklahoma:OK,oregon:OR," +
    "pennsylvania:PA,rhode island:RI,south carolina:SC,south dakota:SD,tennessee:TN,texas:TX,utah:UT," +
    "vermont:VT,virginia:VA,washington:WA,west virginia:WV,wisconsin:WI,wyoming:WY"
  )
    .split(",")
    .map((s) => s.split(":") as [string, string])
);

// Terre-Neuve : l'IEM a utilisé les deux codes, on essaie les deux.
const CA_PROVINCES: Record<string, string[]> = {
  alberta: ["AB"],
  "british columbia": ["BC"],
  manitoba: ["MB"],
  "new brunswick": ["NB"],
  "newfoundland and labrador": ["NL", "NF"],
  "nova scotia": ["NS"],
  "northwest territories": ["NT"],
  nunavut: ["NU"],
  ontario: ["ON"],
  "prince edward island": ["PE"],
  quebec: ["QC"],
  saskatchewan: ["SK"],
  yukon: ["YT"],
};

const norm = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

/** `state` peut être un nom anglais (« New York ») ou un code à deux lettres (« NY »). */
function regionNetworks(cc: string, state: string | undefined): string[] | null {
  const key = state ? norm(state) : "";
  const isCode = /^[a-z]{2}$/.test(key);
  if (cc === "US") {
    const code = isCode ? key.toUpperCase() : US_STATES[key];
    return code ? [`${code}_ASOS`] : null;
  }
  const codes = isCode ? (key === "nl" ? ["NL", "NF"] : [key.toUpperCase()]) : CA_PROVINCES[key];
  return codes ? codes.map((c) => `CA_${c}_ASOS`) : null;
}

/** Identifiants des réseaux IEM couvrant le point (par pays ; par État aux États-Unis et au Canada). */
export async function networksFor(
  lat: number,
  lon: number,
  countryCode: string,
  state: string | undefined,
  signal?: AbortSignal
): Promise<string[]> {
  const cc = countryCode.toUpperCase();
  if (cc !== "US" && cc !== "CA") return [`${cc}__ASOS`];
  const direct = regionNetworks(cc, state);
  if (direct) return direct;
  // Nom d'État localisé (« Californie ») : on demande son code normalisé.
  const code = await regionCode(lat, lon, signal);
  return (code && regionNetworks(cc, code)) || [];
}

// ---------------------------------------------------------------- métadonnées

interface NetworkFeature {
  id?: string;
  properties?: { elevation?: number | null; sname?: string; online?: boolean };
  geometry?: { coordinates?: [number, number] };
}

const networkCache = new Map<string, Promise<StationMeta[]>>();

function tidyName(raw: string): string {
  const s = raw.trim();
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s/\-.(])([a-zà-ÿ])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

/** Liste des stations d'un réseau. Non annulable à dessein : le résultat est mis en cache et resservira. */
function loadNetwork(network: string): Promise<StationMeta[]> {
  let p = networkCache.get(network);
  if (!p) {
    p = getJson<{ features?: NetworkFeature[] }>(`${IEM}/geojson/network/${network}.geojson`, {
      timeoutMs: 10_000,
    }).then((json) => {
      const out: StationMeta[] = [];
      for (const f of json.features ?? []) {
        const [lon, lat] = f.geometry?.coordinates ?? [NaN, NaN];
        if (!f.id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (f.properties?.online === false) continue;
        const elev = f.properties?.elevation;
        out.push({
          id: f.id,
          name: tidyName(f.properties?.sname ?? f.id),
          lat,
          lon,
          elev: typeof elev === "number" && Number.isFinite(elev) ? elev : null,
          network,
        });
      }
      return out;
    });
    networkCache.set(network, p);
    p.catch(() => networkCache.delete(network));
  }
  return p;
}

// ---------------------------------------------------------------- historique

let historyCache: { key: string; at: number; data: Map<string, Obs[]> } | null = null;

export function parseHistoryCsv(text: string): Map<string, Obs[]> {
  const lines = text.split(/\r?\n/);
  const header = lines[0]?.trim().toLowerCase() ?? "";
  if (!header.startsWith("station,")) {
    if (/too many requests/i.test(text)) throw new HttpError("http", "Trop de requêtes", 429);
    throw new HttpError("parse", "Historique des stations illisible.");
  }
  const cols = header.split(",");
  const iT = cols.indexOf("tmpc");
  const iD = cols.indexOf("dwpc");
  if (iT < 0 || iD < 0) throw new HttpError("parse", "Historique des stations incomplet.");

  const out = new Map<string, Obs[]>();
  for (let k = 1; k < lines.length; k++) {
    const parts = lines[k].split(",");
    if (parts.length < cols.length) continue;
    const m = parts[1].match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
    if (!m) continue;
    const temp = parseFloat(parts[iT]);
    const dewRaw = parseFloat(parts[iD]);
    // Contrôle de vraisemblance minimal ; l'écart aux modèles est contrôlé plus loin.
    if (!Number.isFinite(temp) || !Number.isFinite(dewRaw)) continue;
    if (temp < -75 || temp > 60 || dewRaw > temp + 0.6 || dewRaw < temp - 70) continue;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    const list = out.get(parts[0]) ?? [];
    list.push({ t, temp, dew: Math.min(dewRaw, temp) });
    out.set(parts[0], list);
  }
  for (const list of out.values()) list.sort((a, b) => a.t - b.t);
  return out;
}

/** Historique brut, sans le cache court de la recherche automatique. */
export async function fetchObservations(
  ids: string[],
  hours: number,
  signal?: AbortSignal,
  nowMs: number = Date.now()
): Promise<Map<string, Obs[]>> {
  const from = new Date(nowMs - hours * 3.6e6);
  const to = new Date(nowMs + 6 * 3.6e6);
  const q = new URLSearchParams();
  for (const id of ids) q.append("station", id);
  q.append("data", "tmpc");
  q.append("data", "dwpc");
  q.set("year1", String(from.getUTCFullYear()));
  q.set("month1", String(from.getUTCMonth() + 1));
  q.set("day1", String(from.getUTCDate()));
  q.set("year2", String(to.getUTCFullYear()));
  q.set("month2", String(to.getUTCMonth() + 1));
  q.set("day2", String(to.getUTCDate()));
  q.set("tz", "Etc/UTC");
  q.set("format", "onlycomma");
  q.set("latlon", "no");
  q.set("missing", "null");
  q.set("trace", "null");
  q.append("report_type", "3");
  q.append("report_type", "4");
  const text = await getText(`${IEM}/cgi-bin/request/asos.py?${q}`, { signal, timeoutMs: 20_000 });
  const data = parseHistoryCsv(text);
  const since = nowMs - hours * 3.6e6;
  const out = new Map<string, Obs[]>();
  for (const [id, list] of data) {
    out.set(
      id,
      list.filter((o) => o.t >= since && o.t <= nowMs + 10 * 60_000)
    );
  }
  return out;
}

async function fetchHistory(ids: string[], nowMs: number, signal?: AbortSignal): Promise<Map<string, Obs[]>> {
  const key = [...ids].sort().join(",");
  if (historyCache && historyCache.key === key && nowMs - historyCache.at < HISTORY_TTL_MS) {
    return historyCache.data;
  }
  const from = new Date(nowMs - HISTORY_HOURS * 3.6e6);
  const to = new Date(nowMs + 24 * 3.6e6);
  const q = new URLSearchParams();
  for (const id of ids) q.append("station", id);
  q.append("data", "tmpc");
  q.append("data", "dwpc");
  q.set("year1", String(from.getUTCFullYear()));
  q.set("month1", String(from.getUTCMonth() + 1));
  q.set("day1", String(from.getUTCDate()));
  q.set("year2", String(to.getUTCFullYear()));
  q.set("month2", String(to.getUTCMonth() + 1));
  q.set("day2", String(to.getUTCDate()));
  q.set("tz", "Etc/UTC");
  q.set("format", "onlycomma");
  q.set("latlon", "no");
  q.set("missing", "null");
  q.set("trace", "null");
  q.append("report_type", "3");
  q.append("report_type", "4");

  const text = await getText(`${IEM}/cgi-bin/request/asos.py?${q}`, { signal, timeoutMs: 12_000 });
  const data = parseHistoryCsv(text);
  historyCache = { key, at: nowMs, data };
  return data;
}

// ---------------------------------------------------------------- recherche

/**
 * Stations proches du point, avec leurs mesures des dernières 48 h.
 * Ne lève jamais d'erreur (hors annulation) : sans mesures, l'app reste utilisable.
 */
export async function findStations(
  lat: number,
  lon: number,
  countryCode: string | undefined,
  state: string | undefined,
  signal?: AbortSignal,
  nowMs: number = Date.now()
): Promise<StationSearch> {
  if (!countryCode) {
    return { stations: [], note: "Point en mer ou très isolé : aucune station de mesure à rechercher." };
  }
  try {
    const networks = await networksFor(lat, lon, countryCode, state, signal);
    const metas: StationMeta[] = [];
    for (const network of networks) metas.push(...(await loadNetwork(network)));
    if (signal?.aborted) throw new HttpError("aborted", "Requête annulée");

    const candidates = metas
      .map((m) => ({ ...m, distanceKm: haversineKm(lat, lon, m.lat, m.lon) }))
      .filter((m) => m.distanceKm <= SEARCH_RADIUS_KM)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, MAX_CANDIDATES);
    if (candidates.length === 0) {
      return {
        stations: [],
        note: `Aucune station de mesure à moins de ${SEARCH_RADIUS_KM} km dans ce pays.`,
      };
    }

    const history = await fetchHistory(
      candidates.map((c) => c.id),
      nowMs,
      signal
    );
    const since = nowMs - 48 * 3.6e6;
    const stations: Station[] = [];
    for (const c of candidates) {
      const obs = (history.get(c.id) ?? []).filter((o) => o.t >= since && o.t <= nowMs + 10 * 60_000);
      if (obs.length >= 6) stations.push({ ...c, obs });
    }
    if (stations.length === 0) {
      return { stations: [], note: "Les stations proches n'ont transmis aucune mesure récente d'humidité." };
    }
    return { stations, note: null };
  } catch (e) {
    if (isAbort(e)) throw e;
    return { stations: [], note: describeError(e, "Le service de mesures (IEM)") };
  }
}
