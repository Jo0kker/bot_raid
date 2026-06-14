# API panel admin

Cette API sert de contrat entre le bot Discord GW Events et un futur panel admin plus complet.

## Authentification

Le panel utilise OAuth Discord. Les routes admin lisent la session HTTP-only `gw_events_session`, créée par:

- `GET /auth/discord/login`
- `GET /auth/discord/callback`

Le login OAuth demande les scopes Discord:

- `identify`
- `guilds.members.read`

L'utilisateur doit appartenir au serveur configuré en base (`app_config.value.discord.guildId`) et posséder un rôle listé dans `app_config.value.discord.adminRoleIds`.

Le setup initial se fait avec:

```http
POST /api/setup/discord
Content-Type: application/json

{
  "password": "WEB_SETUP_PASSWORD",
  "guildId": "id_serveur_discord",
  "adminRoleIds": "role_id_1,role_id_2"
}
```

Le header suivant reste accepté uniquement comme secours technique/API:

```http
X-Admin-Token: valeur_de_WEB_ADMIN_TOKEN
```

## Configuration

### `GET /api/config`

Retourne la configuration publique du bot:

- branding
- defaults
- difficulties
- signupStates
- roles
- templates
- links

Cette route n'est pas protégée aujourd'hui parce que le panel statique en a besoin au chargement. Elle ne doit pas exposer de secret.

Cette configuration vient de PostgreSQL: `app_config` pour la configuration globale, `app_roles` pour les groupes de composition, `app_signup_options` pour le catalogue des choix d'inscription, `app_templates` pour les templates de composition et `app_emoji_palette` pour la palette d'icônes.

### `PUT /api/config`

Sauvegarde la configuration admin: roles de composition, templates, difficultes, liens et etats d'inscription.
PostgreSQL est la source de vérité. Il n'y a plus de backup JSON.
Les templates sont écrits dans `app_templates`, pas dans le JSONB global.
Les rôles, options/classes et icônes sont écrits dans `app_roles`, `app_signup_options` et `app_emoji_palette`.

```http
PUT /api/config
Content-Type: application/json
X-Admin-Token: ...
```

Le payload est le JSON complet de configuration.

### `GET /api/discord/options`

Retourne les salons textuels et roles Discord du serveur configuré en base via le setup.

```http
GET /api/discord/options
X-Admin-Token: ...
```

Réponse:

```json
{
  "channels": [
    {
      "id": "123",
      "name": "events",
      "isText": true,
      "canView": true,
      "canSend": true,
      "canEmbed": true,
      "usableForEvents": true,
      "parentId": "456",
      "parentName": "Guild Wars"
    }
  ],
  "roles": [
    {
      "id": "789",
      "name": "Raider",
      "color": "#ff0000",
      "position": 12
    }
  ]
}
```

## Events

### `GET /api/events`

Liste les events, du plus récent au plus ancien.

Requête:

```http
GET /api/events
X-Admin-Token: ...
```

Réponse:

```json
{
  "events": [
    {
      "id": "uuid",
      "title": "Raid du Dimanche 21h",
      "date": "2026-06-14",
      "time": "21:00",
      "timezone": "Europe/Paris",
      "timestampSeconds": 1781463600,
      "channelId": "123456789012345678",
      "difficulty": "CM",
      "leader": "Pseudo",
      "status": "published",
      "discord": {
        "channelId": "123",
        "messageId": "456",
        "url": "https://discord.com/channels/..."
      },
      "allowedRoleIds": ["123456789012345678"],
      "signupCount": 7,
      "stateCounts": {
        "confirmed": 7,
        "late": 1,
        "absence": 2
      },
      "createdAt": "2026-06-14T12:00:00.000Z",
      "updatedAt": "2026-06-14T12:05:00.000Z"
    }
  ]
}
```

### `GET /api/events/:id`

Retourne un event complet avec sa composition et ses inscriptions.

Requête:

```http
GET /api/events/uuid
X-Admin-Token: ...
```

Réponse:

```json
{
  "event": {
    "id": "uuid",
    "title": "Raid du Dimanche 21h",
    "date": "2026-06-14",
    "time": "21:00",
    "timezone": "Europe/Paris",
    "timestampSeconds": 1781463600,
    "difficulty": "CM",
    "leader": "Pseudo",
    "channelId": "123456789012345678",
    "description": "Texte affiche dans Discord",
    "imageUrl": "https://...",
    "roles": [
      {
        "roleId": "dps",
        "label": "DPS",
        "emoji": "⚔️",
        "capacity": 5
      }
    ],
    "links": [
      {
        "label": "Comp",
        "url": "https://snowcrows.com"
      }
    ],
    "allowedRoleIds": [
      "123456789012345678"
    ],
    "discord": {
      "channelId": "123",
      "messageId": "456",
      "url": "https://discord.com/channels/..."
    },
    "signups": [
      {
        "userId": "123",
        "userName": "DiscordName",
        "userDisplayName": "Pseudo serveur",
        "userAvatarUrl": "https://cdn.discordapp.com/...",
        "roleId": "dps",
        "state": "confirmed",
        "updatedAt": "2026-06-14T12:05:00.000Z"
      }
    ],
    "status": "published",
    "createdAt": "2026-06-14T12:00:00.000Z",
    "updatedAt": "2026-06-14T12:05:00.000Z"
  }
}
```

### `POST /api/events`

Crée un event, le stocke, puis publie ou édite le message Discord.

Requête:

```http
POST /api/events
Content-Type: application/json
X-Admin-Token: ...
```

Payload:

```json
{
  "title": "Raid du Dimanche 21h",
  "templateId": "raid10",
  "date": "2026-06-14",
  "time": "21:00",
  "difficulty": "CM",
  "leader": "Pseudo",
  "channelId": "123456789012345678",
  "description": "N'oubliez pas de vous inscrire.",
  "imageUrl": "https://...",
  "roles": [
    {
      "roleId": "dps",
      "label": "DPS",
      "emoji": "⚔️",
      "capacity": 5
    }
  ],
  "links": [
    {
      "label": "Comp",
      "url": "https://snowcrows.com"
    }
  ],
  "allowedRoleIds": [
    "123456789012345678"
  ]
}
```

Réponse:

```json
{
  "id": "uuid",
  "discordUrl": "https://discord.com/channels/..."
}
```

### `PUT /api/events/:id`

Modifie un event existant puis met a jour le message Discord.

Le payload est le meme que `POST /api/events`.

```http
PUT /api/events/uuid
Content-Type: application/json
X-Admin-Token: ...
```

Réponse:

```json
{
  "id": "uuid",
  "discordUrl": "https://discord.com/channels/..."
}
```

### `DELETE /api/events/:id`

Supprime l'event et tente de supprimer le message Discord associe.

```http
DELETE /api/events/uuid
X-Admin-Token: ...
```

Réponse:

```json
{
  "deleted": true
}
```

## Restriction par roles Discord

Un event peut etre limite a certains roles Discord avec `allowedRoleIds`.

Si la liste est vide, tout le monde peut interagir avec l'event.

Si la liste contient des IDs, seuls les membres ayant au moins un de ces roles peuvent utiliser le selecteur de role ou les boutons Bench/Retard/Tentative/Absence.

Pour recuperer l'ID d'un role Discord:

1. activer le mode developpeur dans Discord;
2. aller dans les parametres du serveur;
3. menu Roles;
4. clic droit sur le role;
5. copier l'identifiant.

## Webhook sortant inscriptions

Si `SIGNUP_WEBHOOK_URL` est défini dans `.env`, le bot envoie un `POST` à cette URL après chaque inscription ou changement de statut.

Variables:

```env
SIGNUP_WEBHOOK_URL=https://panel.example.com/webhooks/gw-events/signups
SIGNUP_WEBHOOK_SECRET=secret-partage-optionnel
```

Header envoyé si `SIGNUP_WEBHOOK_SECRET` existe:

```http
X-GW-Events-Secret: secret-partage-optionnel
```

Payload:

```json
{
  "type": "signup.updated",
  "action": "role-selected",
  "occurredAt": "2026-06-14T12:10:00.000Z",
  "event": {
    "id": "uuid",
    "title": "Raid du Dimanche 21h",
    "date": "2026-06-14",
    "time": "21:00",
    "timezone": "Europe/Paris",
    "discordUrl": "https://discord.com/channels/..."
  },
  "signup": {
    "userId": "123",
    "userName": "DiscordName",
    "roleId": "dps",
    "state": "confirmed",
    "updatedAt": "2026-06-14T12:10:00.000Z"
  }
}
```

Actions possibles aujourd'hui:

- `role-selected`
- `state-selected`

Le panel peut ignorer le webhook et simplement appeler `GET /api/events/:id` apres reception pour recharger l'etat complet.

## Stockage

Le stockage recommande est PostgreSQL:

```env
DATABASE_URL=postgres://user:password@localhost:5432/gw_events
DATABASE_SSL=false
```

Au demarrage, le bot cree automatiquement les tables:

- `events`
- `signups`
- `app_config`
- `app_roles`
- `app_signup_options`
- `app_templates`
- `app_emoji_palette`

Si `DATABASE_URL` n'est pas defini, le bot refuse de demarrer. Le fallback JSON a ete supprime.

Limites connues:

- pas encore d'historique d'audit separe
- pas encore de gestion fine des comptes admin
