// Formatage (fr-FR). Les Intl.DateTimeFormat sont coûteux à construire :
// on les met en cache par (type, fuseau) au lieu d'en créer un par cellule affichée.

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(kind: string, tz: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${kind}|${tz ?? ""}`;
  let f = cache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("fr-FR", { ...opts, timeZone: tz });
    } catch {
      // Fuseau inconnu du navigateur : on retombe sur le fuseau local plutôt que de planter.
      f = new Intl.DateTimeFormat("fr-FR", opts);
    }
    cache.set(key, f);
  }
  return f;
}

type DateLike = Date | number;

export function fmtHour(d: DateLike, tz?: string): string {
  return formatter("hm", tz, { hour: "2-digit", minute: "2-digit" }).format(d);
}

export function fmtDayShort(d: DateLike, tz?: string): string {
  return formatter("day", tz, { weekday: "short", day: "numeric" }).format(d);
}

export function fmtDayLong(d: DateLike, tz?: string): string {
  return formatter("dayLong", tz, { weekday: "long", day: "numeric", month: "long" }).format(d);
}

export function fmtDayHour(d: DateLike, tz?: string): string {
  return formatter("dayHm", tz, { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

export function fmtFull(d: DateLike, tz?: string): string {
  return formatter("full", tz, {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** Heure locale (0–23) dans le fuseau donné. */
export function localHour(d: DateLike, tz?: string): number {
  const s = formatter("h23", tz, { hour: "2-digit", hourCycle: "h23" }).format(d);
  return parseInt(s, 10) % 24;
}

/** Clé de jour local stable (AAAA-MM-JJ) pour regrouper les heures par journée. */
export function localDayKey(d: DateLike, tz?: string): string {
  const parts = formatter("ymd", tz, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtSigned(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return "—";
  const r = Number(v.toFixed(digits));
  const body = Math.abs(r).toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${body}`;
}

export function fmtCoord(lat: number, lon: number): string {
  const la = `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}`;
  const lo = `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "O"}`;
  return `${la}, ${lo}`;
}

/** « il y a 12 min » — pour un instant passé. */
export function fmtAgo(tMs: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - tMs) / 1000));
  if (s < 45) return "à l'instant";
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 6 && rest >= 5) return `il y a ${h} h ${String(rest).padStart(2, "0")}`;
  return `il y a ${h} h`;
}
