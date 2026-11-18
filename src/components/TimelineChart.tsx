import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Basis, HourEstimate, MemberSummary, StationSummary } from "../lib/estimate";
import { fmtDayHour, fmtDayShort, fmtNum, fmtSigned, localHour } from "../lib/format";
import type { ModelId } from "../lib/openmeteo";
import { cn } from "../utils/cn";

interface Props {
  hours: HourEstimate[];
  now: HourEstimate;
  station: StationSummary | null;
  members: MemberSummary[];
  tz: string;
}

type Overlay = "temp" | "wind" | "cloud" | "none";

const OVERLAYS: Record<
  Exclude<Overlay, "none">,
  { label: string; unit: string; color: string; fromZero: boolean; pick: (h: HourEstimate) => number | null }
> = {
  temp: { label: "Température", unit: "°C", color: "#fb923c", fromZero: false, pick: (h) => h.temp },
  wind: { label: "Vent", unit: "km/h", color: "#c4b5fd", fromZero: true, pick: (h) => h.wind },
  cloud: { label: "Nébulosité", unit: "%", color: "#cbd5e1", fromZero: true, pick: (h) => h.cloud },
};

const MODEL_COLORS: Record<ModelId, string> = {
  best_match: "#f472b6",
  ecmwf_ifs025: "#facc15",
  icon_seamless: "#4ade80",
  meteofrance_seamless: "#60a5fa",
  gfs_seamless: "#f87171",
};

export const BASIS_LABEL: Record<Basis, string> = {
  obs: "calé sur la mesure",
  persist: "écart mesuré récemment",
  bias: "biais des modèles corrigé",
  none: "sans correction",
};

const HALF_HOUR = 30 * 60_000;
const TOOLTIP_W = 232;
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

type Pt = [number, number];

function pathOf(points: Pt[]): string {
  let d = "";
  for (let i = 0; i < points.length; i++) d += `${i ? "L" : "M"}${points[i][0].toFixed(1)},${points[i][1].toFixed(1)}`;
  return d;
}

/** Tracé interrompu là où la valeur manque. */
function brokenPath<T>(items: T[], pick: (item: T) => Pt | null): string {
  let d = "";
  let pen = false;
  for (const item of items) {
    const p = pick(item);
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    pen = true;
  }
  return d;
}

function niceStep(range: number, target: number): number {
  const raw = Math.max(range, 1e-6) / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
}

function TimelineChart({ hours, now, station, members, tz }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const clipId = useId();
  const [width, setWidth] = useState(960);
  const [overlay, setOverlay] = useState<Overlay>("temp");
  const [showModels, setShowModels] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  useIsoLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => {
      const w = Math.round(el.clientWidth);
      if (w > 0) setWidth(w);
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const modelIds = useMemo(() => members.filter((m) => !m.duplicate).map((m) => m.id), [members]);

  const g = useMemo(() => {
    const compact = width < 600;
    const height = compact ? 280 : 340;
    const ov = overlay === "none" ? null : OVERLAYS[overlay];
    const m = { l: 40, r: ov ? 44 : 14, t: 16, b: 34 };
    const iw = Math.max(60, width - m.l - m.r);
    const ih = height - m.t - m.b;
    const t0 = hours[0].t;
    const t1 = hours[hours.length - 1].t;
    const span = Math.max(1, t1 - t0);
    const x = (t: number) => m.l + ((t - t0) / span) * iw;

    const obs = (station?.series ?? []).filter((o, i) => o.t >= t0 && o.t <= t1 && (!compact || i % 2 === 0));

    // Échelle d'humidité : resserrée sur les valeurs utiles, au moins 40 points d'amplitude.
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of hours) {
      lo = Math.min(lo, h.rhLow, h.rhRaw);
      hi = Math.max(hi, h.rhHigh, h.rhRaw);
      if (showModels) {
        for (const id of modelIds) {
          const v = h.perModel[id];
          if (v !== undefined) {
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
        }
      }
    }
    for (const o of obs) {
      lo = Math.min(lo, o.rh);
      hi = Math.max(hi, o.rh);
    }
    let y0 = Math.max(0, Math.floor((lo - 2) / 10) * 10);
    let y1 = Math.min(100, Math.ceil((hi + 2) / 10) * 10);
    while (y1 - y0 < 40) {
      if (y0 > 0) y0 -= 10;
      if (y1 - y0 < 40 && y1 < 100) y1 += 10;
      if (y0 <= 0 && y1 >= 100) break;
    }
    const y = (v: number) => m.t + (1 - (v - y0) / (y1 - y0)) * ih;
    const yStep = y1 - y0 > 60 ? 20 : 10;
    const yTicks: number[] = [];
    for (let v = y0; v <= y1; v += yStep) yTicks.push(v);

    const line = pathOf(hours.map((h) => [x(h.t), y(h.rh)]));
    const band =
      pathOf(hours.map((h) => [x(h.t), y(h.rhHigh)])) +
      pathOf(
        hours
          .slice()
          .reverse()
          .map((h) => [x(h.t), y(h.rhLow)])
      ).replace("M", "L") +
      "Z";
    const raw = pathOf(hours.map((h) => [x(h.t), y(h.rhRaw)]));
    const models = showModels
      ? modelIds.map((id) => ({
          id,
          d: brokenPath(hours, (h) => {
            const v = h.perModel[id];
            return v === undefined ? null : [x(h.t), y(v)];
          }),
        }))
      : [];

    // Nuits
    const nights: { x: number; w: number }[] = [];
    let start: number | null = null;
    for (let i = 0; i < hours.length; i++) {
      const night = !hours[i].isDay;
      if (night && start === null) start = i;
      if (start !== null && (!night || i === hours.length - 1)) {
        const end = night ? i : i - 1;
        const xa = x(hours[start].t - HALF_HOUR);
        const xb = x(hours[end].t + HALF_HOUR);
        nights.push({ x: xa, w: Math.max(0, xb - xa) });
        start = null;
      }
    }

    // Pluie : cumul de l'heure écoulée, donc barre centrée une demi-heure avant l'horodatage.
    const pMax = Math.max(2, ...hours.map((h) => h.precip ?? 0));
    const barW = Math.max(1.5, (iw / hours.length) * 0.7);
    const bars = hours
      .filter((h) => (h.precip ?? 0) >= 0.05)
      .map((h) => {
        const bh = ((h.precip ?? 0) / pMax) * ih * 0.24;
        return { key: h.t, x: x(h.t - HALF_HOUR) - barW / 2, y: m.t + ih - bh, w: barW, h: bh };
      });

    // Variable superposée (axe de droite)
    let ovPath = "";
    let ovTicks: { v: number; y: number }[] = [];
    if (ov) {
      const vals = hours.map(ov.pick).filter((v): v is number => v !== null);
      if (vals.length) {
        let a = ov.fromZero ? 0 : Math.min(...vals);
        let b = overlay === "cloud" ? 100 : Math.max(...vals);
        if (b - a < 4) b = a + 4;
        const step = niceStep(b - a, 4);
        a = Math.floor(a / step) * step;
        b = Math.ceil(b / step) * step;
        const yo = (v: number) => m.t + (1 - (v - a) / (b - a)) * ih;
        ovPath = brokenPath(hours, (h) => {
          const v = ov.pick(h);
          return v === null ? null : [x(h.t), yo(v)];
        });
        for (let v = a; v <= b + 1e-9; v += step) ovTicks.push({ v: Math.round(v * 10) / 10, y: yo(v) });
        if (ovTicks.length > 7) ovTicks = ovTicks.filter((_, i) => i % 2 === 0);
      }
    }

    // Graduations horaires (heure locale du lieu)
    const stepH = width < 420 ? 24 : compact ? 12 : 6;
    const xTicks: { x: number; label: string; midnight: boolean }[] = [];
    for (const h of hours) {
      const hr = localHour(h.t, tz);
      if (hr % stepH !== 0) continue;
      xTicks.push({
        x: x(h.t),
        midnight: hr === 0,
        label: hr === 0 ? fmtDayShort(h.t, tz) : `${String(hr).padStart(2, "0")} h`,
      });
    }

    return { compact, height, m, iw, ih, t0, t1, span, x, y, yTicks, line, band, raw, models, nights, bars, ov, ovPath, ovTicks, xTicks, obs };
  }, [hours, station, width, overlay, showModels, modelIds, tz]);

  const hovered = hover !== null ? hours[hover] : null;
  const xNow = g.x(Math.min(g.t1, Math.max(g.t0, now.t)));

  const nearest = (clientX: number, target: SVGSVGElement): number => {
    const rect = target.getBoundingClientRect();
    const t = g.t0 + ((clientX - rect.left - g.m.l) / g.iw) * g.span;
    let best = 0;
    let dist = Infinity;
    for (let i = 0; i < hours.length; i++) {
      const d = Math.abs(hours[i].t - t);
      if (d < dist) {
        dist = d;
        best = i;
      }
    }
    return best;
  };

  const nowIndex = useMemo(() => {
    let best = 0;
    for (let i = 0; i < hours.length; i++) if (Math.abs(hours[i].t - now.t) < Math.abs(hours[best].t - now.t)) best = i;
    return best;
  }, [hours, now.t]);

  let tooltipLeft = 0;
  if (hovered) {
    const xh = g.x(hovered.t);
    tooltipLeft = xh > width / 2 ? xh - 14 - TOOLTIP_W : xh + 14;
    tooltipLeft = Math.min(Math.max(4, tooltipLeft), Math.max(4, width - TOOLTIP_W - 4));
  }

  return (
    <section
      id="evolution"
      aria-labelledby="chart-title"
      className="scroll-mt-4 rounded-3xl border border-white/10 bg-white/[0.04] p-4 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-5"
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="chart-title" className="text-base font-semibold text-white">
            Évolution : 24 h passées → 72 h à venir
          </h3>
          <p className="text-xs text-slate-400">
            Estimation et fourchette probable{station ? `, mesures de la station ${station.name} (${station.id})` : ""}, pluie, et une variable au choix.
          </p>
        </div>
        <div role="group" aria-label="Options du graphique" className="flex flex-wrap items-center gap-1.5">
          {(["temp", "wind", "cloud", "none"] as Overlay[]).map((o) => (
            <Toggle key={o} pressed={overlay === o} onClick={() => setOverlay(o)}>
              {o === "none" ? "Humidité seule" : OVERLAYS[o].label}
            </Toggle>
          ))}
          <Toggle pressed={showModels} onClick={() => setShowModels((s) => !s)} accent>
            Détail des modèles
          </Toggle>
        </div>
      </div>

      <div ref={wrapRef} className="relative w-full" style={{ height: g.height }}>
        <svg
          width={width}
          height={g.height}
          role="img"
          tabIndex={0}
          aria-label="Graphique de l'humidité relative estimée, des 24 dernières heures aux 72 prochaines. Flèches gauche et droite pour parcourir les heures ; le tableau plus bas reprend toutes les valeurs."
          className="block touch-pan-y select-none rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
          onPointerMove={(e) => setHover(nearest(e.clientX, e.currentTarget))}
          onPointerDown={(e) => setHover(nearest(e.clientX, e.currentTarget))}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") setHover(null);
          }}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
              e.preventDefault();
              const dir = e.key === "ArrowRight" ? 1 : -1;
              setHover((h) => Math.min(hours.length - 1, Math.max(0, (h ?? nowIndex) + dir)));
            } else if (e.key === "Escape") setHover(null);
          }}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={g.m.l} y={g.m.t} width={g.iw} height={g.ih} />
            </clipPath>
          </defs>

          <g clipPath={`url(#${clipId})`}>
            {g.nights.map((n, i) => (
              <rect key={i} x={n.x} y={g.m.t} width={n.w} height={g.ih} fill="#000000" opacity="0.3" />
            ))}
          </g>

          {g.yTicks.map((v) => (
            <g key={v}>
              <line x1={g.m.l} x2={g.m.l + g.iw} y1={g.y(v)} y2={g.y(v)} stroke="rgba(255,255,255,0.07)" />
              <text x={g.m.l - 6} y={g.y(v) + 3.5} textAnchor="end" fontSize="11" fill="#94a3b8">
                {v}%
              </text>
            </g>
          ))}
          {g.xTicks.map((t, i) => (
            <g key={i}>
              {t.midnight && <line x1={t.x} x2={t.x} y1={g.m.t} y2={g.m.t + g.ih} stroke="rgba(255,255,255,0.14)" />}
              <text
                x={t.x}
                y={g.height - 12}
                textAnchor="middle"
                fontSize="11"
                fontWeight={t.midnight ? 600 : 400}
                fill={t.midnight ? "#e2e8f0" : "#94a3b8"}
              >
                {t.label}
              </text>
            </g>
          ))}
          {g.ov &&
            g.ovTicks.map((t) => (
              <text key={t.v} x={g.m.l + g.iw + 6} y={t.y + 3.5} fontSize="11" fill={g.ov?.color}>
                {t.v}
              </text>
            ))}

          <g clipPath={`url(#${clipId})`}>
            {g.bars.map((b) => (
              <rect key={b.key} x={b.x} y={b.y} width={b.w} height={b.h} rx="1.5" fill="#3b82f6" opacity="0.7" />
            ))}
            <path d={g.band} fill="#38bdf8" opacity="0.17" />
            {g.models.map((mo) => (
              <path key={mo.id} d={mo.d} fill="none" stroke={MODEL_COLORS[mo.id]} strokeWidth="1" opacity="0.75" />
            ))}
            {showModels && <path d={g.raw} fill="none" stroke="#e2e8f0" strokeWidth="1.4" strokeDasharray="4 3" opacity="0.8" />}
            {g.ov && <path d={g.ovPath} fill="none" stroke={g.ov.color} strokeWidth="1.6" opacity="0.9" />}
            <path d={g.line} fill="none" stroke="#38bdf8" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          </g>
          {g.obs.map((o) => (
            <circle key={o.t} cx={g.x(o.t)} cy={g.y(o.rh)} r="2.6" fill="#34d399" stroke="#022c22" strokeWidth="0.8" />
          ))}

          {/* Maintenant */}
          <line x1={xNow} x2={xNow} y1={g.m.t - 4} y2={g.m.t + g.ih} stroke="#ffffff" strokeDasharray="3 3" opacity="0.85" />
          <text x={xNow + 5} y={g.m.t + 6} fontSize="11" fontWeight="600" fill="#ffffff">
            maintenant
          </text>
          <circle cx={xNow} cy={g.y(now.rh)} r="4.5" fill="#38bdf8" stroke="#ffffff" strokeWidth="2" />

          {hovered && (
            <g pointerEvents="none">
              <line x1={g.x(hovered.t)} x2={g.x(hovered.t)} y1={g.m.t} y2={g.m.t + g.ih} stroke="rgba(255,255,255,0.45)" />
              <circle cx={g.x(hovered.t)} cy={g.y(hovered.rh)} r="5" fill="#38bdf8" stroke="#fff" strokeWidth="2" />
            </g>
          )}
        </svg>

        {hovered && (
          <div
            role="status"
            className="pointer-events-none absolute top-2 z-10 rounded-xl border border-white/10 bg-slate-900/95 p-3 text-xs shadow-xl backdrop-blur"
            style={{ left: tooltipLeft, width: TOOLTIP_W }}
          >
            <div className="mb-1.5 font-semibold text-white">
              {fmtDayHour(hovered.t, tz)}{" "}
              <span className="font-normal text-slate-400">{hovered.isPast ? "· passé" : "· prévision"}</span>
            </div>
            <Row k="Humidité estimée" v={`${Math.round(hovered.rh)} %`} color="#38bdf8" strong />
            <Row k="Fourchette probable" v={`${Math.round(hovered.rhLow)} – ${Math.round(hovered.rhHigh)} %`} />
            {hovered.obsRh !== null && <Row k="Mesuré (station)" v={`${Math.round(hovered.obsRh)} %`} color="#34d399" />}
            <Row
              k="Modèles bruts"
              v={`${Math.round(hovered.rhRaw)} % (${fmtSigned(hovered.rh - hovered.rhRaw)})`}
            />
            <p className="mt-0.5 text-[11px] text-slate-400">{BASIS_LABEL[hovered.basis]}</p>
            <div className="my-1.5 h-px bg-white/10" />
            <Row k="Température" v={`${fmtNum(hovered.temp, 1)} °C`} color="#fb923c" />
            <Row k="Point de rosée" v={`${fmtNum(hovered.dewPoint, 1)} °C`} />
            <Row k="Vent" v={hovered.wind === null ? "—" : `${fmtNum(hovered.wind)} km/h`} />
            <Row k="Nébulosité" v={hovered.cloud === null ? "—" : `${fmtNum(hovered.cloud)} %`} />
            <Row k="Pluie (1 h)" v={hovered.precip === null ? "—" : `${fmtNum(hovered.precip, 1)} mm`} color="#3b82f6" />
            {showModels && (
              <>
                <div className="my-1.5 h-px bg-white/10" />
                {members
                  .filter((mo) => hovered.perModel[mo.id] !== undefined && !mo.duplicate)
                  .map((mo) => (
                    <Row key={mo.id} k={mo.label} v={`${Math.round(hovered.perModel[mo.id] ?? 0)} %`} color={MODEL_COLORS[mo.id]} />
                  ))}
              </>
            )}
          </div>
        )}
      </div>

      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[11px] text-slate-300">
        <Legend swatch={<span className="h-0.5 w-4 rounded bg-sky-400" />} label="Humidité estimée" />
        <Legend swatch={<span className="h-2.5 w-3 rounded-sm bg-sky-400/30" />} label="Fourchette probable (≈ 80 %)" />
        {g.obs.length > 0 && station && (
          <Legend swatch={<span className="h-2 w-2 rounded-full bg-emerald-400" />} label={`Mesuré à la station ${station.name} (${station.id})`} />
        )}
        <Legend swatch={<span className="h-2.5 w-3 rounded-sm bg-blue-500/80" />} label="Pluie (mm/h)" />
        {g.ov && <Legend swatch={<span className="h-0.5 w-4 rounded" style={{ background: g.ov.color }} />} label={`${g.ov.label} (${g.ov.unit}, axe de droite)`} />}
        <Legend swatch={<span className="h-2.5 w-3 rounded-sm bg-slate-950 ring-1 ring-white/15" />} label="Nuit" />
        {showModels && (
          <>
            <Legend swatch={<span className="w-4 border-t-2 border-dashed border-slate-200" />} label="Consensus brut" />
            {members
              .filter((mo) => !mo.duplicate)
              .map((mo) => (
                <Legend key={mo.id} swatch={<span className="h-0.5 w-4 rounded" style={{ background: MODEL_COLORS[mo.id] }} />} label={mo.label} />
              ))}
          </>
        )}
      </ul>
    </section>
  );
}

function Toggle({ pressed, onClick, accent, children }: { pressed: boolean; onClick: () => void; accent?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "rounded-lg px-2.5 py-1 text-xs font-medium transition",
        pressed
          ? accent
            ? "bg-fuchsia-500/25 text-fuchsia-100 ring-1 ring-fuchsia-400/40"
            : "bg-sky-500/25 text-sky-100 ring-1 ring-sky-400/40"
          : "bg-white/5 text-slate-300 hover:bg-white/10"
      )}
    >
      {children}
    </button>
  );
}

function Row({ k, v, color, strong }: { k: string; v: string; color?: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-1.5 text-slate-300">
        {color && <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
        <span className="truncate">{k}</span>
      </span>
      <span className={cn("shrink-0 tabular-nums", strong ? "font-semibold text-white" : "text-slate-100")}>{v}</span>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span aria-hidden="true" className="flex w-4 items-center justify-center">
        {swatch}
      </span>
      {label}
    </li>
  );
}

export default memo(TimelineChart);
