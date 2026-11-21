import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";

// RUM same-origin : collecte CLS, LCP, INP, TTFB via PerformanceObserver.
// Envoi unique par page via sendBeacon à la fermeture (visibilitychange → hidden).
// Aucune coordonnée, aucun identifiant, aucun cookie.
(() => {
  // Marquage self : ?self=1 pose le drapeau puis s'efface de l'URL.
  try {
    const params = new URLSearchParams(location.search);
    if (params.get("self") === "1") {
      localStorage.setItem("rum-self", "1");
      params.delete("self");
      const qs = params.toString();
      history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    }
  } catch {
    // localStorage indisponible (navigation privée) — on ignore.
  }

  let cls = 0;
  let lcp = 0;
  let inp = 0;
  let ttfb = 0;
  let sent = false;
  let clsTop: string | null = null;
  let clsTopMax = 0;

  const describe = (n: Element | null): string | null =>
    !n ? null : n.tagName + (n.classList?.length ? "." + [...n.classList].slice(0, 2).join(".") : "");

  const send = () => {
    if (sent) return;
    sent = true;
    let self = 0;
    try {
      self = localStorage.getItem("rum-self") === "1" ? 1 : 0;
    } catch {
      self = 0;
    }
    const payload = JSON.stringify({
      path: location.pathname,
      cls: +cls.toFixed(4),
      lcp: Math.round(lcp),
      inp: Math.round(inp),
      ttfb: Math.round(ttfb),
      ts: Date.now(),
      self,
      vw: window.innerWidth,
      conn: (navigator as any).connection?.effectiveType ?? null,
      cls_top: clsTop,
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/vitals", new Blob([payload], { type: "application/json" }));
    }
  };

  // TTFB
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (nav) ttfb = nav.responseStart - nav.requestStart;

  // CLS — max d'une fenêtre glissante de 5 s (coupure après 1 s d'inactivité).
  // Le CLS officiel est le pire cas sur 5 s, pas une somme cumulée.
  const clsEntries: Array<{ t: number; v: number }> = [];
  new PerformanceObserver((l) => {
    l.getEntries().forEach((e) => {
      const ls = e as PerformanceEntry & { value?: number; hadRecentInput?: boolean; sources?: Array<{ node?: Element }> };
      if (!ls.value || ls.hadRecentInput) return;
      // Mémoriser la source de la plus grosse entrée isolée.
      if (ls.value > clsTopMax) {
        clsTopMax = ls.value;
        clsTop = describe(ls.sources?.[0]?.node ?? null);
      }
      clsEntries.push({ t: ls.startTime, v: ls.value });
      // Recalculer le CLS = max session sur 5 s.
      let maxSession = 0;
      let sessionStart = -1;
      let sessionValue = 0;
      let lastEntry = 0;
      for (const entry of clsEntries) {
        if (sessionStart === -1 || entry.t - sessionStart > 5000 || entry.t - lastEntry > 1000) {
          // Nouvelle session (gap > 1 s d'inactivité ou > 5 s depuis le début).
          maxSession = Math.max(maxSession, sessionValue);
          sessionStart = entry.t;
          sessionValue = entry.v;
        } else {
          sessionValue += entry.v;
        }
        lastEntry = entry.t;
      }
      maxSession = Math.max(maxSession, sessionValue);
      cls = maxSession;
    });
  }).observe({ type: "layout-shift", buffered: true });

  // LCP
  new PerformanceObserver((l) => {
    const entries = l.getEntries();
    const last = entries[entries.length - 1] as PerformanceEntry & { startTime?: number };
    if (last?.startTime) lcp = last.startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });

  // INP
  new PerformanceObserver((l) => {
    l.getEntries().forEach((e) => {
      const ev = e as PerformanceEntry & { duration?: number };
      if (ev.duration && ev.duration > inp) inp = ev.duration;
    });
  }).observe({ type: "event", buffered: true, durationThreshold: 40 } as PerformanceObserverInit);

  // Envoi à la fermeture de la page.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") send();
  });
  window.addEventListener("pagehide", send);
})();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary label="L'application" className="m-6 min-h-[60vh]">
      <App />
    </ErrorBoundary>
  </StrictMode>
);
