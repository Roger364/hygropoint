# hygropoint — consignes agent

Application web d'estimation de l'humidité relative (React 19 + TypeScript + Vite + Tailwind 4).

## Commandes

```bash
npm install
npm run dev         # http://localhost:5173
npm run typecheck   # tsc --noEmit (src, tests, vite.config.ts)
npm test            # banc d'essai du moteur via tsx
npm run build       # dist/index.html (monofichier, vite-plugin-singlefile)
npm run check       # typecheck + test + build
```

## Règles du projet

- Interface, messages d'erreur, commentaires et documentation **en français** (fr-FR).
- Aucune clé d'API, aucun backend, aucun compte : tout passe par des services
  publics appelés depuis le navigateur (`src/lib/openmeteo.ts`, `stations.ts`,
  `terrain.ts`, `geo.ts`). Ne pas introduire de secret dans le dépôt.
- Le moteur (`src/lib/estimate.ts`) doit rester une **fonction pure** de ses
  entrées : pas de `fetch`, pas d'accès au DOM, pas d'horloge implicite (l'instant
  est passé en paramètre). C'est ce qui permet le recalcul instantané et les tests.
- Toute nouvelle hypothèse physique va dans `src/lib/tune.ts` (valeur par défaut
  + métadonnée), pour rester réglable et visible par l'utilisateur.
- Les appels réseau passent par `src/lib/http.ts` (délai maximal, annulation,
  `HttpError`) et remontent un message lisible via `describeError`.
- `tests/engine.test.ts` est un script autonome (`check(nom, condition)`, code de
  sortie 1 en cas d'échec) : ajouter les cas au même format, ne pas le convertir
  en framework sans raison.
- Après un changement de logique : `npm run typecheck && npm test`.


