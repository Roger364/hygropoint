import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";

// Instrumentation CLS derrière ?clsdebug=1 (lisible dans le rapport PSI via console.error).
if (location.search.includes("clsdebug")) {
  new PerformanceObserver((l) => {
    l.getEntries().forEach((e) => {
      const ls = e as PerformanceEntry & { value?: number; hadRecentInput?: boolean; sources?: Array<{ node?: Element; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }> };
      if (!ls.value || ls.hadRecentInput) return;
      const main = document.querySelector("main");
      console.error("CLSDBG " + JSON.stringify({
        t: Math.round(e.startTime),
        v: +ls.value.toFixed(3),
        src: (ls.sources || []).map((s) => ({
          sel: s.node ? s.node.tagName + "." + String(s.node.className || "").slice(0, 60) : null,
          prevTop: Math.round(s.previousRect.top),
          prevH: Math.round(s.previousRect.height),
          curTop: Math.round(s.currentRect.top),
          curH: Math.round(s.currentRect.height),
        })),
        ctx: {
          mainKids: main?.childElementCount ?? null,
          mainH: main ? Math.round(main.getBoundingClientRect().height) : null,
          screens: document.querySelectorAll(".min-h-screen").length,
          txt: (main?.innerText || "").slice(0, 80),
        },
      }));
    });
  }).observe({ type: "layout-shift", buffered: true });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary label="L'application" className="m-6 min-h-[60vh]">
      <App />
    </ErrorBoundary>
  </StrictMode>
);
