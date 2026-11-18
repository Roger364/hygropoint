# HygroPoint

Estimation de l'humidité relative de l'air **à l'endroit précis que vous désignez** :
les 24 heures passées, l'instant présent et les 72 heures à venir, recalés sur les
mesures réelles des stations météo voisines.

Application web autonome (aucun serveur, aucune clé d'API, aucun compte). Le
navigateur interroge directement des services publics de météo, de relief et de
cartographie, puis calcule l'estimation localement.

---

## Ce que fait l'application

| Fonction | Détail |
| --- | --- |
| Choix du lieu | Recherche par nom ou adresse (Photon / OpenStreetMap, secours Open-Meteo), coordonnées saisies à la main (`45.1885, 5.7245`, `48,85 N 2,35 E`), clic ou repère glissé sur la carte, ou géolocalisation du navigateur. |
| Humidité maintenant | Valeur, intervalle de confiance à 80 %, point de rosée, humidité absolue et confort ressenti. |
| Évolution | Graphique 24 h passées / 72 h à venir avec les différents modèles, tableau heure par heure, synthèse par journée (moyenne, min, max, cumul de pluie). |
| Relief 3D | Terrain interactif (three.js) autour du point : creux et bosses, plans d'eau, couvert forestier, stations de mesure ; un clic déplace le point. |
| Hypothèses réglables | Curseurs (poche de froid nocturne, contraste de versant, apport d'un plan d'eau, portée d'une station…) avec l'effet immédiat sur la valeur et l'incertitude. |
| Calage sur le passé | Comparaison sur 7 jours entre humidité anticipée et humidité mesurée, regroupée par situation météo ; une correction n'est retenue que si elle améliore les dernières 24 h (validation hors échantillon). |
| Compte rendu | Verdict lisible (« air sec », « lourd »…), provenance des chiffres, avertissements quand les stations sont trop loin ou trop haut. |

## Comment l'estimation est construite

1. **Modèles** — Open-Meteo renvoie cinq modèles (ECMWF IFS, DWD ICON,
   Météo-France AROME/ARPEGE, NOAA GFS/HRRR, sélection locale). L'humidité est
   déduite de la température et du point de rosée (Magnus, coefficients
   Alduchov & Eskridge 1996, convention OMM), pas d'un simple champ « RH ».
2. **Stations** — les METAR les plus proches (réseau ASOS via Iowa Environmental
   Mesonet) sont classés par distance et par dénivelé, puis convertis en
   « mesures attendues au point » via le gradient thermique.
3. **Terrain** — modèle numérique de terrain (API elevation d'Open-Meteo) sur
   plusieurs emprises (700 m à 20 km) pour le creux topographique, l'exposition
   des versants et l'ensoleillement réel ; Overpass/OSM pour les plans d'eau
   (jusqu'à 1,5 km) et le couvert forestier (600 m).
4. **Fusion** — pondération bayésienne : confiance décroissante avec la distance
   (échelle 35 km) et le dénivelé (250 m), biais par régime météo, moyenne
   pondérée avec les modèles quand aucune mesure n'est exploitable.
5. **Incertitude** — écart type propagé (bruit d'une mesure METAR ≈ 3,5 points,
   erreur des modèles ≈ 9 points, +30 % à 72 h), intervalle à 80 %.

Tout le calcul est une **fonction pure** de ses entrées : bouger un curseur ou
changer d'échelle recalcule l'affichage sans nouvelle requête réseau.

## Sources de données et licences

| Source | Usage | Licence / conditions |
| --- | --- | --- |
| [Open-Meteo](https://open-meteo.com/) | Prévisions multi-modèles, altitude, géocodage de secours | CC BY 4.0, usage non commercial gratuit (10 000 req/jour) |
| [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/) | Réseaux et observations METAR/ASOS | Données publiques, citer l'IEM |
| [Photon (komoot)](https://photon.komoot.io/) · OpenStreetMap | Recherche de lieux, géocodage inverse | ODbL (© contributeurs OpenStreetMap) |
| [BigDataCloud](https://www.bigdatacloud.net/) | Géocodage inverse de secours | Service public gratuit, sans clé |
| [Overpass API](https://overpass-api.de/) | Plans d'eau et forêts (OSM) | ODbL, serveurs publics à ménager |
| [OpenStreetMap](https://www.openstreetmap.org/) | Fonds de carte (tuiles raster) | © contributeurs OpenStreetMap ; données sous ODbL |

L'estimation reste **indicative** : elle ne remplace ni un hygromètre, ni un
bulletin officiel.

## Démarrage rapide

Prérequis : **Node.js ≥ 20.19** (testé avec Node 24) et npm.

```bash
git clone https://github.com/Roger364/hygropoint.git
cd hygropoint
npm install
npm run dev      # http://localhost:5173
```

Sous Windows, `demarrer.bat` fait la même chose en double-clic (installation si
besoin, puis ouverture du navigateur).

### Build de production

```bash
npm run build    # dist/index.html — un seul fichier autonome (HTML + CSS + JS)
npm run preview  # vérification locale du build
```

Grâce à `vite-plugin-singlefile`, le build tient dans **un seul `dist/index.html`** :
il peut être ouvert directement, envoyé par courriel ou déposé sur n'importe quel
hébergement statique (GitHub Pages, Netlify, Cloudflare Pages, un simple dossier
partagé). Aucune variable d'environnement n'est nécessaire.

## Scripts

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Serveur de développement Vite avec rechargement à chaud |
| `npm run build` | Build de production dans `dist/` |
| `npm run preview` | Sert le build local |
| `npm run typecheck` | `tsc --noEmit` sur `src/`, `tests/` et la configuration |
| `npm test` | Vérification du moteur d'estimation sur un monde synthétique dont la vérité est connue |
| `npm run check` | Typecheck + tests + build, dans cet ordre |

## Architecture

```text
hygropoint/
├── index.html                 point d'entrée, métadonnées et favicon
├── vite.config.ts             React + Tailwind 4 + build monofichier, alias @ → src
├── tsconfig.json              strict, noUnusedLocals/Parameters
├── src/
│   ├── main.tsx               montage React + ErrorBoundary racine
│   ├── App.tsx                état du lieu, orchestration, mise en page
│   ├── index.css              thème Tailwind, thème sombre, styles Leaflet
│   ├── components/            carte, relief 3D, graphique, cartes de synthèse
│   ├── hooks/useHumidity.ts   chargement (modèles → stations → terrain), rafraîchissement 15 min
│   ├── lib/
│   │   ├── estimate.ts        moteur : fusion, terrain, incertitude, verdict (≈ 1 400 lignes)
│   │   ├── physics.ts         Magnus, point de rosée, humidité absolue
│   │   ├── openmeteo.ts       clients Open-Meteo et analyse tolérante des réponses
│   │   ├── stations.ts        réseaux METAR, historique CSV, classement des stations
│   │   ├── terrain.ts         relief, eau et forêt, position du soleil
│   │   ├── dem.ts             grilles d'altitude, plusieurs emprises, cache LRU
│   │   ├── geo.ts             haversine, saisie de coordonnées, géocodage
│   │   ├── retrospective.ts   calage sur les mesures passées
│   │   ├── tune.ts            hypothèses réglables et leurs métadonnées
│   │   ├── format.ts          formatage fr-FR, fuseaux, cache des Intl
│   │   └── http.ts            fetch avec délai maximal, annulation, erreurs typées
│   └── utils/cn.ts            fusion de classes Tailwind
└── tests/engine.test.ts       banc d'essai du moteur (monde synthétique + vérité terrain)
```

Principes tenus dans le code :

- **Aucune donnée utilisateur envoyée** : le lieu choisi reste dans le
  `localStorage` du navigateur ; seules les coordonnées partent vers les services
  météo, comme pour n'importe quelle consultation de prévision.
- **Le réseau ne bloque jamais l'affichage** : modèles d'abord, terrain ensuite,
  chaque appel a un délai maximal et une erreur en français.
- **Honnêteté des chiffres** : chaque valeur affichée sait d'où elle vient
  (mesure, persistance, correction apprise) et annonce son incertitude.

## Hypothèses et limites

- L'humidité relative est très locale (fond de vallon, bord de lac, sous-bois).
  Les valeurs par défaut des curseurs sont des ordres de grandeur ; elles sont
  ajustables parce qu'elles ne sont pas mesurables à votre endroit.
- Une station METAR arrondit température et point de rosée au degré : l'écart
  résiduel est de l'ordre de 3 à 5 points d'humidité.
- En mer ou dans les régions sans station à moins de 80 km, l'estimation repose
  sur les seuls modèles et l'incertitude affichée augmente.
- Les services publics (Overpass, Photon, IEM) peuvent limiter le débit : les
  messages d'erreur le signalent et les données déjà affichées restent visibles.
