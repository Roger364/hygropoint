// Paramètres réglables de l'estimateur.
//
// Toutes ces grandeurs sont des hypothèses : l'application ne peut pas les mesurer à
// votre endroit. Les rendre ajustables est plus honnête que de les figer, et permet de
// voir à quel point l'estimation en dépend. Chaque réglage affiche son effet en direct.

export interface Tune {
  /** Profondeur de creux (m) au-delà de laquelle l'accumulation d'air froid est maximale. */
  poolDepth: number;
  /** Refroidissement maximal en fond de vallée, nuit calme et dégagée (°C). */
  poolCap: number;
  /** Contraste maximal de température entre versants exposés (°C). */
  sunCap: number;
  /** Hausse maximale du point de rosée au contact d'un plan d'eau (°C). */
  waterTd: number;
  /** Portée de l'influence d'un plan d'eau (m). */
  waterReach: number;
  /** Refroidissement maximal sous couvert végétal, en journée (°C). */
  forestCap: number;
  /** Densité réelle du couvert, de 0 (lisière clairsemée) à 1 (futaie dense). */
  canopy: number;
  /** Distance (km) au-delà de laquelle une station de mesure ne représente plus le point. */
  stationKm: number;
  /** Dénivelé (m) au-delà duquel une station ne représente plus le point. */
  stationM: number;
  /** 0 = ignorer l'eau, 1 = carte OSM, 2 = plan d'eau placé à la main. */
  waterMode: number;
  /** Distance au plan d'eau placé à la main (m). */
  waterDist: number;
  /** Ampleur de ce plan d'eau, de 0 à 1. */
  waterSize: number;
  /** Azimut du point vers l'eau (°). */
  waterFrom: number;
  /** Vent au sol imposé (km/h). −1 = garder le vent du modèle. */
  groundWind: number;
  /** Direction d'où vient ce vent (° , 0 = nord). */
  windFrom: number;
}

export const DEFAULT_TUNE: Tune = {
  poolDepth: 55,
  poolCap: 3,
  sunCap: 1.5,
  waterTd: 1.6,
  waterReach: 700,
  forestCap: 1,
  canopy: 0.7,
  stationKm: 35,
  stationM: 250,
  waterMode: 1,
  waterDist: 40,
  waterSize: 0.8,
  waterFrom: 180,
  groundWind: -1,
  windFrom: 200,
};

export type TuneKey = keyof Tune;

export interface TuneMeta {
  key: TuneKey;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  help: string;
  /** Ce que le réglage influence, pour regrouper l'affichage. */
  group: "terrain" | "stations";
}

export const TUNE_META: TuneMeta[] = [
  {
    key: "poolDepth",
    label: "Profondeur de creux",
    min: 10,
    max: 150,
    step: 5,
    unit: "m",
    help: "Dénivelé avec le tour à 2 km au-delà duquel l'accumulation d'air froid est à son maximum.",
    group: "terrain",
  },
  {
    key: "poolCap",
    label: "Poche de froid nocturne",
    min: 0,
    max: 6,
    step: 0.25,
    unit: "°C",
    help: "Refroidissement maximal en fond de vallée, par nuit calme et dégagée. Les combes karstiques dépassent 6 °C.",
    group: "terrain",
  },
  {
    key: "sunCap",
    label: "Contraste de versant",
    min: 0,
    max: 4,
    step: 0.25,
    unit: "°C",
    help: "Écart maximal de température entre un adret et un ubac, à pente et ensoleillement égaux.",
    group: "terrain",
  },
  {
    key: "waterTd",
    label: "Apport d'un plan d'eau",
    min: 0,
    max: 4,
    step: 0.1,
    unit: "°C",
    help: "Hausse maximale du point de rosée au bord de l'eau, par temps chaud et vent favorable.",
    group: "terrain",
  },
  {
    key: "waterReach",
    label: "Portée de l'eau",
    min: 100,
    max: 2000,
    step: 50,
    unit: "m",
    help: "Distance à laquelle l'influence d'un plan d'eau est divisée par 2,7.",
    group: "terrain",
  },
  {
    key: "forestCap",
    label: "Effet du sous-bois",
    min: 0,
    max: 3,
    step: 0.25,
    unit: "°C",
    help: "Refroidissement maximal sous couvert, en journée ensoleillée.",
    group: "terrain",
  },
  {
    key: "canopy",
    label: "Densité du couvert",
    min: 0,
    max: 1,
    step: 0.05,
    unit: "",
    help: "La carte ne dit pas si la forêt est une futaie dense ou une jeune plantation : à vous de le juger sur place.",
    group: "terrain",
  },
  {
    key: "stationKm",
    label: "Portée d'une station",
    min: 5,
    max: 120,
    step: 5,
    unit: "km",
    help: "Distance au-delà de laquelle une station de mesure ne représente plus votre point. S'applique aux stations déjà retenues.",
    group: "stations",
  },
  {
    key: "stationM",
    label: "Tolérance de dénivelé",
    min: 50,
    max: 1000,
    step: 25,
    unit: "m",
    help: "Dénivelé au-delà duquel une station ne représente plus votre point (gradient thermique ≈ 0,6 °C / 100 m).",
    group: "stations",
  },
];

export function isDefaultTune(t: Tune): boolean {
  return (Object.keys(DEFAULT_TUNE) as TuneKey[]).every((k) => Math.abs(t[k] - DEFAULT_TUNE[k]) < 1e-9);
}

export function changedKeys(t: Tune): TuneKey[] {
  return (Object.keys(DEFAULT_TUNE) as TuneKey[]).filter((k) => Math.abs(t[k] - DEFAULT_TUNE[k]) >= 1e-9);
}

export function tuneValue(v: number, unit: string): string {
  if (unit === "") return `${Math.round(v * 100)} %`;
  const digits = Number.isInteger(v) ? 0 : v * 10 % 1 === 0 ? 1 : 2;
  return `${v.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${unit}`;
}
