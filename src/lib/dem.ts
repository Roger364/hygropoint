// Grille de terrain (MNT) pour la vue 3D.
// Copernicus DEM GLO-90 via Open-Meteo Élévation, qui accepte 100 coordonnées au plus
// par requête : on découpe la grille en lots et on les enchaîne en parallèle limité.

import { getJson, HttpError, type RequestOptions } from "./http";

export interface DemGrid {
  /** Côté de la grille en échantillons (n × n). */
  n: number;
  /** Pas entre deux échantillons, en mètres. */
  spacingM: number;
  centerLat: number;
  centerLon: number;
  /** Altitudes en mètres, rangées du nord au sud, colonnes de l'ouest à l'est. */
  elev: Float32Array;
  min: number;
  max: number;
  /** Nombre d'échantillons obtenus directement (le reste a été interpolé). */
  fetched: number;
  /** Ampleur est-ouest et nord-sud, en mètres. */
  widthM: number;
  heightM: number;
}

export interface DemResolution {
  id: string;
  /** Libellé court, exprimé en emprise réelle. */
  label: string;
  n: number;
  spacingM: number;
  hint: string;
}

/**
 * Emprises disponibles, de la plus fine à la plus large.
 *
 * Le relief occupe toujours la même place à l'écran : réduire l'emprise grossit les
 * détails, l'agrandir dévoile du terrain supplémentaire. Dézoomer fait donc passer
 * d'un niveau à l'autre, comme sur une carte.
 */
export const DEM_RESOLUTIONS: DemResolution[] = [
  { id: "fine", label: "700 m", n: 25, spacingM: 28, hint: "700 m de large · maille 28 m" },
  { id: "medium", label: "1,6 km", n: 21, spacingM: 80, hint: "1,6 km de large · maille 80 m" },
  { id: "coarse", label: "2,6 km", n: 17, spacingM: 160, hint: "2,6 km de large · maille 160 m" },
  { id: "wide", label: "5 km", n: 21, spacingM: 250, hint: "5 km de large · maille 250 m" },
  { id: "region", label: "10 km", n: 17, spacingM: 625, hint: "10 km de large · maille 625 m" },
  { id: "massif", label: "20 km", n: 13, spacingM: 1660, hint: "20 km de large · maille 1,7 km" },
];

const CHUNK = 40;
const CONCURRENCY = 3;
const CACHE_MAX = 6;

const cache = new Map<string, DemGrid>();
const inflight = new Map<string, Promise<DemGrid>>();

const M_PER_DEG_LAT = 111_320;

export function metresPerDegLon(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

function keyOf(lat: number, lon: number, n: number, spacingM: number): string {
  return `${lat.toFixed(4)}|${lon.toFixed(4)}|${n}|${spacingM}`;
}

/** Coordonnées de la grille, du nord au sud puis de l'ouest à l'est. */
export function gridCoords(lat: number, lon: number, n: number, spacingM: number): { lat: number; lon: number }[] {
  const dLat = spacingM / M_PER_DEG_LAT;
  const dLon = spacingM / Math.max(1, metresPerDegLon(lat));
  const half = (n - 1) / 2;
  const out: { lat: number; lon: number }[] = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      out.push({ lat: lat + (half - row) * dLat, lon: lon + (col - half) * dLon });
    }
  }
  return out;
}

function parseElevations(raw: unknown): number[] {
  // Documenté : { elevation: [...] }. On accepte aussi un tableau d'objets, au cas où.
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as { elevation?: unknown }).elevation)) {
    return (raw as { elevation: unknown[] }).elevation.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN));
  }
  if (Array.isArray(raw)) {
    return raw.map((v) => {
      if (typeof v === "number") return v;
      if (v && typeof v === "object" && typeof (v as { elevation?: unknown }).elevation === "number") {
        return (v as { elevation: number }).elevation;
      }
      return NaN;
    });
  }
  throw new HttpError("parse", "Réponse du modèle de terrain inexploitable.");
}

async function fetchChunk(coords: { lat: number; lon: number }[], opts: RequestOptions): Promise<number[]> {
  const params = new URLSearchParams({
    latitude: coords.map((c) => c.lat.toFixed(5)).join(","),
    longitude: coords.map((c) => c.lon.toFixed(5)).join(","),
  });
  const raw = await getJson<unknown>(`https://api.open-meteo.com/v1/elevation?${params}`, { timeoutMs: 12_000, ...opts });
  const values = parseElevations(raw);
  if (values.length !== coords.length) throw new HttpError("parse", "Nombre d'altitudes inattendu.");
  return values;
}

function fillGaps(elev: Float32Array, n: number): number {
  const valid = [...elev].filter((v) => Number.isFinite(v));
  if (valid.length === 0) return 0;
  if (valid.length === elev.length) return elev.length;
  valid.sort((a, b) => a - b);
  const fallback = valid[valid.length >> 1];
  // Passe de comblement : moyenne des voisins connus, sinon médiane globale.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < elev.length; i++) {
      if (Number.isFinite(elev[i])) continue;
      const row = Math.floor(i / n);
      const col = i % n;
      let sum = 0;
      let count = 0;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || r >= n || c < 0 || c >= n) continue;
        const v = elev[r * n + c];
        if (Number.isFinite(v)) {
          sum += v;
          count++;
        }
      }
      elev[i] = count > 0 ? sum / count : fallback;
    }
  }
  for (let i = 0; i < elev.length; i++) if (!Number.isFinite(elev[i])) elev[i] = fallback;
  return valid.length;
}

/**
 * Grille d'altitudes centrée sur le point. Le résultat est mis en cache : revenir sur
 * une résolution déjà chargée, ou déplacer le point de quelques dizaines de mètres,
 * ne déclenche aucune requête.
 */
export async function fetchDem(
  lat: number,
  lon: number,
  res: DemResolution,
  opts: RequestOptions = {},
  onProgress?: (done: number, total: number) => void
): Promise<DemGrid> {
  const { n, spacingM } = res;
  const key = keyOf(lat, lon, n, spacingM);
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;

  const job = (async () => {
    const coords = gridCoords(lat, lon, n, spacingM);
    const elev = new Float32Array(n * n).fill(NaN);

    // Lots de 100 coordonnées, cinq en vol à la fois.
    const chunks: number[][] = [];
    for (let i = 0; i < coords.length; i += CHUNK) chunks.push([i, Math.min(i + CHUNK, coords.length)]);
    let cursor = 0;
    let done = 0;
    let failed = 0;
    const worker = async () => {
      while (cursor < chunks.length) {
        const idx = cursor++;
        const [a, b] = chunks[idx];
        const slice = coords.slice(a, b);
        let values: number[] | null = null;
        try {
          values = await fetchChunk(slice, opts);
        } catch (e) {
          if (e instanceof HttpError && e.kind === "aborted") throw e;
          try {
            values = await fetchChunk(slice, opts);
          } catch (e2) {
            if (e2 instanceof HttpError && e2.kind === "aborted") throw e2;
            failed++;
          }
        }
        if (values) for (let k = 0; k < values.length; k++) elev[a + k] = values[k];
        done++;
        onProgress?.(done, chunks.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
    if (opts.signal?.aborted) throw new HttpError("aborted", "Requête annulée");

    const fetched = fillGaps(elev, n);
    if (fetched === 0) throw new HttpError("parse", "Aucune altitude obtenue pour ce lieu.");

    let min = Infinity;
    let max = -Infinity;
    for (const v of elev) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const grid: DemGrid = {
      n,
      spacingM,
      centerLat: lat,
      centerLon: lon,
      elev,
      min,
      max,
      fetched,
      widthM: spacingM * (n - 1),
      heightM: spacingM * (n - 1),
    };
    cache.set(key, grid);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    if (failed > 0) grid.fetched = Math.max(0, fetched - failed);
    return grid;
  })();

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

/** Altitude bilinéaire en un point ; null hors de la grille. */
export function sampleDem(g: DemGrid, lat: number, lon: number): number | null {
  const dLat = g.spacingM / M_PER_DEG_LAT;
  const dLon = g.spacingM / Math.max(1, metresPerDegLon(g.centerLat));
  const half = (g.n - 1) / 2;
  const fx = (lon - g.centerLon) / dLon + half; // colonne, ouest → est
  const fy = half - (lat - g.centerLat) / dLat; // rangée, nord → sud
  if (fx < 0 || fy < 0 || fx > g.n - 1 || fy > g.n - 1) return null;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(g.n - 1, x0 + 1);
  const y1 = Math.min(g.n - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = g.elev[y0 * g.n + x0];
  const b = g.elev[y0 * g.n + x1];
  const c = g.elev[y1 * g.n + x0];
  const d = g.elev[y1 * g.n + x1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

/** Altitude au centre exact de la grille, arrondie au mètre. */
export function centreElevation(g: DemGrid): number {
  const mid = ((g.n - 1) / 2) | 0;
  return g.elev[mid * g.n + mid];
}
