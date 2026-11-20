import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

function cssPreload(): Plugin {
  return {
    name: "hygropoint:css-preload",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const m = html.match(/<link rel="stylesheet" crossorigin href="(\/assets\/[^"]+\.css)">/);
        if (m) {
          const href = m[1];
          const preload = `<link rel="preload" as="style" href="${href}" crossorigin>`;
          html = html.replace("<script type=\"module\"", preload + "\n    <script type=\"module\"");
        }
        return html;
      },
    },
  };
}
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Lit une notice telle qu'elle est livrée par le paquet réellement installé. */
function readNotice(pkg: string, file: string): string {
  const filePath = path.join(__dirname, "node_modules", pkg, file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Notice de licence introuvable : ${filePath} — lancer npm ci avant de construire.`);
  }
  return fs
    .readFileSync(filePath, "utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

/** Première ligne « Copyright » d'un paquet, telle qu'elle figure dans sa notice. */
function copyrightLine(pkg: string, file: string): string {
  const line = readNotice(pkg, file)
    .split("\n")
    .find((l) => l.trim().startsWith("Copyright"));
  if (!line) throw new Error(`Avis de copyright introuvable dans node_modules/${pkg}/${file}.`);
  return line.trim();
}

/**
 * Bloc de notices du livrable.
 *
 * Le build est un fichier autonome : il redistribue du code tiers sous forme
 * binaire. La BSD-2-Clause de Leaflet (clause 2) et la Hippocratic-2.1 de
 * react-leaflet (clause « Notice ») exigent que l'avis accompagne la
 * distribution ; la MIT de React, React DOM, three.js, clsx et tailwind-merge
 * exige la reproduction de l'avis de copyright.
 *
 * Les textes sont lus dans `node_modules` plutôt que recopiés : ils restent ainsi
 * strictement identiques à ceux des paquets installés et une montée de version
 * ne peut pas laisser une notice périmée. Le contenu est placé dans un
 * commentaire HTML : il n'est ni exécuté, ni rendu, ni téléchargé.
 */
function buildNoticesBlock(): string {
  // Avis de copyright des composants MIT ; le texte de la licence suit.
  const mitAppendix = [
    `${copyrightLine("react", "LICENSE")} — React 19.2.6`,
    `${copyrightLine("react-dom", "LICENSE")} — React DOM 19.2.6`,
    `${copyrightLine("three", "LICENSE")} — three.js 0.187.0`,
    `${copyrightLine("clsx", "license")} — clsx 2.1.1`,
    `${copyrightLine("tailwind-merge", "LICENSE.md")} — tailwind-merge 3.4.0`,
  ];

  const body = [
    "HygroPoint — notices de licence des composants tiers",
    "====================================================",
    "",
    "Ce fichier redistribue du code tiers compilé. Les licences ci-dessous",
    "exigent que leurs avis accompagnent cette distribution :",
    "",
    "  · Leaflet 1.9.4 — BSD-2-Clause (clause 2, redistribution binaire)",
    "  · react-leaflet 5.0.0 — Hippocratic-2.1 (clause « Notice »)",
    "  · React 19.2.6, React DOM 19.2.6, three.js 0.187.0, clsx 2.1.1,",
    "    tailwind-merge 3.4.0 — MIT (avis de copyright)",
    "",
    "Le code propre à HygroPoint est sous licence MIT (voir LICENSE).",
    "Inventaire et textes : THIRD-PARTY-NOTICES.md dans le dépôt.",
    "",
    "",
    "----------------------------------------------------------------------",
    "Leaflet 1.9.4 — BSD-2-Clause",
    "https://leafletjs.com/",
    "----------------------------------------------------------------------",
    "",
    readNotice("leaflet", "LICENSE"),
    "",
    "",
    "----------------------------------------------------------------------",
    "react-leaflet 5.0.0 — Hippocratic-2.1 (Ethical Source, non OSI)",
    "https://react-leaflet.js.org/",
    "----------------------------------------------------------------------",
    "",
    readNotice("react-leaflet", "LICENSE.md"),
    "",
    "",
    "----------------------------------------------------------------------",
    "React 19.2.6 · React DOM 19.2.6 · three.js 0.187.0 · clsx 2.1.1 · tailwind-merge 3.4.0 — MIT",
    "----------------------------------------------------------------------",
    "",
    "Avis de copyright :",
    ...mitAppendix.map((line) => `  ${line}`),
    "",
    readNotice("react", "LICENSE"),
  ].join("\n");

  if (body.includes("-->")) {
    throw new Error("Une notice contient « --> » : le commentaire HTML serait tronqué.");
  }

  return `<!--\n${body}\n-->\n`;
}

/**
 * Injecte les notices en tête de `<head>` une fois le HTML transformé par les
 * autres greffons (`order: "post"`). `vite-plugin-singlefile` n'intervient
 * qu'à `generateBundle` : le bloc survit donc à l'inlining des scripts.
 */
function thirdPartyNotices(): Plugin {
  let block: string | null = null;
  return {
    name: "hygropoint:third-party-notices",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        block ??= buildNoticesBlock();
        return html.replace("<head>", `<head>\n${block}`);
      },
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const portable = mode === "portable";
  return {
    plugins: [
      react(),
      tailwindcss(),
      cssPreload(),
      ...(portable ? [thirdPartyNotices(), viteSingleFile()] : []),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
    build: portable
      ? {}
      : {
          rollupOptions: {
            output: {
              manualChunks: {
                "vendor-three": ["three"],
                "vendor-leaflet": ["leaflet", "react-leaflet"],
              },
            },
          },
        },
  };
});
