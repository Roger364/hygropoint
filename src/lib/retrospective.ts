// Compare, sur plusieurs jours, l'humidité anticipée par les modèles et celle
// réellement mesurée, regroupée par situation météo. Une correction n'est proposée
// que si, apprise sur les jours anciens, elle réduit l'erreur des dernières 24 h.

import type { LearnedBias, Regime } from "./estimate";
import { REGIME_LABELS } from "./estimate";
import { describeError, isAbort } from "./http";
import { fetchStationLookback, type ModelData } from "./openmeteo";
import { rhFromTempDew } from "./physics";
import { fetchObservations, type Station } from "./stations";

const H = 3.6e6;
const LOOKBACK_H = 7 * 24;
const HOLDOUT_H = 24;

export interface RegimeGroup {
  key: Regime;
  label: string;
  n: number;
  anticipated: number;
  observed: number;
  /** Anticipé − mesuré, en points. Négatif : les modèles sont trop secs. */
  bias: number;
}

export interface Retrospective {
  stations: string[];
  hours: number;
  groups: RegimeGroup[];
  /** Erreur absolue moyenne sur les dernières 24 h, avant / après correction. */
  holdout: { n: number; before: number; after: number } | null;
  learned: LearnedBias | null;
  applied: boolean;
  summary: string;
}

function regimeOf(precip: number, wind: number, cloud: number, isDay: boolean): Regime {
  if (Number.isFinite(precip) && precip >= 0.1) return "rain";
  const w = Number.isFinite(wind) ? wind : 15;
  const c = Number.isFinite(cloud) ? cloud : 60;
  if (w >= 25) return "windy";
  if (!isDay && w < 10 && c < 50) return "night_calm";
  if (isDay && c < 50) return "day_sunny";
  return "other";
}

function atHour(model: ModelData, t: number): { rh: number; regime: Regime } | null {
  let best = -1;
  let dist = 35 * 60_000;
  for (let i = 0; i < model.times.length; i++) {
    const d = Math.abs(model.times[i] - t);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  if (best < 0) return null;
  const temps: number[] = [];
  const dews: number[] = [];
  for (const m of model.members) {
    const T = m.temp[best];
    const D = m.dew[best];
    if (Number.isFinite(T) && Number.isFinite(D)) {
      temps.push(T);
      dews.push(Math.min(D, T));
    }
  }
  if (!temps.length) return null;
  const T = temps.reduce((a, b) => a + b, 0) / temps.length;
  const D = dews.reduce((a, b) => a + b, 0) / dews.length;
  const precip = model.ctx.precipitation?.[best] ?? 0;
  const wind = model.ctx.wind_speed_10m?.[best] ?? 10;
  const cloud = model.ctx.cloud_cover?.[best] ?? 50;
  const isDay = (model.ctx.is_day?.[best] ?? 1) >= 0.5;
  return { rh: rhFromTempDew(T, D), regime: regimeOf(precip, wind, cloud, isDay) };
}

interface Pair {
  regime: Regime;
  anticipated: number;
  observed: number;
  recent: boolean;
}

export async function runRetrospective(
  stations: Station[],
  signal?: AbortSignal
): Promise<Retrospective> {
  const picked = stations.slice(0, 3);
  if (!picked.length) {
    return {
      stations: [],
      hours: 0,
      groups: [],
      holdout: null,
      learned: null,
      applied: false,
      summary: "Aucune station de mesure à proximité : rien à comparer.",
    };
  }
  try {
    const [obs, models] = await Promise.all([
      fetchObservations(picked.map((s) => s.id), LOOKBACK_H, signal),
      Promise.all(picked.map((s) => fetchStationLookback(s.lat, s.lon, { signal }))),
    ]);
    if (signal?.aborted) throw new Error("annulé");
    const now = Date.now();
    const pairs: Pair[] = [];
    picked.forEach((s, i) => {
      const model = models[i];
      for (const o of obs.get(s.id) ?? []) {
        if (o.t > now - 20 * 60_000) continue;
        const hit = atHour(model, o.t);
        if (!hit) continue;
        const observed = rhFromTempDew(o.temp, o.dew);
        if (Math.abs(hit.rh - observed) > 40) continue;
        pairs.push({
          regime: hit.regime,
          anticipated: hit.rh,
          observed,
          recent: o.t >= now - HOLDOUT_H * H,
        });
      }
    });
    return summarise(picked.map((s) => s.name), pairs, trustOf(picked));
  } catch (e) {
    if (isAbort(e)) throw e;
    return {
      stations: picked.map((s) => s.name),
      hours: 0,
      groups: [],
      holdout: null,
      learned: null,
      applied: false,
      summary: describeError(e, "La comparaison aux mesures passées"),
    };
  }
}

function trustOf(stations: Station[]): number {
  if (!stations.length) return 0;
  const nearest = Math.min(...stations.map((s) => s.distanceKm));
  return Math.exp(-((nearest / 35) ** 2));
}

function summarise(names: string[], pairs: Pair[], weight: number): Retrospective {
  const keys: Regime[] = ["rain", "windy", "night_calm", "day_sunny", "other"];
  const groups: RegimeGroup[] = [];
  const trainBias: Partial<Record<Regime, number>> = {};
  for (const key of keys) {
    const all = pairs.filter((p) => p.regime === key);
    const train = all.filter((p) => !p.recent);
    if (all.length < 4) continue;
    const mean = (xs: Pair[], pick: (p: Pair) => number) => xs.reduce((a, p) => a + pick(p), 0) / xs.length;
    const bias = train.length >= 6 ? mean(train, (p) => p.anticipated - p.observed) : mean(all, (p) => p.anticipated - p.observed);
    const shrunk = (bias * train.length) / (train.length + 8);
    if (train.length >= 6 && Math.abs(shrunk) >= 0.4) trainBias[key] = -shrunk;
    groups.push({
      key,
      label: REGIME_LABELS[key],
      n: all.length,
      anticipated: mean(all, (p) => p.anticipated),
      observed: mean(all, (p) => p.observed),
      bias,
    });
  }
  groups.sort((a, b) => b.n - a.n);

  const test = pairs.filter((p) => p.recent);
  let holdout: Retrospective["holdout"] = null;
  let applied = false;
  if (test.length >= 8 && Object.keys(trainBias).length) {
    const before = test.reduce((a, p) => a + Math.abs(p.anticipated - p.observed), 0) / test.length;
    const after = test.reduce((a, p) => a + Math.abs(p.anticipated + (trainBias[p.regime] ?? 0) - p.observed), 0) / test.length;
    holdout = { n: test.length, before, after };
    applied = before - after >= 0.4;
  }
  const learned: LearnedBias | null = applied ? { byRegime: trainBias, weight: Math.min(1, weight) } : null;
  const summary = !pairs.length
    ? "Pas assez de mesures exploitables sur les 7 derniers jours."
    : applied && holdout
      ? `Correction retenue : elle réduit l'erreur des dernières 24 h de ${holdout.before.toFixed(1)} à ${holdout.after.toFixed(1)} points.`
      : holdout
        ? `Comparaison faite, mais la correction n'améliore pas les dernières 24 h (${holdout.before.toFixed(1)} → ${holdout.after.toFixed(1)}). Estimation inchangée.`
        : "Historique trop court pour valider une correction hors de la période d'apprentissage.";
  return { stations: names, hours: pairs.length, groups, holdout, learned, applied, summary };
}
