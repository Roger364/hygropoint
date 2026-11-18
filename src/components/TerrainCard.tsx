import type { EstimateResult, TerrainPart } from "../lib/estimate";
import type { Tune } from "../lib/tune";
import { fmtNum, fmtSigned } from "../lib/format";
import { describeTerrain, type TerrainInfo } from "../lib/terrain";

interface Props {
  result: EstimateResult;
  terrain: TerrainInfo;
  tune: Tune;
}

const PART_ICONS: Record<TerrainPart["key"], string> = {
  cold_air: "🌫️",
  sun_exposure: "⛰️",
  water: "💧",
  forest: "🌳",
};

export default function TerrainCard({ result, terrain, tune }: Props) {
  const { terrain: summary } = result;
  const feats = describeTerrain(terrain);
  const now = summary.now;
  const active = now.parts.length > 0;
  const ref = result.stations[0];
  const stationPool = terrain.stations[ref?.id ?? ""] ?? null;

  return (
    <section
      aria-labelledby="terrain-title"
      className="flex min-w-0 flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.04] p-4 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-5"
    >
      <div>
        <h3 id="terrain-title" className="text-base font-semibold text-white">
          Terrain et alentours
        </h3>
        <p className="text-xs text-slate-400">Ce que le lieu lui-même change pour l'humidité à 2 m</p>
      </div>

      {/* Le lieu */}
      <div className="rounded-2xl border border-white/10 bg-slate-950/40 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Le point choisi</h4>
        {feats.length === 0 ? (
          <p className="mt-1.5 text-xs text-slate-400">
            Relief et occupation du sol non analysés : l'estimation ne tient pas compte du terrain.
          </p>
        ) : (
          <ul className="mt-1.5 space-y-1 text-xs text-slate-200">
            {feats.map((f) => (
              <li key={f} className="flex gap-2">
                <span aria-hidden="true" className="text-slate-500">
                  •
                </span>
                {f}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Effet appliqué maintenant */}
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Effet sur l'estimation</h4>
        {!active ? (
          <p className="mt-2 text-xs text-slate-400">
            Aucun pour l'instant. {summary.available ? "Aux conditions du moment, le terrain ne modifie pas l'humidité à 2 m." : ""}
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {now.parts.map((part) => (
              <li key={part.key} className="flex items-baseline justify-between gap-2 text-xs">
                <span className="min-w-0 text-slate-200">
                  <span aria-hidden="true" className="mr-1.5">
                    {PART_ICONS[part.key]}
                  </span>
                  {part.label}
                </span>
                <span className="shrink-0 font-medium tabular-nums text-white">
                  {fmtSigned(part.dT, 1)} °C · rosée {fmtSigned(part.dTd, 1)} °C
                </span>
              </li>
            ))}
          </ul>
        )}
        {active && (
          <p className="mt-2 rounded-lg border border-white/10 bg-slate-950/50 px-2.5 py-1.5 text-xs text-slate-300">
            Total appliqué : <strong className="font-semibold text-white">{fmtSigned(now.dT, 1)} °C</strong> sur la température
            et <strong className="font-semibold text-white">{fmtSigned(now.dTd, 1)} °C</strong> sur le point de rosée, soit{" "}
            {fmtSigned(result.now.rh - rhWithoutTerrain(result.now), 1)} point
            {Math.abs(result.now.rh - rhWithoutTerrain(result.now)) >= 1.5 ? "s" : ""} d'humidité relative.
          </p>
        )}
      </div>

      {/* Heures concernées */}
      {summary.activeParts.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Sur les 96 heures couvertes</h4>
          <ul className="mt-2 space-y-1 text-xs">
            {summary.activeParts.map((p) => (
              <li key={p.key} className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 text-slate-300">
                  <span aria-hidden="true" className="mr-1.5">
                    {PART_ICONS[p.key]}
                  </span>
                  {p.label}
                </span>
                <span className="shrink-0 tabular-nums text-slate-200">
                  {p.hours} h · {fmtSigned(p.meanRh, 1)} pt en moyenne
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-slate-400">
            Effet moyen sur l'ensemble de la période : {fmtSigned(summary.meanRhNow, 1)} point d'humidité, au maximum{" "}
            {fmtNum(summary.maxAbsRh, 1)} point.
          </p>
        </div>
      )}

      {/* Station de référence */}
      {ref && (
        <p className="text-xs leading-relaxed text-slate-400">
          Terrain de la station {ref.name} ({ref.id}) :{" "}
          {stationPool && stationPool.tpi !== null
            ? stationPool.tpi < -12
              ? "aussi en creux"
              : stationPool.tpi > 12
                ? "en position dominante"
                : "plat et dégagé"
            : "non analysé"}
          . Quand une station proche ancre l'estimation, on ne lui applique que ce qui distingue votre terrain du sien — sinon son
          propre creux de vallée serait compté deux fois.
        </p>
      )}

      {/* Disponibilité et limites */}
      <details className="group rounded-2xl border border-white/10 bg-slate-950/40 text-xs text-slate-300">
        <summary className="cursor-pointer select-none rounded-2xl px-3 py-2.5 font-medium text-slate-100 marker:text-slate-400">
          Données utilisées, et ce qu'on ne sait pas
        </summary>
        <div className="space-y-2.5 px-3 pb-3 leading-relaxed">
          <p>
            <strong className="text-white">Relief.</strong> Altitudes du modèle Copernicus DEM (maille 90 m) obtenues sur un
            pochoir de points autour du lieu : pente et exposition par la méthode de Horn, position dans le relief par
            comparaison avec le tour à 2 km. Un versant reçoit plus ou moins de soleil qu'un terrain plat selon la géométrie
            du moment, calculée à partir de la position du soleil.
          </p>
          <p>
            <strong className="text-white">Eau et végétation.</strong> Plans d'eau et zones boisées d'OpenStreetMap dans un
            rayon de 1,5 km et 600 m. L'apport d'humidité dépend de la taille du plan d'eau, de la distance et du sens du
            vent : il n'est compté que si le vent souffle de l'eau vers vous.
          </p>
          <p>
            <strong className="text-white">Ce que ceci n'est pas.</strong> Les ordres de grandeur (jusqu'à{" "}
            {fmtNum(tune.poolCap, 1)} °C dans une poche de froid nocturne, {fmtNum(tune.waterTd, 1)} point de rosée au bord
            d'un plan d'eau) suivent des effets physiques connus mais ne sont pas mesurés à votre endroit. Ils se règlent dans
            le panneau « Affiner ». Un sous-bois dense, une rivière
            encaissée ou une rue canyon peuvent s'en écarter. Sans station de mesure proche, l'effet appliqué est une
            hypothèse : la fourchette affichée est élargie en conséquence.
          </p>
          {terrain.water && (
            <p className="font-mono text-[11px] text-slate-400">
              Plan d'eau :{" "}
              {terrain.water.distanceM < 25 ? "au bord" : `${Math.round(terrain.water.distanceM)} m`} · ampleur{" "}
              {Math.round(terrain.water.size * 100)} % · direction {Math.round(terrain.water.bearing)}°
            </p>
          )}
          {summary.notes.length > 0 && (
            <ul className="list-inside list-disc space-y-1 text-[11px] text-amber-200/90">
              {summary.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </section>
  );
}

/** Humidité qu'on afficherait sans la correction de terrain. */
function rhWithoutTerrain(h: EstimateResult["now"]): number {
  const t = h.temp - h.terrain.dT;
  const d = Math.min(h.dewPoint - h.terrain.dTd, t);
  const es = (x: number) => 6.1094 * Math.exp((17.625 * x) / (243.04 + x));
  return Math.min(100, Math.max(0, (100 * es(d)) / es(t)));
}

