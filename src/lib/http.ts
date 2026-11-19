// Petit client HTTP : délai maximal, annulation propre et erreurs typées.

export type HttpErrorKind = "aborted" | "timeout" | "network" | "http" | "parse";

export class HttpError extends Error {
  kind: HttpErrorKind;
  status?: number;
  body?: string;

  constructor(kind: HttpErrorKind, message: string, status?: number, body?: string) {
    super(message);
    this.name = "HttpError";
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** `reload` ignore le cache applicatif : réservé au bouton « Actualiser ». */
  cache?: "default" | "reload";
}

export async function getText(url: string, { signal, timeoutMs = 12_000 }: RequestOptions = {}): Promise<string> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  // Le délai couvre aussi le téléchargement du corps, pas seulement les en-têtes.
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new HttpError("http", `HTTP ${res.status}`, res.status, text.slice(0, 400));
    return text;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (signal?.aborted) throw new HttpError("aborted", "Requête annulée");
    if (timedOut) throw new HttpError("timeout", "Délai dépassé");
    throw new HttpError("network", "Réseau injoignable");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function getJson<T>(url: string, opts?: RequestOptions): Promise<T> {
  const text = await getText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError("parse", "Réponse illisible", undefined, text.slice(0, 200));
  }
}

export function isAbort(e: unknown): boolean {
  return e instanceof HttpError && e.kind === "aborted";
}

/** Message d'erreur lisible, en français, pour l'utilisateur. */
export function describeError(e: unknown, service: string): string {
  if (e instanceof HttpError) {
    switch (e.kind) {
      case "timeout":
        return `${service} ne répond pas (délai dépassé).`;
      case "network":
        return `Connexion à ${service} impossible. Vérifiez votre accès Internet.`;
      case "parse":
        return `Réponse inattendue de ${service}.`;
      case "aborted":
        return "Requête annulée.";
      case "http":
        if (e.status === 429) return `${service} : trop de requêtes, réessayez dans une minute.`;
        if ((e.status ?? 0) >= 500) return `${service} est momentanément indisponible (erreur ${e.status}).`;
        return `${service} a refusé la requête (erreur ${e.status}).`;
    }
  }
  return e instanceof Error && e.message ? e.message : `Erreur inattendue (${service}).`;
}
