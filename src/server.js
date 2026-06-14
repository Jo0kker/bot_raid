const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { loadConfig, saveConfig } = require("./config");
const { createEvent, deleteEvent, getEvent, readEvents, updateEvent } = require("./storage");
const { deleteEventMessage, getGuildOptions, publishEvent } = require("./bot");

const PUBLIC_DIR = path.join(process.cwd(), "public");

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function assertAdmin(request) {
  const expected = process.env.WEB_ADMIN_TOKEN;
  if (!expected) {
    return;
  }

  if (request.headers["x-admin-token"] !== expected) {
    const error = new Error("Token admin invalide.");
    error.status = 401;
    throw error;
  }
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

  const guildId = process.env.DISCORD_GUILD_ID;
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
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    const error = new Error("DISCORD_GUILD_ID manquant.");
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
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    const error = new Error("DISCORD_GUILD_ID manquant.");
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
        sendJson(response, 200, await getGuildOptions(client));
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
