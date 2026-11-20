// Cloudflare Pages Function — collecteur RUM same-origin.
// Reçoit les métriques Core Web Vitals (CLS, LCP, INP, TTFB) envoyées par
// sendBeacon depuis le navigateur. Aucune donnée personnelle, aucune coordonnée.
// Les événements sont disponibles dans les logs Pages (dashboard ou `wrangler pages deployment tail`).

interface VitalsPayload {
  path?: string;
  cls?: number;
  lcp?: number;
  inp?: number;
  ttfb?: number;
  // Timestamp côté client (epoch ms).
  ts?: number;
}

export const onRequestPost = async (context: any): Promise<Response> => {
  try {
    const text = await context.request.text();
    let body: VitalsPayload;
    try {
      body = JSON.parse(text) as VitalsPayload;
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    // Validation minimale : au moins une métrique.
    if (typeof body.cls !== "number" && typeof body.lcp !== "number" && typeof body.inp !== "number") {
      return new Response("missing metrics", { status: 400 });
    }
    // Normaliser le chemin : pas de query string, pas de fragment.
    const path = (body.path || "/").split("?")[0].split("#")[0].slice(0, 200);
    const record = {
      path,
      cls: body.cls != null ? +body.cls.toFixed(4) : null,
      lcp: body.lcp != null ? Math.round(body.lcp) : null,
      inp: body.inp != null ? Math.round(body.inp) : null,
      ttfb: body.ttfb != null ? Math.round(body.ttfb) : null,
      ts: body.ts || Date.now(),
    };
    console.log("VITALS " + JSON.stringify(record));
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return new Response("error: " + (e instanceof Error ? e.message : "unknown"), { status: 400 });
  }
};

// Rejeter les autres méthodes.
export const onRequest = async (): Promise<Response> => {
  return new Response("method not allowed", { status: 405 });
};