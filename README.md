# GW Discord Event Bot

Bot Discord pour créer des annonces d'events Guild Wars / Guild Wars 2 avec inscription par rôle, templates de composition et petit portail web d'administration.

## Installation

```powershell
npm install
Copy-Item .env.example .env
```

Renseigne ensuite `.env` avec le token du bot, l'ID du serveur et l'ID du salon où poster les events.

## Base de données locale

Un PostgreSQL local est fourni via Docker Compose:

```powershell
docker compose up -d postgres
```

La variable `.env` compatible est:

```env
DATABASE_URL=postgres://gw_events:gw_events_dev_password@localhost:5432/gw_events
DATABASE_SSL=false
```

Le bot crée automatiquement les tables au démarrage. Les données PostgreSQL sont conservées dans le volume Docker `botdiscordgw_postgres_data` ou un nom proche selon le dossier du projet.

Pour vérifier que les tables existent dans le PostgreSQL Docker:

```powershell
npm run db:tables
```

Pour ouvrir `psql` dans la bonne base:

```powershell
npm run db:shell
```

Au démarrage, le bot affiche le backend utilisé:

```text
Stockage: postgres
Configuration: postgres
```

Si `DATABASE_URL` est absent, le bot refuse de démarrer. Il n'y a plus de fallback JSON.

## Environnement de test

Un PostgreSQL de test séparé est disponible sur le port `5433`:

```powershell
npm run db:test
```

Il utilise:

```env
DATABASE_URL=postgres://gw_events_test:gw_events_test_password@localhost:5433/gw_events_test
WEB_PORT=3001
PUBLIC_BASE_URL=http://localhost:3001
WEB_SESSION_SECRET=test-session-secret-change-me
```

Le fichier [.env.test](.env.test) contient ces credentials de test. Renseigne seulement les valeurs Discord de test avant de lancer:

```powershell
npm run start:test:win
```

Sur Linux/macOS:

```bash
npm run start:test
```

Pour arrêter la base de test:

```powershell
npm run db:test:down
```

## Lancer

```powershell
npm start
```

Le panel est disponible sur `http://localhost:3000`.

Le panel utilise OAuth Discord. Le serveur cible et les rôles admin sont enregistrés en base depuis le bloc `Setup serveur` du panel.

## OAuth Discord

Dans le Discord Developer Portal, ajoute cette Redirect URI:

```text
https://ton-domaine.example/auth/discord/callback
```

En local, utilise:

```text
http://localhost:3000/auth/discord/callback
```

Scopes utilisés pour la connexion admin:

- `identify`
- `guilds.members.read`

Scopes utilisés pour le bouton "Ajouter à Discord":

- `bot`
- `applications.commands`

Variables à configurer:

```env
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
PUBLIC_BASE_URL=https://ton-domaine.example
WEB_SESSION_SECRET=une-valeur-longue-aleatoire
WEB_SETUP_PASSWORD=mot-de-passe-pour-configurer-le-serveur
```

Après déploiement:

1. Ouvre le panel.
2. Clique `Ajouter à Discord` et choisis le serveur.
3. Dans `Setup serveur`, saisis `WEB_SETUP_PASSWORD`, l'ID du serveur Discord et les IDs des rôles admin.
4. Clique `Connexion Discord`.

## Leader Discord

Le champ leader accepte toujours une vraie mention Discord (`<@id>`) ou un ID utilisateur.

La recherche par pseudo (`@pseudo`) est optionnelle. Pour l'activer:

1. Dans le Discord Developer Portal, active `Bot > Privileged Gateway Intents > Server Members Intent`.
2. Dans `.env`, mets:

```env
DISCORD_ENABLE_GUILD_MEMBERS_INTENT=true
```

Si l'intent n'est pas activé côté Discord mais demandé dans `.env`, Discord renvoie `Used disallowed intents` au démarrage.

## Configuration

La configuration admin est stockée dans PostgreSQL:

- `app_config`, clé `guild`: configuration globale
- `app_roles`: groupes de composition, par exemple Heal, Tank, Support, DPS
- `app_signup_options`: options/classes d'inscription possibles, par exemple Druide, Healbrand, Quickness
- `app_templates`: templates de composition, avec `id`, `label`, `game`, `roles`, `signup_options`
- `app_emoji_palette`: palette d'emojis/icônes proposée dans le panel

Les events et inscriptions sont aussi en PostgreSQL:

- `events`
- `signups`

Les fichiers `config/guild.json` et `data/events.json` ne sont plus utilisés.

Pour construire un panel admin plus complet, le contrat API et le webhook d'inscription sont documentés dans [docs/panel-api.md](docs/panel-api.md).

## Permissions Discord

Le bot a besoin de pouvoir:

- lire et envoyer des messages dans le salon d'events
- intégrer des liens / embeds
- utiliser les composants interactifs
- gérer ses propres messages
