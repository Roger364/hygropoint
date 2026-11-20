// Cloudflare Pages Function — proxy caché pour le geojson des réseaux de stations IEM.
// Cache long (6 h) car la liste des stations change à l'échelle de la saison.

const IEM = "https://mesonet.agron.iastate.edu";
const CACHE_TTL = 6 * 3600; // 6 heures

export const onRequestGet = async (context: any): Promise<Response> => {
  const url = new URL(context.request.url);
  const network = url.searchParams.get("network") || "FR__ASOS";
  const target = `${IEM}/geojson/network/${network}.geojson`;

  const cache = (globalThis as any).caches?.default;
  const cacheKey = new Request(target, { method: "GET" });

  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const res = new Response(cached.body, cached);
      res.headers.set("Content-Type", "application/json");
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
        "Content-Type": "application/json",
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
