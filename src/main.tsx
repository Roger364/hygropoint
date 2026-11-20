import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";

// Instrumentation CLS/LCP derrière ?clsdebug=1 (lisible dans le rapport PSI via console.debug).
if (location.search.includes("clsdebug")) {
  new PerformanceObserver((l) => {
    l.getEntries().forEach((e) => {
      const ls = e as PerformanceEntry & { value?: number; hadRecentInput?: boolean; sources?: Array<{ node?: Element; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }> };
      if (!ls.value || ls.hadRecentInput) return;
      const main = document.querySelector("main");
      console.debug("CLSDBG " + JSON.stringify({
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

  new PerformanceObserver((list) => {
    list.getEntries().forEach((e) => {
      const lcp = e as PerformanceEntry & { size?: number; url?: string; element?: Element | null };
      const el = lcp.element;
      console.debug("LCPDBG " + JSON.stringify({
        t: Math.round(e.startTime),
        size: lcp.size ?? null,
        url: lcp.url || null,
        sel: el ? el.tagName + "." + String(el.className || "").slice(0, 60) : null,
        top: el ? Math.round(el.getBoundingClientRect().top) : null,
        h: el ? Math.round(el.getBoundingClientRect().height) : null,
        txt: el ? (el as HTMLElement).innerText?.slice(0, 40) ?? null : null,
        vh: window.innerHeight,
        scrollY: Math.round(window.scrollY),
      }));
    });
  }).observe({ type: "largest-contentful-paint", buffered: true });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary label="L'application" className="m-6 min-h-[60vh]">
      <App />
    </ErrorBoundary>
  </StrictMode>
);
