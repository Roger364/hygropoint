import { useCallback, useEffect, useRef, useState } from "react";
import { computeEstimate, rankStations, type EstimateResult, type StationInput } from "../lib/estimate";
import { reverseGeocode, type ReverseResult } from "../lib/geo";
import { describeError, isAbort } from "../lib/http";
import { fetchPointModels, fetchStationModels, type ModelData } from "../lib/openmeteo";
import { findStations, type Station } from "../lib/stations";
import { EMPTY_TERRAIN, fetchTerrain, type TerrainInfo } from "../lib/terrain";

export interface Place {
  lat: number;
  lon: number;
  label: string;
  countryCode?: string;
  state?: string;
  /** Faux tant que le libellé n'est qu'une paire de coordonnées en attente de nom. */
  resolved?: boolean;
}

export interface EstimationCore {
  key: string;
  point: ModelData;
  stations: StationInput[];
  note: string | null;
  nowMs: number;
}

interface State {
  result: EstimateResult | null;
  point: ModelData | null;
  terrain: TerrainInfo;
  core: EstimationCore | null;
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
}

const AUTO_REFRESH_MS = 15 * 60_000;
const RETRY_MIN_MS = 2 * 60_000;

/**
 * Charge et estime l'humidité pour un lieu.
 *
 * Deux temps : les modèles et les mesures d'abord (rapide, indispensable), le terrain
 * ensuite. Le terrain arrivant, l'estimation est recalculée — c'est une fonction pure,
 * donc aucun nouveau chargement ne se produit et l'utilisateur voit déjà les chiffres.
 */
export function useHumidity(place: Place, onResolved: (r: ReverseResult, lat: number, lon: number) => void) {
  const [state, setState] = useState<State>({
    result: null,
    point: null,
    terrain: EMPTY_TERRAIN,
    core: null,
    loading: true,
    error: null,
    loadedAt: null,
  });

  const placeRef = useRef(place);
  placeRef.current = place;
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;
  const ctrlRef = useRef<AbortController | null>(null);
  const loadingRef = useRef(false);
  const loadedAtRef = useRef<number | null>(null);
  const lastAttemptRef = useRef(0);
  const keyRef = useRef<string | null>(null);
  const overrideRef = useRef<{ key: string; countryCode: string; state?: string } | null>(null);
  /** Dernières données brutes : sert à recalculer quand le terrain arrive. */
  const coreRef = useRef<{
    key: string;
    point: ModelData;
    stations: StationInput[];
    note: string | null;
    terrain: TerrainInfo;
    nowMs: number;
  } | null>(null);

  const load = useCallback(async (fresh = false) => {
    const p = placeRef.current;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    const { signal } = ctrl;
    const key = `${p.lat},${p.lon}`;
    loadingRef.current = true;
    lastAttemptRef.current = Date.now();
    if (keyRef.current !== key) {
      keyRef.current = key;
      loadedAtRef.current = null;
      coreRef.current = null;
    }
    setState((s) =>
      coreRef.current === null
        ? { result: null, point: null, terrain: EMPTY_TERRAIN, core: null, loading: true, error: null, loadedAt: null }
        : { ...s, loading: true, error: null }
    );

    /** Recalcule l'estimation à partir de ce qui est déjà en mémoire. */
    const publish = (nowMs: number) => {
      const core = coreRef.current;
      if (!core || core.key !== key) return;
      const result = computeEstimate(core.point, core.stations, core.note, nowMs, core.terrain);
      loadedAtRef.current = Date.now();
      setState({
        result,
        point: core.point,
        terrain: core.terrain,
        core: { key: core.key, point: core.point, stations: core.stations, note: core.note, nowMs },
        loading: false,
        error: null,
        loadedAt: loadedAtRef.current,
      });
    };

    try {
      // Le pays sert à trouver le réseau de stations. S'il est déjà connu (lieu issu de la
      // recherche, ou point voisin du précédent), on n'attend pas le service de noms de lieux.
      const override = overrideRef.current?.key === key ? overrideRef.current : null;
      const known = override ?? (p.countryCode ? { countryCode: p.countryCode, state: p.state } : null);
      let geoFailed = false;
      const named: Promise<ReverseResult | null> =
        p.resolved === false || !known
          ? reverseGeocode(p.lat, p.lon, signal).then(
              (r) => {
                if (r && !signal.aborted) onResolvedRef.current(r, p.lat, p.lon);
                return r;
              },
              (e) => {
                if (isAbort(e)) throw e;
                geoFailed = true;
                return null;
              }
            )
          : Promise.resolve(null);
      named.catch(() => undefined);
      const geo: Promise<{ countryCode?: string; state?: string } | null> = known ? Promise.resolve(known) : named;
      const stationsPromise = geo.then((g) => findStations(p.lat, p.lon, g?.countryCode, g?.state, signal));
      stationsPromise.catch(() => undefined);

      // Une actualisation demandée par l'utilisateur relit le réseau ; sinon on
      // accepte une réponse de moins de 15 min (cache de session).
      const cache = fresh ? "reload" : "default";
      const point = await fetchPointModels(p.lat, p.lon, { signal, cache });
      const search = await stationsPromise;
      const ranked = rankStations(search.stations as Station[], point.elevation);
      const settled = await Promise.allSettled(
        ranked.map((s) => fetchStationModels(s.lat, s.lon, { signal, cache }))
      );
      if (signal.aborted) return;

      const inputs: StationInput[] = [];
      settled.forEach((r, i) => {
        if (r.status === "fulfilled") inputs.push({ ...ranked[i], model: r.value });
      });

      let note = search.note;
      if (!known && geoFailed) {
        note =
          "Le service de noms de lieux n'a pas répondu : pays du point inconnu, stations non recherchées. Réessayez avec « Actualiser ».";
      } else if (!note && search.stations.length > 0 && ranked.length === 0) {
        note = "Les stations proches sont trop éloignées ou à une altitude trop différente pour représenter ce point.";
      } else if (!note && ranked.length > 0 && inputs.length === 0) {
        note = "Les modèles n'ont pas pu être évalués à l'emplacement des stations : calage impossible cette fois-ci.";
      }

      const nowMs = Date.now();
      coreRef.current = { key, point, stations: inputs, note, terrain: EMPTY_TERRAIN, nowMs };
      publish(nowMs);

      // Le terrain du point et des stations retenues, sans bloquer l'affichage.
      const terrain = await fetchTerrain(
        p.lat,
        p.lon,
        inputs.map((s) => ({ id: s.id, lat: s.lat, lon: s.lon })),
        { signal }
      ).catch((e: unknown) => {
        if (isAbort(e)) throw e;
        return { ...EMPTY_TERRAIN, notes: ["Terrain non analysé : " + describeError(e, "les données de relief")] };
      });
      if (signal.aborted || coreRef.current?.key !== key) return;
      coreRef.current = { ...coreRef.current, terrain };
      publish(nowMs);

      // Pays supposé (hérité du point précédent) démenti par le géocodeur : on relance
      // avec le bon réseau de stations.
      if (known && !override) {
        void named
          .then((r) => {
            if (!r?.countryCode || signal.aborted) return;
            const northAmerica = r.countryCode === "US" || r.countryCode === "CA";
            if (r.countryCode !== known.countryCode || (northAmerica && r.state !== known.state)) {
              overrideRef.current = { key, countryCode: r.countryCode, state: r.state };
              void load();
            }
          })
          .catch(() => undefined);
      }
    } catch (e) {
      if (isAbort(e) || signal.aborted) return;
      setState((s) => ({ ...s, loading: false, error: describeError(e, "Open-Meteo") }));
    } finally {
      if (ctrlRef.current === ctrl) loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
    return () => ctrlRef.current?.abort();
  }, [place.lat, place.lon, load]);

  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== "visible" || loadingRef.current) return;
      const now = Date.now();
      if (now - lastAttemptRef.current < RETRY_MIN_MS) return;
      const at = loadedAtRef.current;
      if (at === null || now - at >= AUTO_REFRESH_MS) void load();
    };
    const id = window.setInterval(check, 60_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", check);
    };
  }, [load]);

  // L'utilisateur qui demande une actualisation ne doit pas recevoir le cache.
  return { ...state, refresh: () => load(true) };
}
