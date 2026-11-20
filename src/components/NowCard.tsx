import type { EstimateResult, Regime } from "../lib/estimate";
import { humidityLabel, rhColor } from "../lib/estimate";
import { fmtAgo, fmtNum, fmtSigned } from "../lib/format";

interface Props {
  result: EstimateResult;
  placeLabel: string;
  /** Horloge courante (ms), pour l'âge des mesures. */
  clock: number;
}

// Repères qualitatifs, sans chiffre : ils décrivent la situation, ils ne corrigent rien.
const CONTEXT: Partial<Record<Regime, string>> = {
  rain: "Sous la pluie, l'air proche du sol se rapproche de la saturation.",
  night_calm:
    "Nuit calme et dégagée : l'humidité varie beaucoup sur de courtes distances (creux et fonds de vallée plus humides).",
  windy: "Vent soutenu : l'air est bien brassé, l'humidité est plus homogène d'un endroit à l'autre.",
  day_sunny: "Journée ensoleillée : l'humidité baisse avec le réchauffement, minimum en milieu d'après-midi.",
};

const LEVEL_STYLE = {
  high: { dot: "bg-emerald-400", text: "text-emerald-300" },
  medium: { dot: "bg-amber-400", text: "text-amber-300" },
  low: { dot: "bg-orange-400", text: "text-orange-300" },
} as const;

function Gauge({ value, low, high, color }: { value: number; low: number; high: number; color: string }) {
  const r = 82;
  const rOuter = 96;
  const c = 2 * Math.PI * r;
  const cOuter = 2 * Math.PI * rOuter;
  const sweep = 0.75; // arc de 270°, ouverture en bas
  const segment = (circ: number, from: number, to: number) => ({
    strokeDasharray: `${Math.max(0, (circ * sweep * (to - from)) / 100)} ${circ}`,
    strokeDashoffset: (-circ * sweep * from) / 100,
  });
  return (
    <div
      role="meter"
      aria-label="Humidité relative estimée"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)} %, fourchette probable de ${Math.round(low)} à ${Math.round(high)} %`}
      className="relative h-52 w-52 shrink-0"
    >
      <svg viewBox="0 0 200 200" className="h-full w-full rotate-[135deg]" aria-hidden="true">
        <circle cx="100" cy="100" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="14" strokeLinecap="round" {...segment(c, 0, 100)} />
        <circle
          cx="100"
          cy="100"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="14"
          strokeLinecap="round"
          {...segment(c, 0, Math.max(1, value))}
          style={{ filter: `drop-shadow(0 0 10px ${color}88)`, transition: "stroke-dasharray .8s ease" }}
        />
        {/* Fourchette probable */}
        <circle cx="100" cy="100" r={rOuter} fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="3" strokeLinecap="round" {...segment(cOuter, low, Math.max(low + 0.5, high))} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="flex items-start">
          <span className="text-6xl font-bold tabular-nums tracking-tight text-white">{Math.round(value)}</span>
          <span className="mt-2 text-2xl font-semibold text-slate-300">%</span>
        </div>
        <span className="mt-1 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-400">humidité relative</span>
      </div>
    </div>
  );
}

export default function NowCard({ result, placeLabel, clock }: Props) {
  const { now, confidence, calibration, stations } = result;
  const color = rhColor(now.rh);
  const ref = stations[0];
  const delta = now.rh - now.rhRaw;
  const level = LEVEL_STYLE[confidence.level];

  const basisHint = calibration.anchoring.active
    ? `calée sur une mesure à ${fmtNum(ref.distanceKm, ref.distanceKm < 10 ? 1 : 0)} km`
    : calibration.hasStations
      ? "modèles confrontés aux mesures voisines"
      : "modèles seuls, non vérifiés ici";

  const metrics: { icon: string; k: string; v: string; sub?: string }[] = [
    { icon: "🌡️", k: "Température", v: `${fmtNum(now.temp, 1)} °C` },
    { icon: "💧", k: "Point de rosée", v: `${fmtNum(now.dewPoint, 1)} °C` },
    { icon: "🫧", k: "Humidité absolue", v: `${fmtNum(now.absHumidity, 1)} g/m³` },
    {
      icon: "🌬️",
      k: "Vent",
      v: now.wind === null ? "—" : `${fmtNum(now.wind)} km/h`,
      sub: now.gust !== null ? `rafales ${fmtNum(now.gust)}` : undefined,
    },
    {
      icon: "🌧️",
      k: "Précipitations",
      v: now.precip === null ? "—" : `${fmtNum(now.precip, 1)} mm/h`,
      sub: now.precipProb !== null ? `probabilité ${fmtNum(now.precipProb)} %` : undefined,
    },
    { icon: "☁️", k: "Nébulosité", v: now.cloud === null ? "—" : `${fmtNum(now.cloud)} %` },
    { icon: "🧭", k: "Pression", v: now.pressure === null ? "—" : `${fmtNum(now.pressure)} hPa` },
    {
      icon: now.isDay ? "☀️" : "🌙",
      k: "Rayonnement solaire",
      v: now.radiation === null ? "—" : `${fmtNum(now.radiation)} W/m²`,
    },
  ];

  return (
    <section
      aria-labelledby="now-title"
      className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-white/[0.08] to-white/[0.03] p-5 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-6"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full opacity-30 blur-3xl"
        style={{ background: color }}
      />
      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center">
        <div className="flex flex-col items-center gap-3">
          <Gauge value={now.rh} low={now.rhLow} high={now.rhHigh} color={color} />
          <span
            className="rounded-full px-3 py-1 text-xs font-semibold ring-1"
            style={{ color, background: `${color}22`, boxShadow: `inset 0 0 0 1px ${color}55` }}
          >
            {humidityLabel(now.rh)}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-300">Maintenant</p>
          <h2 id="now-title" className="mt-1 break-words text-xl font-semibold text-white">
            {placeLabel}
          </h2>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Tile label="Fourchette probable" value={`${Math.round(now.rhLow)} – ${Math.round(now.rhHigh)} %`} hint="environ 8 chances sur 10" />
            <Tile
              label="Fiabilité"
              value={
                <span className={`flex items-center gap-2 ${level.text}`}>
                  <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${level.dot}`} />
                  {confidence.label}
                </span>
              }
              hint={basisHint}
            />
            <Tile
              label="Modèles bruts → estimation"
              value={`${Math.round(now.rhRaw)} → ${Math.round(now.rh)} %`}
              hint={Math.abs(delta) >= 0.5 ? `${fmtSigned(delta)} point${Math.abs(delta) >= 1.5 ? "s" : ""} après calage` : "aucune correction"}
            />
          </div>

          <p className="mt-3 flex items-start gap-2 rounded-2xl border border-white/10 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">
            <span aria-hidden="true" className={`mt-1 h-2 w-2 shrink-0 rounded-full ${ref ? "bg-emerald-400" : "bg-slate-500"}`} />
            {ref ? (
              <span>
                Dernière mesure : <strong className="font-semibold text-white">{Math.round(ref.last.rh)} %</strong> (
                {fmtNum(ref.last.temp)} °C, rosée {fmtNum(ref.last.dew)} °C) à la station {ref.name} ({ref.id}), à{" "}
                {fmtNum(ref.distanceKm, ref.distanceKm < 10 ? 1 : 0)} km — {fmtAgo(ref.last.t, clock)}.
              </span>
            ) : (
              <span>Aucune mesure exploitable à proximité : l'estimation repose sur les modèles seuls.</span>
            )}
          </p>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            {metrics.map((m) => (
              <div key={m.k} className="relative min-w-0 pl-6">
                <span aria-hidden="true" className="absolute left-0 top-0.5 text-base leading-none">
                  {m.icon}
                </span>
                <dt className="text-[11px] text-slate-400">{m.k}</dt>
                <dd className="text-sm font-medium text-white">{m.v}</dd>
                {m.sub && <dd className="text-[11px] text-slate-400">{m.sub}</dd>}
              </div>
            ))}
          </dl>

          {CONTEXT[now.regime] && <p className="mt-4 text-xs leading-relaxed text-slate-400">{CONTEXT[now.regime]}</p>}
          {now.terrain.parts.length > 0 && (
            <p className="mt-2 text-xs text-sky-200/90">
              Terrain pris en compte : {now.terrain.parts.map((p) => p.label.toLowerCase()).join(", ")} — détail plus bas.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function Tile({ label, value, hint }: { label: string; value: React.ReactNode; hint: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/40 px-3 py-2.5">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="mt-0.5 text-base font-semibold tabular-nums text-white">{value}</div>
      <div className="text-[11px] text-slate-400">{hint}</div>
    </div>
  );
}
