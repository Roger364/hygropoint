import { memo, useEffect, useMemo, useRef, useState } from "react";
import { CircleMarker, MapContainer, Marker, TileLayer, Tooltip, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { StationSummary } from "../lib/estimate";
import { fmtNum } from "../lib/format";

interface Props {
  lat: number;
  lon: number;
  stations: StationSummary[];
  onPick: (lat: number, lon: number) => void;
}

const MAX_ZOOM = 19;

// Fond unique, sans clé d'API : les tuiles OpenStreetMap. Les fonds commerciaux
// (satellite, sombre) ont été retirés : leurs conditions d'usage ne sont pas
// compatibles avec la redistribution du projet.
const OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_CREDIT = {
  text: "© OpenStreetMap contributors",
  href: "https://www.openstreetmap.org/copyright",
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

function KeyboardHandler({ lat, lon, onPick }: { lat: number; lon: number; onPick: (lat: number, lon: number) => void }) {
  useMapEvents({
    keydown(e: L.LeafletKeyboardEvent) {
      const step = 0.0005;
      let newLat = lat;
      let newLon = lon;
      switch (e.originalEvent.key) {
        case "ArrowUp":
          newLat += step;
          break;
        case "ArrowDown":
          newLat -= step;
          break;
        case "ArrowLeft":
          newLon -= step;
          break;
        case "ArrowRight":
          newLon += step;
          break;
        default:
          return;
      }
      e.originalEvent.preventDefault();
      onPick(newLat, newLon);
    },
  });
  return null;
}

const mediaMatches = (query: string): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;

function MapPicker({ lat, lon, stations, onPick }: Props) {
  const [map, setMap] = useState<L.Map | null>(null);
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
  // `invalidateSize` lit les dimensions : on le fait dans une image séparée, et
  // seulement si elles ont réellement changé, pour ne pas déclencher une mise en page
  // synchrone juste après les écritures DOM de React (reflow forcé).
  useEffect(() => {
    const el = wrapRef.current;
    if (!map || !el || typeof ResizeObserver === "undefined") return;
    let w = 0;
    let h = 0;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (width === 0 || height === 0) return;
      if (width === w && height === h) return;
      w = width;
      h = height;
      map.invalidateSize({ animate: false, pan: false });
    };
    const ro = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    });
    ro.observe(el);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [map]);

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
    <div
      ref={wrapRef}
      role="application"
      aria-label="Carte interactive — flèches pour déplacer le point choisi"
      className="relative isolate h-full w-full overflow-hidden rounded-3xl"
    >
      <img
        src="/img/hero-512.webp"
        alt=""
        aria-hidden="true"
        fetchPriority="high"
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
      />
      <MapContainer
        ref={setMap}
        center={[lat, lon]}
        zoom={12}
        maxZoom={MAX_ZOOM}
        className="h-full w-full"
        zoomControl={false}
        attributionControl={false}
        dragging={!coarse}
        keyboard={true}
      >
        <TileLayer url={OSM_TILES} maxNativeZoom={19} maxZoom={MAX_ZOOM} />
        <ClickHandler onPick={onPick} />
        <KeyboardHandler lat={lat} lon={lon} onPick={onPick} />
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
          keyboard
          eventHandlers={markerHandlers}
          alt="Point choisi"
          title="Point choisi — flèches pour le déplacer"
          zIndexOffset={1000}
        />
      </MapContainer>

      {/* Les contrôles sont hors du conteneur Leaflet : un clic dessus ne déplace pas le point. */}
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

      <div className="pointer-events-none absolute bottom-12 left-2 z-[1000]">
        <span aria-live="polite" className="sr-only">
          Point choisi : {lat.toFixed(4)}, {lon.toFixed(4)}
        </span>
      </div>

      <div className="absolute inset-x-2 bottom-2 z-[1000] flex items-end justify-between gap-2 text-[10px] leading-tight">
        <span className="pointer-events-none rounded-lg bg-slate-950/80 px-2 py-1 text-slate-200 backdrop-blur">
          {coarse ? "Touchez pour placer le point · deux doigts pour déplacer la carte" : "Cliquez ou utilisez les flèches pour placer le point"}
        </span>
        <a
          href={OSM_CREDIT.href}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 rounded-lg bg-slate-950/80 px-2 py-1 text-slate-200 underline-offset-2 backdrop-blur hover:underline"
        >
          {OSM_CREDIT.text}
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
