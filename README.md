# Nuvio — Catalogues streaming France & Canada

Addon statique compatible avec le protocole de catalogues Stremio, destiné à Nuvio. Il publie des catalogues séparés pour les films et les séries, en France et au Canada.

## Ce que contiennent les catalogues

Pour chacun des deux pays et chaque type (films/séries) :

1. **Sorties des 12 derniers mois — actuellement disponibles** : titres dont la date de sortie initiale est dans les 365 derniers jours et qui disposent actuellement d'au moins une offre de streaming correspondant aux types configurés.
2. **Ajouts détectés depuis le lancement** : nouvelles disponibilités ou nouveaux fournisseurs observés lors d'un scan après le premier scan de référence.
3. **Disponibilités retirées** : offres/fournisseurs qui étaient présents lors du scan précédent et qui ne sont plus retournés.
4. **Tendances** : titres actuellement disponibles, triés selon la popularité TMDB parmi les titres analysés.

L'historique des événements affiché est conservé pendant 90 jours. L'état des titres est sauvegardé dans `data/state.json` et commité automatiquement par GitHub Actions.

## Important : limite de la rétroactivité

La rétroactivité de 12 mois signifie : **date de sortie initiale du titre dans les 365 derniers jours + disponibilité actuelle**. Elle ne signifie pas que nous connaissons la date historique exacte à laquelle le titre a été ajouté à Netflix, Prime Video, Disney+, etc. L'API TMDB/JustWatch fournit les offres actuellement répertoriées, pas un historique complet des dates d'arrivée passées.

Le premier scan établit une base de référence et ne transforme pas toutes les disponibilités existantes en faux « ajouts récents ». Les véritables ajouts/retraits de cet addon commencent à être datés à partir des scans suivants. Les dates affichées sont des dates de détection par cet addon, pas des dates officielles de lancement streaming.

## Source et attribution

Les données de disponibilité par pays sont obtenues avec les endpoints TMDB Watch Providers, alimentés par JustWatch. **L'attribution JustWatch est obligatoire** : elle est incluse dans les descriptions du manifest et des fiches. Consultez les conditions et la documentation :

- TMDB Watch Providers — séries : https://developer.themoviedb.org/reference/tv-series-watch-providers
- TMDB API : https://developer.themoviedb.org/docs/getting-started
- Conditions TMDB : https://www.themoviedb.org/api-terms-of-use

## Déploiement depuis un téléphone Android

Aucun ordinateur ni serveur Node.js permanent n'est nécessaire. GitHub Actions exécute le scan toutes les 3 heures et publie les fichiers statiques sur GitHub Pages.

### 1. Créer le dépôt

1. Sur GitHub, créez un nouveau dépôt, par exemple `nuvio-streaming-catalogues`.
2. Choisissez **Public** (GitHub Pages gratuit est le plus simple sur un dépôt public).
3. Ne cochez pas l'option pour ajouter un README, car le ZIP contient déjà les fichiers.
4. Téléversez **le contenu du ZIP** à la racine du dépôt, en conservant le dossier `.github/workflows/` et le dossier `src/`.

### 2. Ajouter le secret TMDB

1. Créez/ouvrez votre jeton TMDB API **Read Access Token v4** depuis https://www.themoviedb.org/settings/api.
2. Dans GitHub, ouvrez le nouveau dépôt → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
3. Nom exact : `TMDB_API_TOKEN`.
4. Collez le jeton v4 comme valeur. Ne le mettez jamais dans un fichier du dépôt et ne le partagez pas dans une conversation.

### 3. Activer GitHub Pages

1. Dépôt → **Settings** → **Pages**.
2. Dans **Build and deployment**, choisissez **GitHub Actions** comme source.
3. Enregistrez si GitHub le demande.

### 4. Lancer le premier scan

1. Ouvrez l'onglet **Actions**.
2. Choisissez **Build and deploy Nuvio catalogues**.
3. Appuyez sur **Run workflow** puis confirmez.
4. Attendez la fin du travail. Le premier scan peut être long car il constitue la base de référence rétroactive.
5. Les scans suivants tourneront automatiquement toutes les trois heures.

Le workflow conserve automatiquement `data/state.json` dans le dépôt. Ne supprimez pas ce fichier : il contient l'historique nécessaire à la détection des ajouts et retraits.

## URL à utiliser dans Nuvio

Après le premier déploiement réussi, l'URL du manifest sera :

`https://VOTRE-PSEUDO.github.io/VOTRE-DEPOT/manifest.json`

Exemple si le compte GitHub est `mouradb3` et le dépôt `nuvio-streaming-catalogues` :

`https://mouradb3.github.io/nuvio-streaming-catalogues/manifest.json`

Ajoutez cette URL comme addon/catalogue personnalisé dans Nuvio. Ne remplacez pas vos catalogues MDBList existants : cet addon est indépendant.

## Contrôles après déploiement

- `/manifest.json` : manifest et liste des catalogues.
- `/status.json` : dernière mise à jour, nombre de titres et nombre d'événements.
- `/catalog/movie/nuvio-releases-fr-movies.json` : sorties récentes disponibles en France.
- `/catalog/series/nuvio-releases-ca-series.json` : sorties récentes disponibles au Canada.

## Réglages du scan

Le workflow utilise actuellement :

- fenêtre de sorties : 365 jours ;
- 20 pages TMDB par type et par pays (jusqu’à 400 candidats par segment ; le catalogue lui-même n’applique pas de plafond fixe) ;
- offres `flatrate` uniquement par défaut (abonnements) ;
- historique visible des événements : 90 jours ;
- cadence : toutes les 3 heures.

Le nombre de pages peut être augmenté dans `.github/workflows/deploy.yml` via `MAX_PAGES_PER_TYPE_REGION` (jusqu’à 500 pages selon les limites TMDB), au prix de davantage de requêtes TMDB et d’un scan plus long. Le nombre de résultats retournés dans chaque fichier catalogue n’est pas tronqué artificiellement. Les offres gratuites/avec publicité peuvent être ajoutées à `MONETIZATION_TYPES` (`flatrate,free,ads`). Les offres `rent` et `buy` ne sont pas incluses par défaut.

Les productions dont le pays de production TMDB inclut l'Inde (`IN`) sont exclues. Le filtre se base sur le pays de production/origine, pas sur la langue du titre : un film non indien en langue hindi n'est donc pas exclu uniquement pour cette raison.

## Fichiers principaux

- `src/tmdb.js` : client TMDB avec reprise en cas de limitation temporaire.
- `src/update.js` : rétroactivité, scan des offres, comparaison des états, export des catalogues.
- `src/export-static.js` : validation de tous les catalogues statiques avant publication.
- `.github/workflows/deploy.yml` : exécution planifiée, persistance de l'état et déploiement Pages.
- `data/state.json` : créé automatiquement au premier scan, puis mis à jour à chaque exécution.
- `public/` : fichiers statiques servis par GitHub Pages.
