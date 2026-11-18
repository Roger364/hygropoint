// Thermodynamique de l'air humide.
// Formule de Magnus, coefficients d'Alduchov & Eskridge (1996), pression de vapeur
// saturante par rapport à l'eau liquide (convention OMM pour l'humidité relative).

const A = 17.625;
const B = 243.04; // °C

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Pression de vapeur saturante (hPa) à la température tC (°C). */
export function saturationVaporPressure(tC: number): number {
  return 6.1094 * Math.exp((A * tC) / (B + tC));
}

/** Humidité relative (%) à partir de la température et du point de rosée (°C). */
export function rhFromTempDew(tC: number, tdC: number): number {
  return clamp((100 * saturationVaporPressure(tdC)) / saturationVaporPressure(tC), 0, 100);
}

/** Point de rosée (°C) à partir de la température (°C) et de l'humidité relative (%). */
export function dewPointFromRh(tC: number, rh: number): number {
  const gamma = Math.log(clamp(rh, 0.5, 100) / 100) + (A * tC) / (B + tC);
  return (B * gamma) / (A - gamma);
}

/** Humidité absolue (g de vapeur d'eau par m³ d'air). */
export function absoluteHumidity(tC: number, rh: number): number {
  const ePa = (clamp(rh, 0, 100) / 100) * saturationVaporPressure(tC) * 100;
  return (ePa * 2.16679) / (tC + 273.15);
}
