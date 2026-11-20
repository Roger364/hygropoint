// Cloudflare Pages Function — collecteur RUM same-origin + stockage D1.
// Reçoit les métriques Core Web Vitals (CLS, LCP, INP, TTFB) envoyées par
// sendBeacon depuis le navigateur. Stockage dans D1 (table vitals).
// Aucune donnée personnelle, aucune coordonnée.

interface VitalsPayload {
  path?: string;
  cls?: number;
  lcp?: number;
  inp?: number;
  ttfb?: number;
  ts?: number;
}

const ALLOWED_KEYS = new Set(["path", "cls", "lcp", "inp", "ttfb", "ts"]);

export const onRequestPost = async (context: any): Promise<Response> => {
  try {
    const text = await context.request.text();
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return new Response("bad request", { status: 400 });
    }

    // Reconstruire l'objet depuis les clés connues uniquement.
    const body: VitalsPayload = {};
    for (const key of ALLOWED_KEYS) {
      if (key in raw) body[key as keyof VitalsPayload] = raw[key] as any;
    }

    // Validation minimale : au moins une métrique, types corrects.
    const hasMetric =
      (typeof body.cls === "number" && isFinite(body.cls)) ||
      (typeof body.lcp === "number" && isFinite(body.lcp)) ||
      (typeof body.inp === "number" && isFinite(body.inp));
    if (!hasMetric) {
      return new Response("bad request", { status: 400 });
    }

    // Normaliser le chemin.
    const path = (typeof body.path === "string" ? body.path : "/")
      .split("?")[0]
      .split("#")[0]
      .slice(0, 200);

    // Stockage D1.
    const db = (context.env as any)?.DB;
    if (db) {
      await db
        .prepare(
          "INSERT INTO vitals (path, cls, lcp, inp, ttfb, ts) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(
          path,
          typeof body.cls === "number" ? +body.cls.toFixed(4) : null,
          typeof body.lcp === "number" ? Math.round(body.lcp) : null,
          typeof body.inp === "number" ? Math.round(body.inp) : null,
          typeof body.ttfb === "number" ? Math.round(body.ttfb) : null,
          typeof body.ts === "number" ? body.ts : Date.now()
        )
        .run();
    }

    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return new Response("bad request", { status: 400 });
  }
};

// Rejeter les autres méthodes.
export const onRequest = async (): Promise<Response> => {
  return new Response("method not allowed", { status: 405 });
};