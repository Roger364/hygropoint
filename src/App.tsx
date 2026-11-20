import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import HourlyTable from "./components/HourlyTable";
import MapPicker from "./components/MapPicker";
import NowCard from "./components/NowCard";
import RetrospectiveCard from "./components/RetrospectiveCard";
import SearchBar from "./components/SearchBar";
import TerrainCard from "./components/TerrainCard";
import TimelineChart from "./components/TimelineChart";
import VerdictCard from "./components/VerdictCard";
import { useHumidity, type Place, type EstimationCore } from "./hooks/useHumidity";
import { computeEstimate, rhColor, type EstimateResult, type HourEstimate, type LearnedBias } from "./lib/estimate";
import { runRetrospective, type Retrospective } from "./lib/retrospective";
import { DEFAULT_TUNE, isDefaultTune, type Tune } from "./lib/tune";
import { fmtAgo, fmtCoord, fmtDayShort, fmtFull, fmtHour, localDayKey } from "./lib/format";
import { haversineKm, type ReverseResult } from "./lib/geo";
import { EMPTY_TERRAIN, type TerrainInfo } from "./lib/terrain";
import { cn } from "./utils/cn";
import type { ModelData } from "./lib/openmeteo";

const Terrain3D = lazy(() => import("./components/Terrain3D"));

const STORAGE_KEY = "hygropoint.place";
const LEGACY_KEY = "hr-place";
const DEFAULT_PLACE: Place = { lat: 48.8566, lon: 2.3522, label: "Paris, France", countryCode: "FR", resolved: true };

const GEO_ERRORS: Record<number, string> = {
  1: "Accès à votre position refusé. Autorisez la localisation, ou désignez le point sur la carte.",
  2: "Votre position est indisponible pour le moment.",
  3: "La localisation a pris trop de temps. Réessayez.",
};

/** Dernier lieu consulté. Le contenu du stockage est validé : il peut être absent, ancien ou altéré. */
function readStoredPlace(): Place | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Record<string, unknown> | null;
    if (!o || typeof o.lat !== "number" || typeof o.lon !== "number") return null;
    if (!Number.isFinite(o.lat) || !Number.isFinite(o.lon) || Math.abs(o.lat) > 90 || Math.abs(o.lon) > 180) return null;
    const label = typeof o.label === "string" && o.label.trim() ? o.label.slice(0, 200) : fmtCoord(o.lat, o.lon);
    return {
      lat: o.lat,
      lon: o.lon,
      label,
      countryCode: typeof o.countryCode === "string" ? o.countryCode.slice(0, 2).toUpperCase() : undefined,
      state: typeof o.state === "string" ? o.state.slice(0, 80) : undefined,
      resolved: true,
    };
  } catch {
    return null;
  }
}

function storePlace(p: Place): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Stockage indisponible (navigation privée, cadre restreint) : sans conséquence.
  }
}

interface DaySummary {
  key: string;
  label: string;
  span: string;
  mean: number;
  min: number;
  max: number;
  rain: number;
}

export default function App() {
  const [place, setPlace] = useState<Place>(() => readStoredPlace() ?? DEFAULT_PLACE);
  const [locating, setLocating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  // Le nom du lieu arrive après coup : il met à jour le libellé sans relancer le chargement.
  const onResolved = useCallback((r: ReverseResult, lat: number, lon: number) => {
    setPlace((p) =>
      p.lat === lat && p.lon === lon
        ? { ...p, label: p.resolved === false ? r.label : p.label, countryCode: r.countryCode, state: r.state, resolved: true }
        : p
    );
  }, []);

  const { result: loaded, point, terrain, core, loading, error, loadedAt, refresh } = useHumidity(place, onResolved);

  // Hypothèses réglables : l'estimation est une fonction pure de ces entrées, donc un
  // curseur recalcule tout instantanément, sans requête. Le calcul est différé pour que
  // le curseur reste fluide.
  const [tune, setTune] = useState<Tune>(DEFAULT_TUNE);
  const [learned, setLearned] = useState<LearnedBias | null>(null);
  const [retro, setRetro] = useState<Retrospective | null>(null);
  const [retroBusy, setRetroBusy] = useState(false);
  const [retroError, setRetroError] = useState<string | null>(null);
  const deferredTune = useDeferredValue(tune);
  const result = useMemo(() => {
    if (!core) return loaded;
    try {
      return computeEstimate(core.point, core.stations, core.note, core.nowMs, terrain, deferredTune, learned);
    } catch {
      return loaded;
    }
  }, [core, terrain, deferredTune, loaded, learned]);
  const [showTerrain3D, setShowTerrain3D] = useState(false);
  const terrainPlaceholderRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = terrainPlaceholderRef.current;
    if (!el || showTerrain3D) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setShowTerrain3D(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [showTerrain3D]);
  const [staleResult, setStaleResult] = useState<EstimateResult | null>(null);
  const [stalePoint, setStalePoint] = useState<ModelData | null>(null);
  const [staleCore, setStaleCore] = useState<EstimationCore | null>(null);
  const [staleTerrain, setStaleTerrain] = useState<TerrainInfo | null>(null);
  useEffect(() => {
    if (result) setStaleResult(result);
    if (point) setStalePoint(point);
    if (core) setStaleCore(core);
    if (terrain) setStaleTerrain(terrain);
  }, [result, point, core, terrain]);
  const displayResult = result ?? staleResult;
  const displayPoint = point ?? stalePoint;
  const displayCore = core ?? staleCore;
  const displayTerrain = terrain ?? staleTerrain ?? EMPTY_TERRAIN;
  const baseline = useMemo(() => {
    if (!displayCore || isDefaultTune(deferredTune)) return null;
    try {
      return computeEstimate(displayCore.point, displayCore.stations, displayCore.note, displayCore.nowMs, displayTerrain, DEFAULT_TUNE);
    } catch {
      return null;
    }
  }, [displayCore, displayTerrain, deferredTune]);

  // Un nouveau lieu invalide les réglages : ils décrivent un terrain précis.
  useEffect(() => {
    setTune(DEFAULT_TUNE);
    setLearned(null);
    setRetro(null);
    setRetroError(null);
  }, [place.lat, place.lon]);

  useEffect(() => storePlace(place), [place]);

  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const rhNow = result ? Math.round(result.now.rh) : null;
  useEffect(() => {
    document.title = rhNow !== null ? `${rhNow} % · ${place.label} — HygroPoint` : "HygroPoint — Humidité relative précise";
  }, [rhNow, place.label]);

  const comparePast = useCallback(async () => {
    if (!core?.stations.length || retroBusy) return;
    setRetroBusy(true);
    setRetroError(null);
    try {
      const report = await runRetrospective(core.stations);
      setRetro(report);
      setLearned(report.learned);
    } catch (e) {
      setRetroError(e instanceof Error ? e.message : "Comparaison impossible.");
    } finally {
      setRetroBusy(false);
    }
  }, [core, retroBusy]);

  const selectPlace = useCallback((p: Place) => {
    setNotice(null);
    setPlace(p);
  }, []);

  const pickOnMap = useCallback((lat: number, lon: number) => {
    setNotice(null);
    // Point voisin du précédent : même pays a priori, ce qui évite d'attendre le service de noms de lieux.
    setPlace((prev) => {
      const near = prev.countryCode !== undefined && haversineKm(prev.lat, prev.lon, lat, lon) <= 30;
      return {
        lat,
        lon,
        label: fmtCoord(lat, lon),
        resolved: false,
        countryCode: near ? prev.countryCode : undefined,
        state: near ? prev.state : undefined,
      };
    });
  }, []);

  const locate = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setNotice("La géolocalisation n'est pas disponible dans ce navigateur.");
      return;
    }
    setLocating(true);
    setNotice(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        pickOnMap(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => {
        setLocating(false);
        setNotice(GEO_ERRORS[err.code] ?? "Localisation impossible.");
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 }
    );
  }, [pickOnMap]);

  const tz = displayPoint?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const stations = displayResult?.stations ?? NO_STATIONS;

  // Repères de la carte en relief : figés par chargement. Les recréer à chaque rendu
  // reconstruirait toute la scène WebGL (horloge, curseurs d’hypothèses…).
  const reliefStations = useMemo(
    () => (displayCore?.stations ?? []).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, distanceKm: s.distanceKm })),
    [displayCore]
  );

  // Synthèse par journée locale. Les journées incomplètes annoncent la plage réellement couverte ;
  // les bribes de moins de 4 h sont omises.
  const days = useMemo<DaySummary[]>(() => {
    if (!displayResult) return [];
    const groups = new Map<string, HourEstimate[]>();
    for (const h of displayResult.next72) {
      const key = localDayKey(h.t, tz);
      const list = groups.get(key);
      if (list) list.push(h);
      else groups.set(key, [h]);
    }
    const today = localDayKey(displayResult.computedAt, tz);
    const tomorrow = localDayKey(displayResult.computedAt + 24 * 3.6e6, tz);
    return [...groups.entries()]
      .filter(([, hs]) => hs.length >= 4)
      .slice(0, 4)
      .map(([key, hs]) => {
      const rhs = hs.map((h) => h.rh);
      return {
        key,
        label: key === today ? "Aujourd'hui" : key === tomorrow ? "Demain" : fmtDayShort(hs[0].t, tz),
        span: hs.length >= 23 ? "journée entière" : `${fmtHour(hs[0].t, tz)} → ${fmtHour(hs[hs.length - 1].t, tz)}`,
        mean: rhs.reduce((a, b) => a + b, 0) / rhs.length,
        min: Math.min(...rhs),
        max: Math.max(...rhs),
        rain: hs.reduce((a, h) => a + (h.precip ?? 0), 0),
      };
    });
  }, [displayResult, tz]);

  const ambient = displayResult ? rhColor(displayResult.now.rh) : "#38bdf8";

  return (
    <div className="relative min-h-screen bg-slate-950 text-slate-100">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
        <div
          className="absolute -left-40 -top-40 h-[32rem] w-[32rem] rounded-full opacity-25 blur-3xl transition-colors duration-1000"
          style={{ background: ambient }}
        />
        <div className="absolute -bottom-40 -right-40 h-[36rem] w-[36rem] rounded-full bg-indigo-600 opacity-20 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-7xl px-4 pb-14 pt-5 sm:px-6">
        {/* Bandeau expérience technique */}
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-200">
          <span className="font-semibold">Expérience technique</span> — estimation indicative de l&apos;humidité relative.
          &nbsp;·&nbsp;
          <a href="#sources" className="underline hover:text-amber-100">Sources de données</a>
          &nbsp;·&nbsp;
          <span className="text-amber-300/80">Vos coordonnées sont envoyées aux services météo listés ci-dessous.</span>
        </div>
        <header className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div
              aria-hidden="true"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-400 to-indigo-500 text-2xl shadow-lg shadow-sky-500/30"
            >
              💧
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-white">
                Hygro<span className="text-sky-300">Point</span>
              </h1>
              <p className="text-xs text-slate-400">Humidité relative de l'air, à l'endroit précis que vous désignez</p>
            </div>
          </div>

          <div className="flex w-full items-center gap-2 lg:max-w-2xl">
            <SearchBar onSelect={selectPlace} onLocate={locate} locating={locating} />
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label="Actualiser les données"
              title="Actualiser les données"
              className="flex h-12 shrink-0 items-center gap-2 rounded-2xl bg-gradient-to-r from-sky-500 to-indigo-500 px-3.5 text-sm font-semibold text-white shadow-lg shadow-sky-500/25 transition hover:brightness-110 active:scale-95 disabled:opacity-70 sm:px-4"
            >
              <svg
                aria-hidden="true"
                className={cn("h-5 w-5", loading && "animate-spin")}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
              <span className="hidden sm:inline">Actualiser</span>
            </button>
          </div>
        </header>

        {/* Annonce vocale limitée aux changements d'état : l'heure affichée ne doit pas être relue chaque minute. */}
        <p role="status" className="sr-only">
          {loading ? "Actualisation en cours" : error ? "Échec de la dernière actualisation" : result ? "Données à jour" : ""}
        </p>
        <p className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
          <span className="flex items-center gap-1.5 text-slate-300">
            <span
              aria-hidden="true"
              className={cn(
                "h-2 w-2 rounded-full",
                loading ? "animate-pulse bg-amber-400" : error ? "bg-rose-400" : "bg-emerald-400"
              )}
            />
            {loading
              ? "Actualisation en cours…"
              : error
                ? "Échec de la dernière actualisation"
                : loadedAt
                  ? `Données actualisées ${fmtAgo(loadedAt, clock)}`
                  : "En attente"}
          </span>
          <span className="hidden sm:inline">Actualisation automatique toutes les 15 min</span>
          <span className="font-mono">{fmtCoord(place.lat, place.lon)}</span>
          <span className="tabular-nums">Heure du lieu : {fmtFull(clock, tz)}</span>
        </p>

        {(error || notice) && (
          <div
            role="alert"
            className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
          >
            <span>
              {error ?? notice}
              {error && result && loadedAt && ` Les données affichées datent de ${fmtHour(loadedAt)}.`}
            </span>
            {error ? (
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-lg bg-rose-500/30 px-3 py-1 text-xs font-semibold transition hover:bg-rose-500/45"
              >
                Réessayer
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="rounded-lg bg-rose-500/30 px-3 py-1 text-xs font-semibold transition hover:bg-rose-500/45"
              >
                Fermer
              </button>
            )}
          </div>
        )}

        <main className={cn("flex flex-col gap-5 transition-opacity", loading && displayResult && "opacity-70", "lg:min-h-[3400px]")} aria-busy={loading}>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div key="map-container" className="order-1 hp-map-wrap h-[320px] overflow-hidden rounded-3xl border border-white/10 shadow-2xl shadow-black/30 lg:order-2 lg:h-[440px] lg:min-h-[440px]" style={{ minHeight: "320px" }}>
              <ErrorBoundary label="La carte">
                <MapPicker lat={place.lat} lon={place.lon} stations={stations} onPick={pickOnMap} />
              </ErrorBoundary>
            </div>
            <div key="hero" className="order-2 lg:order-1">
              {displayResult ? (
                <NowCard result={displayResult} placeLabel={place.label} clock={clock} />
              ) : (
                <div className="hp-now-fallback flex min-h-[420px] items-center justify-center rounded-3xl border border-white/10 bg-white/[0.04] p-6 text-sm text-slate-400 lg:min-h-[440px]">
                  {error ? (
                    "Aucune donnée à afficher pour ce point."
                  ) : (
                    <span className="flex items-center gap-3">
                      <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 border-slate-600 border-t-sky-300" />
                      Interrogation des modèles et des stations de mesure…
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {displayResult && displayPoint && (
              <>
                {days.length > 0 && (
                <ul aria-label="Synthèse par journée" className={cn("grid grid-cols-2 gap-3", days.length >= 4 ? "md:grid-cols-4" : "md:grid-cols-3")}>
                  {days.map((d) => (
                    <li key={d.key} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur-xl">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">{d.label}</span>
                        {d.rain >= 0.5 && (
                          <span className="text-xs text-blue-300">
                            <span aria-hidden="true">🌧️ </span>
                            {d.rain.toFixed(1).replace(".", ",")} mm
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400">{d.span}</p>
                      <div className="mt-1 flex items-baseline gap-1">
                        <span className="text-3xl font-bold tabular-nums" style={{ color: rhColor(d.mean) }}>
                          {Math.round(d.mean)}
                        </span>
                        <span className="whitespace-nowrap text-xs text-slate-400 sm:text-sm">% en moyenne</span>
                      </div>
                      <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-400">
                        <span>min {Math.round(d.min)}</span>
                        <div aria-hidden="true" className="relative h-1.5 flex-1 rounded-full bg-white/10">
                          <div
                            className="absolute h-full rounded-full"
                            style={{
                              left: `${d.min}%`,
                              width: `${Math.max(2, d.max - d.min)}%`,
                              background: `linear-gradient(90deg, ${rhColor(d.min)}, ${rhColor(d.max)})`,
                            }}
                          />
                        </div>
                        <span>max {Math.round(d.max)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <nav aria-label="Aller à une section" className="flex flex-wrap gap-2">
                <NavLink href="#relief" icon="⛰️" label="Relief 3D et réglages" primary />
                <NavLink href="#evolution" icon="📈" label="Évolution 24 h / 72 h" />
                <NavLink href="#detail" icon="🕐" label="Détail heure par heure" />
              </nav>

              <div className="hp-below"><RetrospectiveCard
                report={retro}
                busy={retroBusy}
                error={retroError}
                disabled={!displayCore?.stations.length}
                onRun={() => void comparePast()}
              /></div>

              <ErrorBoundary label="La carte en relief">
                {showTerrain3D ? (
                <Suspense fallback={
                  <div className="flex min-h-[440px] items-center justify-center rounded-3xl border border-white/10 bg-white/[0.04]">
                    <span className="flex items-center gap-3 text-sm text-slate-400">
                      <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 border-slate-600 border-t-sky-300" />
                      Chargement du relief 3D…
                    </span>
                  </div>
                }>
                  <Terrain3D
                    lat={place.lat}
                    lon={place.lon}
                    features={displayTerrain.features}
                    stations={reliefStations}
                    nowMs={displayResult.computedAt}
                    tz={tz}
                    onPick={pickOnMap}
                    tune={tune}
                    onTune={setTune}
                    deltaRh={baseline ? displayResult.now.rh - baseline.now.rh : 0}
                    deltaSigma={baseline ? displayResult.now.sigma - baseline.now.sigma : 0}
                    rhNow={displayResult.now.rh}
                  />
                </Suspense>
              ) : (
                <div
                  ref={terrainPlaceholderRef}
                  className="flex min-h-[440px] items-center justify-center rounded-3xl border border-white/10 bg-white/[0.04]"
                >
                  <span className="flex items-center gap-3 text-sm text-slate-400">
                    <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 border-slate-600 border-t-sky-300" />
                    Chargement du relief 3D…
                  </span>
                </div>
              )}
              </ErrorBoundary>

              <ErrorBoundary label="Le graphique">
                <TimelineChart hours={displayResult.hours} now={displayResult.now} station={stations[0] ?? null} members={displayResult.members} tz={tz} />
              </ErrorBoundary>

              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
                <HourlyTable result={displayResult} tz={tz} />
                <div className="flex flex-col gap-5">
                  <TerrainCard result={displayResult} terrain={displayTerrain} tune={tune} />
                  <VerdictCard result={displayResult} point={displayPoint} />
                </div>
              </div>
            </>
          )}
        </main>

        <footer id="sources" className="mt-10 text-center text-[11px] leading-relaxed text-slate-400">
          HygroPoint · Modèles : Open-Meteo (CC BY 4.0) · Mesures : METAR via Iowa Environmental Mesonet · Lieux : Photon /
          OpenStreetMap · Fonds de carte : © OpenStreetMap contributors · Estimation indicative
        </footer>
      </div>
    </div>
  );
}

const NO_STATIONS: never[] = [];

function NavLink({ href, icon, label, primary }: { href: string; icon: string; label: string; primary?: boolean }) {
  return (
    <a
      href={href}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition",
        primary
          ? "border-sky-400/40 bg-sky-500/20 text-sky-100 shadow-lg shadow-sky-500/20 hover:bg-sky-500/30"
          : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white"
      )}
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </a>
  );
}
