// Accès aux modèles de prévision via Open-Meteo (gratuit, sans clé).
// L'analyse des réponses est volontairement tolérante : horodatages ISO ou Unix,
// clés suffixées par modèle ou non, objet seul ou tableau.

import { getJson, HttpError, type RequestOptions } from "./http";
import { dewPointFromRh } from "./physics";

export const MODELS = [
  { id: "best_match", label: "Sélection locale Open-Meteo" },
  { id: "ecmwf_ifs025", label: "ECMWF IFS" },
  { id: "icon_seamless", label: "DWD ICON" },
  { id: "meteofrance_seamless", label: "Météo-France AROME / ARPEGE" },
  { id: "gfs_seamless", label: "NOAA GFS / HRRR" },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

const ALL_IDS: ModelId[] = MODELS.map((m) => m.id);
const labelOf = (id: ModelId): string => MODELS.find((m) => m.id === id)?.label ?? id;

export const CTX_VARS = [
  "precipitation",
  "precipitation_probability",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "cloud_cover",
  "cloud_cover_low",
  "surface_pressure",
  "shortwave_radiation",
  "is_day",
] as const;

export type CtxVar = (typeof CTX_VARS)[number];

/** Série d'un modèle. NaN = valeur absente. */
export interface MemberSeries {
  id: ModelId;
  label: string;
  temp: number[];
  dew: number[];
}

export interface ModelData {
  latitude: number;
  longitude: number;
  elevation: number | null;
  timezone: string;
  /** Instants réels (ms epoch), croissants, au pas horaire. */
  times: number[];
  members: MemberSeries[];
  missing: { id: ModelId; label: string }[];
  /** Variables de contexte (vent, pluie, nuages…). NaN = absent. */
  ctx: Record<CtxVar, number[]>;
  /** Vrai si l'API a refusé la requête multi-modèles et qu'on s'est replié sur un seul. */
  degraded: boolean;
  fetchedAt: number;
}

interface RawResponse {
  latitude?: number;
  longitude?: number;
  elevation?: number;
  timezone?: string;
  utc_offset_seconds?: number;
  hourly?: Record<string, unknown>;
}

const API = "https://api.open-meteo.com/v1/forecast";

function toMs(v: unknown, offsetSec: number): number {
  if (typeof v === "number") return v * 1000;
  if (typeof v === "string") {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - offsetSec * 1000;
  }
  return NaN;
}

function numSeries(hourly: Record<string, unknown>, key: string): number[] | null {
  const arr = hourly[key];
  if (!Array.isArray(arr)) return null;
  return arr.map((x) => (typeof x === "number" && Number.isFinite(x) ? x : NaN));
}

export function parseModelResponse(raw: unknown, ids: readonly ModelId[], degraded = false): ModelData {
  const obj = (Array.isArray(raw) ? raw[0] : raw) as RawResponse | undefined;
  const hourly = obj?.hourly;
  const rawTimes = hourly?.time;
  if (!obj || !hourly || !Array.isArray(rawTimes) || rawTimes.length === 0) {
    throw new HttpError("parse", "Réponse Open-Meteo sans données horaires.");
  }
  const offset = typeof obj.utc_offset_seconds === "number" ? obj.utc_offset_seconds : 0;
  const times = rawTimes.map((v) => toMs(v, offset));
  if (times.some((t) => !Number.isFinite(t))) {
    throw new HttpError("parse", "Horodatages Open-Meteo illisibles.");
  }
  const n = times.length;
  const single = ids.length === 1;
  const pick = (v: string, id: ModelId): number[] | null =>
    numSeries(hourly, `${v}_${id}`) ?? (single ? numSeries(hourly, v) : null);

  const members: MemberSeries[] = [];
  const missing: { id: ModelId; label: string }[] = [];
  for (const id of ids) {
    const t = pick("temperature_2m", id);
    const td = pick("dew_point_2m", id);
    const rh = pick("relative_humidity_2m", id);
    const temp = new Array<number>(n).fill(NaN);
    const dew = new Array<number>(n).fill(NaN);
    let valid = 0;
    for (let i = 0; i < n; i++) {
      const ti = t ? t[i] : NaN;
      if (!Number.isFinite(ti)) continue;
      let di = td ? td[i] : NaN;
      if (!Number.isFinite(di) && rh && Number.isFinite(rh[i])) di = dewPointFromRh(ti, rh[i]);
      if (!Number.isFinite(di)) continue;
      temp[i] = ti;
      dew[i] = Math.min(di, ti);
      valid++;
    }
    if (valid >= Math.min(24, n * 0.5)) members.push({ id, label: labelOf(id), temp, dew });
    else missing.push({ id, label: labelOf(id) });
  }
  if (members.length === 0) {
    throw new HttpError("parse", "Aucun modèle météo ne fournit de données pour ce point.");
  }

  // Contexte : valeur de la sélection locale si disponible, sinon moyenne des autres modèles.
  const ctx = {} as Record<CtxVar, number[]>;
  for (const v of CTX_VARS) {
    const perModel = ids.map((id) => pick(v, id));
    const out = new Array<number>(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const first = perModel[0]?.[i];
      if (first !== undefined && Number.isFinite(first)) {
        out[i] = first;
        continue;
      }
      let sum = 0;
      let count = 0;
      for (const s of perModel) {
        const x = s?.[i];
        if (x !== undefined && Number.isFinite(x)) {
          sum += x;
          count++;
        }
      }
      if (count) out[i] = sum / count;
    }
    ctx[v] = out;
  }

  return {
    latitude: typeof obj.latitude === "number" ? obj.latitude : NaN,
    longitude: typeof obj.longitude === "number" ? obj.longitude : NaN,
    elevation: typeof obj.elevation === "number" && Number.isFinite(obj.elevation) ? obj.elevation : null,
    timezone: typeof obj.timezone === "string" && obj.timezone ? obj.timezone : "UTC",
    times,
    members,
    missing,
    ctx,
    degraded,
    fetchedAt: Date.now(),
  };
}

async function request(
  lat: number,
  lon: number,
  ids: readonly ModelId[],
  extra: Record<string, string>,
  opts: RequestOptions,
  degraded: boolean
): Promise<ModelData> {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    models: ids.join(","),
    timeformat: "unixtime",
    wind_speed_unit: "kmh",
    ...extra,
  });
  const raw = await getJson<unknown>(`${API}?${params}`, { timeoutMs: 15_000, ...opts });
  return parseModelResponse(raw, ids, degraded);
}

/** Modèles au point choisi : humidité + contexte, 48 h passées → 96 h à venir. */
export async function fetchPointModels(lat: number, lon: number, opts: RequestOptions = {}): Promise<ModelData> {
  const extra = {
    hourly: ["temperature_2m", "relative_humidity_2m", "dew_point_2m", ...CTX_VARS].join(","),
    past_days: "2",
    forecast_days: "5",
    timezone: "auto",
  };
  try {
    return await request(lat, lon, ALL_IDS, extra, opts, false);
  } catch (e) {
    // Requête refusée (identifiant de modèle retiré, par ex.) : repli sur la sélection locale seule.
    if (e instanceof HttpError && e.kind === "http" && e.status === 400) {
      return request(lat, lon, ["best_match"], extra, opts, true);
    }
    throw e;
  }
}

/** Sept jours passés à l'emplacement d'une station, pour comparer anticipation et mesure. */
export async function fetchStationLookback(lat: number, lon: number, opts: RequestOptions = {}): Promise<ModelData> {
  const extra = {
    hourly: ["temperature_2m", "dew_point_2m", "relative_humidity_2m", "precipitation", "wind_speed_10m", "cloud_cover", "is_day"].join(","),
    past_days: "7",
    forecast_days: "1",
    timezone: "GMT",
  };
  try {
    return await request(lat, lon, ["best_match", "ecmwf_ifs025"], extra, { timeoutMs: 18_000, ...opts }, false);
  } catch (e) {
    if (e instanceof HttpError && e.kind === "http" && e.status === 400) {
      return request(lat, lon, ["best_match"], extra, { timeoutMs: 18_000, ...opts }, true);
    }
    throw e;
  }
}

/** Mêmes modèles à l'emplacement d'une station (température et point de rosée seulement). */
export async function fetchStationModels(lat: number, lon: number, opts: RequestOptions = {}): Promise<ModelData> {
  const extra = {
    hourly: "temperature_2m,dew_point_2m",
    past_days: "2",
    forecast_days: "2",
    timezone: "GMT",
  };
  return request(lat, lon, ALL_IDS, extra, { timeoutMs: 10_000, ...opts }, false);
}
