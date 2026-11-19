// Cache applicatif des réponses de services publics (Open-Meteo, IEM).
//
// Ces services répondent en plusieurs secondes sous throttling mobile et leurs
// données ne changent qu'à l'heure : recharger la page ne doit pas relancer la
// même requête. Deux niveaux, tous deux best-effort : une mémoire de session
// (immédiate) et `sessionStorage` (survit à un rechargement, meurt avec l'onglet).
//
// Ce cache n'est pas une source de vérité : illisible, plein ou indisponible, il
// se contente de laisser passer la requête.

const PREFIX = "hygropoint.cache.";
/** Au-delà, l'entrée n'est pas persistée : le quota de session est partagé. */
const MAX_ENTRY_CHARS = 400_000;
const MAX_MEMORY_ENTRIES = 32;

interface Entry<T> {
  /** Instant de la réponse (ms epoch). */
  at: number;
  value: T;
}

const memory = new Map<string, Entry<unknown>>();

export function hasSessionStorage(): boolean {
  return typeof sessionStorage !== "undefined";
}

function readStorage<T>(key: string): Entry<T> | null {
  if (!hasSessionStorage()) return null;
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Entry<T> | null;
    if (!parsed || typeof parsed.at !== "number" || !("value" in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Écrit l'entrée ; si le quota est atteint, libère les nôtres et réessaie une fois. */
function writeStorage<T>(key: string, entry: Entry<T>): void {
  if (!hasSessionStorage()) return;
  const raw = JSON.stringify(entry);
  if (raw.length > MAX_ENTRY_CHARS) return;
  try {
    sessionStorage.setItem(PREFIX + key, raw);
    return;
  } catch {
    // Quota probablement atteint : on ne touche qu'à nos propres clés.
  }
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(PREFIX)) sessionStorage.removeItem(k);
    }
    sessionStorage.setItem(PREFIX + key, raw);
  } catch {
    // Stockage définitivement indisponible : le cache mémoire suffit.
  }
}

export interface CachedJsonOptions<T> {
  /** Clé stable et unique : l'URL complète de la requête convient. */
  key: string;
  ttlMs: number;
  load: () => Promise<T>;
  /** Ignore une entrée encore fraîche (bouton « Actualiser »). */
  bypass?: boolean;
}

/**
 * Rend la réponse en cache si elle a moins de `ttlMs`, sinon l'obtient via `load`
 * puis la conserve. Une erreur de `load` — annulation comprise — n'écrit rien.
 */
export async function cachedJson<T>({ key, ttlMs, load, bypass = false }: CachedJsonOptions<T>): Promise<T> {
  if (!bypass) {
    const hit = memory.get(key) ?? readStorage<T>(key);
    if (hit && Date.now() - hit.at < ttlMs) {
      if (!memory.has(key)) memory.set(key, hit as Entry<unknown>);
      return hit.value as T;
    }
  }
  const value = await load();
  const entry: Entry<T> = { at: Date.now(), value };
  if (memory.size >= MAX_MEMORY_ENTRIES && !memory.has(key)) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, entry as Entry<unknown>);
  writeStorage(key, entry);
  return value;
}
