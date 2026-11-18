import type { Retrospective } from "../lib/retrospective";
import { fmtNum, fmtSigned } from "../lib/format";
import { cn } from "../utils/cn";

interface Props {
  report: Retrospective | null;
  busy: boolean;
  error: string | null;
  disabled: boolean;
  onRun: () => void;
}

export default function RetrospectiveCard({ report, busy, error, disabled, onRun }: Props) {
  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-4 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-white">Mesures passées</h3>
          <p className="text-xs text-slate-400">
            Sept jours de mesures réelles, regroupées par situation, comparées à ce que les modèles anticipaient.
          </p>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={busy || disabled}
          className="rounded-xl bg-gradient-to-r from-emerald-500 to-sky-500 px-3.5 py-2 text-xs font-semibold text-white shadow-lg shadow-emerald-500/20 transition hover:brightness-110 active:scale-95 disabled:opacity-60"
        >
          {busy ? "Comparaison…" : "Comparer et ajuster"}
        </button>
      </div>
      {disabled && !report && (
        <p className="mt-3 text-xs text-slate-400">Aucune station de mesure proche : la comparaison n'est pas possible ici.</p>
      )}
      {error && <p className="mt-3 text-xs text-rose-200">{error}</p>}
      {report && (
        <div className="mt-3">
          <p
            className={cn(
              "rounded-2xl border px-3 py-2 text-xs",
              report.applied ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100" : "border-white/10 bg-slate-950/40 text-slate-300"
            )}
          >
            {report.summary}
            {report.stations.length > 0 && (
              <span className="mt-1 block text-[11px] text-slate-400">
                {report.hours} heures · {report.stations.join(", ")}
              </span>
            )}
          </p>
          {report.groups.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[11px] text-slate-400">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Situation</th>
                    <th className="px-2 py-1 text-right font-medium">Heures</th>
                    <th className="px-2 py-1 text-right font-medium">Anticipé</th>
                    <th className="px-2 py-1 text-right font-medium">Mesuré</th>
                    <th className="py-1 pl-2 text-right font-medium">Écart</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {report.groups.map((g) => (
                    <tr key={g.key}>
                      <th className="py-1.5 pr-2 font-normal text-slate-200">{g.label}</th>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-300">{g.n}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-200">{fmtNum(g.anticipated, 0)} %</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-white">{fmtNum(g.observed, 0)} %</td>
                      <td className={cn("py-1.5 pl-2 text-right tabular-nums", g.bias < 0 ? "text-amber-300" : "text-sky-300")}>
                        {fmtSigned(g.bias)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1.5 text-[11px] text-slate-500">Écart = anticipé − mesuré. Négatif : les modèles étaient trop secs.</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
