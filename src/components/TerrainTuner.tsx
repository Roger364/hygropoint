import { DEFAULT_TUNE, TUNE_META, changedKeys, isDefaultTune, tuneValue, type Tune } from "../lib/tune";
import { fmtSigned } from "../lib/format";
import { cn } from "../utils/cn";

interface Props {
  tune: Tune;
  onChange: (next: Tune) => void;
  /** Écart d'humidité relative, en points, entre les hypothèses choisies et celles par défaut. */
  deltaRh: number;
  deltaSigma: number;
  rhNow: number;
  /** L'exagération verticale de la vue 3D suit la forme choisie. */
  onExagg?: (value: number) => void;
}

const SHAPES: { id: string; label: string; hint: string; exagg: number; poolCap: number; poolDepth: number }[] = [
  { id: "flat", label: "Plat", hint: "peu de poche de froid", exagg: 1.2, poolCap: 0.4, poolDepth: 120 },
  { id: "natural", label: "Naturel", hint: "hypothèse par défaut", exagg: 2, poolCap: 3, poolDepth: 55 },
  { id: "valley", label: "Vallée", hint: "air froid qui stagne", exagg: 3.5, poolCap: 4.5, poolDepth: 28 },
  { id: "combe", label: "Combe", hint: "fond très encaissé", exagg: 5, poolCap: 6, poolDepth: 12 },
];

const WATERS: { id: string; label: string; mode: number; dist?: number; size?: number }[] = [
  { id: "off", label: "Ignorer", mode: 0 },
  { id: "map", label: "Carte", mode: 1 },
  { id: "bank", label: "Au bord", mode: 2, dist: 20, size: 0.9 },
  { id: "river", label: "Rivière", mode: 2, dist: 160, size: 0.45 },
  { id: "lake", label: "Lac", mode: 2, dist: 70, size: 0.95 },
];

const WINDS: { id: string; label: string; kmh: number }[] = [
  { id: "auto", label: "Modèle", kmh: -1 },
  { id: "calm", label: "Calme", kmh: 2 },
  { id: "breeze", label: "Brise", kmh: 12 },
  { id: "strong", label: "Soutenu", kmh: 28 },
];

const DIRS = [
  { l: "N", d: 0 },
  { l: "NE", d: 45 },
  { l: "E", d: 90 },
  { l: "SE", d: 135 },
  { l: "S", d: 180 },
  { l: "SO", d: 225 },
  { l: "O", d: 270 },
  { l: "NO", d: 315 },
];

function shapeId(t: Tune): string | null {
  return SHAPES.find((s) => Math.abs(t.poolCap - s.poolCap) < 0.05 && Math.abs(t.poolDepth - s.poolDepth) < 1)?.id ?? null;
}

export default function TerrainTuner({ tune, onChange, deltaRh, deltaSigma, rhNow, onExagg }: Props) {
  const changed = changedKeys(tune);
  const significant = Math.abs(deltaRh) >= 0.5;
  const patch = (p: Partial<Tune>) => onChange({ ...tune, ...p });

  return (
    <fieldset className="min-w-0">
      <legend className="text-xs font-semibold uppercase tracking-wider text-slate-400">Affiner l'estimation</legend>

      <div
        className={cn(
          "mt-2 rounded-2xl border px-3 py-2 text-xs",
          significant ? "border-sky-400/35 bg-sky-400/10 text-sky-100" : "border-white/10 bg-slate-950/40 text-slate-300"
        )}
        role="status"
      >
        {isDefaultTune(tune) ? (
          "Hypothèses par défaut. Un bouton recalcule l'humidité tout de suite, sans nouvelle requête."
        ) : significant ? (
          <>
            <strong className="font-semibold tabular-nums text-white">{fmtSigned(deltaRh)} point</strong> d'humidité par
            rapport aux hypothèses par défaut, fourchette {fmtSigned(deltaSigma)} point.
          </>
        ) : rhNow >= 99 ? (
          "L'air est déjà saturé : un apport d'humidité ne peut plus faire monter le pourcentage."
        ) : (
          "Peu d'effet à cette heure-ci. Le tableau horaire montre les heures qui bougent."
        )}
      </div>

      <Group title="Forme du relief" hint="Creux, coteau, combe — change la poche de froid et le relief affiché.">
        <Row>
          {SHAPES.map((s) => (
            <Pick
              key={s.id}
              pressed={shapeId(tune) === s.id}
              title={s.hint}
              onClick={() => {
                patch({ poolCap: s.poolCap, poolDepth: s.poolDepth });
                onExagg?.(s.exagg);
              }}
            >
              {s.label}
            </Pick>
          ))}
        </Row>
      </Group>

      <Group title="Eau à proximité" hint="La carte en rate souvent un ruisseau. Placez-le : le disque bleu suit sur le relief.">
        <Row>
          {WATERS.map((w) => (
            <Pick
              key={w.id}
              pressed={tune.waterMode === w.mode && (w.mode < 2 || Math.abs(tune.waterDist - (w.dist ?? 0)) < 15)}
              onClick={() => patch({ waterMode: w.mode, waterDist: w.dist ?? tune.waterDist, waterSize: w.size ?? tune.waterSize })}
            >
              {w.label}
            </Pick>
          ))}
        </Row>
        {tune.waterMode >= 2 && (
          <div className="mt-2 space-y-2">
            <Mini
              label="Distance"
              value={tune.waterDist}
              min={0}
              max={800}
              step={10}
              display={tune.waterDist < 15 ? "au bord" : `${Math.round(tune.waterDist)} m`}
              onChange={(v) => patch({ waterDist: v })}
            />
            <div>
              <div className="mb-1 text-[11px] text-slate-400">L'eau est vers</div>
              <Row>
                {DIRS.map((d) => (
                  <Pick key={d.l} pressed={Math.abs(((tune.waterFrom - d.d + 540) % 360) - 180) < 23} onClick={() => patch({ waterFrom: d.d })}>
                    {d.l}
                  </Pick>
                ))}
              </Row>
            </div>
          </div>
        )}
      </Group>

      <Group title="Vent au sol" hint="Un vent calme laisse l'air froid stagner ; un vent soutenu l'emporte, et n'apporte l'humidité de l'eau que s'il en vient.">
        <Row>
          {WINDS.map((w) => (
            <Pick key={w.id} pressed={Math.abs(tune.groundWind - w.kmh) < 0.5} onClick={() => patch({ groundWind: w.kmh })}>
              {w.label}
            </Pick>
          ))}
        </Row>
        {tune.groundWind >= 0 && (
          <div className="mt-2">
            <div className="mb-1 flex justify-between text-[11px] text-slate-400">
              <span>Il vient du</span>
              <span className="font-semibold tabular-nums text-slate-200">{Math.round(tune.groundWind)} km/h</span>
            </div>
            <Row>
              {DIRS.map((d) => (
                <Pick key={d.l} pressed={Math.abs(((tune.windFrom - d.d + 540) % 360) - 180) < 23} onClick={() => patch({ windFrom: d.d })}>
                  {d.l}
                </Pick>
              ))}
            </Row>
            <Mini
              label="Vitesse"
              value={tune.groundWind}
              min={0}
              max={40}
              step={1}
              display={`${Math.round(tune.groundWind)} km/h`}
              onChange={(v) => patch({ groundWind: v })}
            />
          </div>
        )}
      </Group>

      <details className="mt-3 rounded-xl border border-white/10 bg-slate-950/30 px-3 py-2">
        <summary className="cursor-pointer text-[11px] font-semibold text-slate-300">Réglages fins</summary>
        <div className="mt-2 space-y-2.5">
          {TUNE_META.map((m) => {
            const v = tune[m.key];
            const modified = Math.abs(v - DEFAULT_TUNE[m.key]) >= 1e-9;
            return (
              <Mini
                key={m.key}
                label={m.label}
                value={v}
                min={m.min}
                max={m.max}
                step={m.step}
                display={tuneValue(v, m.unit)}
                help={m.help}
                modified={modified}
                onChange={(n) => patch({ [m.key]: n } as Partial<Tune>)}
              />
            );
          })}
        </div>
      </details>

      {changed.length > 0 && (
        <button
          type="button"
          onClick={() => {
            onChange({ ...DEFAULT_TUNE });
            onExagg?.(2);
          }}
          className="mt-3 w-full rounded-xl bg-white/5 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-white/10"
        >
          Revenir aux hypothèses par défaut
        </button>
      )}
    </fieldset>
  );
}

function Group({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <h4 className="text-[11px] font-semibold text-slate-100">{title}</h4>
      <p className="text-[10px] leading-snug text-slate-500">{hint}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-1">{children}</div>;
}

function Pick({ pressed, onClick, title, children }: { pressed: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "rounded-lg px-2 py-1 text-[11px] font-semibold transition",
        pressed ? "bg-sky-500 text-white shadow" : "bg-white/5 text-slate-300 hover:bg-white/10"
      )}
    >
      {children}
    </button>
  );
}

function Mini({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
  help,
  modified,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
  help?: string;
  modified?: boolean;
}) {
  const pct = ((value - min) / Math.max(1e-9, max - min)) * 100;
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className={cn("text-[11px]", modified ? "text-sky-200" : "text-slate-400")}>{label}</span>
        <span className="text-[11px] font-semibold tabular-nums text-slate-100">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none"
        style={{ background: `linear-gradient(90deg, #38bdf8 ${pct}%, rgba(255,255,255,.12) ${pct}%)` }}
      />
      {help && <p className="mt-0.5 text-[10px] leading-snug text-slate-500">{help}</p>}
    </div>
  );
}
