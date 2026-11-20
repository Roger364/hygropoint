// Terrain et alentours du point choisi.
//
// Deux sources, toutes deux gratuites et sans clé :
//  - Open-Meteo Élévation (Copernicus DEM GLO-90) : altitudes sur un pochoir de points
//    autour du lieu → pente, exposition, concavité, position dans le relief.
//  - Overpass (OpenStreetMap) : plans d'eau et zones boisées à proximité.
//
// Ces données décrivent le lieu. L'effet qu'elles ont sur l'humidité à 2 m, lui,
// suit des relations physiques classiques (écoulement d'air froid nocturne, bilans
// d'énergie d'un versant, évaporation d'un plan d'eau) dont l'ordre de grandeur est
// encadré mais non mesuré ici : c'est explicité dans l'interface.

import { getJson, HttpError, isAbort, type RequestOptions } from "./http";
import { clamp } from "./physics";

// ---------------------------------------------------------------- types

export interface TerrainPoint {
  /** Altitude du MNT (m), ou null si indisponible. */
  elevation: number | null;
  /** Pente (°). */
  slope: number | null;
  /** Azimut vers lequel le versant descend (°, 0 = nord). */
  aspect: number | null;
  /** Altitude du point moins celle du tour à ~2 km (m) : négatif = creux. */
  tpi: number | null;
  /** Altitude du point moins la moyenne des 8 voisins immédiats (m). */
  curvature: number | null;
  /** De 0 (terrain quelconque) à 1 (fond de vallée plat, propice à l'accumulation d'air froid). */
  poolIndex: number;
}

export type WaterKind = "sea" | "lake" | "river" | "stream" | "canal" | "pond";

export interface WaterFeature {
  kind: WaterKind;
  /** Distance au bord (m), 0 si le point est dans l'eau. */
  distanceM: number;
  /** Azimut du point vers l'eau (°). */
  bearing: number;
  /** Ampleur, de 0 (ruisseau) à 1 (mer ou grand lac). */
  size: number;
}

/** Géométrie OpenStreetMap conservée pour le rendu 3D : [latitude, longitude]. */
export interface TerrainFeature {
  kind: WaterKind | "forest";
  /** Polygone fermé (lac, mare, parcelle boisée) ou simple ligne (rivière, chemin d'eau). */
  closed: boolean;
  /** Ampleur relative, 0 à 1 : sert à l'épaisseur du tracé et à l'opacité. */
  size: number;
  points: [number, number][];
}

export interface ForestCover {
  /** De 0 à 1 : proxy d'occupation du sol, pas une mesure de canopée. */
  fraction: number;
  /** Distance à la lisière (m), 0 si le point est en forêt. */
  nearestM: number;
}

export interface TerrainInfo {
  point: TerrainPoint;
  /** Terrain de chaque station de mesure retenue (concavité seulement). */
  stations: Record<string, { tpi: number | null; poolIndex: number }>;
  water: WaterFeature | null;
  forest: ForestCover | null;
  /** Géométries voisines, pour la carte en relief. */
  features: TerrainFeature[];
  /** Problèmes de collecte, affichés tels quels. */
  notes: string[];
  /** Ce qui a pu être réellement obtenu. */
  detail: "full" | "osm-only" | "none";
}

export const EMPTY_TERRAIN: TerrainInfo = {
  point: { elevation: null, slope: null, aspect: null, tpi: null, curvature: null, poolIndex: 0 },
  stations: {},
  water: null,
  forest: null,
  features: [],
  notes: [],
  detail: "none",
};

/**
 * Indice d'accumulation d'air froid, de 0 (terrain quelconque) à 1 (creux profond).
 * Dépend du dénivelé avec le tour à 2 km ; `depth` fixe la profondeur qui sature l'effet.
 * Les quatre premiers mètres sont ignorés : c'est le bruit du modèle de terrain.
 */
export function derivePool(tpi: number | null, depth = 55): number {
  if (tpi === null || !Number.isFinite(tpi)) return 0;
  return clamp(Math.max(0, -tpi - 4) / Math.max(5, depth), 0, 1);
}

// ---------------------------------------------------------------- géométrie

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function bearingTo(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x =
    Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Distance (m) du point au segment [a, b], et azimut du point vers le point le plus proche. */

// ---------------------------------------------------------------- MNT

interface ElevationResponse {
  elevation?: number[];
}

const CELL = 0.001; // ~110 m : voisinage immédiat
const RING = 0.018; // ~2 km : position dans le relief

function stencil(lat: number, lon: number): { lat: number; lon: number }[] {
  const pts: { lat: number; lon: number }[] = [];
  for (const dj of [-1, 0, 1])
    for (const di of [-1, 0, 1]) pts.push({ lat: lat + dj * CELL, lon: lon + di * CELL * (1 / Math.cos(rad(lat)) ) });
  for (const [dj, di] of [
    [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1],
  ] as const)
    pts.push({ lat: lat + dj * RING, lon: lon + di * RING * (1 / Math.cos(rad(lat))) });
  return pts;
}

function ringStencil(lat: number, lon: number): { lat: number; lon: number }[] {
  const out: { lat: number; lon: number }[] = [{ lat, lon }];
  for (const [dj, di] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const)
    out.push({ lat: lat + dj * RING, lon: lon + di * RING * (1 / Math.cos(rad(lat))) });
  return out;
}

/**
 * Pente, exposition et concavité à partir d'une grille 3×3 (méthode de Horn).
 * `e` est rangée par ligne : index = (ligne + 1) * 3 + (colonne + 1), ligne 0 au nord.
 */
function describeGrid(lat: number, e: number[]): TerrainPoint {
  const center = e[4];
  const elevation = center;
  const neighbours = [e[0], e[1], e[2], e[3], e[5], e[6], e[7], e[8]];
  const ring = e.slice(9);
  const mean8 = neighbours.reduce((a, b) => a + b, 0) / neighbours.length;
  const meanRing = ring.reduce((a, b) => a + b, 0) / ring.length;

  const cellY = CELL * 111320;
  const cellX = CELL * 111320 * Math.cos(rad(lat));
  // Horn : a = NO, b = N, c = NE, d = O, f = E, g = SO, h = S, i = SE
  const [a, b, c, , , f, g, h, i] = e;
  const dzdx = (c + 2 * f + i - (a + 2 * d_unused(e) + g)) / (8 * cellX);
  const dzdy = (g + 2 * h + i - (a + 2 * b + c)) / (8 * cellY);
  const slopeRaw = deg(Math.atan(Math.hypot(dzdx, dzdy)));
  const slope = slopeRaw <= 35 ? slopeRaw : null;
  const aspect = Math.hypot(dzdx, dzdy) < 1e-9 ? null : (deg(Math.atan2(dzdx, -dzdy)) + 360) % 360;

  const tpi = center - meanRing;
  const curvature = center - mean8;
  // Uniquement fonction du creux : la station de mesure n'a pas de pente connue, et
  // l'effet doit pouvoir s'annuler exactement quand les deux terrains se ressemblent.
  const poolIndex = derivePool(tpi);

  return { elevation, slope, aspect, tpi, curvature, poolIndex };
}

// Marqueur pour garder la correspondance avec la notation de Horn (d = O).
function d_unused(e: number[]): number {
  return e[3];
}

/** Altitudes demandées en une seule requête (limite : 100 coordonnées). */
async function fetchElevations(coords: { lat: number; lon: number }[], opts: RequestOptions): Promise<number[]> {
  if (coords.length === 0) return [];
  if (coords.length > 100) coords = coords.slice(0, 100);
  const params = new URLSearchParams({
    latitude: coords.map((c) => c.lat.toFixed(5)).join(","),
    longitude: coords.map((c) => c.lon.toFixed(5)).join(","),
  });
  const j = await getJson<ElevationResponse>(`https://api.open-meteo.com/v1/elevation?${params}`, {
    timeoutMs: 8000,
    ...opts,
  });
  if (!Array.isArray(j.elevation) || j.elevation.length !== coords.length) {
    throw new HttpError("parse", "Réponse du modèle de terrain inexploitable.");
  }
  return j.elevation.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN));
}

function poolFromTpi(e: number[]): { tpi: number | null; poolIndex: number } {
  const center = e[0];
  const ring = e.slice(1);
  if (!Number.isFinite(center) || ring.some((v) => !Number.isFinite(v))) return { tpi: null, poolIndex: 0 };
  const tpi = center - ring.reduce((a, b) => a + b, 0) / ring.length;
  return { tpi, poolIndex: derivePool(tpi) };
}

// ---------------------------------------------------------------- Overpass


// ---------------------------------------------------------------- collecte

const cache = new Map<string, { at: number; info: TerrainInfo }>();
const CACHE_MS = 30 * 60_000;
const pending = new Map<string, Promise<TerrainInfo>>();

/** Arrondit les coordonnées (~250 m) : déplacer le repère de quelques mètres ne change rien. */
function keyOf(lat: number, lon: number): string {
  return `${lat.toFixed(3)}|${lon.toFixed(3)}`;
}

/**
 * Terrain du point et des stations. Ne lève jamais d'erreur (hors annulation) :
 * sans données, on rend `detail: "none"` et l'estimation reste celle des modèles.
 */
export async function fetchTerrain(
  lat: number,
  lon: number,
  stations: { id: string; lat: number; lon: number }[],
  opts: RequestOptions = {}
): Promise<TerrainInfo> {
  const key = keyOf(lat, lon);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.info;
  const inflight = pending.get(key);
  if (inflight) return inflight;

  const job = (async (): Promise<TerrainInfo> => {
    const notes: string[] = [];
    const stStencil = stations.slice(0, 3).flatMap((s) => ringStencil(s.lat, s.lon));
    const own = stencil(lat, lon);
    // Relief (élévation) seul : l'occupation du sol (Overpass) est retirée
    // car les deux miroirs publics sont en panne et le terrain se dessine
    // sans landuse. Évite 12 s de requêtes mortes par chargement.
    const elevRes = await (async () => {
      try {
        const v = await fetchElevations([...own, ...stStencil], opts);
        return { status: "fulfilled" as const, value: v };
      } catch (e) {
        return { status: "rejected" as const, reason: e };
      }
    })();

    let point: TerrainPoint = { ...EMPTY_TERRAIN.point };
    const stationTerrain: TerrainInfo["stations"] = {};

    if (elevRes.status === "fulfilled") {
      const elev = elevRes.value;
      const ownE = elev.slice(0, own.length);
      if (ownE.some((v) => Number.isFinite(v))) {
        point = describeGrid(lat, ownE.map((v) => (Number.isFinite(v) ? v : point.elevation ?? 0)));
      } else notes.push("Altitudes indisponibles : relief non analysé.");
      let off = own.length;
      for (const s of stations.slice(0, 3)) {
        const e = elev.slice(off, off + 5);
        off += 5;
        stationTerrain[s.id] = poolFromTpi(e);
      }
    } else {
      if (isAbort(elevRes.reason)) throw elevRes.reason;
      notes.push("Modèle de terrain inaccessible : relief non analysé.");
    }

    let water: WaterFeature | null = null;
    let forest: ForestCover | null = null;
    let foundFeatures: TerrainFeature[] = [];
    // Occupation du sol (Overpass) désactivée : les miroirs publics sont en
    // panne et le terrain se dessine sans landuse. Aucune requête réseau.
    notes.push("Carte des alentours (OpenStreetMap) non chargée : eau et végétation ignorées.");

    const info: TerrainInfo = {
      point,
      stations: stationTerrain,
      water,
      forest,
      features: foundFeatures,
      notes,
      detail: point.slope !== null ? "full" : water || forest ? "osm-only" : "none",
    };
    cache.set(key, { at: Date.now(), info });
    return info;
  })();

  pending.set(key, job);
  try {
    return await job;
  } finally {
    pending.delete(key);
  }
}

// ---------------------------------------------------------------- descriptions

export function describeTerrain(t: TerrainInfo): string[] {
  const out: string[] = [];
  const p = t.point;
  if (p.elevation !== null) {
    out.push(`Altitude ${Math.round(p.elevation)} m`);
    if (p.slope !== null && p.slope >= 1) {
      const dir = p.aspect === null ? "" : `exposé ${cardinal(p.aspect)}`;
      out.push(`Versant de ${Math.round(p.slope)}° ${dir}`.trim());
    } else out.push("Terrain plat");
    if (p.tpi !== null) {
      const slope = p.slope ?? 0;
      if (p.tpi < -12 && slope < 3) out.push("Fond de vallée ou cuvette : l'air froid y stagne");
      else if (p.tpi < -12) out.push("Bas de versant, au-dessus du fond de vallée");
      else if (p.tpi > 12 && slope < 3) out.push("Position dominante : plateau ou crête dégagée");
      else if (p.tpi > 12) out.push("Haut de versant, position exposée");
      else out.push("Mi-pente, sans accumulation marquée d'air froid");
    }
  }
  if (t.forest) {
    if (t.forest.fraction >= 0.95) out.push("Sous couvert forestier");
    else if (t.forest.fraction >= 0.3) out.push(`Végétation boisée à ${Math.round(t.forest.nearestM)} m`);
  }
  if (t.water) {
    const phrase = WATER_PHRASE[t.water.kind];
    out.push(
      t.water.distanceM < 25
        ? `Au bord ${phrase}`
        : `À ${Math.round(t.water.distanceM)} m ${phrase}`
    );
  }
  return out;
}

const WATER_PHRASE: Record<WaterKind, string> = {
  sea: "de la mer",
  lake: "d'un lac",
  river: "d'une rivière",
  stream: "d'un cours d'eau",
  canal: "d'un canal",
  pond: "d'une mare",
};

export function cardinal(bearing: number): string {
  const dirs = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"];
  return dirs[Math.round(((bearing % 360) / 45)) % 8];
}

// ---------------------------------------------------------------- soleil

export interface Sun {
  altitude: number;
  azimuth: number;
}

/** Position du soleil (hauteur et azimut depuis le nord) à un instant et un lieu donnés. */
export function sunPosition(tMs: number, lat: number, lon: number): Sun {
  const d = new Date(tMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const n = (tMs - start) / 86_400_000;
  const decl = rad(23.44 * Math.sin((2 * Math.PI * (284 + n)) / 365.25));
  const utcHours = d.getUTCHours() + d.getUTCMinutes() / 60;
  const H = rad((utcHours + lon / 15 - 12) * 15); // temps solaire moyen (équation du temps négligée)
  const sinLat = Math.sin(rad(lat));
  const cosLat = Math.cos(rad(lat));
  const sinDec = Math.sin(decl);
  const cosDec = Math.cos(decl);
  const up = sinLat * sinDec + cosLat * cosDec * Math.cos(H);
  const east = -cosDec * Math.sin(H);
  const north = cosLat * sinDec - sinLat * cosDec * Math.cos(H);
  return { altitude: deg(Math.asin(clamp(up, -1, 1))), azimuth: (deg(Math.atan2(east, north)) + 360) % 360 };
}
