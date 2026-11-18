# Politique de sécurité — HygroPoint

## Périmètre

HygroPoint est une **application cliente uniquement** : le build
(`dist/index.html`) est un fichier statique autonome, sans serveur applicatif,
sans base de données et sans compte utilisateur. Le projet ne détient **aucune
clé d'API, aucun jeton d'authentification et aucun identifiant** : les services
tiers (Open-Meteo,
Photon, Overpass, Iowa Environmental Mesonet, BigDataCloud, OpenStreetMap) sont
appelés directement depuis le navigateur, sans authentification.

Sont donc concernés par cette politique :

- le code publié dans ce dépôt et le fichier `dist/index.html` qu'il produit ;
- les défauts de sécurité côté client : injection HTML, fuite d'information,
  dépendance vulnérable, contournement des protections du navigateur ;
- les erreurs de calcul ou de validation qui exposeraient des données
  inattendues à un service tiers.

Ne relèvent pas de cette politique : l'indisponibilité ou le comportement des
services publics tiers, les limites de débit qu'ils imposent, et l'exactitude
météorologique des estimations (voir « Hypothèses et limites » du `README.md`).

## Versions prises en charge

| Version | Prise en charge |
| --- | --- |
| 1.x (branche `main`) | Oui |
| Autres / versions dérivées | Non |

Les correctifs sont appliqués sur `main`. Les versions antérieures ne reçoivent
pas de correctif dédié.

## Signaler une vulnérabilité

Merci de **ne pas ouvrir d'issue publique** pour une faille exploitable : une
issue publique révèle le problème avant qu'un correctif existe.

Utilisez le **signalement privé de vulnérabilité de GitHub**
(*Private Vulnerability Reporting*) :

1. ouvrir l'onglet **Security** du dépôt
   <https://github.com/Roger364/hygropoint/security> ;
2. cliquer sur **Report a vulnerability** ;
3. décrire le problème : version concernée, navigateur, étapes de reproduction,
   impact estimé, éventuelle preuve de concept.

Ce canal reste privé entre vous et les mainteneurs et permet d'échanger des
détails techniques sans les exposer. Aucune adresse électronique n'est demandée
ni publiée.

Si le bouton **Report a vulnerability** n'est pas disponible, c'est que le
signalement privé n'est pas encore activé côté dépôt : dans ce cas seulement,
ouvrez une issue **sans détail exploitable** demandant l'ouverture d'un canal
privé.

## Délais annoncés

| Étape | Délai visé |
| --- | --- |
| Accusé de réception | 5 jours ouvrés |
| Première évaluation (gravité, exploitabilité) | 10 jours ouvrés |
| Correctif ou mesure d'atténuation | 30 jours pour une faille critique, 90 jours sinon |

Ces délais sont des objectifs, pas une garantie contractuelle : le projet est
maintenu bénévolement.

## Bonnes pratiques pour les rapports

- Indiquez la version (commit ou `dist/index.html` concerné) et le navigateur.
- Joignez un cas de reproduction minimal ; évitez les données personnelles.
- Ne testez pas sur des infrastructures qui ne vous appartiennent pas et
  n'utilisez pas les services tiers d'une manière qui contourne leurs conditions.
- Un rapport de bonne foi sera traité comme tel : le projet ne poursuivra pas un
  chercheur qui respecte ce cadre.

## Mise à jour des dépendances

Les dépendances sont verrouillées par `package-lock.json` et installées par
`npm ci` en intégration continue. Une dépendance vulnérable doit être signalée
comme ci-dessus ; la mise à jour se fait par une modification du `package.json`
accompagnée du verrouillage correspondant.
