import { memo, useEffect, useMemo, useRef, useState } from "react";
import { CircleMarker, MapContainer, Marker, TileLayer, Tooltip, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { StationSummary } from "../lib/estimate";
import { fmtNum } from "../lib/format";
import { cn } from "../utils/cn";

interface Props {
  lat: number;
  lon: number;
  stations: StationSummary[];
  onPick: (lat: number, lon: number) => void;
}

type MapStyle = "streets" | "satellite" | "dark";

interface LayerDef {
  label: string;
  tiles: { url: string; maxNativeZoom: number; maxZoom?: number }[];
  credit: { text: string; href: string };
}

const ESRI_SERVER = "https://server.arcgisonline.com/ArcGIS/rest/services";
const ESRI_CANVAS = "https://services.arcgisonline.com/arcgis/rest/services/Canvas";
const MAX_ZOOM = 19;

// Fonds sans clé d'API. Les fonds Esri sans libellés reçoivent une couche de noms par-dessus.
const LAYERS: Record<MapStyle, LayerDef> = {
  streets: {
    label: "Plan",
    tiles: [{ url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maxNativeZoom: 19 }],
    credit: { text: "© OpenStreetMap", href: "https://www.openstreetmap.org/copyright" },
  },
  satellite: {
    label: "Satellite",
    tiles: [
      { url: `${ESRI_SERVER}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 17 },
      {
        url: `${ESRI_SERVER}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
        maxNativeZoom: 13,
        maxZoom: 15,
      },
    ],
    credit: { text: "© Esri, Maxar", href: "https://www.esri.com/" },
  },
  dark: {
    label: "Sombre",
    tiles: [
      { url: `${ESRI_CANVAS}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 16 },
      { url: `${ESRI_CANVAS}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 16 },
    ],
    credit: { text: "© Esri", href: "https://www.esri.com/" },
  },
};

// Repère dont la pointe coïncide exactement avec le point désigné.
const pinIcon = L.divIcon({
  className: "hp-pin",
  html:
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40" aria-hidden="true">' +
    '<defs><linearGradient id="hpPinG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#38bdf8"/>' +
    '<stop offset="1" stop-color="#6366f1"/></linearGradient></defs>' +
    '<path d="M15 38.5C15 38.5 3.5 24.6 3.5 15a11.5 11.5 0 1 1 23 0C26.5 24.6 15 38.5 15 38.5Z" ' +
    'fill="url(#hpPinG)" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>' +
    '<circle cx="15" cy="15" r="4.2" fill="#fff"/></svg>',
  iconSize: [30, 40],
  iconAnchor: [15, 39],
});

function ClickHandler({ onPick }: { onPick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

const mediaMatches = (query: string): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;

function MapPicker({ lat, lon, stations, onPick }: Props) {
  const [map, setMap] = useState<L.Map | null>(null);
  const [style, setStyle] = useState<MapStyle>("streets");
  const [wheelHint, setWheelHint] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const coarse = useMemo(() => mediaMatches("(pointer: coarse)"), []);
  const reducedMotion = useMemo(() => mediaMatches("(prefers-reduced-motion: reduce)"), []);
  const isMac = useMemo(() => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? ""), []);

  const markerHandlers = useMemo(
    () => ({
      dragend(e: L.DragEndEvent) {
        const p = (e.target as L.Marker).getLatLng();
        onPick(p.lat, p.lng);
      },
    }),
    [onPick]
  );

  // Recentrage quand le point change et sort de la zone visible.
  useEffect(() => {
    if (!map) return;
    const target = L.latLng(lat, lon);
    if (map.getBounds().pad(-0.15).contains(target)) return;
    const zoom = Math.max(map.getZoom(), 13);
    if (reducedMotion) map.setView(target, zoom, { animate: false });
    else map.flyTo(target, zoom, { duration: 0.8 });
  }, [map, lat, lon, reducedMotion]);

  // La molette fait défiler la page ; elle ne zoome la carte qu'avec Ctrl/⌘ (ou un pincement au pavé tactile).
  useEffect(() => {
    const el = wrapRef.current;
    if (!map || !el) return;
    map.scrollWheelZoom.disable();
    let timer = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        map.scrollWheelZoom.enable();
        setWheelHint(false);
      } else {
        map.scrollWheelZoom.disable();
        setWheelHint(true);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setWheelHint(false), 1400);
      }
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel, { capture: true });
      window.clearTimeout(timer);
    };
  }, [map]);

  // La carte change de taille avec la mise en page, pas seulement avec la fenêtre.
  useEffect(() => {
    const el = wrapRef.current;
    if (!map || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);

  const layer = LAYERS[style];

  const recenter = () => {
    if (!map) return;
    map.setView([lat, lon], Math.max(map.getZoom(), 14), { animate: !reducedMotion });
  };
  const showStations = () => {
    if (!map || !stations.length) return;
    const bounds = L.latLngBounds([[lat, lon], ...stations.map((s) => [s.lat, s.lon] as [number, number])]);
    map.fitBounds(bounds.pad(0.25), { animate: !reducedMotion });
  };

  return (
    <div ref={wrapRef} className="relative isolate h-full w-full overflow-hidden rounded-3xl">
      <MapContainer
        ref={setMap}
        center={[lat, lon]}
        zoom={12}
        maxZoom={MAX_ZOOM}
        className="h-full w-full"
        zoomControl={false}
        attributionControl={false}
        dragging={!coarse}
      >
        {layer.tiles.map((t) => (
          <TileLayer key={`${style}-${t.url}`} url={t.url} maxNativeZoom={t.maxNativeZoom} maxZoom={t.maxZoom ?? MAX_ZOOM} />
        ))}
        <ClickHandler onPick={onPick} />
        {stations.map((s) => (
          <CircleMarker
            key={s.id}
            center={[s.lat, s.lon]}
            radius={6}
            bubblingMouseEvents={false}
            pathOptions={{ color: "#ffffff", weight: 1.5, fillColor: "#34d399", fillOpacity: 0.95 }}
          >
            <Tooltip direction="top" offset={[0, -6]}>
              {s.name} · {fmtNum(s.distanceKm, 1)} km · {Math.round(s.last.rh)} % mesuré
            </Tooltip>
          </CircleMarker>
        ))}
        <Marker
          position={[lat, lon]}
          icon={pinIcon}
          draggable
          eventHandlers={markerHandlers}
          alt="Point choisi"
          title="Point choisi — glissez pour l'ajuster"
          zIndexOffset={1000}
        />
      </MapContainer>

      {/* Les contrôles sont hors du conteneur Leaflet : un clic dessus ne déplace pas le point. */}
      <div
        role="group"
        aria-label="Fond de carte"
        className="absolute left-2 top-2 z-[1000] flex gap-1 rounded-xl border border-white/10 bg-slate-900/85 p-1 shadow-lg backdrop-blur"
      >
        {(Object.keys(LAYERS) as MapStyle[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={style === key}
            onClick={() => setStyle(key)}
            className={cn(
              "rounded-lg px-2.5 py-1 text-[11px] font-semibold transition",
              style === key ? "bg-sky-500 text-white shadow-sm" : "text-slate-200 hover:bg-white/10 hover:text-white"
            )}
          >
            {LAYERS[key].label}
          </button>
        ))}
      </div>

      <div className="absolute right-2 top-2 z-[1000] flex flex-col overflow-hidden rounded-xl border border-white/10 bg-slate-900/85 shadow-lg backdrop-blur">
        <CtlButton label="Zoomer" onClick={() => map?.zoomIn()}>
          +
        </CtlButton>
        <CtlButton label="Dézoomer" onClick={() => map?.zoomOut()}>
          −
        </CtlButton>
        <CtlButton label="Recentrer sur le point choisi" onClick={recenter}>
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 3v4M12 17v4M3 12h4M17 12h4" strokeLinecap="round" />
          </svg>
        </CtlButton>
        {stations.length > 0 && (
          <CtlButton label="Voir les stations de mesure" onClick={showStations}>
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full border border-white bg-emerald-400" />
          </CtlButton>
        )}
      </div>

      {wheelHint && (
        <div className="pointer-events-none absolute inset-0 z-[1000] flex items-center justify-center bg-slate-950/45">
          <span className="rounded-xl bg-slate-900/90 px-3 py-2 text-xs font-medium text-white shadow-lg">
            {isMac ? "⌘" : "Ctrl"} + molette pour zoomer la carte
          </span>
        </div>
      )}

      <div className="absolute inset-x-2 bottom-2 z-[1000] flex items-end justify-between gap-2 text-[10px] leading-tight">
        <span className="pointer-events-none rounded-lg bg-slate-950/80 px-2 py-1 text-slate-200 backdrop-blur">
          {coarse ? "Touchez pour placer le point · deux doigts pour déplacer la carte" : "Cliquez pour placer le point · glissez le repère pour l'ajuster"}
        </span>
        <a
          href={layer.credit.href}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 rounded-lg bg-slate-950/80 px-2 py-1 text-slate-200 underline-offset-2 backdrop-blur hover:underline"
        >
          {layer.credit.text}
        </a>
      </div>
    </div>
  );
}

function CtlButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center border-b border-white/10 text-base font-bold text-white transition last:border-b-0 hover:bg-white/10 active:bg-white/20"
    >
      {children}
    </button>
  );
}

export default memo(MapPicker);
