// Géographie : distances, saisie de coordonnées, géocodage direct et inverse.
// Géocodeur principal : Photon (komoot, données OpenStreetMap) — gère les adresses,
// lieux-dits et sommets, et autorise la recherche en cours de frappe.
// Secours : géocodeur Open-Meteo (villes uniquement) ; BigDataCloud pour le géocodage inverse.

import { getJson, isAbort } from "./http";

export type PlaceKind = "house" | "street" | "city" | "region" | "nature" | "other";

export interface GeoPlace {
  id: string;
  name: string;
  detail: string;
  label: string;
  lat: number;
  lon: number;
  kind: PlaceKind;
  countryCode?: string;
  state?: string;
}

export interface ReverseResult {
  label: string;
  countryCode?: string;
  state?: string;
}

const R_EARTH_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Reconnaît « 45.1885, 5.7245 », « 45.1885 5.7245 », « 45,1885 ; 5,7245 » (décimales
 * françaises) et les suffixes d'hémisphère (« 33.87 S 151.21 E », « 48.85° N, 2.35° E »).
 */
export function parseCoordinates(input: string): { lat: number; lon: number } | null {
  const s = input.trim();
  if (!s) return null;
  let latTxt: string;
  let lonTxt: string;
  let latHemi = "";
  let lonHemi = "";

  // Deux nombres à virgule décimale, séparés par « ; », un espace ou « , ».
  const fr = s.match(/^(-?\d{1,2},\d+)\s*(?:;|,\s|\s)\s*(-?\d{1,3},\d+)$/);
  if (fr) {
    latTxt = fr[1].replace(",", ".");
    lonTxt = fr[2].replace(",", ".");
  } else {
    const m = s.match(
      /^(-?\d{1,2}(?:\.\d+)?)\s*°?\s*([NSns])?\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*°?\s*([EWOewo])?$/
    );
    if (!m) return null;
    latTxt = m[1];
    latHemi = (m[2] ?? "").toUpperCase();
    lonTxt = m[3];
    lonHemi = (m[4] ?? "").toUpperCase();
  }

  let lat = parseFloat(latTxt);
  let lon = parseFloat(lonTxt);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (latHemi === "S") lat = -Math.abs(lat);
  if (lonHemi === "W" || lonHemi === "O") lon = -Math.abs(lon);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// ---------------------------------------------------------------- Photon

interface PhotonProps {
  osm_type?: string;
  osm_id?: number;
  osm_key?: string;
  type?: string;
  name?: string;
  housenumber?: string;
  street?: string;
  postcode?: string;
  city?: string;
  locality?: string;
  district?: string;
  county?: string;
  state?: string;
  country?: string;
  countrycode?: string;
}

interface PhotonFeature {
  properties?: PhotonProps;
  geometry?: { coordinates?: [number, number] };
}

interface PhotonResponse {
  features?: PhotonFeature[];
}

const PHOTON = "https://photon.komoot.io";

function kindOf(p: PhotonProps): PlaceKind {
  if (p.type === "house") return "house";
  if (p.type === "street") return "street";
  if (p.type === "city" || p.type === "district" || p.type === "locality") return "city";
  if (p.type === "county" || p.type === "state" || p.type === "country") return "region";
  if (p.osm_key === "natural" || p.osm_key === "waterway" || p.osm_key === "landuse") return "nature";
  return "other";
}

function uniq(parts: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const p of parts) if (p && !out.includes(p)) out.push(p);
  return out;
}

function placeFromPhoton(f: PhotonFeature): GeoPlace | null {
  const p = f.properties ?? {};
  const [lon, lat] = f.geometry?.coordinates ?? [NaN, NaN];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const streetLine = [p.housenumber, p.street].filter(Boolean).join(" ");
  const town = p.city ?? p.locality ?? p.district;
  const name = p.name ?? (streetLine || town || p.county || p.state || p.country);
  if (!name) return null;

  const townLine = [p.postcode, town].filter(Boolean).join(" ");
  const detail = uniq([
    streetLine && streetLine !== name ? streetLine : undefined,
    town && town !== name ? townLine : undefined,
    p.state !== name ? p.state : undefined,
    p.country !== name ? p.country : undefined,
  ]).join(", ");
  const label = uniq([name, town, p.country]).join(", ");

  return {
    id: `${p.osm_type ?? "x"}${p.osm_id ?? `${lat},${lon}`}`,
    name,
    detail,
    label,
    lat,
    lon,
    kind: kindOf(p),
    countryCode: p.countrycode?.toUpperCase(),
    state: p.state,
  };
}

interface OpenMeteoGeo {
  results?: {
    id: number;
    name: string;
    latitude: number;
    longitude: number;
    country?: string;
    country_code?: string;
    admin1?: string;
  }[];
}

async function searchOpenMeteo(q: string, signal?: AbortSignal): Promise<GeoPlace[]> {
  const params = new URLSearchParams({ name: q, count: "7", language: "fr", format: "json" });
  const json = await getJson<OpenMeteoGeo>(`https://geocoding-api.open-meteo.com/v1/search?${params}`, {
    signal,
    timeoutMs: 8000,
  });
  return (json.results ?? []).map((r) => ({
    id: `om${r.id}`,
    name: r.name,
    detail: uniq([r.admin1, r.country]).join(", "),
    label: uniq([r.name, r.admin1, r.country]).join(", "),
    lat: r.latitude,
    lon: r.longitude,
    kind: "city" as const,
    countryCode: r.country_code?.toUpperCase(),
    state: r.admin1,
  }));
}

/** Recherche de lieux (adresses comprises). Lève une erreur si aucun géocodeur ne répond. */
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<GeoPlace[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  try {
    const params = new URLSearchParams({ q, lang: "fr", limit: "7" });
    const json = await getJson<PhotonResponse>(`${PHOTON}/api/?${params}`, { signal, timeoutMs: 4500 });
    const seen = new Set<string>();
    const out: GeoPlace[] = [];
    for (const f of json.features ?? []) {
      const place = placeFromPhoton(f);
      if (!place) continue;
      const key = `${place.label}|${place.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(place);
    }
    return out;
  } catch (e) {
    if (isAbort(e)) throw e;
    return searchOpenMeteo(q, signal);
  }
}

/** Nom du lieu via Photon (précis à la rue). Lève une erreur si le service ne répond pas. */
async function reversePhoton(lat: number, lon: number, signal?: AbortSignal): Promise<ReverseResult | null> {
  const params = new URLSearchParams({ lat: lat.toFixed(5), lon: lon.toFixed(5), lang: "fr", radius: "30", limit: "1" });
  const json = await getJson<PhotonResponse>(`${PHOTON}/reverse?${params}`, { signal, timeoutMs: 4500 });
  const f = json.features?.[0];
  const p = f?.properties;
  if (!f || !p) return null;

  const [flon, flat] = f.geometry?.coordinates ?? [NaN, NaN];
  const dist = Number.isFinite(flat) && Number.isFinite(flon) ? haversineKm(lat, lon, flat, flon) : 0;
  const town = p.city ?? p.locality ?? p.district ?? p.county;
  const near = p.type === "house" || p.type === "street" ? p.street ?? p.name : p.name;
  // Au-delà de ~1,5 km, l'objet trouvé ne décrit plus le point : on se contente de la commune.
  const parts = dist <= 1.5 ? uniq([near, town, p.country]) : uniq([town ?? p.name, p.country]);
  const text = parts.join(", ");
  if (!text) return null;
  return {
    label: dist > 1.5 ? `Près de ${text}` : text,
    countryCode: p.countrycode?.toUpperCase(),
    state: p.state,
  };
}

interface BdcResponse {
  countryCode?: string;
  countryName?: string;
  principalSubdivision?: string;
  principalSubdivisionCode?: string;
  city?: string;
  locality?: string;
}

/**
 * Secours : BigDataCloud (précis à la commune, répond aussi en mer).
 * Pour les États-Unis et le Canada, `state` contient le code normalisé (« NY », « QC »).
 */
async function reverseBigDataCloud(lat: number, lon: number, signal?: AbortSignal): Promise<ReverseResult | null> {
  const params = new URLSearchParams({ latitude: lat.toFixed(5), longitude: lon.toFixed(5), localityLanguage: "fr" });
  const j = await getJson<BdcResponse>(`https://api.bigdatacloud.net/data/reverse-geocode-client?${params}`, {
    signal,
    timeoutMs: 6000,
  });
  const cc = j.countryCode ? j.countryCode.toUpperCase() : undefined;
  const label = uniq([j.locality || undefined, j.city || undefined, j.countryName || undefined]).join(", ");
  if (!label && !cc) return null;
  const code = j.principalSubdivisionCode?.split("-")[1];
  return {
    label: label || (cc ?? ""),
    countryCode: cc,
    state: (cc === "US" || cc === "CA") && code ? code : j.principalSubdivision || undefined,
  };
}

/**
 * Nom et pays d'un point. Renvoie null si rien n'est connu à cet endroit ;
 * lève une erreur si aucun des deux services ne répond.
 */
export async function reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<ReverseResult | null> {
  let primaryFailed = false;
  try {
    const r = await reversePhoton(lat, lon, signal);
    if (r) return r;
  } catch (e) {
    if (isAbort(e)) throw e;
    primaryFailed = true;
  }
  try {
    return await reverseBigDataCloud(lat, lon, signal);
  } catch (e) {
    if (isAbort(e) || primaryFailed) throw e;
    return null;
  }
}

/** Code d'État ou de province (« NY », « QC ») d'un point : sert aux réseaux de stations nord-américains. */
export async function regionCode(lat: number, lon: number, signal?: AbortSignal): Promise<string | null> {
  try {
    const r = await reverseBigDataCloud(lat, lon, signal);
    return r?.state && /^[A-Z]{2}$/.test(r.state) ? r.state : null;
  } catch (e) {
    if (isAbort(e)) throw e;
    return null;
  }
}
