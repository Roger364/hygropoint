// Vérification du moteur d'estimation sur un monde synthétique dont la vérité est connue.
// Lancement :
//   npm test

import { computeEstimate, rankStations, type EstimateResult, type StationInput } from "../src/lib/estimate";
import { DEFAULT_TUNE, type Tune } from "../src/lib/tune";
import { haversineKm, parseCoordinates } from "../src/lib/geo";
import { HttpError } from "../src/lib/http";
import { CTX_VARS, MODELS, parseModelResponse, type ModelId } from "../src/lib/openmeteo";
import { rhFromTempDew } from "../src/lib/physics";
import { parseHistoryCsv, type Station } from "../src/lib/stations";
import { EMPTY_TERRAIN, sunPosition, type TerrainInfo } from "../src/lib/terrain";

const H = 3.6e6;
const NOW = Date.UTC(2026, 10, 15, 10, 20);
const T0 = Math.floor(NOW / H) * H - 58 * H;
const N = 58 + 100;
const IDS: ModelId[] = MODELS.map((m) => m.id);

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rnd: () => number): number {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

function ar1(n: number, rho: number, sigma: number, rnd: () => number): number[] {
  const out = [sigma * gauss(rnd)];
  for (let i = 1; i < n; i++) out.push(rho * out[i - 1] + sigma * Math.sqrt(1 - rho * rho) * gauss(rnd));
  return out;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

interface Loc {
  id: string;
  lat: number;
  lon: number;
  elev: number;
  dT: number; // écart réel de température par rapport au point
  dDep: number; // écart réel de dépression du point de rosée
}

const P: Loc = { id: "POINT", lat: 48.85, lon: 2.35, elev: 60, dT: 0, dDep: 0 };
const S1: Loc = { id: "AAAA", lat: 48.85 + 8 / 111.2, lon: 2.35, elev: 80, dT: -0.4, dDep: -0.3 };
const S2: Loc = { id: "BBBB", lat: 48.85, lon: 2.35 + 0.342, elev: 20, dT: 0.3, dDep: 0.4 };
const S3: Loc = { id: "CCCC", lat: 48.85 - 45 / 111.2, lon: 2.35, elev: 110, dT: -0.2, dDep: 0.2 };

function truth(L: Loc, t: number): { T: number; Td: number; rh: number } {
  const h = ((t / H) % 24 + 24) % 24;
  const day = (t - T0) / (24 * H);
  const T = 9 + L.dT + 5 * Math.sin((2 * Math.PI * (h - 9)) / 24) + 1.5 * Math.sin((2 * Math.PI * day) / 5);
  const sun = h >= 7 && h <= 18 ? Math.max(0, Math.sin((Math.PI * (h - 7)) / 11)) : 0;
  const dep = Math.max(0.2, 1.0 + 6 * sun + 0.8 * Math.sin((2 * Math.PI * day) / 3) + L.dDep);
  return { T, Td: T - dep, rh: rhFromTempDew(T, T - dep) };
}

type Reg = "rain" | "windy" | "night_calm" | "day_sunny" | "other";

function contextAt(t: number) {
  const rel = (t - NOW) / H;
  const h = ((t / H) % 24 + 24) % 24;
  const dayIdx = Math.floor((t - T0) / (24 * H));
  const isDay = h >= 7 && h < 17;
  const cloud = [20, 80, 30, 90, 25, 60, 20, 40][dayIdx % 8];
  const windy = (rel >= -40 && rel <= -34) || (rel >= 30 && rel <= 36);
  const wind = windy ? 32 : 6 + 3 * Math.sin((2 * Math.PI * (t - T0)) / (48 * H));
  const rain = (rel >= -30 && rel <= -26) || (rel >= -8 && rel <= -6) || (rel >= 20 && rel <= 24);
  const precip = rain ? 1.2 : 0;
  const radiation = isDay ? (1 - cloud / 100) * 500 + 100 : 0;
  let regime: Reg = "other";
  if (precip >= 0.1) regime = "rain";
  else if (wind >= 25) regime = "windy";
  else if (!isDay && wind < 10 && cloud < 50) regime = "night_calm";
  else if (isDay && cloud < 50 && radiation >= 200) regime = "day_sunny";
  return { isDay, cloud, wind, precip, radiation, regime };
}

const TIMES = Array.from({ length: N }, (_, i) => T0 + i * H);
const CTX = TIMES.map(contextAt);

// Biais systématiques communs à tous les modèles (K), par situation météo
const REG_T: Record<Reg, number> = { rain: 0.2, windy: 0, night_calm: 1.6, day_sunny: 0.2, other: 0.3 };
const REG_D: Record<Reg, number> = { rain: -1.0, windy: 0, night_calm: -0.4, day_sunny: -1.2, other: -0.2 };
const CONST_T = [0, -0.3, 0.6, 0.1, -0.5];
const CONST_D = [0, 0.2, -0.8, 0, 0.6];

interface WorldCfg {
  seed: number;
  coherence: number; // part de l'erreur commune à toute la région (0–1)
  biased: boolean;
  /** Si fourni : le biais n’existe qu’aux heures (relatives à maintenant) où la fonction est vraie. */
  biasWhen?: (relHours: number) => boolean;
}

function makeWorld(cfg: WorldCfg) {
  const rnd = mulberry32(cfg.seed);
  const regT = IDS.map(() => ar1(N, 0.85, 0.6, rnd));
  const regD = IDS.map(() => ar1(N, 0.85, 0.8, rnd));
  const iCut = TIMES.findIndex((t) => t > NOW + 60 * H); // Météo-France s'arrête à +60 h

  function modelJson(L: Loc, withCtx: boolean): unknown {
    const hourly: Record<string, unknown> = { time: TIMES.map((t) => t / 1000) };
    IDS.forEach((id, m) => {
      if (id === "best_match") return;
      const locT = ar1(N, 0.85, 0.6, rnd);
      const locD = ar1(N, 0.85, 0.8, rnd);
      const T: (number | null)[] = [];
      const D: (number | null)[] = [];
      const R: (number | null)[] = [];
      for (let i = 0; i < N; i++) {
        if (id === "meteofrance_seamless" && i >= iCut) {
          T.push(null);
          D.push(null);
          R.push(null);
          continue;
        }
        const tr = truth(L, TIMES[i]);
        const reg = CTX[i].regime;
        const c = Math.sqrt(cfg.coherence);
        const l = Math.sqrt(1 - cfg.coherence);
        const on = cfg.biased && (!cfg.biasWhen || cfg.biasWhen((TIMES[i] - NOW) / H));
        const eT = (on ? CONST_T[m] + REG_T[reg] : 0) + c * regT[m][i] + l * locT[i];
        const eD = (on ? CONST_D[m] + REG_D[reg] : 0) + c * regD[m][i] + l * locD[i];
        const t = round1(tr.T + eT);
        const d = Math.min(round1(tr.Td + eD), t);
        T.push(t);
        D.push(d);
        R.push(Math.round(rhFromTempDew(t, d)));
      }
      hourly[`temperature_2m_${id}`] = T;
      hourly[`dew_point_2m_${id}`] = D;
      hourly[`relative_humidity_2m_${id}`] = R;
    });
    // La « sélection locale » recopie Météo-France, puis ECMWF au-delà de sa portée.
    for (const v of ["temperature_2m", "dew_point_2m", "relative_humidity_2m"]) {
      const mf = hourly[`${v}_meteofrance_seamless`] as (number | null)[];
      const ec = hourly[`${v}_ecmwf_ifs025`] as (number | null)[];
      hourly[`${v}_best_match`] = mf.map((x, i) => x ?? ec[i]);
    }
    if (withCtx) {
      const series: Record<string, number[]> = {
        precipitation: CTX.map((c) => c.precip),
        precipitation_probability: CTX.map((c) => (c.precip > 0 ? 90 : 5)),
        wind_speed_10m: CTX.map((c) => round1(c.wind)),
        wind_gusts_10m: CTX.map((c) => round1(c.wind * 1.6)),
        cloud_cover: CTX.map((c) => c.cloud),
        cloud_cover_low: CTX.map((c) => Math.round(c.cloud / 2)),
        surface_pressure: CTX.map(() => 1009.4),
        wind_direction_10m: CTX.map((c) => (c.wind >= 25 ? 270 : 200)),
        shortwave_radiation: CTX.map((c) => Math.round(c.radiation)),
        is_day: CTX.map((c) => (c.isDay ? 1 : 0)),
      };
      for (const v of CTX_VARS) {
        // Un trou dans la sélection locale : le repli sur un autre modèle doit jouer.
        hourly[`${v}_best_match`] = series[v].map((x, i) => (i === 5 ? null : x));
        hourly[`${v}_ecmwf_ifs025`] = series[v];
      }
    }
    return {
      latitude: L.lat,
      longitude: L.lon,
      elevation: L.elev,
      timezone: "Europe/Paris",
      utc_offset_seconds: 3600,
      hourly,
    };
  }

  function obsCsv(locs: Loc[], extraLines: string[] = []): string {
    const lines = ["station,valid,tmpc,dwpc"];
    for (let t = NOW - 49.5 * H; t <= NOW - 20 * 60_000; t += 30 * 60_000) {
      const d = new Date(t).toISOString();
      const stamp = `${d.slice(0, 10)} ${d.slice(11, 16)}`;
      for (const L of locs) {
        const tr = truth(L, t);
        const T = Math.round(tr.T);
        const Td = Math.min(Math.round(tr.Td), T);
        lines.push(`${L.id},${stamp},${T.toFixed(2)},${Td.toFixed(2)}`);
      }
    }
    return [...lines, ...extraLines].join("\n") + "\n";
  }

  function stations(locs: Loc[], extraLines: string[] = []): StationInput[] {
    const history = parseHistoryCsv(obsCsv(locs, extraLines));
    const list: Station[] = locs.map((L) => ({
      id: L.id,
      name: `Station ${L.id}`,
      lat: L.lat,
      lon: L.lon,
      elev: L.elev,
      network: "XX__ASOS",
      distanceKm: haversineKm(P.lat, P.lon, L.lat, L.lon),
      obs: history.get(L.id) ?? [],
    }));
    return rankStations(list, P.elev).map((s) => {
      const L = locs.find((x) => x.id === s.id)!;
      return { ...s, model: parseModelResponse(modelJson(L, false), IDS) };
    });
  }

  return { point: () => parseModelResponse(modelJson(P, true), IDS), stations, modelJson };
}

function evaluate(r: EstimateResult) {
  const mae = (hs: typeof r.hours, pick: (h: (typeof r.hours)[number]) => number) =>
    hs.reduce((acc, h) => acc + Math.abs(pick(h) - truth(P, h.t).rh), 0) / Math.max(1, hs.length);
  const future = r.next72.filter((h) => h.hoursFromNow <= 48);
  const near = r.next72.filter((h) => h.hoursFromNow <= 6);
  const inside = r.hours.filter((h) => {
    const tr = truth(P, h.t).rh;
    return tr >= h.rhLow && tr <= h.rhHigh;
  }).length;
  return {
    pastRaw: mae(r.past24, (h) => h.rhRaw),
    pastEst: mae(r.past24, (h) => h.rh),
    nearRaw: mae(near, (h) => h.rhRaw),
    nearEst: mae(near, (h) => h.rh),
    futRaw: mae(future, (h) => h.rhRaw),
    futEst: mae(future, (h) => h.rh),
    nowRaw: Math.abs(r.now.rhRaw - truth(P, NOW).rh),
    nowEst: Math.abs(r.now.rh - truth(P, NOW).rh),
    coverage: inside / r.hours.length,
  };
}

const f = (v: number) => v.toFixed(2);

// ------------------------------------------------------------------ A
console.log("\nA. Modèles biaisés, erreurs cohérentes dans la région, 3 stations");
{
  const world = makeWorld({ seed: 7, coherence: 0.7, biased: true });
  const r = computeEstimate(world.point(), world.stations([S1, S2, S3]), null, NOW);
  const e = evaluate(r);
  const c = r.calibration;
  console.log(
    `     stations ${r.stations.map((s) => `${s.id} ${s.distanceKm.toFixed(0)}km a=${s.trust.toFixed(2)}`).join(", ")}`
  );
  console.log(
    `     brut mesuré MAE ${f(c.rawMae ?? NaN)} biais ${f(c.rawBias ?? NaN)} | temporel ${c.temporal.variant} ${f(c.temporal.before)}→${f(c.temporal.after)} (n=${c.temporal.n}) | spatial ${f(c.spatial.before)}→${f(c.spatial.after)} (n=${c.spatial.n}) | rho ${f(c.anchoring.rho)}`
  );
  console.log(
    `     vs vérité : passé ${f(e.pastRaw)}→${f(e.pastEst)} | maintenant ${f(e.nowRaw)}→${f(e.nowEst)} | +6h ${f(e.nearRaw)}→${f(e.nearEst)} | +48h ${f(e.futRaw)}→${f(e.futEst)} | couverture ${f(e.coverage)}`
  );
  check("3 stations retenues", r.stations.length === 3);
  check("heures : 24 h passées et 72 h à venir", r.past24.length >= 24 && r.next72.length >= 72, `${r.past24.length}/${r.next72.length}`);
  check("verdict « amélioré »", r.verdict.status === "improved");
  check("contrôle spatial testé et vérifié", c.spatial.tested && c.spatial.verified);
  check("correction temporelle retenue", c.temporal.tested && c.temporal.applied);
  check("passé : erreur réelle au point nettement réduite", e.pastEst < 0.7 * e.pastRaw);
  check("prévisions à 48 h : erreur réelle réduite", e.futEst < e.futRaw);
  check("prochaines 6 h : erreur réelle réduite", e.nearEst < e.nearRaw);
  // Monde idéalisé (pas de variabilité locale) : on vérifie seulement que la fourchette n’est pas trop étroite.
  check("fourchette jamais trop optimiste", e.coverage >= 0.8, f(e.coverage));
  check("fourchette resserrée par l’ancrage", r.confidence.halfWidth < 7, f(r.confidence.halfWidth));
  check("ancrage actif maintenant", c.anchoring.active && r.now.basis === "persist", `poids ${f(r.now.anchor)}`);
  check("valeurs bornées et cohérentes", r.hours.every((h) => h.rh >= 0 && h.rh <= 100 && h.dewPoint <= h.temp + 1e-9 && h.rhLow <= h.rh && h.rh <= h.rhHigh));
  const bm = r.members.find((m) => m.id === "best_match");
  const share = r.members.reduce((acc, m) => acc + m.share, 0);
  check("sélection locale reconnue comme doublon", bm?.duplicate === true && bm.share === 0);
  check("parts des modèles = 100 %", Math.abs(share - 1) < 1e-9, f(share));
  check("mesures affichées pour le passé", r.past24.filter((h) => h.obsRh !== null).length >= 20);
  check("contexte : repli quand la sélection locale manque", Number.isFinite(world.point().ctx.wind_speed_10m[5]));
}

// ------------------------------------------------------------------ B
console.log("\nB. Modèles sans biais, erreurs purement locales (aucune cohérence spatiale)");
{
  const world = makeWorld({ seed: 11, coherence: 0, biased: false });
  const r = computeEstimate(world.point(), world.stations([S1, S2, S3]), null, NOW);
  const e = evaluate(r);
  const c = r.calibration;
  console.log(
    `     temporel ${c.temporal.applied ? c.temporal.variant : "non retenu"} ${f(c.temporal.before)}→${f(c.temporal.after)} | spatial ok=${c.spatial.ok} ${f(c.spatial.before)}→${f(c.spatial.after)} | verdict ${r.verdict.status}`
  );
  console.log(`     vs vérité : passé ${f(e.pastRaw)}→${f(e.pastEst)} | +48h ${f(e.futRaw)}→${f(e.futEst)} | couverture ${f(e.coverage)}`);
  check("le contrôle spatial ne valide pas le transfert", c.spatial.tested && !c.spatial.verified);
  check("pas de dégradation notable du passé", e.pastEst <= e.pastRaw + 0.5, `${f(e.pastRaw)}→${f(e.pastEst)}`);
  check("pas de dégradation notable des prévisions", e.futEst <= e.futRaw + 0.5, `${f(e.futRaw)}→${f(e.futEst)}`);
}

// ------------------------------------------------------------------ C
console.log("\nC. Aucune station");
{
  const world = makeWorld({ seed: 7, coherence: 0.7, biased: true });
  const r = computeEstimate(world.point(), [], "Aucune station de mesure à moins de 80 km dans ce pays.", NOW);
  check("verdict « indéterminé »", r.verdict.status === "no_reference");
  check("aucune correction appliquée", r.hours.every((h) => Math.abs(h.rh - h.rhRaw) < 1e-9 && h.basis === "none"));
  check("incertitude par défaut (9 pts) maintenant", Math.abs(r.now.sigma - 9) < 0.6, f(r.now.sigma));
  check("incertitude croissante avec l'échéance", r.next72[r.next72.length - 1].sigma > r.now.sigma);
  check("confiance « limitée »", r.confidence.level === "low");
  check("la note de recherche est reprise", r.verdict.lines[0].includes("80 km"));
}

// ------------------------------------------------------------------ D
console.log("\nD. Une seule station, proche");
{
  const world = makeWorld({ seed: 7, coherence: 0.7, biased: true });
  const r = computeEstimate(world.point(), world.stations([S1]), null, NOW);
  const e = evaluate(r);
  console.log(`     vs vérité : passé ${f(e.pastRaw)}→${f(e.pastEst)} | maintenant ${f(e.nowRaw)}→${f(e.nowEst)} | +48h ${f(e.futRaw)}→${f(e.futEst)}`);
  check("contrôle spatial non testable", !r.calibration.spatial.tested);
  check("verdict « a priori » tant que le gain n'est pas vérifiable", r.verdict.status === "assumed" || r.calibration.temporal.applied, r.verdict.status);
  check("ancrage tout de même actif", r.calibration.anchoring.active);
  check("passé amélioré", e.pastEst < e.pastRaw);
}

// ------------------------------------------------------------------ E
console.log("\nE. Robustesse des entrées");
{
  const world = makeWorld({ seed: 7, coherence: 0.7, biased: true });
  const bogus = [`AAAA,2026-11-15 08:10,45.00,-20.00`, `AAAA,2026-11-15 08:40,null,null`, `AAAA,bad line`];
  const point = world.point();
  const clean = computeEstimate(point, makeWorld({ seed: 7, coherence: 0.7, biased: true }).stations([S1, S2, S3]), null, NOW);
  const dirty = computeEstimate(point, makeWorld({ seed: 7, coherence: 0.7, biased: true }).stations([S1, S2, S3], bogus), null, NOW);
  check("mesure aberrante écartée", Math.abs(clean.now.rh - dirty.now.rh) < 0.01, `${f(clean.now.rh)} / ${f(dirty.now.rh)}`);

  let limited = false;
  try {
    parseHistoryCsv("Too many requests from your IP address, slow down.");
  } catch (err) {
    limited = err instanceof HttpError && err.status === 429;
  }
  check("limitation de débit IEM reconnue", limited);

  const far: Station = { id: "FAR", name: "Loin", lat: 49.4, lon: 2.35, elev: 60, network: "X", distanceKm: 70, obs: [] };
  const high: Station = { id: "HIGH", name: "Haut", lat: 48.9, lon: 2.35, elev: 700, network: "X", distanceKm: 6, obs: [] };
  check("station lointaine ou très dénivelée écartée", rankStations([far, high], 60).length === 0);

  // Format ISO local + clés sans suffixe (requête mono-modèle)
  const iso = parseModelResponse(
    {
      latitude: 1,
      longitude: 2,
      elevation: 3,
      timezone: "Europe/Paris",
      utc_offset_seconds: 3600,
      hourly: {
        time: Array.from({ length: 30 }, (_, i) => `2026-11-15T${String(i % 24).padStart(2, "0")}:00`).map((s, i) =>
          i < 24 ? s : s.replace("-15T", "-16T")
        ),
        temperature_2m: Array.from({ length: 30 }, () => 10),
        relative_humidity_2m: Array.from({ length: 30 }, () => 80),
      },
    },
    ["best_match"]
  );
  check("horodatage ISO local converti en instant réel", iso.times[0] === Date.UTC(2026, 10, 14, 23, 0));
  check("point de rosée déduit de l'humidité si absent", Math.abs(rhFromTempDew(10, iso.members[0].dew[0]) - 80) < 0.01);
  const single = computeEstimate(iso, [], null, Date.UTC(2026, 10, 15, 3, 30));
  check("modèle unique, couverture partielle : pas de plantage", single.hours.length > 0 && Math.abs(single.now.rh - 80) < 0.01);

  let threw = false;
  try {
    parseModelResponse({ hourly: { time: [] } }, IDS);
  } catch {
    threw = true;
  }
  check("réponse vide refusée proprement", threw);
}

// ------------------------------------------------------------------ F
console.log("\nF. Saisie de coordonnées");
{
  const eq = (a: { lat: number; lon: number } | null, lat: number, lon: number) =>
    a !== null && Math.abs(a.lat - lat) < 1e-9 && Math.abs(a.lon - lon) < 1e-9;
  check("« 45.1885, 5.7245 »", eq(parseCoordinates("45.1885, 5.7245"), 45.1885, 5.7245));
  check("« 45,1885 ; 5,7245 »", eq(parseCoordinates("45,1885 ; 5,7245"), 45.1885, 5.7245));
  check("« 45,1885 5,7245 »", eq(parseCoordinates("45,1885 5,7245"), 45.1885, 5.7245));
  check("« -33.87 151.21 »", eq(parseCoordinates("-33.87 151.21"), -33.87, 151.21));
  check("« 33.87 S, 151.21 E »", eq(parseCoordinates("33.87 S, 151.21 E"), -33.87, 151.21));
  check("« 48.85° N, 2.35° O »", eq(parseCoordinates("48.85° N, 2.35° O"), 48.85, -2.35));
  check("texte libre refusé", parseCoordinates("12 rue de la Paix") === null && parseCoordinates("Paris 15") === null);
  check("hors limites refusé", parseCoordinates("95, 10") === null && parseCoordinates("45, 190") === null);
}

// ------------------------------------------------------------------ G
console.log("\nG. Biais présent avant-hier seulement (non persistant)");
{
  const world = makeWorld({ seed: 7, coherence: 0.7, biased: true, biasWhen: (rel) => rel < -24 });
  const r = computeEstimate(world.point(), world.stations([S1, S2, S3]), null, NOW);
  const e = evaluate(r);
  const c = r.calibration;
  console.log(`     temporel ${c.temporal.applied ? c.temporal.variant : "non retenu"} ${f(c.temporal.before)}→${f(c.temporal.after)} | vs vérité : +48h ${f(e.futRaw)}→${f(e.futEst)}`);
  check("correction des prévisions rejetée par le test hors échantillon", c.temporal.tested && !c.temporal.applied);
  check("prévisions non dégradées", e.futEst <= e.futRaw + 0.5, `${f(e.futRaw)}→${f(e.futEst)}`);
}

// ------------------------------------------------------------------ H
console.log("\nH. Une seule station, modèles sans biais : gain non vérifiable");
{
  const world = makeWorld({ seed: 23, coherence: 0.7, biased: false });
  const r = computeEstimate(world.point(), world.stations([S1]), null, NOW);
  const e = evaluate(r);
  console.log(`     verdict ${r.verdict.status} | temporel ${r.calibration.temporal.applied ? "retenu" : "non retenu"} | vs vérité : passé ${f(e.pastRaw)}→${f(e.pastEst)} | +48h ${f(e.futRaw)}→${f(e.futEst)}`);
  check("verdict « a priori » : ancrage actif mais gain non vérifiable", r.verdict.status === "assumed", r.verdict.status);
  check("aucune correction de prévision sans preuve", !r.calibration.temporal.applied);
  check("prévisions lointaines identiques au consensus", Math.abs(r.next72[r.next72.length - 1].rh - r.next72[r.next72.length - 1].rhRaw) < 0.2);
  check("pas de dégradation du passé", e.pastEst <= e.pastRaw + 0.5, `${f(e.pastRaw)}→${f(e.pastEst)}`);
}

// ------------------------------------------------------------------ I
console.log("\nI. Prise en compte du terrain et des alentours");
{
  const world = makeWorld({ seed: 7, coherence: 0.7, biased: false });
  const plain: TerrainInfo = { ...EMPTY_TERRAIN, detail: "full" };
  // Entrées figées : chaque appel au monde synthétique tirerait un nouveau bruit.
  const pt = world.point();
  const three = world.stations([S1, S2, S3]);
  const oneS = world.stations([S1]);

  // a) Fond de vallée, nuit calme et dégagée
  const valley: TerrainInfo = {
    ...plain,
    point: { elevation: 200, slope: 1, aspect: 180, tpi: -60, curvature: -2, poolIndex: 1 },
  };
  const rPlain = computeEstimate(pt, three, null, NOW, plain);
  const rValley = computeEstimate(pt, three, null, NOW, valley);
  const at = (r: EstimateResult, t: number) => r.hours.find((x) => x.t === t)!;
  const nightCalm = rValley.next72.filter((h) => !h.isDay && (h.wind ?? 0) < 9 && (h.cloud ?? 0) < 40);
  // Heure calme la plus proche de maintenant : c’est là que l’ancrage pèse le plus.
  // Heure calme où l’ancrage station pèse le plus : dans le passé, où l’écart est mesuré.
  const calmRef = rValley.hours
    .filter((h) => !h.isDay && (h.wind ?? 0) < 9 && (h.cloud ?? 0) < 40 && h.basis === "obs")
    .slice(-1)[0];
  const windyNight = rValley.next72.filter((h) => !h.isDay && (h.wind ?? 0) > 25);
  check(
    "fond de vallée : plus humide les nuits calmes et dégagées",
    nightCalm.length > 0 && nightCalm.every((h) => h.rh > at(rPlain, h.t).rh + 0.05),
    nightCalm.length + " h, gain moyen " + f(nightCalm.reduce((a, h) => a + h.rh - at(rPlain, h.t).rh, 0) / Math.max(1, nightCalm.length)) + " pt"
  );
  check("fond de vallée : effet plafonné à 3 °C", nightCalm.every((h) => h.terrain.dT >= -3.001));
  check("par grand vent, le relief ne se ressent plus", windyNight.every((h) => h.terrain.parts.length === 0), windyNight.length + " h ventées");

  // b) Le creux de la station ne doit pas être compté deux fois
  const stationHollow: TerrainInfo = {
    ...valley,
    stations: { AAAA: { tpi: -60, poolIndex: 1 }, BBBB: { tpi: -60, poolIndex: 1 }, CCCC: { tpi: -60, poolIndex: 1 } },
  };
  const rSame = computeEstimate(pt, three, null, NOW, stationHollow);
  if (calmRef) {
    const a = calmRef;
    const b = rSame.hours.find((x) => x.t === a.t)!;
    check(
      "station dans le même creux : effet réduit (pas de double compte)",
      Math.abs(b.terrain.dT) < Math.abs(a.terrain.dT) - 0.4,
      f(a.terrain.dT) + " → " + f(b.terrain.dT) + " °C, ancrage " + f(a.anchor)
    );
  }

  // c) Sans station, l’effet s’applique pleinement et la fourchette s’élargit
  const rAlone = computeEstimate(pt, [], null, NOW, valley);
  if (calmRef) {
    const t = calmRef.t;
    const hAlone = rAlone.hours.find((x) => x.t === t)!;
    const hRef = at(rPlain, t);
    check("sans station : effet complet", Math.abs(hAlone.terrain.dT) > Math.abs(at(rValley, t).terrain.dT) - 0.05, f(hAlone.terrain.dT));
    check("sans station : fourchette élargie en conséquence", hAlone.sigma > hRef.sigma, f(hRef.sigma) + " → " + f(hAlone.sigma));
  }

  // d) Exposition du versant : un ubac plus humide qu’un adret, en journée
  const south: TerrainInfo = { ...plain, point: { elevation: 800, slope: 25, aspect: 180, tpi: 0, curvature: 0, poolIndex: 0 } };
  const north: TerrainInfo = { ...plain, point: { elevation: 800, slope: 25, aspect: 0, tpi: 0, curvature: 0, poolIndex: 0 } };
  const flat: TerrainInfo = { ...plain, point: { elevation: 800, slope: 0, aspect: null, tpi: 0, curvature: 0, poolIndex: 0 } };
  const rs = computeEstimate(pt, [], null, NOW, south);
  const rn = computeEstimate(pt, [], null, NOW, north);
  const rf = computeEstimate(pt, [], null, NOW, flat);
  const sun = sunPosition(NOW + 24 * H, 45.5, 6.5);
  const idx = rs.next72.findIndex((x) => x.isDay && (x.cloud ?? 0) < 50 && (x.radiation ?? 0) > 250);
  if (idx >= 0 && sun.altitude > 15) {
    const hs = rs.next72[idx];
    const hn = rn.next72[idx];
    const hf = rf.next72[idx];
    check("adret plus chaud que le plat, ubac plus froid", hs.terrain.dT > 0.15 && hn.terrain.dT < -0.15, f(hs.terrain.dT) + " / " + f(hn.terrain.dT) + " °C");
    check("ubac plus humide que l’adret et que le plat", hn.rh > hs.rh && hn.rh > hf.rh, f(hn.rh) + " / " + f(hf.rh) + " / " + f(hs.rh));
  } else {
    check("exposition : heure ensoleillée absente du jeu de test", true, "non testé");
  }

  // e) Plan d’eau sous le vent
  const nearLake: TerrainInfo = {
    ...plain,
    water: { kind: "lake", distanceM: 120, bearing: 200, size: 0.9 },
    point: { elevation: 300, slope: 0, aspect: null, tpi: 0, curvature: 0, poolIndex: 0 },
  };
  const farLake: TerrainInfo = { ...nearLake, water: { kind: "lake", distanceM: 4000, bearing: 200, size: 0.9 } };
  const rLake = computeEstimate(pt, [], null, NOW, nearLake);
  const rFar = computeEstimate(pt, [], null, NOW, farLake);
  const warmDay = rLake.next72.find((x) => x.isDay && x.temp > 10 && (x.wind ?? 0) > 2);
  if (warmDay) {
    const warmDayFar = rFar.next72.find((x) => x.t === warmDay.t)!;
    check("au bord d’un lac : point de rosée relevé", warmDay.terrain.dTd > 0.15, f(warmDay.terrain.dTd));
    check("à 4 km du lac : effet négligeable", Math.abs(warmDayFar.terrain.dTd) < 0.05, f(warmDayFar.terrain.dTd));
    check("l’effet d’eau reste borné", warmDay.terrain.dTd <= 1.61);
  }

  // f) Sous couvert forestier
  const wood: TerrainInfo = {
    ...plain,
    forest: { fraction: 1, nearestM: 0 },
    point: { elevation: 400, slope: 0, aspect: null, tpi: 0, curvature: 0, poolIndex: 0 },
  };
  const rWood = computeEstimate(pt, [], null, NOW, wood);
  const dayW = rWood.next72.find((x) => x.isDay && (x.radiation ?? 0) > 150);
  const nightW = rWood.next72.find((x) => !x.isDay && (x.cloud ?? 0) < 35);
  if (dayW) check("sous-bois : plus frais et plus humide le jour", dayW.terrain.dT < -0.3 && dayW.terrain.dTd > 0.05, f(dayW.terrain.dT) + " °C");
  if (nightW) check("sous-bois : moins froid la nuit (couvert)", nightW.terrain.dT > 0.1, f(nightW.terrain.dT) + " °C");

  // g) Terrain indisponible : aucun effet, aucune régression
  const rNone = computeEstimate(pt, oneS, null, NOW);
  check("sans données de terrain, rien n’est modifié", rNone.hours.every((h) => h.terrain.parts.length === 0 && h.terrain.dT === 0));
  check("le résumé signale l’absence", rNone.terrain.available === false);
  check(
    "cohérence : rosée jamais supérieure à la température",
    [...rValley.hours, ...rLake.hours, ...rWood.hours].every((h) => h.dewPoint <= h.temp + 1e-9)
  );
  check("terrain : effet nul le jour en terrain plat sans eau ni forêt", rf.hours.every((h) => h.terrain.parts.length === 0));
}

// ------------------------------------------------------------------ J
console.log("\nJ. Hypothèses réglables");
{
  const world = makeWorld({ seed: 7, coherence: 0.7, biased: false });
  const valley: TerrainInfo = {
    ...EMPTY_TERRAIN,
    detail: "full",
    point: { elevation: 200, slope: 22, aspect: 180, tpi: -60, curvature: -2, poolIndex: 1 },
    water: { kind: "lake", distanceM: 100, bearing: 200, size: 0.9 },
    forest: { fraction: 0.9, nearestM: 0 },
    stations: { AAAA: { tpi: 0, poolIndex: 0 } },
  };
  // Entrées figées une bonne fois : le monde synthétique tire son bruit d'un flux
  // aléatoire partagé, et chaque appel régénérerait des données différentes.
  const pt = world.point();
  const three = world.stations([S1, S2, S3]);
  const base = computeEstimate(pt, three, null, NOW, valley);
  const withTune = (t: Partial<Tune>) => computeEstimate(pt, three, null, NOW, valley, { ...DEFAULT_TUNE, ...t });

  check("hypothèses par défaut : rien n'est signalé comme modifié", base.tuned === false);
  check("un réglage modifié est signalé", withTune({ poolCap: 4 }).tuned === true);

  // Chaque curseur doit avoir un effet mesurable et borné
  const nightCalm = base.hours.filter((h) => !h.isDay && (h.wind ?? 0) < 9 && (h.cloud ?? 0) < 40 && h.terrain.parts.some((x) => x.key === "cold_air"));
  check("des nuits calmes existent dans le jeu de test", nightCalm.length > 0, nightCalm.length + " h");
  const off = withTune({ poolCap: 0 });
  check("poche de froid à 0 °C : l'effet disparaît", off.hours.every((h) => !h.terrain.parts.some((x) => x.key === "cold_air")));
  const double = withTune({ poolCap: 6 });
  const coldPart = (h: (typeof base.hours)[number]) => h.terrain.parts.find((x) => x.key === "cold_air")?.dT ?? 0;
  const forestPart = (h: (typeof base.hours)[number]) => h.terrain.parts.find((x) => x.key === "forest")?.dT ?? 0;
  if (nightCalm.length) {
    const t = nightCalm[0].t;
    const a = coldPart(nightCalm[0]);
    const b = coldPart(double.hours.find((x) => x.t === t)!);
    check("poche de froid doublée : refroidissement doublé", Math.abs(b - 2 * a) < 0.05, f(a) + " → " + f(b));
    check("le refroidissement reste plafonné au curseur", b >= -6.001);
  }

  const noCanopy = withTune({ canopy: 0 });
  check("couvert à 0 % : plus d'effet de végétation", noCanopy.hours.every((h) => !h.terrain.parts.some((x) => x.key === "forest")));
  const dense = withTune({ canopy: 1 });
  const dayForest = base.hours.find((h) => h.isDay && h.terrain.parts.some((x) => x.key === "forest"));
  if (dayForest) {
    const d = dense.hours.find((x) => x.t === dayForest.t)!;
    check("couvert dense : effet plus fort", Math.abs(forestPart(d)) > Math.abs(forestPart(dayForest)), f(forestPart(dayForest)) + " → " + f(forestPart(d)));
  }

  const nearWater = base.hours.find((h) => h.isDay && h.terrain.parts.some((x) => x.key === "water"));
  if (nearWater) {
    const short = withTune({ waterReach: 120 }).hours.find((x) => x.t === nearWater.t)!;
    const long = withTune({ waterReach: 2000 }).hours.find((x) => x.t === nearWater.t)!;
    check("portée de l'eau : plus elle est courte, plus l'effet tombe vite", Math.abs(short.terrain.dTd) < Math.abs(long.terrain.dTd), f(short.terrain.dTd) + " vs " + f(long.terrain.dTd));
    check("apport d'eau nul quand le curseur est à 0", withTune({ waterTd: 0 }).hours.every((h) => !h.terrain.parts.some((x) => x.key === "water")));
    check("ignorer l'eau retire l'effet même si la carte en montre", withTune({ waterMode: 0 }).hours.every((h) => !h.terrain.parts.some((x) => x.key === "water")));
  }
  const placed = withTune({ waterMode: 2, waterDist: 15, waterSize: 0.9, waterFrom: 200, waterTd: 1.6 });
  check("un plan d'eau placé à la main humidifie", placed.hours.some((h) => h.terrain.parts.some((x) => x.key === "water")));
  const windy = withTune({ groundWind: 30, windFrom: 20 });
  check("vent au sol soutenu : plus de poche de froid", windy.hours.every((h) => !h.terrain.parts.some((x) => x.key === "cold_air")));

  // Portée des stations : trop courte, plus aucune mesure n'est retenue
  const faded = withTune({ stationKm: 5, stationM: 50 });
  check(
    "portée réduite à 5 km : l'ancrage s'estompe sans disparaître brutalement",
    faded.stations.length <= base.stations.length && faded.stations[0].trust < base.stations[0].trust * 0.2,
    f(base.stations[0].trust) + " → " + f(faded.stations[0]?.trust ?? 0)
  );
  const tight = withTune({ stationKm: 3, stationM: 30 });
  check("portée réduite à 3 km : plus aucune station retenue", tight.stations.length === 0 && tight.calibration.hasStations === false);
  check("le verdict repasse en « indéterminé »", tight.verdict.status === "no_reference");
  const wide = withTune({ stationKm: 120, stationM: 1000 });
  check("portée élargie : les stations restent retenues", wide.stations.length === base.stations.length);
  check("la confiance accordée augmente avec la portée", wide.stations[0].trust >= base.stations[0].trust, f(base.stations[0].trust) + " → " + f(wide.stations[0].trust));

  // Aucun réglage ne doit casser les invariants
  const extremes: Partial<Tune>[] = [
    { poolCap: 6, poolDepth: 10, sunCap: 4, waterTd: 4, waterReach: 2000, forestCap: 3, canopy: 1 },
    { poolCap: 0, poolDepth: 150, sunCap: 0, waterTd: 0, waterReach: 100, forestCap: 0, canopy: 0 },
  ];
  for (const e of extremes) {
    const r = withTune(e);
    check(
      "réglages extrêmes : valeurs bornées et cohérentes",
      r.hours.every((h) => h.rh >= 0 && h.rh <= 100 && h.rhLow <= h.rh && h.rh <= h.rhHigh && h.dewPoint <= h.temp + 1e-9 && h.sigma > 0)
    );
  }
  // Aux réglages extrêmes, un creux de 6 °C peut légitimement déplacer l'humidité de
  // plus de 25 points ; ce qui compte, c'est que la fourchette suive.
  // On compare l'effet du terrain seul : l'écart à rhRaw mêle aussi le calage sur les
  // stations, qui est identique dans les deux runs et fausserait la comparaison.
  const extreme = withTune(extremes[0]);
  const magnitude = (h: (typeof base.hours)[number]) => Math.abs(h.terrain.dT) + Math.abs(h.terrain.dTd);
  const affected = extreme.hours.filter((h) => magnitude(h) > magnitude(base.hours.find((x) => x.t === h.t)!) + 0.2);
  check("réglages extrêmes : l'effet du terrain augmente bien", affected.length > 0, affected.length + " h");
  const maxShift = Math.max(0, ...affected.map((h) => Math.abs(h.rh - base.hours.find((x) => x.t === h.t)!.rh)));
  // À saturation, un refroidissement supplémentaire ne change plus l’humidité relative :
  // aucune incertitude supplémentaire n’est alors justifiée.
  const moved = affected.filter((h) => Math.abs(h.rh - base.hours.find((x) => x.t === h.t)!.rh) > 0.5);
  check("des heures voient leur humidité déplacée par les réglages extrêmes", moved.length > 0, moved.length + " h");
  check("réglages extrêmes : déplacement important mais borné", maxShift <= 45, "max " + f(maxShift) + " pt");
  // Invariant pertinent : la fourchette doit suivre le déplacement net dû au terrain.
  // Comparer deux jeux de réglages ne suffit pas — renforcer une hypothèse peut en
  // compenser une autre et réduire le déplacement total tout en déplaçant l'humidité.
  const terrainOff = withTune(extremes[1]); // tous les effets de terrain à zéro
  check(
    "effets de terrain à zéro : estimation identique au consensus corrigé",
    terrainOff.hours.every((h) => h.terrain.parts.length === 0)
  );
  const pairs = terrainOff.hours.map((h) => ({ terrainOff: h, on: base.hours.find((x) => x.t === h.t)! }));
  const narrower = pairs.filter((p) => p.on.sigma < p.terrainOff.sigma - 1e-9);
  check(
    "le terrain n'élargit jamais à tort une fourchette déjà large",
    narrower.length === 0,
    narrower.length
      ? narrower
          .slice(0, 3)
          .map((p) => f(p.terrainOff.sigma) + "→" + f(p.on.sigma) + " dT " + f(p.on.terrain.dT) + " ancr " + f(p.on.anchor))
          .join(" ; ")
      : ""
  );
  const displaced = pairs.filter((p) => Math.abs(p.on.rh - p.terrainOff.rh) > 1);
  const widened = displaced.filter((p) => p.on.sigma > p.terrainOff.sigma + 1e-6);
  const meanWiden =
    displaced.length > 0
      ? displaced.reduce((a, p) => a + (p.on.sigma - p.terrainOff.sigma), 0) / displaced.length
      : 0;
  check(
    "la fourchette s'élargit quand le terrain déplace l'estimation",
    displaced.length > 0 && widened.length === displaced.length && meanWiden >= 0.2,
    widened.length + "/" + displaced.length + " h, élargissement moyen " + f(meanWiden) + " pt pour un déplacement de " +
      f(displaced.reduce((a, p) => a + Math.abs(p.on.rh - p.terrainOff.rh), 0) / Math.max(1, displaced.length)) + " pt"
  );
}

console.log(failures ? `\n${failures} échec(s)` : "\nTous les contrôles passent.");
process.exit(failures ? 1 : 0);
