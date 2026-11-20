#!/usr/bin/env node
// Gate déterministe : échoue si l'artefact construit peut régresser le LCP
// ou dépasser les budgets de poids. Ne dépend d'aucun paquet.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

const DIST = resolve("dist");
const LIMITS = {
  jsGzip: 200 * 1024,     // actuel ~158 KiB (index 109 + leaflet 49)
  cssGzip: 25 * 1024,     // actuel ~15,6 KiB
  heroBytes: 60 * 1024,   // actuel 45 772 o
};

const errors = [];
const ok = [];
const gz = (p) => gzipSync(readFileSync(p)).length;

const indexPath = resolve(DIST, "index.html");
if (!existsSync(indexPath)) {
  console.error("dist/index.html absent — lancer `npm run build` d'abord.");
  process.exit(2);
}
const html = readFileSync(indexPath, "utf8");

// 1. Le hero ne doit jamais venir d'une origine tierce.
const hero = html.match(/<img\b[^>]*fetchpriority=["']high["'][^>]*>/i);
if (!hero) {
  errors.push('aucun <img fetchpriority="high"> dans index.html');
} else {
  const src = (hero[0].match(/\bsrc=["']([^"']+)["']/i) || [])[1] || "";
  if (!src) errors.push("hero sans attribut src");
  else if (/^https?:\/\//i.test(src)) {
    errors.push(`hero servi depuis une origine tierce : ${src} — régression LCP`);
  } else ok.push(`hero local : ${src}`);
}

// 2. Aucune tuile distante dans le HTML initial.
//    (le preconnect est un hint de performance, pas une requête — on l'exclut)
const htmlWithoutPreconnect = html.replace(/<link[^>]*rel=["']preconnect["'][^>]*>/gi, "");
if (/tile\.openstreetmap\.org/.test(htmlWithoutPreconnect)) {
  errors.push("une tuile distante apparaît dans index.html");
}

// 3. Budgets gzip sur les ressources JS du chemin initial
const initial = new Set();
for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.js)["']/gi)) {
  initial.add(m[1]);
}
for (const m of html.matchAll(/<link\b[^>]*\brel=["']modulepreload["'][^>]*\bhref=["']([^"']+\.js)["']/gi)) {
  initial.add(m[1]);
}
let js = 0;
for (const src of initial) {
  const p = resolve(DIST, src.replace(/^\//, ""));
  if (existsSync(p)) js += gz(p);
}
if (js > LIMITS.jsGzip) errors.push(`JS gzip ${(js / 1024).toFixed(1)} KiB > ${LIMITS.jsGzip / 1024} KiB`);
else ok.push(`JS gzip ${(js / 1024).toFixed(1)} KiB`);

// 4. Budget CSS gzip.
const assets = resolve(DIST, "assets");
let css = 0;
if (existsSync(assets)) {
  for (const f of readdirSync(assets)) {
    if (f.endsWith(".css")) {
      css += gz(resolve(assets, f));
    }
  }
}
if (css > LIMITS.cssGzip) errors.push(`CSS gzip ${(css / 1024).toFixed(1)} KiB > ${LIMITS.cssGzip / 1024} KiB`);
else ok.push(`CSS gzip ${(css / 1024).toFixed(1)} KiB`);

// 4. Poids du hero.
const heroPath = resolve(DIST, "img", "hero-512.webp");
if (!existsSync(heroPath)) errors.push("dist/img/hero-512.webp absent");
else {
  const size = statSync(heroPath).size;
  if (size > LIMITS.heroBytes) errors.push(`hero ${size} o > ${LIMITS.heroBytes} o`);
  else ok.push(`hero ${size} o`);
}

for (const m of ok) console.log(`  ok   ${m}`);
for (const m of errors) console.error(`  FAIL ${m}`);
if (errors.length) {
  console.error(`\n${errors.length} invariant(s) cassé(s). Gate rouge.`);
  process.exit(1);
}
console.log("\nGate vert : aucun invariant de performance cassé.");