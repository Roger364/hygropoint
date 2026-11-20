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

  // CLS — max d'une fenêtre glissante de 5 s (coupure à 1 s d'inactivité).
  // Ce n'est pas une somme cumulée : le CLS officiel est le pire cas sur 5 s.
  const clsEntries: Array<{ t: number; v: number }> = [];
  new PerformanceObserver((l) => {
    l.getEntries().forEach((e) => {
      const ls = e as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
      if (!ls.value || ls.hadRecentInput) return;
      clsEntries.push({ t: ls.startTime, v: ls.value });
      // Recalculer le CLS = max session sur 5 s.
      let maxSession = 0;
      let sessionStart = 0;
      let sessionValue = 0;
      for (const entry of clsEntries) {
        if (sessionStart === 0 || entry.t - sessionStart > 5000 || entry.t - (sessionStart + sessionValue) > 1000) {
          // Nouvelle session (gap > 1 s ou > 5 s depuis le début).
          maxSession = Math.max(maxSession, sessionValue);
          sessionStart = entry.t;
          sessionValue = entry.v;
        } else {
          sessionValue += entry.v;
        }
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
