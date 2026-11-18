import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { fmtCoord } from "../lib/format";
import { parseCoordinates, searchPlaces, type GeoPlace, type PlaceKind } from "../lib/geo";
import { isAbort } from "../lib/http";
import type { Place } from "../hooks/useHumidity";
import { cn } from "../utils/cn";

interface Props {
  onSelect: (place: Place) => void;
  onLocate: () => void;
  locating: boolean;
}

type Status = "idle" | "loading" | "empty" | "error";

const KIND_ICON: Record<PlaceKind, string> = {
  house: "🏠",
  street: "🛣️",
  city: "🏙️",
  region: "🗺️",
  nature: "⛰️",
  other: "📍",
};

export default function SearchBar({ onSelect, onLocate, locating }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoPlace[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const skipNextSearch = useRef(false);
  const listId = useId();

  const coords = useMemo(() => parseCoordinates(query), [query]);
  const trimmed = query.trim();
  const optionCount = coords ? 1 : results.length;

  const runSearch = useCallback(async (q: string): Promise<GeoPlace[] | null> => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStatus("loading");
    try {
      const found = await searchPlaces(q, ctrl.signal);
      if (ctrl.signal.aborted) return null;
      setResults(found);
      setStatus(found.length ? "idle" : "empty");
      setActive(-1);
      setOpen(true);
      return found;
    } catch (e) {
      if (isAbort(e) || ctrl.signal.aborted) return null;
      setResults([]);
      setStatus("error");
      setOpen(true);
      return null;
    }
  }, []);

  // Recherche en cours de frappe (temporisée). Une réponse périmée est annulée, jamais affichée.
  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return;
    }
    if (coords || trimmed.length < 3) {
      abortRef.current?.abort();
      setResults([]);
      setStatus("idle");
      return;
    }
    const id = window.setTimeout(() => void runSearch(trimmed), 300);
    return () => window.clearTimeout(id);
  }, [trimmed, coords, runSearch]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  const commit = (place: Place) => {
    // Le libellé recopié dans le champ ne doit pas relancer une recherche.
    if (place.label !== query) skipNextSearch.current = true;
    abortRef.current?.abort();
    setQuery(place.label);
    setResults([]);
    setStatus("idle");
    setOpen(false);
    setActive(-1);
    inputRef.current?.blur();
    onSelect(place);
  };

  const choose = (p: GeoPlace) =>
    commit({ lat: p.lat, lon: p.lon, label: p.label, countryCode: p.countryCode, state: p.state, resolved: true });

  const chooseCoords = (c: { lat: number; lon: number }) =>
    commit({ lat: c.lat, lon: c.lon, label: fmtCoord(c.lat, c.lon), resolved: false });

  const submit = async () => {
    if (coords) return chooseCoords(coords);
    const picked = results[active] ?? results[0];
    if (picked) return choose(picked);
    if (trimmed.length < 3) return;
    const found = await runSearch(trimmed);
    if (found?.[0]) choose(found[0]);
  };

  const showPanel = open && (coords !== null || results.length > 0 || status !== "idle");

  return (
    <div ref={boxRef} className="relative min-w-0 flex-1">
      <form
        role="search"
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="relative min-w-0 flex-1">
          <label htmlFor={`${listId}-input`} className="sr-only">
            Rechercher un lieu, une adresse ou des coordonnées
          </label>
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute left-3.5 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-slate-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            id={`${listId}-input`}
            type="text"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={showPanel}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? `${listId}-opt-${active}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && optionCount > 0) {
                e.preventDefault();
                setOpen(true);
                setActive((a) => (a + 1) % optionCount);
              } else if (e.key === "ArrowUp" && optionCount > 0) {
                e.preventDefault();
                setActive((a) => (a <= 0 ? optionCount - 1 : a - 1));
              } else if (e.key === "Escape") {
                setOpen(false);
                setActive(-1);
              }
            }}
            placeholder="Adresse, lieu ou coordonnées"
            title="Exemples : 12 rue de la Paix, Paris · Chamrousse · 45.1885, 5.7245"
            className={cn(
              "h-12 w-full text-ellipsis rounded-2xl border border-white/10 bg-white/[0.06] pl-11 text-[15px] text-white outline-none ring-sky-400/40 transition placeholder:text-slate-400 focus:border-sky-400/50 focus:bg-white/[0.09] focus:ring-4",
              query ? "pr-12" : "pr-4"
            )}
          />
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
            {status === "loading" && (
              <span
                aria-hidden="true"
                className="h-4 w-4 animate-spin rounded-full border-2 border-slate-500 border-t-sky-300"
              />
            )}
            {query && (
              <button
                type="button"
                aria-label="Effacer la recherche"
                onClick={() => {
                  setQuery("");
                  setOpen(false);
                  inputRef.current?.focus();
                }}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/10 hover:text-white"
              >
                <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onLocate}
          disabled={locating}
          aria-label="Utiliser ma position actuelle"
          title="Utiliser ma position actuelle"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06] text-sky-200 transition hover:bg-white/[0.12] active:scale-95 disabled:opacity-60"
        >
          {locating ? (
            <span aria-hidden="true" className="h-4.5 w-4.5 animate-spin rounded-full border-2 border-slate-500 border-t-sky-300" />
          ) : (
            <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <circle cx="12" cy="12" r="8" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </form>

      {showPanel && (
        <div className="absolute z-30 mt-2 w-full overflow-hidden rounded-2xl border border-white/10 bg-slate-900/95 shadow-2xl shadow-black/50 backdrop-blur-xl">
          <ul id={listId} role="listbox" aria-label="Suggestions de lieux" className="max-h-80 overflow-auto p-1.5">
            {coords && (
              <Option id={`${listId}-opt-0`} active={active === 0} onHover={() => setActive(0)} onPick={() => chooseCoords(coords)}>
                <Icon>🎯</Icon>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-white">Aller à ces coordonnées</span>
                  <span className="block truncate font-mono text-xs text-slate-400">{fmtCoord(coords.lat, coords.lon)}</span>
                </span>
              </Option>
            )}
            {!coords &&
              results.map((p, i) => (
                <Option key={p.id} id={`${listId}-opt-${i}`} active={i === active} onHover={() => setActive(i)} onPick={() => choose(p)}>
                  <Icon>{KIND_ICON[p.kind]}</Icon>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-white">{p.name}</span>
                    {p.detail && <span className="block truncate text-xs text-slate-400">{p.detail}</span>}
                  </span>
                </Option>
              ))}
          </ul>
          {!coords && results.length === 0 && (
            <p role="status" className="px-4 py-3 text-sm text-slate-300">
              {status === "loading" && "Recherche en cours…"}
              {status === "empty" &&
                "Aucun lieu trouvé. Essayez une adresse plus complète, une commune, ou des coordonnées (latitude, longitude)."}
              {status === "error" &&
                "Recherche momentanément indisponible. Vous pouvez saisir des coordonnées ou cliquer sur la carte."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Icon({ children }: { children: string }) {
  return (
    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/5 text-base">
      {children}
    </span>
  );
}

function Option({
  id,
  active,
  onHover,
  onPick,
  children,
}: {
  id: string;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
  children: React.ReactNode;
}) {
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      onPointerMove={onHover}
      onClick={onPick}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 transition",
        active ? "bg-sky-500/20" : "hover:bg-white/5"
      )}
    >
      {children}
    </li>
  );
}
