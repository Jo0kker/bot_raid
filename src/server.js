const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { PermissionFlagsBits } = require("discord.js");
const { loadConfig, saveConfig } = require("./config");
const { createEvent, deleteEvent, getEvent, readEvents, updateEvent } = require("./storage");
const { deleteEventMessage, getGuildOptions, publishEvent } = require("./bot");

const PUBLIC_DIR = path.join(process.cwd(), "public");
const SESSION_COOKIE = "gw_events_session";
const OAUTH_STATE_COOKIE = "gw_events_oauth_state";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function redirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function assertAdmin(request) {
  const session = readSession(request);
  if (session) {
    return session;
  }

  const expected = process.env.WEB_ADMIN_TOKEN;
  if (!expected) {
    const error = new Error("Connexion Discord requise.");
    error.status = 401;
    throw error;
  }

  if (request.headers["x-admin-token"] !== expected) {
    const error = new Error("Token admin invalide.");
    error.status = 401;
    throw error;
  }
}

function parseCookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function cookieHeader(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function authSecret() {
  const secret = process.env.WEB_SESSION_SECRET || process.env.WEB_ADMIN_TOKEN || process.env.DISCORD_CLIENT_SECRET;
  if (!secret) {
    throw new Error("WEB_SESSION_SECRET ou DISCORD_CLIENT_SECRET est requis pour les sessions OAuth.");
  }
  return secret;
}

function sign(value) {
  return crypto.createHmac("sha256", authSecret()).update(value).digest("base64url");
}

function createSessionCookie(session) {
  const payload = Buffer.from(JSON.stringify({
    ...session,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readSession(request) {
  const raw = parseCookies(request)[SESSION_COOKIE];
  if (!raw) {
    return null;
  }

  const [payload, signature] = raw.split(".");
  if (!payload || !signature || signature !== sign(payload)) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.exp || session.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function baseUrl(request) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  }
  const proto = request.headers["x-forwarded-proto"] || "http";
  const host = request.headers["x-forwarded-host"] || request.headers.host || `localhost:${process.env.WEB_PORT || 3000}`;
  return `${proto}://${host}`;
}

function oauthRedirectUri(request) {
  return process.env.DISCORD_OAUTH_REDIRECT_URI || `${baseUrl(request)}/auth/discord/callback`;
}

function requiredOAuthEnv() {
  for (const key of ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"]) {
    if (!process.env[key]) {
      throw new Error(`${key} est requis pour OAuth Discord.`);
    }
  }
}

function normalizeCsvIds(value) {
  return String(value || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

async function discordSettings() {
  const config = await loadConfig();
  return {
    guildId: config.discord?.guildId || "",
    adminRoleIds: Array.isArray(config.discord?.adminRoleIds) ? config.discord.adminRoleIds : []
  };
}

async function updateDiscordSettings(input) {
  const guildId = normalizeDiscordId(input.guildId);
  if (!guildId) {
    const error = new Error("ID serveur Discord invalide.");
    error.status = 400;
    throw error;
  }

  const config = await loadConfig();
  config.discord = {
    ...(config.discord || {}),
    guildId,
    adminRoleIds: Array.isArray(input.adminRoleIds)
      ? input.adminRoleIds.map(normalizeDiscordId).filter(Boolean)
      : normalizeCsvIds(input.adminRoleIds).map(normalizeDiscordId).filter(Boolean)
  };
  return saveConfig(config);
}

function assertSetupPassword(input) {
  const expected = process.env.WEB_SETUP_PASSWORD || process.env.WEB_ADMIN_TOKEN;
  if (!expected || input.password !== expected) {
    const error = new Error("Mot de passe setup invalide.");
    error.status = 401;
    throw error;
  }
}

function discordLoginUrl(request, state) {
  requiredOAuthEnv();
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: oauthRedirectUri(request),
    response_type: "code",
    scope: "identify guilds.members.read",
    state,
    prompt: "none"
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

function discordInviteUrl(request) {
  const permissions = (
    PermissionFlagsBits.ViewChannel |
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.EmbedLinks |
    PermissionFlagsBits.ReadMessageHistory |
    PermissionFlagsBits.UseExternalEmojis |
    PermissionFlagsBits.ManageGuildExpressions
  ).toString();
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID || "",
    permissions,
    scope: "bot applications.commands"
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

async function discordApi(pathname, accessToken) {
  const response = await fetch(`https://discord.com/api/v10${pathname}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || "Discord OAuth API error.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function exchangeDiscordCode(request, code) {
  requiredOAuthEnv();
  const response = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: oauthRedirectUri(request)
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error_description || payload.message || "Échange OAuth Discord impossible.");
    error.status = 401;
    throw error;
  }
  return payload;
}

async function createOAuthSession(request, code) {
  const token = await exchangeDiscordCode(request, code);
  const user = await discordApi("/users/@me", token.access_token);
  const settings = await discordSettings();
  if (!settings.guildId) {
    const error = new Error("Aucun serveur Discord n'est configuré. Utilise le setup avant de te connecter.");
    error.status = 403;
    throw error;
  }

  const member = await discordApi(`/users/@me/guilds/${settings.guildId}/member`, token.access_token);
  const allowedRoles = settings.adminRoleIds;
  if (allowedRoles.length === 0) {
    const error = new Error("Aucun rôle admin configuré. Utilise le setup serveur avant la connexion OAuth.");
    error.status = 403;
    throw error;
  }

  const hasAllowedRole = member.roles?.some((roleId) => allowedRoles.includes(roleId));
  if (!hasAllowedRole) {
    const error = new Error("Accès refusé: ton compte Discord n'a pas un rôle admin autorisé.");
    error.status = 403;
    throw error;
  }
  return {
    userId: user.id,
    username: user.username,
    globalName: user.global_name,
    avatar: user.avatar,
    roles: member.roles || []
  };
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );

  return asUtc - date.getTime();
}

function timestampFromLocalTime(dateValue, timeValue, timeZone) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!dateMatch || !timeMatch) {
    return null;
  }

  const [, year, month, day] = dateMatch.map(Number);
  const [, hour, minute] = timeMatch.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return null;
  }

  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const parsed = new Date(utcGuess);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  const firstOffset = timeZoneOffsetMs(new Date(utcGuess), timeZone);
  let timestampMs = utcGuess - firstOffset;
  const finalOffset = timeZoneOffsetMs(new Date(timestampMs), timeZone);
  if (finalOffset !== firstOffset) {
    timestampMs = utcGuess - finalOffset;
  }

  return Math.floor(timestampMs / 1000);
}

function normalizeDiscordId(value) {
  const match = String(value || "").match(/\d{15,25}/);
  return match ? match[0] : "";
}

function cleanDiscordName(value) {
  return String(value || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}

async function resolveLeader(client, value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return { leader: "à confirmer", leaderUserId: "" };
  }

  const directId = normalizeDiscordId(raw);
  if (directId) {
    return { leader: "", leaderUserId: directId };
  }

  const { guildId } = await discordSettings();
  if (!guildId) {
    return { leader: raw, leaderUserId: "" };
  }

  const query = cleanDiscordName(raw);
  if (!query) {
    return { leader: "à confirmer", leaderUserId: "" };
  }

  try {
    const members = await searchGuildMembers(client, query, 10);
    const exact = members.find((member) => member.searchNames.includes(query));
    const member = exact || members[0];
    if (member) {
      return {
        leader: member.displayName || member.user.globalName || member.user.username,
        leaderUserId: member.id
      };
    }
  } catch (error) {
    if (error.code === 50001 || error.code === 50013) {
      const leaderError = new Error("Impossible de rechercher le leader Discord. Vérifie que le bot a accès au serveur et la permission de voir les membres.");
      leaderError.status = 400;
      throw leaderError;
    }
    throw error;
  }

  const error = new Error(`Leader Discord introuvable: ${raw}. Utilise une vraie mention Discord ou l'ID utilisateur, ou active DISCORD_ENABLE_GUILD_MEMBERS_INTENT=true avec Server Members Intent dans le Developer Portal.`);
  error.status = 400;
  throw error;
}

async function searchGuildMembers(client, queryValue, limit = 10) {
  const { guildId } = await discordSettings();
  if (!guildId) {
    const error = new Error("Aucun serveur Discord configuré.");
    error.status = 400;
    throw error;
  }

  const query = cleanDiscordName(queryValue);
  if (query.length < 2) {
    return [];
  }

  const guild = await client.guilds.fetch(guildId);
  const members = await guild.members.search({ query, limit });
  return members.map((member) => ({
    id: member.id,
    displayName: member.displayName,
    username: member.user.username,
    globalName: member.user.globalName,
    mention: `<@${member.id}>`,
    searchNames: [
      member.displayName,
      member.user.username,
      member.user.globalName
    ].map(cleanDiscordName).filter(Boolean)
  }));
}

function parseEmojiImageDataUrl(value) {
  const match = /^data:image\/(png|jpe?g|gif|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(String(value || ""));
  if (!match) {
    const error = new Error("Image invalide. Utilise un fichier PNG, JPG, WEBP ou GIF.");
    error.status = 400;
    throw error;
  }

  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > 256 * 1024) {
    const error = new Error("Image trop lourde pour un emoji Discord. Max conseillé: 256 Ko.");
    error.status = 400;
    throw error;
  }

  return buffer;
}

function normalizeEmojiName(value) {
  const name = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);

  if (name.length < 2) {
    const error = new Error("Nom d'emoji invalide. Utilise 2 à 32 caractères: lettres, chiffres ou underscore.");
    error.status = 400;
    throw error;
  }

  return name;
}

async function createGuildEmojiFromUpload(client, input) {
  const { guildId } = await discordSettings();
  if (!guildId) {
    const error = new Error("Aucun serveur Discord configuré.");
    error.status = 400;
    throw error;
  }

  const guild = await client.guilds.fetch(guildId);
  const emoji = await guild.emojis.create({
    attachment: parseEmojiImageDataUrl(input.imageDataUrl),
    name: normalizeEmojiName(input.name),
    reason: "Création depuis le panel GW Events"
  });
  const value = `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
  const config = await loadConfig();
  config.emojiPalette = config.emojiPalette || [];
  if (!config.emojiPalette.includes(value)) {
    config.emojiPalette.push(value);
  }
  await saveConfig(config);

  return {
    emoji: {
      id: emoji.id,
      name: emoji.name,
      animated: Boolean(emoji.animated),
      url: emoji.imageURL(),
      value
    },
    config
  };
}

async function normalizeEvent(input, config, client) {
  if (!input.title || !input.date || !input.time) {
    const error = new Error("Titre, date et heure sont obligatoires.");
    error.status = 400;
    throw error;
  }

  const timezone = config.defaults?.timezone || "Europe/Paris";
  const timestampSeconds = timestampFromLocalTime(String(input.date), String(input.time), timezone);
  if (!timestampSeconds) {
    const error = new Error("Date ou heure invalide.");
    error.status = 400;
    throw error;
  }

  const leaderInfo = await resolveLeader(client, input.leaderUserId || input.leader);

  return {
    title: String(input.title).trim(),
    templateId: String(input.templateId || "custom"),
    date: String(input.date),
    time: String(input.time),
    timezone,
    timestampSeconds,
    difficulty: String(input.difficulty || ""),
    leader: leaderInfo.leader,
    leaderUserId: leaderInfo.leaderUserId,
    description: String(input.description || ""),
    imageUrl: String(input.imageUrl || ""),
    channelId: String(input.channelId || process.env.DISCORD_EVENT_CHANNEL_ID || "").trim(),
    roles: Array.isArray(input.roles) ? input.roles : [],
    signupOptions: Array.isArray(input.signupOptions) ? input.signupOptions : config.signupOptions || [],
    links: Array.isArray(input.links) ? input.links : [],
    allowedRoleIds: Array.isArray(input.allowedRoleIds)
      ? input.allowedRoleIds.map((roleId) => String(roleId).trim()).filter(Boolean)
      : []
  };
}

function summarizeEvent(event) {
  return {
    id: event.id,
    title: event.title,
    date: event.date,
    time: event.time,
    timezone: event.timezone,
    timestampSeconds: event.timestampSeconds,
    difficulty: event.difficulty,
    leader: event.leader,
    leaderUserId: event.leaderUserId || "",
    status: event.status,
    discord: event.discord,
    channelId: event.channelId || event.discord?.channelId || null,
    signupOptions: event.signupOptions || [],
    allowedRoleIds: event.allowedRoleIds || [],
    signupCount: event.signups.filter((signup) => signup.state === "confirmed").length,
    stateCounts: event.signups.reduce((counts, signup) => {
      counts[signup.state] = (counts[signup.state] || 0) + 1;
      return counts;
    }, {}),
    createdAt: event.createdAt,
    updatedAt: event.updatedAt
  };
}

async function serveStatic(request, response) {
  const url = new URL(request.url, "http://localhost");
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  const ext = path.extname(filePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
  };
  const content = await fs.readFile(filePath);
  response.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
  response.end(content);
}

function createServer(client) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && url.pathname === "/api/auth/me") {
        const session = readSession(request);
        const settings = await discordSettings();
        sendJson(response, 200, {
          authenticated: Boolean(session),
          user: session ? {
            id: session.userId,
            username: session.username,
            globalName: session.globalName,
            avatar: session.avatar
          } : null,
          inviteUrl: discordInviteUrl(request),
          loginUrl: "/auth/discord/login",
          oauthConfigured: Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET),
          setupConfigured: Boolean(settings.guildId),
          guildId: settings.guildId,
          adminRolesConfigured: settings.adminRoleIds.length > 0,
          scopes: ["identify", "guilds.members.read"]
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/setup/discord") {
        const input = await readBody(request);
        assertSetupPassword(input);
        const config = await updateDiscordSettings(input);
        sendJson(response, 200, { config, discord: config.discord });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": cookieHeader(SESSION_COOKIE, "", { maxAge: 0 })
        });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/auth/discord/invite") {
        redirect(response, discordInviteUrl(request));
        return;
      }

      if (request.method === "GET" && url.pathname === "/auth/discord/login") {
        const state = crypto.randomBytes(24).toString("base64url");
        response.writeHead(302, {
          Location: discordLoginUrl(request, state),
          "Set-Cookie": cookieHeader(OAUTH_STATE_COOKIE, state, { maxAge: 10 * 60 })
        });
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/auth/discord/callback") {
        const expectedState = parseCookies(request)[OAUTH_STATE_COOKIE];
        if (!expectedState || expectedState !== url.searchParams.get("state")) {
          sendJson(response, 400, { error: "État OAuth invalide." });
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          sendJson(response, 400, { error: "Code OAuth manquant." });
          return;
        }
        const session = await createOAuthSession(request, code);
        response.writeHead(302, {
          Location: "/",
          "Set-Cookie": [
            cookieHeader(SESSION_COOKIE, createSessionCookie(session), { maxAge: SESSION_MAX_AGE_SECONDS }),
            cookieHeader(OAUTH_STATE_COOKIE, "", { maxAge: 0 })
          ]
        });
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/config") {
        sendJson(response, 200, await loadConfig());
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/config") {
        assertAdmin(request);
        const config = await saveConfig(await readBody(request));
        sendJson(response, 200, { config });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/discord/options") {
        assertAdmin(request);
        const settings = await discordSettings();
        sendJson(response, 200, await getGuildOptions(client, settings.guildId));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/discord/members") {
        assertAdmin(request);
        if (process.env.DISCORD_ENABLE_GUILD_MEMBERS_INTENT !== "true") {
          sendJson(response, 400, {
            error: "Recherche par pseudo désactivée. Utilise une mention/ID Discord ou active DISCORD_ENABLE_GUILD_MEMBERS_INTENT=true avec Server Members Intent."
          });
          return;
        }
        const query = url.searchParams.get("query") || "";
        sendJson(response, 200, { members: await searchGuildMembers(client, query, 10) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/discord/emojis") {
        assertAdmin(request);
        sendJson(response, 201, await createGuildEmojiFromUpload(client, await readBody(request)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/events") {
        assertAdmin(request);
        const events = await readEvents();
        sendJson(response, 200, {
          events: events
            .map(summarizeEvent)
            .sort((left, right) => (right.timestampSeconds || 0) - (left.timestampSeconds || 0))
        });
        return;
      }

      const eventMatch = /^\/api\/events\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && eventMatch) {
        assertAdmin(request);
        const event = await getEvent(eventMatch[1]);
        if (!event) {
          sendJson(response, 404, { error: "Event introuvable." });
          return;
        }

        sendJson(response, 200, { event });
        return;
      }

      if (request.method === "PUT" && eventMatch) {
        assertAdmin(request);
        const config = await loadConfig();
        const normalized = await normalizeEvent(await readBody(request), config, client);
        const updated = await updateEvent(eventMatch[1], (event) => ({
          ...event,
          ...normalized
        }));
        const published = await publishEvent(client, updated);
        sendJson(response, 200, { id: published.id, discordUrl: published.discord.url });
        return;
      }

      if (request.method === "DELETE" && eventMatch) {
        assertAdmin(request);
        const event = await getEvent(eventMatch[1]);
        if (!event) {
          sendJson(response, 404, { error: "Event introuvable." });
          return;
        }

        await deleteEventMessage(client, event);
        await deleteEvent(event.id);
        sendJson(response, 200, { deleted: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/events") {
        assertAdmin(request);
        const config = await loadConfig();
        const event = await createEvent(await normalizeEvent(await readBody(request), config, client));
        const published = await publishEvent(client, event);
        sendJson(response, 201, { id: published.id, discordUrl: published.discord.url });
        return;
      }

      if (request.method === "GET") {
        await serveStatic(request, response);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (error.code === "ENOENT") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      sendJson(response, error.status || 500, { error: error.message });
    }
  });
}

async function startServer(client) {
  const port = Number(process.env.WEB_PORT || 3000);
  const server = createServer(client);
  await new Promise((resolve) => server.listen(port, resolve));
  return { server, port };
}

module.exports = { createServer, startServer };
