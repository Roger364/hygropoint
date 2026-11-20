import { memo, useId, useState } from "react";
import type { Basis, EstimateResult, HourEstimate, Stats } from "../lib/estimate";
import { rhColor } from "../lib/estimate";
import { fmtDayHour, fmtDayShort, fmtHour, fmtNum, fmtSigned, localDayKey } from "../lib/format";
import { cn } from "../utils/cn";

interface Props {
  result: EstimateResult;
  tz: string;
}

const BASIS: Record<Basis, { tag: string; title: string }> = {
  obs: { tag: "mesure", title: "Écart constaté à la station au même moment, retiré au point choisi" },
  persist: { tag: "mesure récente", title: "Dernier écart mesuré, qui s'estompe avec l'échéance" },
  bias: { tag: "biais", title: "Biais des modèles par situation météo, validé sur les mesures" },
  none: { tag: "", title: "Consensus des modèles, sans correction" },
};

function HourlyTable({ result, tz }: Props) {
  const [tab, setTab] = useState<"past" | "next">("next");
  const id = useId();
  const rows = tab === "past" ? result.past24 : result.next72;
  const stats = tab === "past" ? result.stats.past24 : result.stats.next72;
  const station = result.stations[0];
  const showObs = tab === "past" && rows.some((h) => h.obsRh !== null);

  return (
    <section
      id="detail"
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 scroll-mt-4 flex-col rounded-3xl border border-white/10 bg-white/[0.04] p-4 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-5"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 id={`${id}-title`} className="text-base font-semibold text-white">
          Détail heure par heure
        </h3>
        <div role="tablist" aria-label="Période" className="flex rounded-xl bg-white/5 p-1">
          <Tab id={`${id}-tab-past`} panel={`${id}-panel`} selected={tab === "past"} onSelect={() => setTab("past")}>
            24 h passées
          </Tab>
          <Tab id={`${id}-tab-next`} panel={`${id}-panel`} selected={tab === "next"} onSelect={() => setTab("next")}>
            72 h à venir
          </Tab>
        </div>
      </div>

      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
        <StatsStrip stats={stats} tz={tz} />

        <div className="mt-4 min-h-[420px] flex-1 basis-0 overflow-auto rounded-xl border border-white/10" tabIndex={0} role="group" aria-label="Tableau horaire défilant">
          <table className="w-full min-w-[720px] text-left text-xs">
            <caption className="sr-only">
              Humidité relative estimée heure par heure, {tab === "past" ? "24 dernières heures" : "72 prochaines heures"},
              heure locale du lieu.
            </caption>
            <thead className="sticky top-0 z-10 bg-slate-900 text-[11px] uppercase tracking-wide text-slate-400">
              <tr>
                <Th>Heure</Th>
                <Th title="Humidité relative estimée">Humidité</Th>
                <Th title="Fourchette probable (environ 8 chances sur 10)">Fourchette</Th>
                {showObs && <Th title={station ? `Mesure de la station ${station.name} (${station.id})` : undefined}>Mesuré</Th>}
                <Th title="Écart entre l'estimation et le consensus brut des modèles">Calage</Th>
                <Th title="Effet du terrain et des alentours sur la température">Terrain</Th>
                <Th>Temp.</Th>
                <Th title="Point de rosée">Rosée</Th>
                <Th>Vent</Th>
                <Th>Pluie</Th>
                <Th>Nuages</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((h, i) => (
                <Row
                  key={h.t}
                  h={h}
                  tz={tz}
                  showObs={showObs}
                  newDay={i === 0 || localDayKey(h.t, tz) !== localDayKey(rows[i - 1].t, tz)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Row({ h, tz, newDay, showObs }: { h: HourEstimate; tz: string; newDay: boolean; showObs: boolean }) {
  const delta = h.rh - h.rhRaw;
  const basis = BASIS[h.basis];
  return (
    <tr className={cn("transition hover:bg-white/[0.04]", newDay && "border-t border-white/20")}>
      <th scope="row" className="whitespace-nowrap px-2 py-2 font-normal text-slate-300">
        {newDay && <span className="mr-1.5 font-semibold text-white">{fmtDayShort(h.t, tz)}</span>}
        {fmtHour(h.t, tz)}
      </th>
      <td className="px-2 py-2">
        <div className="flex items-center gap-2">
          <div aria-hidden="true" className="h-1.5 w-8 shrink-0 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full" style={{ width: `${h.rh}%`, background: rhColor(h.rh) }} />
          </div>
          <span className="whitespace-nowrap font-semibold tabular-nums text-white">{Math.round(h.rh)} %</span>
        </div>
      </td>
      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-slate-300">
        {Math.round(h.rhLow)} – {Math.round(h.rhHigh)}
      </td>
      {showObs && (
        <td className="px-2 py-2 tabular-nums text-emerald-300">{h.obsRh === null ? "—" : `${Math.round(h.obsRh)} %`}</td>
      )}
      <td className="whitespace-nowrap px-2 py-2">
        {h.basis === "none" ? (
          <span className="text-slate-500" title={basis.title}>
            —
          </span>
        ) : (
          <span
            title={basis.title}
            className={cn(
              "rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
              h.basis === "bias" ? "bg-violet-400/15 text-violet-200" : "bg-emerald-400/15 text-emerald-200"
            )}
          >
            {fmtSigned(delta)} · {basis.tag}
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-sky-200">
        {h.terrain.parts.length === 0 ? (
          <span className="text-slate-500">—</span>
        ) : (
          <span
            title={h.terrain.parts.map((p) => p.label).join(", ")}
            className="cursor-help rounded bg-sky-400/15 px-1.5 py-0.5 text-sky-200"
          >
            {fmtSigned(h.terrain.dT, 1)} °
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-orange-200">{fmtNum(h.temp, 1)} °</td>
      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-slate-300">{fmtNum(h.dewPoint, 1)} °</td>
      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-violet-200">
        {h.wind === null ? "—" : `${fmtNum(h.wind)} km/h`}
      </td>
      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-blue-200">
        {h.precip !== null && h.precip >= 0.05 ? `${fmtNum(h.precip, 1)} mm` : "—"}
      </td>
      <td className="px-2 py-2 tabular-nums text-slate-300">{h.cloud === null ? "—" : `${Math.round(h.cloud)} %`}</td>
    </tr>
  );
}

function Th({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <th scope="col" title={title} className="whitespace-nowrap px-2 py-2 font-medium">
      {children}
    </th>
  );
}

function Tab({
  id,
  panel,
  selected,
  onSelect,
  children,
}: {
  id: string;
  panel: string;
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={selected}
      aria-controls={panel}
      onClick={onSelect}
      className={cn(
        "rounded-lg px-3 py-1.5 text-xs font-semibold transition",
        selected ? "bg-sky-700 text-white shadow" : "text-slate-300 hover:text-white"
      )}
    >
      {children}
    </button>
  );
}

function StatsStrip({ stats, tz }: { stats: Stats; tz: string }) {
  if (!stats.n) return <p className="text-sm text-slate-400">Aucune donnée sur cette période.</p>;
  const items = [
    { k: "Moyenne", v: `${Math.round(stats.mean)} %`, color: rhColor(stats.mean), sub: `sur ${stats.n} h` },
    { k: "Minimum", v: `${Math.round(stats.min)} %`, color: rhColor(stats.min), sub: fmtDayHour(stats.minAt, tz) },
    { k: "Maximum", v: `${Math.round(stats.max)} %`, color: rhColor(stats.max), sub: fmtDayHour(stats.maxAt, tz) },
    {
      k: "Pluie",
      v: `${stats.rainHours} h`,
      color: "#60a5fa",
      sub: stats.rainHours ? `${fmtNum(stats.rainTotal, 1)} mm au total` : "aucune",
    },
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((it) => (
        <div key={it.k} className="rounded-xl border border-white/10 bg-slate-950/40 px-2 py-2">
          <dt className="text-[11px] text-slate-400">{it.k}</dt>
          <dd className="text-lg font-semibold tabular-nums" style={{ color: it.color }}>
            {it.v}
          </dd>
          <dd className="text-[11px] text-slate-400">{it.sub}</dd>
        </div>
      ))}
    </dl>
  );
}

export default memo(HourlyTable);
