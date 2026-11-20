import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";

// RUM same-origin : collecte CLS, LCP, INP, TTFB via PerformanceObserver.
// Envoi unique par page via sendBeacon à la fermeture (visibilitychange → hidden).
// Aucune coordonnée, aucun identifiant, aucun cookie.
(() => {
  let cls = 0;
  let lcp = 0;
  let inp = 0;
  let ttfb = 0;
  let sent = false;

  const send = () => {
    if (sent) return;
    sent = true;
    const payload = JSON.stringify({
      path: location.pathname,
      cls: +cls.toFixed(4),
      lcp: Math.round(lcp),
      inp: Math.round(inp),
      ttfb: Math.round(ttfb),
      ts: Date.now(),
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/vitals", new Blob([payload], { type: "application/json" }));
    }
  };

  // TTFB
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (nav) ttfb = nav.responseStart - nav.requestStart;

  // CLS
  new PerformanceObserver((l) => {
    l.getEntries().forEach((e) => {
      const ls = e as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
      if (!ls.value || ls.hadRecentInput) return;
      cls += ls.value;
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
