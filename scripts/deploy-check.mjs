#!/usr/bin/env node
// Vérifie que la prod sert le même bundle que dist/.
// Usage : npm run perf:deploy-check  (ou node scripts/deploy-check.mjs [URL])
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PROD = process.argv[2] || "https://labo.bissestudio.ch/";
const DIST = resolve("dist");

// 1. Hash local
const assets = resolve(DIST, "assets");
const jsFiles = existsSync(assets)
  ? readdirSync(assets).filter(f => /^index-.*\.js$/.test(f))
  : [];
if (jsFiles.length !== 1) {
  console.error(`dist/assets: attendu 1 index-*.js, trouvé ${jsFiles.length}`);
  process.exit(2);
}
const localHash = jsFiles[0].replace(/^index-/, "").replace(/\.js$/, "");

// 2. Hash prod
const html = await fetch(PROD).then(r => r.text());
const m = html.match(/index-([A-Za-z0-9_-]+)\.js/);
if (!m) {
  console.error("prod: aucun index-*.js dans le HTML");
  process.exit(2);
}
const prodHash = m[1];

console.log(`local : ${localHash}`);
console.log(`prod  : ${prodHash}`);

if (localHash !== prodHash) {
  console.error("\nDIVERGENCE : la prod ne sert pas le bundle local. Redéployer.");
  process.exit(1);
}
console.log("\nOK : prod et dist alignés.");
