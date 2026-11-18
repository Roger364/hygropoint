// Moteur d'estimation de l'humidité relative en un point.
//
// 1. Consensus : moyenne des modèles en température et point de rosée (l'humidité
//    relative en découle, ce qui garde T, Td et HR cohérents entre eux).
// 2. Calage sur mesures, si des stations proches existent : on compare les mêmes
//    modèles, évalués à l'emplacement des stations, aux mesures des dernières 48 h.
//      a. Passé et présent : l'erreur constatée aux stations est retirée au point,
//         pondérée par une confiance qui décroît avec la distance et le dénivelé.
//      b. Prévisions : un biais par situation météo (pluie, nuit calme…) et une
//         pondération des modèles ne sont appliqués que s'ils réduisent l'erreur sur
//         des données qu'ils n'ont pas vues (appris sur J-2, testés sur J-1).
// 3. Incertitude : tirée de l'erreur réellement mesurée aux stations ; à défaut,
//    un ordre de grandeur prudent, signalé comme tel.
//
// Rien n'est corrigé « à l'aveugle » : sans mesure, on rend le consensus brut.

import { absoluteHumidity, clamp, dewPointFromRh, rhFromTempDew } from "./physics";
import { MODELS, type ModelData, type ModelId } from "./openmeteo";
import type { Station } from "./stations";
import { derivePool, EMPTY_TERRAIN, sunPosition, type TerrainInfo } from "./terrain";
import { DEFAULT_TUNE, isDefaultTune, type Tune } from "./tune";

/** Paramètres de l'estimateur. Les « hypothèses » ne sont pas vérifiables depuis l'app. */
export const CONFIG = {
  windowH: 48, // fenêtre de mesures utilisée
  holdoutH: 24, // dernières heures réservées au test hors échantillon
  spatialScaleKm: 35, // hypothèse : confiance divisée par e à 35 km
  verticalScaleM: 250, // hypothèse : idem pour 250 m de dénivelé
  minTrust: 0.05, // en dessous, une station n'apporte rien
  shrink: 6, // pseudo-mesures tirant les biais vers zéro (anti-surapprentissage)
  sigmaObs: 3.5, // bruit d'une mesure METAR (T et Td arrondis au °C) + micro-échelle
  sigmaDefault: 9, // hypothèse : erreur type des modèles sans mesure locale
  growth72h: 0.3, // hypothèse : +30 % d'erreur à 72 h d'échéance
  rhoDefault: 0.7, // persistance horaire de l'erreur si non mesurable
  minGainAbs: 0.3, // gain minimal (points d'HR) pour retenir une correction…
  minGainRel: 0.05, // …et en proportion de l'erreur initiale
  minSamples: 12,
  z80: 1.2816, // demi-largeur d'un intervalle à 80 % en écarts-types
  blockedRadiusKm: 5, // si le transfert spatial échoue, seules les stations à moins de 5 km ancrent
} as const;

const H = 3.6e6;
const fin = Number.isFinite;

export type Regime = "rain" | "windy" | "night_calm" | "day_sunny" | "other";

/** Correction apprise sur les mesures passées, en points d'humidité, par situation. */
export interface LearnedBias {
  byRegime: Partial<Record<Regime, number>>;
  /** 0–1 : confiance du transfert vers le point (stations proches). */
  weight: number;
}
const REGIMES: Regime[] = ["rain", "windy", "night_calm", "day_sunny", "other"];

export const REGIME_LABELS: Record<Regime, string> = {
  rain: "Pluie",
  windy: "Vent soutenu (≥ 25 km/h)",
  night_calm: "Nuit calme et dégagée",
  day_sunny: "Journée ensoleillée",
  other: "Autres situations",
};

/** Ce qui fonde la correction d'une heure donnée. */
export type Basis = "obs" | "persist" | "bias" | "none";
export type Variant = "none" | "weights" | "bias" | "both";

export interface StationInput extends Station {
  model: ModelData;
}

export interface HourEstimate {
  t: number;
  hoursFromNow: number;
  isPast: boolean;
  rh: number;
  rhRaw: number;
  rhLow: number;
  rhHigh: number;
  sigma: number;
  temp: number;
  dewPoint: number;
  absHumidity: number;
  spread: number;
  nModels: number;
  precip: number | null;
  precipProb: number | null;
  wind: number | null;
  gust: number | null;
  cloud: number | null;
  cloudLow: number | null;
  pressure: number | null;
  radiation: number | null;
  isDay: boolean;
  regime: Regime;
  basis: Basis;
  /** Poids de la mesure dans l'estimation (0 = modèles seuls, 1 = mesure sur place). */
  anchor: number;
  perModel: Partial<Record<ModelId, number>>;
  /** Humidité mesurée à la station de référence à cette heure, si disponible. */
  obsRh: number | null;
  /** Effet du terrain et des alentours appliqué à cette heure (°C, sur T et Td). */
  terrain: TerrainEffect;
}

/** Décomposition de l'effet de terrain, pour l'affichage. */
export interface TerrainPart {
  key: "cold_air" | "sun_exposure" | "water" | "forest";
  label: string;
  dT: number;
  dTd: number;
}

export interface TerrainEffect {
  dT: number;
  dTd: number;
  /** Poids réellement appliqué : 0 si une station voisine ancre déjà l'estimation. */
  weight: number;
  parts: TerrainPart[];
}

export interface StationSummary {
  id: string;
  name: string;
  lat: number;
  lon: number;
  distanceKm: number;
  elev: number | null;
  dz: number | null;
  trust: number;
  nObs: number;
  last: { t: number; temp: number; dew: number; rh: number };
  modelBiasRh: number | null;
  modelMaeRh: number | null;
  series: { t: number; rh: number }[];
}

export interface MemberSummary {
  id: ModelId;
  label: string;
  /** Part dans le consensus (0–1). */
  share: number;
  rhNow: number | null;
  /** Erreur absolue moyenne mesurée aux stations (points d'HR). */
  mae: number | null;
  /** Vrai si cette source recopie un autre modèle de la liste à cet endroit. */
  duplicate: boolean;
}

export interface Calibration {
  hasStations: boolean;
  nSamples: number;
  rawMae: number | null;
  rawRmse: number | null;
  rawBias: number | null;
  temporal: { tested: boolean; applied: boolean; variant: Variant; n: number; before: number; after: number };
  spatial: { tested: boolean; ok: boolean; verified: boolean; n: number; before: number; after: number };
  anchoring: {
    active: boolean;
    weightNow: number;
    lastObsT: number | null;
    rho: number;
    rhoMeasured: boolean;
  };
  regimes: { key: Regime; label: string; n: number; meanErrRh: number | null; corrRh: number | null }[];
  sigmaModel: number;
  sigmaMeasured: boolean;
}

export interface Verdict {
  status: "improved" | "assumed" | "not_improved" | "no_reference";
  title: string;
  lines: string[];
}

export interface Stats {
  n: number;
  min: number;
  max: number;
  mean: number;
  minAt: number;
  maxAt: number;
  rainHours: number;
  rainTotal: number;
}

export interface EstimateResult {
  computedAt: number;
  hours: HourEstimate[];
  now: HourEstimate;
  past24: HourEstimate[];
  next72: HourEstimate[];
  members: MemberSummary[];
  missing: { id: ModelId; label: string }[];
  stations: StationSummary[];
  terrain: TerrainSummary;
  calibration: Calibration;
  verdict: Verdict;
  confidence: { level: "high" | "medium" | "low"; label: string; halfWidth: number };
  /** Vrai si les hypothèses ont été modifiées par rapport aux valeurs par défaut. */
  tuned: boolean;
  stats: { past24: Stats; next72: Stats };
}

// ---------------------------------------------------------------- outils

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const f1 = (v: number): string => v.toFixed(1).replace(".", ",");

/** Confiance (0–1) accordée au transfert d'une information sur `distanceKm` et `dz` mètres. */
export function stationTrust(distanceKm: number, dz: number | null, tune: Tune = DEFAULT_TUNE): number {
  const h = Math.exp(-((distanceKm / tune.stationKm) ** 2));
  const v = dz === null ? 1 : Math.exp(-((dz / tune.stationM) ** 2));
  return h * v;
}

/** Stations les plus représentatives du point (au plus `max`). */
export function rankStations<T extends Station>(
  stations: T[],
  pointElev: number | null,
  max = 3,
  tune: Tune = DEFAULT_TUNE
): T[] {
  return stations
    .map((s) => ({
      s,
      a: stationTrust(s.distanceKm, s.elev !== null && pointElev !== null ? s.elev - pointElev : null, tune),
    }))
    .filter((x) => x.a >= CONFIG.minTrust)
    .sort((x, y) => y.a - x.a)
    .slice(0, max)
    .map((x) => x.s);
}

interface Matrix {
  times: number[];
  T: number[][];
  Td: number[][];
  /** Part des heures où la « sélection locale » recopie un autre modèle. */
  dupShare: number;
}

/**
 * Séries par modèle. La « sélection locale » d'Open-Meteo est souvent l'un des autres
 * modèles de la liste : on l'écarte aux heures où elle en est la copie, pour ne pas
 * compter deux fois la même source.
 */
function buildMatrix(md: ModelData, ids: ModelId[]): Matrix {
  const n = md.times.length;
  const empty = () => new Array<number>(n).fill(NaN);
  const T = ids.map((id) => md.members.find((m) => m.id === id)?.temp.slice() ?? empty());
  const Td = ids.map((id) => md.members.find((m) => m.id === id)?.dew.slice() ?? empty());
  const bm = ids.indexOf("best_match");
  let dup = 0;
  let total = 0;
  if (bm >= 0) {
    for (let i = 0; i < n; i++) {
      if (!fin(T[bm][i])) continue;
      total++;
      for (let j = 0; j < ids.length; j++) {
        if (j === bm || !fin(T[j][i])) continue;
        if (Math.abs(T[bm][i] - T[j][i]) < 0.051 && Math.abs(Td[bm][i] - Td[j][i]) < 0.051) {
          T[bm][i] = NaN;
          Td[bm][i] = NaN;
          dup++;
          break;
        }
      }
    }
  }
  return { times: md.times, T, Td, dupShare: total ? dup / total : 0 };
}

/** Position de t dans une suite croissante : times[i] ≤ t, fraction f vers times[i+1]. */
function locate(times: number[], t: number): { i: number; f: number } | null {
  const n = times.length;
  if (n === 0 || t < times[0] || t > times[n - 1]) return null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  if (t >= times[hi]) return { i: hi, f: 0 };
  const span = times[hi] - times[lo];
  return { i: lo, f: span > 0 ? (t - times[lo]) / span : 0 };
}

/** Valeurs de chaque modèle à l'instant t (interpolation linéaire entre deux heures). */
function membersAt(mx: Matrix, t: number): { T: number[]; Td: number[] } | null {
  const loc = locate(mx.times, t);
  if (!loc) return null;
  const { i, f } = loc;
  const T: number[] = [];
  const Td: number[] = [];
  for (let k = 0; k < mx.T.length; k++) {
    if (f === 0) {
      T.push(mx.T[k][i]);
      Td.push(mx.Td[k][i]);
    } else {
      T.push(mx.T[k][i] + f * (mx.T[k][i + 1] - mx.T[k][i]));
      Td.push(mx.Td[k][i] + f * (mx.Td[k][i + 1] - mx.Td[k][i]));
    }
  }
  return { T, Td };
}

interface Consensus {
  T: number;
  Td: number;
  rh: number;
  n: number;
}

function consensus(T: number[], Td: number[], w: number[]): Consensus | null {
  let sw = 0;
  let sT = 0;
  let sD = 0;
  let n = 0;
  for (let k = 0; k < T.length; k++) {
    if (!fin(T[k]) || !fin(Td[k])) continue;
    sw += w[k];
    sT += w[k] * T[k];
    sD += w[k] * Td[k];
    n++;
  }
  if (sw <= 0) return null;
  const t = sT / sw;
  const d = Math.min(sD / sw, t);
  return { T: t, Td: d, rh: rhFromTempDew(t, d), n };
}

function regimeOf(precip: number, wind: number, cloud: number, isDay: boolean, radiation: number): Regime {
  if (fin(precip) && precip >= 0.1) return "rain";
  const w = fin(wind) ? wind : 15;
  const c = fin(cloud) ? cloud : 60;
  if (w >= 25) return "windy";
  if (!isDay && w < 10 && c < 50) return "night_calm";
  if (isDay && c < 50 && (!fin(radiation) || radiation >= 200)) return "day_sunny";
  return "other";
}

// ---------------------------------------------------------------- échantillons

/** Une mesure de station, avec la valeur de chaque modèle au même endroit et au même instant. */
interface Sample {
  s: number;
  t: number;
  obsT: number;
  obsTd: number;
  obsRh: number;
  mT: number[];
  mTd: number[];
  regime: Regime;
  /** Poids relatif de la station (1 pour la plus représentative). */
  a: number;
  /** Retenu dans le jeu horaire (une mesure par station et par heure). */
  hourly: boolean;
}

interface Bias {
  T: Record<Regime, number>;
  Td: Record<Regime, number>;
}

interface Err {
  eT: number;
  eTd: number;
  eRh: number;
  rh: number;
}

function sampleError(x: Sample, w: number[], bias: Bias | null, scale = 1): Err | null {
  const c = consensus(x.mT, x.mTd, w);
  if (!c) return null;
  let T = c.T;
  let Td = c.Td;
  if (bias) {
    T -= scale * bias.T[x.regime];
    Td = Math.min(Td - scale * bias.Td[x.regime], T);
  }
  const rh = rhFromTempDew(T, Td);
  return { eT: T - x.obsT, eTd: Td - x.obsTd, eRh: rh - x.obsRh, rh };
}

interface Score {
  mae: number;
  rmse: number;
  bias: number;
  n: number;
}

function score(samples: Sample[], w: number[], bias: Bias | null): Score {
  let sw = 0;
  let sa = 0;
  let ss = 0;
  let sb = 0;
  let n = 0;
  for (const x of samples) {
    const e = sampleError(x, w, bias);
    if (!e) continue;
    sw += x.a;
    sa += x.a * Math.abs(e.eRh);
    ss += x.a * e.eRh * e.eRh;
    sb += x.a * e.eRh;
    n++;
  }
  if (sw <= 0) return { mae: NaN, rmse: NaN, bias: NaN, n: 0 };
  return { mae: sa / sw, rmse: Math.sqrt(ss / sw), bias: sb / sw, n };
}

/** Poids des modèles, inversement proportionnels à leur erreur quadratique mesurée. */
function fitWeights(samples: Sample[], m: number): number[] | null {
  if (samples.length < 2 * CONFIG.minSamples) return null;
  const mse: (number | null)[] = [];
  for (let k = 0; k < m; k++) {
    let sw = 0;
    let se = 0;
    let count = 0;
    for (const x of samples) {
      if (!fin(x.mT[k]) || !fin(x.mTd[k])) continue;
      const e = rhFromTempDew(x.mT[k], Math.min(x.mTd[k], x.mT[k])) - x.obsRh;
      sw += x.a;
      se += x.a * e * e;
      count++;
    }
    mse.push(count >= CONFIG.minSamples && sw > 0 ? se / sw : null);
  }
  const known = mse.filter((v): v is number => v !== null);
  if (known.length < 2) return null;
  const fallback = median(known);
  const raw = mse.map((v) => 1 / ((v ?? fallback) + CONFIG.sigmaObs ** 2));
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  return raw.map((v) => v / mean);
}

/** Biais moyen (modèles − mesures) par situation météo, régularisé vers le biais global puis vers zéro. */
function fitBias(samples: Sample[], w: number[]): Bias | null {
  if (samples.length < CONFIG.minSamples) return null;
  const acc = Object.fromEntries(REGIMES.map((r) => [r, { n: 0, sT: 0, sD: 0 }])) as Record<
    Regime,
    { n: number; sT: number; sD: number }
  >;
  let n = 0;
  let sT = 0;
  let sD = 0;
  for (const x of samples) {
    const e = sampleError(x, w, null);
    if (!e) continue;
    const r = acc[x.regime];
    r.n += x.a;
    r.sT += x.a * e.eT;
    r.sD += x.a * e.eTd;
    n += x.a;
    sT += x.a * e.eT;
    sD += x.a * e.eTd;
  }
  if (n <= 0) return null;
  const k = CONFIG.shrink;
  const gT = sT / (n + k);
  const gD = sD / (n + k);
  const T = {} as Record<Regime, number>;
  const Td = {} as Record<Regime, number>;
  for (const r of REGIMES) {
    T[r] = (acc[r].sT + k * gT) / (acc[r].n + k);
    Td[r] = (acc[r].sD + k * gD) / (acc[r].n + k);
  }
  return { T, Td };
}

interface ErrPoint {
  t: number;
  eT: number;
  eTd: number;
}

const NEAR_MS = 45 * 60_000;
const GAP_MS = 150 * 60_000;

/** Erreur d'une station à l'instant t, interpolée entre deux mesures proches. */
function errAt(series: ErrPoint[], t: number): ErrPoint | null {
  const n = series.length;
  if (!n) return null;
  if (t <= series[0].t) return series[0].t - t <= NEAR_MS ? series[0] : null;
  if (t >= series[n - 1].t) return t - series[n - 1].t <= NEAR_MS ? series[n - 1] : null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = series[lo];
  const b = series[hi];
  if (b.t - a.t <= GAP_MS) {
    const f = (t - a.t) / (b.t - a.t);
    return { t, eT: a.eT + f * (b.eT - a.eT), eTd: a.eTd + f * (b.eTd - a.eTd) };
  }
  if (t - a.t <= NEAR_MS) return a;
  if (b.t - t <= NEAR_MS) return b;
  return null;
}

/** Corrélation de l'erreur d'une heure à la suivante : mesure sa persistance. */
function estimateRho(hourly: Sample[], nStations: number, w: number[]): { rho: number; measured: boolean } {
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  let pairs = 0;
  for (let s = 0; s < nStations; s++) {
    const pts: { b: number; e: number }[] = [];
    for (const x of hourly) {
      if (x.s !== s) continue;
      const e = sampleError(x, w, null);
      if (e) pts.push({ b: Math.round(x.t / H), e: e.eRh });
    }
    if (pts.length < 3) continue;
    pts.sort((p, q) => p.b - q.b);
    const mean = pts.reduce((acc, p) => acc + p.e, 0) / pts.length;
    for (let k = 0; k + 1 < pts.length; k++) {
      if (pts[k + 1].b - pts[k].b !== 1) continue;
      const x = pts[k].e - mean;
      const y = pts[k + 1].e - mean;
      sxy += x * y;
      sxx += x * x;
      syy += y * y;
      pairs++;
    }
  }
  if (pairs < 10 || sxx <= 0 || syy <= 0) return { rho: CONFIG.rhoDefault, measured: false };
  return { rho: clamp(sxy / Math.sqrt(sxx * syy), 0, 0.95), measured: true };
}

function statsOf(hs: HourEstimate[]): Stats {
  if (!hs.length) return { n: 0, min: NaN, max: NaN, mean: NaN, minAt: 0, maxAt: 0, rainHours: 0, rainTotal: 0 };
  let min = hs[0];
  let max = hs[0];
  let sum = 0;
  let rainHours = 0;
  let rainTotal = 0;
  for (const h of hs) {
    if (h.rh < min.rh) min = h;
    if (h.rh > max.rh) max = h;
    sum += h.rh;
    if (h.precip !== null && h.precip >= 0.1) {
      rainHours++;
      rainTotal += h.precip;
    }
  }
  return {
    n: hs.length,
    min: min.rh,
    max: max.rh,
    mean: sum / hs.length,
    minAt: min.t,
    maxAt: max.t,
    rainHours,
    rainTotal,
  };
}

// ---------------------------------------------------------------- terrain

/** Plafonds des effets de terrain (°C). Au-delà, on considère la situation hors modèle. */
export const TERRAIN_LIMITS = {
  coldAirT: 3, // poche de froid nocturne
  sunT: 1.5, // contraste d'ensoleillement entre versants
  waterTd: 1.6, // apport d'humidité d'un plan d'eau
  waterT: 0.5, // inertie thermique d'un plan d'eau
  forestT: 1, // sous-bois
  sigma: 14, // plafond de l'incertitude ajoutée par une hypothèse de terrain (points d'HR)
} as const;

const rad180 = (d: number) => (d * Math.PI) / 180;

/**
 * Effet du terrain et des alentours sur la température et le point de rosée à 2 m.
 *
 * Les effets portent sur T et Td, jamais sur l'humidité relative directement : la
 * conversion par Magnus garantit ainsi qu'une hausse d'humidité vient bien d'un
 * refroidissement ou d'un apport de vapeur d'eau, et pas d'un chiffre ajusté.
 *
 * `anchorWeight` est le poids de la station de référence dans l'estimation. L'effet
 * appliqué est celui du point, diminué de celui de la station : sinon, on compterait
 * deux fois le creux de vallée où se trouve souvent… l'aérodrome de mesure.
 */
function terrainEffectAt(
  t: TerrainInfo,
  lat: number,
  lon: number,
  time: number,
  ctx: {
    temp: number;
    wind: number | null;
    windDir: number | null;
    cloud: number | null;
    radiation: number | null;
    isDay: boolean;
  },
  anchorWeight: number,
  tune: Tune
): TerrainEffect {
  const parts: TerrainPart[] = [];
  const cloud = ctx.cloud;
  // Vent au sol : le modèle, sauf si l'utilisateur l'a mesuré ou choisi lui-même.
  const forcedWind = tune.groundWind >= 0;
  const w10 = forcedWind ? Math.max(0, tune.groundWind) : ctx.wind === null ? null : Math.max(0, ctx.wind);
  const windDir = forcedWind ? tune.windFrom : ctx.windDir;
  const mixed = w10 === null ? 0.5 : clamp(1 - (w10 - 8) / 22, 0, 1);
  // Les nuages coupent le rayonnement infrarouge, mais pas tout : même sous un ciel
  // couvert il reste un quart de l’effet (réduction ≈ 0,8 × fraction nuageuse).
  const clear = cloud === null ? 0.6 : clamp(1 - 0.8 * (cloud / 100), 0.15, 1);
  // L’écoulement d’air froid s’installe sous ~10 km/h, et surtout sous 4 km/h :
  // la réponse est donc non linéaire, pas un simple seuil.
  const calm = w10 === null ? 0.5 : clamp(1 - (w10 / 10) ** 1.5, 0, 1);
  const sunny =
    ctx.radiation !== null ? clamp(ctx.radiation / 450, 0, 1) : cloud === null ? 0.6 : clamp((100 - cloud) / 70, 0, 1);

  const p = t.point;

  // 1) Air froid qui s'accumule en point bas, les nuits calmes et dégagées.
  // L'indice de creux est recalculé ici, et non repris du terrain : sa profondeur de
  // saturation est réglable, et la station doit être traitée exactement comme le point.
  const pool = derivePool(p.tpi, tune.poolDepth);
  const stationPool = derivePool(Object.values(t.stations)[0]?.tpi ?? null, tune.poolDepth);
  const night = !ctx.isDay;
  if (night && (pool > 0.05 || (stationPool > 0.05 && anchorWeight > 0.05))) {
    const k = tune.poolCap * calm * clear;
    const dT = -pool * k;
    const stationT = -stationPool * k;
    const applied = dT - anchorWeight * stationT;
    if (Math.abs(applied) >= 0.1) {
      parts.push({ key: "cold_air", label: "Accumulation d'air froid en point bas", dT: applied, dTd: 0.1 * applied });
    }
  }

  // 2) Ensoleillement du versant : un adret reçoit bien plus d'énergie qu'un ubac.
  if (ctx.isDay && p.slope !== null && p.slope >= 2 && p.aspect !== null && sunny > 0.15) {
    const sun = sunPosition(time, lat, lon);
    if (sun.altitude > 8) {
      const s = rad180(p.slope);
      const a = rad180(p.aspect);
      const sunAlt = rad180(sun.altitude);
      const sunAz = rad180(sun.azimuth);
      const cosTheta =
        Math.sin(sunAlt) * Math.cos(s) + Math.cos(sunAlt) * Math.sin(s) * Math.cos(sunAz - a);
      const exposure = clamp(cosTheta / Math.max(0.15, Math.sin(sunAlt)), 0, 2.2);
      if (Math.abs(exposure - 1) >= 0.06) {
        const dT = clamp(tune.sunCap * (exposure - 1), -tune.sunCap, tune.sunCap) * sunny * mixed;
        if (Math.abs(dT) >= 0.1) {
          parts.push({ key: "sun_exposure", label: "Exposition du versant au soleil", dT, dTd: -0.15 * dT });
        }
      }
    }
  }

  // 3) Plan d'eau : celui de la carte, ou celui que l'utilisateur place (la carte en rate souvent un).
  const w =
    tune.waterMode <= 0
      ? null
      : tune.waterMode >= 2
        ? {
            kind: "lake" as const,
            distanceM: tune.waterDist,
            bearing: tune.waterFrom,
            size: tune.waterSize,
          }
        : t.water;
  if (w && (w.size >= 0.12 || w.distanceM < 400)) {
    const prox = Math.exp(-w.distanceM / Math.max(50, tune.waterReach));
    if (prox > 0.04) {
      // L'évaporation croît avec le déficit de saturation, donc avec la chaleur.
      const warm = clamp((ctx.temp - 2) / 18, 0.12, 1);
      // Le vent apporte l'air humide seulement s'il souffle de l'eau vers le point.
      const align =
        windDir === null || w10 === null || w10 < 2
          ? 0.5
          : clamp(Math.cos(rad180(windDir - w.bearing)), 0, 1);
      const dTd = tune.waterTd * prox * w.size * warm * (0.35 + 0.65 * align);
      if (dTd >= 0.12) {
        const dT = ctx.isDay
          ? -0.3 * prox * w.size * (0.3 + 0.7 * align)
          : TERRAIN_LIMITS.waterT * prox * w.size * clear;
        parts.push({ key: "water", label: "Plan d'eau à proximité", dT, dTd });
      }
    }
  }

  // 4) Couvert végétal : plus frais et plus humide le jour, moins froid la nuit.
  const f = t.forest;
  // La carte ne dit pas si la forêt est dense : la densité réelle est réglable.
  const leaf = f ? f.fraction * tune.canopy : 0;
  if (f && leaf >= 0.08) {
    const dT = ctx.isDay ? -tune.forestCap * leaf * sunny : 0.5 * leaf * clear;
    const dTd = ctx.isDay ? 0.22 * leaf : -0.08 * leaf;
    if (Math.abs(dT) + Math.abs(dTd) >= 0.12) {
      parts.push({ key: "forest", label: "Couvert végétal", dT, dTd });
    }
  }

  const dT = clampSum(parts.map((x) => x.dT), 4);
  const dTd = clampSum(parts.map((x) => x.dTd), 2.5);
  return { dT, dTd, weight: 1 - anchorWeight, parts };
}

/**
 * Ce que la prise en compte du terrain change, en points d'humidité relative,
 * sur les heures où elle joue. Le calcul retire l'effet puis reconvertit : la
 * comparaison porte donc bien sur de la physique, pas sur un ajustement direct.
 */
function buildTerrainSummary(t: TerrainInfo, hours: HourEstimate[], nowMs: number): TerrainSummary {
  const rhWithout = (h: HourEstimate): number =>
    rhFromTempDew(h.temp - h.terrain.dT, Math.min(h.dewPoint - h.terrain.dTd, h.temp - h.terrain.dT));

  const perPart = new Map<TerrainPart["key"], { hours: number; sumRh: number }>();
  const deltas: number[] = [];
  for (const h of hours) {
    if (h.terrain.parts.length === 0) continue;
    const d = h.rh - rhWithout(h);
    deltas.push(d);
    for (const part of h.terrain.parts) {
      const e = perPart.get(part.key) ?? { hours: 0, sumRh: 0 };
      e.hours++;
      e.sumRh += d / h.terrain.parts.length;
      perPart.set(part.key, e);
    }
  }

  const nowRow = hours.reduce((a, b) => (Math.abs(b.t - nowMs) < Math.abs(a.t - nowMs) ? b : a), hours[0]);
  return {
    available: t.detail !== "none",
    detail: t.detail,
    notes: t.notes,
    now: nowRow.terrain,
    meanRhNow: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0,
    maxAbsRh: deltas.length ? Math.max(...deltas.map(Math.abs)) : 0,
    activeParts: [...perPart.entries()].map(([key, v]) => ({
      key,
      label: PART_LABELS[key],
      hours: v.hours,
      meanRh: v.sumRh / v.hours,
    })),
  };
}

const PART_LABELS: Record<TerrainPart["key"], string> = {
  cold_air: "Accumulation d'air froid en point bas",
  sun_exposure: "Exposition du versant au soleil",
  water: "Plan d'eau à proximité",
  forest: "Couvert végétal",
};

function clampSum(values: number[], limit: number): number {
  const s = values.reduce((a, b) => a + b, 0);
  return clamp(s, -limit, limit);
}

/** Résumé de l'effet de terrain, pour l'affichage. */
export interface TerrainSummary {
  available: boolean;
  detail: TerrainInfo["detail"];
  notes: string[];
  now: TerrainEffect;
  /** Effet moyen sur 48 h, en points d'humidité relative. */
  meanRhNow: number;
  maxAbsRh: number;
  activeParts: { key: TerrainPart["key"]; label: string; hours: number; meanRh: number }[];
}

// ---------------------------------------------------------------- estimation

export function computeEstimate(
  point: ModelData,
  stationsIn: StationInput[],
  stationNote: string | null,
  nowMs: number = Date.now(),
  terrain: TerrainInfo = EMPTY_TERRAIN,
  tune: Tune = DEFAULT_TUNE,
  learned: LearnedBias | null = null
): EstimateResult {
  const ids = MODELS.map((m) => m.id).filter((id) => point.members.some((m) => m.id === id));
  const M = ids.length;
  const ones = new Array<number>(M).fill(1);
  const mxP = buildMatrix(point, ids);
  const nP = point.times.length;
  const ctx = point.ctx;

  const isDayAt = (i: number): boolean =>
    fin(ctx.is_day[i]) ? ctx.is_day[i] >= 0.5 : fin(ctx.shortwave_radiation[i]) ? ctx.shortwave_radiation[i] > 5 : true;
  const regimes: Regime[] = point.times.map((_, i) =>
    regimeOf(ctx.precipitation[i], ctx.wind_speed_10m[i], ctx.cloud_cover[i], isDayAt(i), ctx.shortwave_radiation[i])
  );
  const nearestIndex = (t: number): number => {
    const loc = locate(point.times, t);
    if (!loc) return t < point.times[0] ? 0 : nP - 1;
    return Math.min(nP - 1, loc.i + (loc.f >= 0.5 ? 1 : 0));
  };
  const regimeAtPoint = (t: number): Regime => (locate(point.times, t) ? regimes[nearestIndex(t)] : "other");

  // ---- Stations : échantillons (mesure + modèles au même endroit), contrôle de vraisemblance
  const since = nowMs - CONFIG.windowH * H;
  const ranked = stationsIn
    .map((s) => {
      const dz = s.elev !== null && point.elevation !== null ? s.elev - point.elevation : null;
      return { s, dz, trust: stationTrust(s.distanceKm, dz, tune) };
    })
    .filter((x) => x.trust >= CONFIG.minTrust)
    .sort((x, y) => y.trust - x.trust);

  const kept: { s: StationInput; dz: number | null; trust: number; samples: Sample[] }[] = [];
  for (const st of ranked) {
    const mx = buildMatrix(st.s.model, ids);
    const list: Sample[] = [];
    for (const o of st.s.obs) {
      if (o.t < since || o.t > nowMs + 10 * 60_000) continue;
      const mv = membersAt(mx, o.t);
      if (!mv) continue;
      const c = consensus(mv.T, mv.Td, ones);
      if (!c) continue;
      // Écart invraisemblable : capteur en panne ou station mal référencée, on écarte la mesure.
      if (Math.abs(c.T - o.temp) > 12 || Math.abs(c.Td - o.dew) > 15) continue;
      list.push({
        s: 0,
        t: o.t,
        obsT: o.temp,
        obsTd: o.dew,
        obsRh: rhFromTempDew(o.temp, o.dew),
        mT: mv.T,
        mTd: mv.Td,
        regime: regimeAtPoint(o.t),
        a: 1,
        hourly: false,
      });
    }
    // Jeu horaire : la mesure la plus proche de chaque heure ronde (à ± 20 min).
    const best = new Map<number, Sample>();
    for (const x of list) {
      const b = Math.round(x.t / H);
      const d = Math.abs(x.t - b * H);
      if (d > 20 * 60_000) continue;
      const cur = best.get(b);
      if (!cur || d < Math.abs(cur.t - b * H)) best.set(b, x);
    }
    for (const x of best.values()) x.hourly = true;
    if (list.length >= 6 && best.size >= 3) kept.push({ ...st, samples: list });
  }

  const S = kept.length;
  const aMax = S ? kept[0].trust : 0;
  kept.forEach((st, idx) => {
    for (const x of st.samples) {
      x.s = idx;
      x.a = st.trust / aMax;
    }
  });
  const samples = kept.flatMap((st) => st.samples);
  const hourly = samples.filter((x) => x.hourly);

  // ---- Erreur brute mesurée (consensus à poids égaux, sans correction)
  const rawScore = score(hourly, ones, null);

  // ---- Garde-fou temporel : ce qui est appris sur J-2 doit améliorer J-1
  const split = nowMs - CONFIG.holdoutH * H;
  const train = hourly.filter((x) => x.t < split);
  const test = hourly.filter((x) => x.t >= split);
  const temporal = {
    tested: false,
    applied: false,
    variant: "none" as Variant,
    n: 0,
    before: NaN,
    after: NaN,
    rmseAfter: NaN,
  };
  if (train.length >= CONFIG.minSamples && test.length >= CONFIG.minSamples) {
    const wTrain = fitWeights(train, M);
    const candidates: { v: Variant; w: number[]; b: Bias | null }[] = [{ v: "none", w: ones, b: null }];
    if (wTrain) candidates.push({ v: "weights", w: wTrain, b: null });
    const bEq = fitBias(train, ones);
    if (bEq) candidates.push({ v: "bias", w: ones, b: bEq });
    const bW = wTrain ? fitBias(train, wTrain) : null;
    if (wTrain && bW) candidates.push({ v: "both", w: wTrain, b: bW });

    const scored = candidates.map((c) => ({ v: c.v, sc: score(test, c.w, c.b) }));
    const base = scored[0].sc;
    let best = scored[0];
    for (const c of scored) if (c.sc.mae < best.sc.mae) best = c;
    const gain = base.mae - best.sc.mae;
    const applied = best.v !== "none" && gain >= Math.max(CONFIG.minGainAbs, CONFIG.minGainRel * base.mae);
    temporal.tested = true;
    temporal.applied = applied;
    temporal.variant = applied ? best.v : "none";
    temporal.n = base.n;
    temporal.before = base.mae;
    temporal.after = best.sc.mae;
    temporal.rmseAfter = applied ? best.sc.rmse : base.rmse;
  }

  // Ajustement final sur toute la fenêtre, uniquement pour ce qui a passé le test.
  let w = ones;
  let bias: Bias | null = null;
  if (temporal.applied) {
    if (temporal.variant === "weights" || temporal.variant === "both") w = fitWeights(hourly, M) ?? ones;
    if (temporal.variant === "bias" || temporal.variant === "both") bias = fitBias(hourly, w);
  }

  // ---- Séries d'erreur par station (sous la pondération retenue)
  const series: ErrPoint[][] = kept.map(() => []);
  for (const x of samples) {
    const e = sampleError(x, w, null);
    if (e) series[x.s].push({ t: x.t, eT: e.eT, eTd: e.eTd });
  }

  // ---- Contrôle croisé spatial : prédire l'erreur de chaque station à partir des autres
  const spatial = { tested: false, ok: true, verified: false, n: 0, before: NaN, after: NaN };
  if (S >= 2) {
    let s0 = 0;
    let s1 = 0;
    let n = 0;
    for (let s = 0; s < S; s++) {
      const me = kept[s].s;
      const others: { j: number; a: number }[] = [];
      for (let j = 0; j < S; j++) {
        if (j === s) continue;
        const o = kept[j].s;
        const d = Math.hypot(
          (me.lat - o.lat) * 111.2,
          (me.lon - o.lon) * 111.2 * Math.cos((((me.lat + o.lat) / 2) * Math.PI) / 180)
        );
        const dz = me.elev !== null && o.elev !== null ? me.elev - o.elev : null;
        const a = stationTrust(d, dz);
        if (a >= 0.2) others.push({ j, a }); // paires trop éloignées : test non informatif
      }
      if (!others.length) continue;
      for (const x of hourly) {
        if (x.s !== s) continue;
        let sa = 0;
        let eT = 0;
        let eTd = 0;
        let top = 0;
        for (const o of others) {
          const e = errAt(series[o.j], x.t);
          if (!e) continue;
          sa += o.a;
          eT += o.a * e.eT;
          eTd += o.a * e.eTd;
          top = Math.max(top, o.a);
        }
        if (sa <= 0) continue;
        const c = consensus(x.mT, x.mTd, w);
        if (!c) continue;
        const T = c.T - (top * eT) / sa;
        const Td = Math.min(c.Td - (top * eTd) / sa, T);
        s0 += Math.abs(c.rh - x.obsRh);
        s1 += Math.abs(rhFromTempDew(T, Td) - x.obsRh);
        n++;
      }
    }
    if (n >= CONFIG.minSamples) {
      spatial.tested = true;
      spatial.n = n;
      spatial.before = s0 / n;
      spatial.after = s1 / n;
      spatial.ok = spatial.after <= spatial.before;
      spatial.verified = spatial.before - spatial.after >= Math.max(CONFIG.minGainAbs, CONFIG.minGainRel * spatial.before);
    }
  }

  // ---- Ancrage : poids de chaque station dans la correction du passé et du présent
  const anchorA = kept.map((st) =>
    spatial.tested && !spatial.ok && st.s.distanceKm > CONFIG.blockedRadiusKm ? 0 : st.trust
  );
  let tLast: number | null = null;
  for (let s = 0; s < S; s++) {
    if (anchorA[s] <= 0 || !series[s].length) continue;
    const t = series[s][series[s].length - 1].t;
    if (tLast === null || t > tLast) tLast = t;
  }

  const fieldAt = (t: number): { eT: number; eTd: number; A: number } | null => {
    let sa = 0;
    let eT = 0;
    let eTd = 0;
    let A = 0;
    for (let s = 0; s < S; s++) {
      if (anchorA[s] <= 0) continue;
      const e = errAt(series[s], t);
      if (!e) continue;
      sa += anchorA[s];
      eT += anchorA[s] * e.eT;
      eTd += anchorA[s] * e.eTd;
      A = Math.max(A, anchorA[s]);
    }
    return sa > 0 ? { eT: eT / sa, eTd: eTd / sa, A } : null;
  };

  const { rho, measured: rhoMeasured } = estimateRho(hourly, S, w);
  const baseAt = (t: number): { cT: number; cTd: number } => {
    if (!bias) return { cT: 0, cTd: 0 };
    const r = regimeAtPoint(t);
    return { cT: aMax * bias.T[r], cTd: aMax * bias.Td[r] };
  };
  const last = tLast !== null ? fieldAt(tLast) : null;
  const lastBase = tLast !== null ? baseAt(tLast) : { cT: 0, cTd: 0 };

  /** Correction (°C) à retirer au consensus du point à l'instant t. */
  const correctionAt = (t: number): { cT: number; cTd: number; omega: number; basis: Basis } => {
    const base = baseAt(t);
    if (tLast !== null && last) {
      if (t <= tLast) {
        const f = fieldAt(t);
        if (f) return { cT: f.A * f.eT, cTd: f.A * f.eTd, omega: f.A, basis: "obs" };
      } else {
        // Au-delà de la dernière mesure, l'écart constaté s'estompe au rythme mesuré (rho par heure).
        const decay = Math.pow(rho, (t - tLast) / H);
        const omega = last.A * decay;
        return {
          cT: base.cT + (last.A * last.eT - lastBase.cT) * decay,
          cTd: base.cTd + (last.A * last.eTd - lastBase.cTd) * decay,
          omega,
          basis: omega >= 0.1 ? "persist" : bias ? "bias" : "none",
        };
      }
    }
    return { cT: base.cT, cTd: base.cTd, omega: 0, basis: bias ? "bias" : "none" };
  };

  // ---- Incertitude du consensus (hors ancrage)
  let sigmaModel: number = CONFIG.sigmaDefault;
  let sigmaMeasured = false;
  if (S && rawScore.n >= CONFIG.minSamples) {
    const measured = Math.max(CONFIG.sigmaObs, temporal.applied ? temporal.rmseAfter : rawScore.rmse);
    // Stations peu représentatives du point : on ne descend pas sous la valeur par défaut.
    const cautious = Math.max(measured, CONFIG.sigmaDefault);
    sigmaModel = Math.sqrt(aMax * measured ** 2 + (1 - aMax) * cautious ** 2);
    sigmaMeasured = true;
  }

  const spreadOf = (T: number[], Td: number[]): { spread: number; perModel: Partial<Record<ModelId, number>> } => {
    const perModel: Partial<Record<ModelId, number>> = {};
    const vals: number[] = [];
    for (let k = 0; k < M; k++) {
      if (!fin(T[k]) || !fin(Td[k])) continue;
      const v = rhFromTempDew(T[k], Math.min(Td[k], T[k]));
      perModel[ids[k]] = v;
      vals.push(v);
    }
    if (vals.length < 2) return { spread: 0, perModel };
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1);
    return { spread: Math.sqrt(variance), perModel };
  };

  // Dispersion « habituelle » des modèles : seule la dispersion en excès élargit l'intervalle.
  const pastSpreads: number[] = [];
  for (let i = 0; i < nP; i++) {
    const t = point.times[i];
    if (t < since || t > nowMs) continue;
    const sp = spreadOf(
      mxP.T.map((row) => row[i]),
      mxP.Td.map((row) => row[i])
    ).spread;
    if (sp > 0) pastSpreads.push(sp);
  }
  const spreadRef = pastSpreads.length ? median(pastSpreads) : 0;

  // Mesures de la station de référence, par heure ronde (affichage)
  const obsByHour = new Map<number, number>();
  for (const x of hourly) if (x.s === 0) obsByHour.set(Math.round(x.t / H), x.obsRh);

  const val = (arr: number[], i: number): number | null => (fin(arr[i]) ? arr[i] : null);

  const estimateAt = (t: number, i: number): HourEstimate | null => {
    const mv = membersAt(mxP, t);
    if (!mv) return null;
    const raw = consensus(mv.T, mv.Td, ones);
    const weighted = consensus(mv.T, mv.Td, w);
    if (!raw || !weighted) return null;
    const c = correctionAt(t);
    const terr = terrainEffectAt(
      terrain,
      point.latitude,
      point.longitude,
      t,
      {
        temp: weighted.T,
        wind: val(ctx.wind_speed_10m, i),
        windDir: val(ctx.wind_direction_10m, i),
        cloud: val(ctx.cloud_cover, i),
        radiation: val(ctx.shortwave_radiation, i),
        isDay: isDayAt(i),
      },
      c.omega,
      tune
    );
    const tempNoTerrain = weighted.T - c.cT;
    const temp = tempNoTerrain + terr.dT;
    const dewNoTerrain = Math.min(weighted.Td - c.cTd, tempNoTerrain);
    const dewPoint = Math.min(dewNoTerrain + terr.dTd, temp);
    const learnedDelta = (learned?.byRegime[regimes[i]] ?? 0) * (learned?.weight ?? 0) * (1 - 0.7 * c.omega);
    const rh = clamp(rhFromTempDew(temp, dewPoint) + learnedDelta, 1, 100);
    const dewPointAdj = dewPointFromRh(temp, rh);
    // Ce que le terrain déplace réellement, en points d'humidité : c'est cette grandeur
    // qui fixe l'incertitude ajoutée, pas les degrés Celsius.
    const terrainShift = rh - rhFromTempDew(tempNoTerrain, dewNoTerrain);
    const { spread, perModel } = spreadOf(mv.T, mv.Td);

    const lead = (t - nowMs) / H;
    const growth = 1 + CONFIG.growth72h * clamp(lead / 72, 0, 1);
    const excess = Math.max(0, spread ** 2 - spreadRef ** 2);
    // Un effet de terrain est une hypothèse : il déplace le centre de l'estimation et
    // élargit d'autant la fourchette. On retient la moitié du déplacement, bornée.
    const sigmaTerr = clamp(0.5 * Math.abs(terrainShift), 0, TERRAIN_LIMITS.sigma);
    const sigmaMod = Math.sqrt((sigmaModel * growth) ** 2 + excess);
    const sigma = Math.sqrt(c.omega * CONFIG.sigmaObs ** 2 + (1 - c.omega) * sigmaMod ** 2 + sigmaTerr ** 2);

    return {
      t,
      hoursFromNow: lead,
      isPast: t < nowMs,
      rh,
      rhRaw: raw.rh,
      rhLow: clamp(rh - CONFIG.z80 * sigma, 0, 100),
      rhHigh: clamp(rh + CONFIG.z80 * sigma, 0, 100),
      sigma,
      temp,
      dewPoint: dewPointAdj,
      absHumidity: absoluteHumidity(temp, rh),
      spread,
      nModels: raw.n,
      precip: val(ctx.precipitation, i),
      precipProb: val(ctx.precipitation_probability, i),
      wind: val(ctx.wind_speed_10m, i),
      gust: val(ctx.wind_gusts_10m, i),
      cloud: val(ctx.cloud_cover, i),
      cloudLow: val(ctx.cloud_cover_low, i),
      pressure: val(ctx.surface_pressure, i),
      radiation: val(ctx.shortwave_radiation, i),
      isDay: isDayAt(i),
      regime: regimes[i],
      basis: c.basis,
      anchor: c.omega,
      perModel,
      obsRh: obsByHour.get(Math.round(t / H)) ?? null,
      terrain: terr,
    };
  };

  const hours: HourEstimate[] = [];
  const from = nowMs - 24 * H - 59 * 60_000;
  const to = nowMs + 72 * H + 59 * 60_000;
  for (let i = 0; i < nP; i++) {
    const t = point.times[i];
    if (t < from || t > to) continue;
    const h = estimateAt(t, i);
    if (h) hours.push(h);
  }
  if (!hours.length) throw new Error("Les modèles ne couvrent pas la période demandée pour ce point.");

  const nowRow = estimateAt(nowMs, nearestIndex(nowMs));
  const now: HourEstimate = nowRow
    ? { ...nowRow, obsRh: null }
    : hours.reduce((a, b) => (Math.abs(b.hoursFromNow) < Math.abs(a.hoursFromNow) ? b : a));

  const past24 = hours.filter((h) => h.t < nowMs);
  const next72 = hours.filter((h) => h.t >= nowMs);

  // ---- Synthèse du terrain
  const terrainSummary = buildTerrainSummary(terrain, hours, nowMs);

  // ---- Synthèses
  const nowMembers = membersAt(mxP, nowMs);
  const shareTotal = ids.reduce((acc, id, k) => acc + (id === "best_match" && mxP.dupShare >= 0.9 ? 0 : w[k]), 0);
  const members: MemberSummary[] = ids.map((id, k) => {
    const duplicate = id === "best_match" && mxP.dupShare >= 0.9;
    let sw = 0;
    let sa = 0;
    let count = 0;
    for (const x of hourly) {
      if (!fin(x.mT[k]) || !fin(x.mTd[k])) continue;
      sw += x.a;
      sa += x.a * Math.abs(rhFromTempDew(x.mT[k], Math.min(x.mTd[k], x.mT[k])) - x.obsRh);
      count++;
    }
    const tk = nowMembers?.T[k];
    const dk = nowMembers?.Td[k];
    return {
      id,
      label: MODELS.find((m) => m.id === id)?.label ?? id,
      share: duplicate || shareTotal <= 0 ? 0 : w[k] / shareTotal,
      rhNow: tk !== undefined && dk !== undefined && fin(tk) && fin(dk) ? rhFromTempDew(tk, Math.min(dk, tk)) : null,
      mae: count >= CONFIG.minSamples && sw > 0 ? sa / sw : null,
      duplicate,
    };
  });

  const stations: StationSummary[] = kept.map((st, idx) => {
    const own = st.samples;
    const lastSample = own[own.length - 1];
    const sc = score(
      own.filter((x) => x.hourly).map((x) => ({ ...x, a: 1 })),
      ones,
      null
    );
    return {
      id: st.s.id,
      name: st.s.name,
      lat: st.s.lat,
      lon: st.s.lon,
      distanceKm: st.s.distanceKm,
      elev: st.s.elev,
      dz: st.dz,
      trust: anchorA[idx],
      nObs: own.length,
      last: { t: lastSample.t, temp: lastSample.obsT, dew: lastSample.obsTd, rh: lastSample.obsRh },
      modelBiasRh: sc.n >= 6 ? sc.bias : null,
      modelMaeRh: sc.n >= 6 ? sc.mae : null,
      series: own.filter((x) => x.t >= nowMs - 24 * H - 59 * 60_000).map((x) => ({ t: x.t, rh: x.obsRh })),
    };
  });

  const regimeRows = REGIMES.map((key) => {
    const rs = hourly.filter((x) => x.regime === key);
    let sw = 0;
    let sErr = 0;
    let sCorr = 0;
    for (const x of rs) {
      const e0 = sampleError(x, ones, null);
      if (!e0) continue;
      sw += x.a;
      sErr += x.a * e0.eRh;
      if (bias) {
        const e1 = sampleError(x, w, bias, aMax);
        const eW = sampleError(x, w, null);
        if (e1 && eW) sCorr += x.a * (e1.rh - eW.rh);
      }
    }
    return {
      key,
      label: REGIME_LABELS[key],
      n: rs.length,
      meanErrRh: sw > 0 ? sErr / sw : null,
      corrRh: bias && sw > 0 ? sCorr / sw : null,
    };
  });

  const anchoringActive = tLast !== null && now.anchor >= 0.05;
  const calibration: Calibration = {
    hasStations: S > 0,
    nSamples: hourly.length,
    rawMae: rawScore.n ? rawScore.mae : null,
    rawRmse: rawScore.n ? rawScore.rmse : null,
    rawBias: rawScore.n ? rawScore.bias : null,
    temporal: {
      tested: temporal.tested,
      applied: temporal.applied,
      variant: temporal.variant,
      n: temporal.n,
      before: temporal.before,
      after: temporal.after,
    },
    spatial,
    anchoring: { active: anchoringActive, weightNow: now.anchor, lastObsT: tLast, rho, rhoMeasured },
    regimes: regimeRows,
    sigmaModel,
    sigmaMeasured,
  };

  // ---- Verdict : l'estimation peut-elle être améliorée ici ?
  const halfWidth = CONFIG.z80 * now.sigma;
  const lines: string[] = [];
  let verdict: Verdict;
  if (S === 0) {
    lines.push(stationNote ?? "Aucune station de mesure exploitable à proximité.");
    lines.push(
      M > 1
        ? `L'estimation est le consensus de ${now.nModels} modèles, sans correction : rien ne permet d'en vérifier une ici.`
        : "L'estimation repose sur un seul modèle, sans correction."
    );
    lines.push(
      `Marge d'erreur par défaut de ± ${Math.round(halfWidth)} points : c'est un ordre de grandeur habituel, non mesuré à cet endroit.`
    );
    verdict = { status: "no_reference", title: "Indéterminé : aucune mesure de référence à proximité", lines };
  } else {
    const ref = stations[0];
    if (rawScore.n >= CONFIG.minSamples) {
      lines.push(
        `Sur 48 h, les modèles bruts s'écartent des mesures de ${f1(rawScore.mae)} points en moyenne ` +
          `(biais ${rawScore.bias >= 0 ? "+" : "−"}${f1(Math.abs(rawScore.bias))}).`
      );
    }
    if (anchoringActive) {
      lines.push(
        `Passé et présent : l'écart constaté à la station ${ref.name} (${ref.id}, ${f1(ref.distanceKm)} km) est retiré au point choisi, ` +
          `avec un poids actuel de ${Math.round(now.anchor * 100)} %.`
      );
    }
    if (spatial.tested) {
      lines.push(
        `Contrôle croisé : en prédisant chaque station à partir des autres, l'erreur passe de ${f1(spatial.before)} ` +
          `à ${f1(spatial.after)} points` +
          (spatial.ok
            ? spatial.verified
              ? " — le transfert vers un point voisin est vérifié."
              : " — gain trop faible pour conclure."
            : ` — le transfert dégrade l'estimation, il est limité aux stations à moins de ${CONFIG.blockedRadiusKm} km.`)
      );
    } else {
      lines.push(
        "Le transfert des mesures vers votre point n'a pas pu être vérifié (une seule station, ou stations trop " +
          "éloignées entre elles) : il repose sur une hypothèse de proximité."
      );
    }
    if (temporal.tested) {
      lines.push(
        temporal.applied
          ? `Prévisions : la correction apprise sur J-2 réduit l'erreur de J-1 de ${f1(temporal.before)} à ` +
              `${f1(temporal.after)} points — elle est appliquée.`
          : `Prévisions : la correction par situation météo a été testée sans gain suffisant (${f1(temporal.before)} → ` +
              `${f1(temporal.after)} points) — les prévisions gardent le consensus des modèles.`
      );
    } else {
      lines.push("Prévisions : historique de mesures insuffisant pour tester une correction, aucune n'est appliquée.");
    }
    const verified = temporal.applied || (anchoringActive && spatial.tested && spatial.verified);
    verdict = verified
      ? { status: "improved", title: "Oui : l'estimation est recalée sur des mesures réelles, gain vérifié", lines }
      : anchoringActive
        ? {
            status: "assumed",
            title: "Oui, a priori : estimation recalée sur une mesure proche, gain non vérifiable ici",
            lines,
          }
        : { status: "not_improved", title: "Non : aucune correction n'apporte de gain mesurable ici", lines };
  }

  const level = halfWidth <= 6 ? "high" : halfWidth <= 10 ? "medium" : "low";
  const label = level === "high" ? "Élevée" : level === "medium" ? "Moyenne" : "Limitée";

  return {
    computedAt: nowMs,
    hours,
    now,
    past24,
    next72,
    members,
    missing: point.missing,
    stations,
    terrain: terrainSummary,
    calibration,
    verdict,
    confidence: { level, label, halfWidth },
    tuned: !isDefaultTune(tune),
    stats: { past24: statsOf(past24), next72: statsOf(next72) },
  };
}

// ---------------------------------------------------------------- affichage

export function humidityLabel(rh: number): string {
  if (rh < 30) return "Air très sec";
  if (rh < 45) return "Air sec";
  if (rh < 65) return "Humidité modérée";
  if (rh < 80) return "Air humide";
  if (rh < 93) return "Air très humide";
  return "Proche de la saturation";
}

export function rhColor(rh: number): string {
  if (rh < 30) return "#f59e0b";
  if (rh < 45) return "#eab308";
  if (rh < 65) return "#10b981";
  if (rh < 80) return "#0ea5e9";
  if (rh < 93) return "#3b82f6";
  return "#6366f1";
}
