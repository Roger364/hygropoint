import { memo } from "react";
import { CONFIG, type EstimateResult } from "../lib/estimate";
import { fmtCoord, fmtHour, fmtNum, fmtSigned } from "../lib/format";
import type { ModelData } from "../lib/openmeteo";
import { SEARCH_RADIUS_KM } from "../lib/stations";
import { cn } from "../utils/cn";

interface Props {
  result: EstimateResult;
  point: ModelData;
}

const STATUS = {
  improved: { box: "border-emerald-400/30 bg-emerald-400/10", badge: "bg-emerald-400/20 text-emerald-300", icon: "✓" },
  assumed: { box: "border-sky-400/30 bg-sky-400/10", badge: "bg-sky-400/20 text-sky-300", icon: "≈" },
  not_improved: { box: "border-amber-400/30 bg-amber-400/10", badge: "bg-amber-400/20 text-amber-300", icon: "=" },
  no_reference: { box: "border-slate-400/25 bg-white/5", badge: "bg-white/10 text-slate-200", icon: "?" },
} as const;

function VerdictCard({ result, point }: Props) {
  const { verdict, stations, calibration, members, missing } = result;
  const tz = point.timezone;
  const status = STATUS[verdict.status];
  const regimes = calibration.regimes.filter((r) => r.n > 0);
  const anyCorrection = regimes.some((r) => r.corrRh !== null);

  return (
    <section
      aria-labelledby="verdict-title"
      className="flex min-w-0 flex-col gap-5 rounded-3xl border border-white/10 bg-white/[0.04] p-4 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-5"
    >
      <div>
        <h3 id="verdict-title" className="text-base font-semibold text-white">
          L'estimation peut-elle être améliorée ici ?
        </h3>
        <div className={cn("mt-2 flex items-start gap-3 rounded-2xl border p-3", status.box)}>
          <span aria-hidden="true" className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold", status.badge)}>
            {status.icon}
          </span>
          <div className="min-w-0 text-sm">
            <p className="font-semibold text-white">{verdict.title}</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed text-slate-300">
              {verdict.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div>
        <Heading>Stations de mesure utilisées</Heading>
        {stations.length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">
            Aucune. La recherche couvre les stations d'aérodrome à moins de {SEARCH_RADIUS_KM} km, dans le pays du point choisi.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {stations.map((s) => (
              <li key={s.id} className="rounded-xl border border-white/10 bg-slate-950/40 p-3 text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate font-medium text-white">
                    <span aria-hidden="true" className="mr-1.5 inline-block h-2 w-2 rounded-full bg-emerald-400" />
                    {s.name} <span className="font-normal text-slate-400">({s.id})</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-slate-300">{fmtNum(s.distanceKm, 1)} km</span>
                </div>
                <p className="mt-1 text-slate-300">
                  Mesuré à {fmtHour(s.last.t, tz)} :{" "}
                  <strong className="font-semibold text-white">{Math.round(s.last.rh)} %</strong> · {fmtNum(s.last.temp)} °C
                  {s.dz !== null && Math.abs(s.dz) >= 20 && ` · ${fmtSigned(s.dz, 0)} m d'altitude`}
                </p>
                <p className="mt-0.5 text-slate-400">
                  {s.trust > 0 ? `Poids accordé : ${Math.round(s.trust * 100)} %` : "Non utilisée pour l'ancrage"}
                  {s.modelBiasRh !== null && ` · écart moyen des modèles : ${fmtSigned(s.modelBiasRh)} pt`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {regimes.length > 0 && (
        <div>
          <Heading>Écart des modèles selon la situation météo</Heading>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Écart moyen entre modèles et mesures sur 48 h, par situation météo</caption>
              <thead className="text-[11px] text-slate-400">
                <tr>
                  <th scope="col" className="py-1 pr-2 font-medium">
                    Situation
                  </th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">
                    Heures
                  </th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">
                    Écart mesuré
                  </th>
                  {anyCorrection && (
                    <th scope="col" className="py-1 pl-2 text-right font-medium">
                      Correction
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {regimes.map((r) => (
                  <tr key={r.key}>
                    <th scope="row" className="py-1.5 pr-2 font-normal text-slate-200">
                      {r.label}
                    </th>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-300">{r.n}</td>
                    <td
                      className={cn(
                        "px-2 py-1.5 text-right tabular-nums",
                        r.meanErrRh === null ? "text-slate-400" : r.meanErrRh < 0 ? "text-amber-300" : "text-sky-300"
                      )}
                    >
                      {r.meanErrRh === null ? "—" : fmtSigned(r.meanErrRh)}
                    </td>
                    {anyCorrection && (
                      <td className="py-1.5 pl-2 text-right tabular-nums text-violet-200">
                        {r.corrRh === null ? "—" : fmtSigned(r.corrRh)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
            Écart = modèles − mesures, en points d'humidité : négatif, les modèles sont trop secs.
            {anyCorrection
              ? " La correction, validée hors échantillon, s'applique aux prévisions."
              : " Aucune correction de prévision n'a passé le test : ces écarts sont donnés à titre indicatif."}
          </p>
        </div>
      )}

      <div>
        <Heading>Modèles de prévision</Heading>
        {point.degraded && (
          <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-1.5 text-xs text-amber-100">
            Open-Meteo a refusé la requête multi-modèles : une seule source est utilisée pour cette actualisation.
          </p>
        )}
        <ul className="mt-2 space-y-2">
          {members.map((m) => (
            <li key={m.id} className="text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-slate-200">{m.label}</span>
                <span className="shrink-0 tabular-nums text-white">{m.rhNow === null ? "—" : `${Math.round(m.rhNow)} %`}</span>
              </div>
              {m.duplicate ? (
                <p className="text-[11px] text-slate-400">Recopie ici un autre modèle de la liste : non comptée deux fois.</p>
              ) : (
                <div className="mt-1 flex items-center gap-2">
                  <div aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-gradient-to-r from-sky-400 to-indigo-400" style={{ width: `${m.share * 100}%` }} />
                  </div>
                  <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
                    poids {Math.round(m.share * 100)} %{m.mae !== null && ` · erreur mesurée ${fmtNum(m.mae, 1)} pt`}
                  </span>
                </div>
              )}
            </li>
          ))}
          {missing.map((m) => (
            <li key={m.id} className="flex items-baseline justify-between gap-2 text-xs text-slate-400">
              <span className="truncate">{m.label}</span>
              <span className="shrink-0 text-[11px]">non disponible ici</span>
            </li>
          ))}
        </ul>
      </div>

      <details className="group rounded-2xl border border-white/10 bg-slate-950/40 text-xs text-slate-300">
        <summary className="cursor-pointer select-none rounded-2xl px-3 py-2.5 font-medium text-slate-100 marker:text-slate-400">
          Méthode, hypothèses et limites
        </summary>
        <div className="space-y-2.5 px-3 pb-3 leading-relaxed">
          <p>
            <strong className="text-white">Consensus.</strong> Moyenne des modèles en température et en point de rosée ;
            l'humidité relative en découle (formule de Magnus). Les mêmes modèles sont évalués à l'emplacement des stations,
            ce qui permet de comparer modèle et mesure au même endroit.
          </p>
          <p>
            <strong className="text-white">Calage.</strong> Pour le passé et le présent, l'écart constaté aux stations est
            retiré au point choisi. Pour les prévisions, une correction n'est appliquée que si, apprise sur l'avant-veille,
            elle réduit l'erreur de la veille d'au moins {String(CONFIG.minGainAbs).replace(".", ",")} point.
          </p>
          <p>
            <strong className="text-white">Hypothèses non vérifiables depuis l'application.</strong> La confiance dans une
            station décroît avec la distance (divisée par 2,7 à {CONFIG.spatialScaleKm} km) et le dénivelé (idem à{" "}
            {CONFIG.verticalScaleM} m). Sans mesure, la marge d'erreur est fixée à ± {Math.round(CONFIG.sigmaDefault * CONFIG.z80)}{" "}
            points. Elle est majorée de {Math.round(CONFIG.growth72h * 100)} % à 72 h d'échéance.
          </p>
          <p>
            <strong className="text-white">Limites.</strong> Les stations sont des aérodromes, en terrain dégagé : un
            sous-bois, un bord de rivière, un fond de vallée ou un centre-ville peuvent s'en écarter de plusieurs points. Les
            messages METAR arrondissent température et point de rosée au degré, soit environ ± 3 points d'humidité. Les
            stations situées de l'autre côté d'une frontière ne sont pas recherchées. La fourchette est une estimation
            prudente, pas une garantie.
          </p>
          <p>
            <strong className="text-white">Sources.</strong> Modèles : Open-Meteo (ECMWF, DWD, Météo-France, NOAA). Mesures :
            METAR diffusés par l'Iowa Environmental Mesonet. Noms de lieux : Photon / OpenStreetMap. Vos coordonnées sont
            transmises à ces services pour obtenir les données ; seul le dernier lieu consulté est mémorisé, dans votre
            navigateur.
          </p>
          <p className="font-mono text-[11px] text-slate-400">
            Maille du modèle : {fmtCoord(point.latitude, point.longitude)}
            {point.elevation !== null && ` · ${Math.round(point.elevation)} m`} · {tz}
          </p>
        </div>
      </details>
    </section>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{children}</h4>;
}

export default memo(VerdictCard);
