// Cloudflare Pages Function — proxy caché pour l'API ASOS de l'Iowa Environmental Mesonet.
// Évite les 429 (rate limit) vus par le navigateur : la requête cross-origin est
// remplacée par un appel same-origin, avec cache de 10 minutes à l'edge.

const IEM = "https://mesonet.agron.iastate.edu";
const CACHE_TTL = 10 * 60; // 10 minutes

export const onRequestGet = async (context: any): Promise<Response> => {
  const url = new URL(context.request.url);
  const target = `${IEM}/cgi-bin/request/asos.py?${url.searchParams.toString()}`;

  // Cache edge : clé = URL complète (query params inclus).
  const cache = (globalThis as any).caches?.default;
  const cacheKey = new Request(target, { method: "GET" });
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const res = new Response(cached.body, cached);
      res.headers.set("X-Cache", "HIT");
      return res;
    }
  }

  try {
    const upstream = await fetch(target, {
      headers: { "User-Agent": "HygroPoint/1.0" },
    });
    const body = await upstream.text();

    const response = new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "text/plain; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`,
        "X-Cache": "MISS",
      },
    });

    if (upstream.ok && cache) {
      context.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  } catch (e) {
    return new Response(`Proxy error: ${e instanceof Error ? e.message : "unknown"}`, {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });
  }
};
