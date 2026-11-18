# Contribuer à HygroPoint

HygroPoint est une démonstration technique ouverte : le code est publié sous
licence MIT pour être lu, vérifié, réutilisé et amélioré. Ce fichier décrit la
manière de signaler un problème ou de proposer une modification.

Avant d'ouvrir une issue ou une *pull request*, lire le [`README.md`](README.md)
(architecture, hypothèses, limites) et les règles du projet dans
[`AGENTS.md`](AGENTS.md).

## Signaler un bug

Les anomalies se signalent dans les **issues GitHub** :
<https://github.com/Roger364/hygropoint/issues>.

Une issue exploitable contient :

- la version utilisée (tag, commit, ou « démo en ligne » avec la date) ;
- le navigateur et le système (par exemple « Firefox 132, Windows 11 ») ;
- le lieu choisi, en coordonnées (`45.1885, 5.7245`) plutôt qu'en texte libre ;
- les étapes qui reproduisent le problème, le résultat attendu et le résultat
  observé ;
- le message d'erreur affiché et, si possible, les erreurs de la console du
  navigateur ;
- une capture d'écran quand le problème est visuel.

Ne joignez pas de données personnelles : l'application n'a pas de compte et
seules les coordonnées du lieu partent vers les services météo.

Un service public indisponible (Open-Meteo, Overpass, Photon, IEM) n'est pas un
bug du projet : l'application affiche l'erreur et conserve les données déjà
chargées. Une estimation qui paraît fausse relève plutôt des « Hypothèses et
limites » du README ; précisez la station de référence et les valeurs mesurées
si vous en disposez.

Pour une **faille de sécurité**, n'ouvrez pas d'issue publique : suivez
[`SECURITY.md`](SECURITY.md).

## Proposer une modification

1. Forker le dépôt et créer une branche depuis `main`.
2. Limiter la *pull request* à un sujet : une correction, une fonctionnalité ou
   une passe de documentation.
3. Écrire des commits en français, à l'impératif, avec un préfixe quand c'est
   utile (`fix:`, `docs:`, `test:`…), sur le modèle de l'historique.
4. Vérifier localement (`npm run check`, voir ci-dessous) : la CI exécute la
   même commande et doit être verte.
5. Ouvrir la *pull request* vers `main` en expliquant le problème, la solution
   retenue et ce qui a été vérifié.

Une relecture est demandée avant fusion. Les retours portent sur le fond
(calcul, comportement, accessibilité) autant que sur la forme.

## Style de code

- **TypeScript strict** (`tsconfig.json` : `strict`, `noUnusedLocals`,
  `noUnusedParameters`, `noFallthroughCasesInSwitch`). Pas de `any` : typer les
  données aux frontières (réponses des services) et laisser le reste s'inférer.
  Pas de `@ts-ignore` : un `as` se justifie à une frontière de données, jamais
  pour faire taire une erreur de type.
- **Interface, messages d'erreur, commentaires et documentation en français**
  (fr-FR), comme le reste du dépôt.
- **Le moteur reste pur** : `src/lib/estimate.ts` ne fait ni `fetch`, ni accès
  au DOM, ni lecture d'horloge ; l'instant est un paramètre. C'est ce qui rend
  le recalcul instantané et les tests possibles.
- **Les appels réseau passent par `src/lib/http.ts`** (délai maximal,
  annulation, `HttpError`) et remontent un message lisible via `describeError`.
- **Toute nouvelle hypothèse physique va dans `src/lib/tune.ts`**, avec sa
  valeur par défaut et sa métadonnée, pour rester réglable dans l'interface.
- **Pas de clé d'API, de backend, de compte ni de traceur** : l'application
  reste un fichier statique autonome, sans collecte de données.
- Aucun formateur automatique n'est configuré : suivre le style des fichiers
  existants (guillemets doubles, points-virgules, 2 espaces, virgule finale
  dans les listes et objets multilignes).

## Tests

`tests/engine.test.ts` est un script autonome : `check(nom, condition)`, code de
sortie 1 en cas d'échec. Ajouter les cas au même format plutôt que d'introduire
un framework. Un changement de logique du moteur (fusion, terrain, incertitude,
verdict) doit venir avec le cas qui le couvre — idéalement sur le monde
synthétique dont la vérité est connue.

## Vérification avant envoi

Prérequis : Node.js ≥ 20.19 et npm.

```bash
npm ci          # ou npm install
npm run check   # typecheck + tests + build
```

`npm run check` enchaîne `tsc --noEmit`, le banc d'essai du moteur et le build
monofichier ; c'est exactement ce que fait la CI
(`.github/workflows/ci.yml`). Pour un travail sur l'interface, `npm run dev`
sert l'application sur <http://localhost:5173>.

## Licence

Le code du dépôt est sous **MIT** (voir [`LICENSE`](LICENSE)). En proposant une
contribution, vous acceptez qu'elle soit publiée sous cette même licence. Aucun
accord de contribution (CLA) n'est demandé : votre contribution reste la vôtre,
sous MIT, aux côtés du reste du projet.

Les dépendances gardent leurs licences respectives ; l'inventaire est dans
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
