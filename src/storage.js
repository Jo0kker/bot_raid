const crypto = require("node:crypto");
const { Pool, types } = require("pg");

types.setTypeParser(1082, (value) => value);

let pool = null;
let schemaReady = null;

function nowIso() {
  return new Date().toISOString();
}

function requireDatabaseUrl() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL est obligatoire. Le stockage JSON a été supprimé.");
  }
}

function storageBackend() {
  return "postgres";
}

function getPool() {
  requireDatabaseUrl();
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
    });
  }

  return pool;
}

async function ensureSchema() {
  requireDatabaseUrl();

  if (!schemaReady) {
    schemaReady = getPool().query(`
      create table if not exists events (
        id uuid primary key,
        guild_id text,
        title text not null,
        template_id text not null default 'custom',
        event_date date not null,
        event_time text not null,
        timezone text not null default 'Europe/Paris',
        timestamp_seconds bigint not null,
        difficulty text not null default '',
        leader text not null default '',
        leader_user_id text,
        description text not null default '',
        image_url text not null default '',
        publication_mode text not null default 'channel',
        channel_id text,
        category_id text,
        roles jsonb not null default '[]'::jsonb,
        signup_options jsonb not null default '[]'::jsonb,
        links jsonb not null default '[]'::jsonb,
        allowed_role_ids jsonb not null default '[]'::jsonb,
        discord jsonb not null default '{}'::jsonb,
        status text not null default 'draft',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists signups (
        event_id uuid not null references events(id) on delete cascade,
        user_id text not null,
        user_name text not null default '',
        user_display_name text,
        user_avatar_url text,
        role_id text,
        signup_option_id text,
        signup_option_label text,
        state text not null,
        note text,
        updated_at timestamptz not null default now(),
        primary key (event_id, user_id)
      );

      alter table events add column if not exists guild_id text;
      alter table events add column if not exists leader_user_id text;
      alter table events add column if not exists publication_mode text not null default 'channel';
      alter table events add column if not exists channel_id text;
      alter table events add column if not exists category_id text;
      alter table events add column if not exists signup_options jsonb not null default '[]'::jsonb;
      alter table signups add column if not exists user_display_name text;
      alter table signups add column if not exists user_avatar_url text;
      alter table signups add column if not exists signup_option_id text;
      alter table signups add column if not exists signup_option_label text;
      create index if not exists events_timestamp_seconds_idx on events(timestamp_seconds desc);
      create index if not exists events_guild_id_timestamp_seconds_idx on events(guild_id, timestamp_seconds desc);
      create index if not exists signups_event_id_idx on signups(event_id);
    `);
  }

  await schemaReady;
}

async function initializeStorage() {
  await ensureSchema();
  return { backend: storageBackend() };
}

function rowToEvent(row, signups = []) {
  return {
    id: row.id,
    guildId: row.guild_id,
    title: row.title,
    templateId: row.template_id,
    date: row.event_date instanceof Date ? row.event_date.toISOString().slice(0, 10) : String(row.event_date),
    time: row.event_time,
    timezone: row.timezone,
    timestampSeconds: Number(row.timestamp_seconds),
    difficulty: row.difficulty,
    leader: row.leader,
    leaderUserId: row.leader_user_id,
    description: row.description,
    imageUrl: row.image_url,
    publicationMode: row.publication_mode || "channel",
    channelId: row.channel_id,
    categoryId: row.category_id,
    roles: row.roles || [],
    signupOptions: row.signup_options || [],
    links: row.links || [],
    allowedRoleIds: row.allowed_role_ids || [],
    discord: row.discord || {},
    signups,
    status: row.status,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at
  };
}

function signupRowToSignup(row) {
  return {
    userId: row.user_id,
    userName: row.user_name,
    userDisplayName: row.user_display_name,
    userAvatarUrl: row.user_avatar_url,
    roleId: row.role_id,
    signupOptionId: row.signup_option_id,
    signupOptionLabel: row.signup_option_label,
    state: row.state,
    note: row.note,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at
  };
}

async function readEventsPg(guildId) {
  await ensureSchema();
  const result = guildId
    ? await getPool().query("select * from events where guild_id = $1 order by timestamp_seconds desc", [guildId])
    : await getPool().query("select * from events order by timestamp_seconds desc");
  return result.rows.map((row) => rowToEvent(row, []));
}

async function getEventPg(eventId) {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    const eventResult = await client.query("select * from events where id = $1", [eventId]);
    if (eventResult.rowCount === 0) {
      return null;
    }

    const signupResult = await client.query(
      "select * from signups where event_id = $1 order by updated_at asc",
      [eventId]
    );
    return rowToEvent(eventResult.rows[0], signupResult.rows.map(signupRowToSignup));
  } finally {
    client.release();
  }
}

async function writeEventPg(client, event) {
  await client.query(
    `
      insert into events (
        id, guild_id, title, template_id, event_date, event_time, timezone, timestamp_seconds,
        difficulty, leader, leader_user_id, description, image_url, publication_mode, channel_id, category_id, roles, signup_options, links,
        allowed_role_ids, discord, status, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
      on conflict (id) do update set
        guild_id = excluded.guild_id,
        title = excluded.title,
        template_id = excluded.template_id,
        event_date = excluded.event_date,
        event_time = excluded.event_time,
        timezone = excluded.timezone,
        timestamp_seconds = excluded.timestamp_seconds,
        difficulty = excluded.difficulty,
        leader = excluded.leader,
        leader_user_id = excluded.leader_user_id,
        description = excluded.description,
        image_url = excluded.image_url,
        publication_mode = excluded.publication_mode,
        channel_id = excluded.channel_id,
        category_id = excluded.category_id,
        roles = excluded.roles,
        signup_options = excluded.signup_options,
        links = excluded.links,
        allowed_role_ids = excluded.allowed_role_ids,
        discord = excluded.discord,
        status = excluded.status,
        updated_at = excluded.updated_at
    `,
    [
      event.id,
      event.guildId || null,
      event.title,
      event.templateId || "custom",
      event.date,
      event.time,
      event.timezone || "Europe/Paris",
      event.timestampSeconds,
      event.difficulty || "",
      event.leader || "",
      event.leaderUserId || null,
      event.description || "",
      event.imageUrl || "",
      event.publicationMode || "channel",
      event.channelId || null,
      event.categoryId || null,
      JSON.stringify(event.roles || []),
      JSON.stringify(event.signupOptions || []),
      JSON.stringify(event.links || []),
      JSON.stringify(event.allowedRoleIds || []),
      JSON.stringify(event.discord || {}),
      event.status || "draft",
      event.createdAt || nowIso(),
      event.updatedAt || nowIso()
    ]
  );
}

async function replaceSignupsPg(client, event) {
  await client.query("delete from signups where event_id = $1", [event.id]);
  for (const signup of event.signups || []) {
    await client.query(
      `
        insert into signups (
          event_id, user_id, user_name, user_display_name, user_avatar_url,
          role_id, signup_option_id, signup_option_label, state, note, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        event.id,
        signup.userId,
        signup.userName || "",
        signup.userDisplayName || null,
        signup.userAvatarUrl || null,
        signup.roleId || null,
        signup.signupOptionId || null,
        signup.signupOptionLabel || null,
        signup.state,
        signup.note || null,
        signup.updatedAt || nowIso()
      ]
    );
  }
}

async function createEventPg(input) {
  await ensureSchema();
  const event = {
    id: crypto.randomUUID(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "draft",
    discord: {},
    signups: [],
    ...input
  };

  const client = await getPool().connect();
  try {
    await client.query("begin");
    await writeEventPg(client, event);
    await client.query("commit");
    return event;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function updateEventPg(eventId, updater) {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const eventResult = await client.query("select * from events where id = $1 for update", [eventId]);
    if (eventResult.rowCount === 0) {
      throw new Error(`Event introuvable: ${eventId}`);
    }

    const signupResult = await client.query("select * from signups where event_id = $1", [eventId]);
    const current = rowToEvent(eventResult.rows[0], signupResult.rows.map(signupRowToSignup));
    const updated = {
      ...await updater(current),
      updatedAt: nowIso()
    };

    await writeEventPg(client, updated);
    await replaceSignupsPg(client, updated);
    await client.query("commit");
    return updated;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function deleteEventPg(eventId) {
  await ensureSchema();
  const result = await getPool().query("delete from events where id = $1 returning id", [eventId]);
  return result.rowCount > 0;
}

async function createEvent(input) {
  return createEventPg(input);
}

async function updateEvent(eventId, updater) {
  return updateEventPg(eventId, updater);
}

async function deleteEvent(eventId) {
  return deleteEventPg(eventId);
}

async function getEvent(eventId) {
  return getEventPg(eventId);
}

async function readEvents(guildId) {
  return readEventsPg(guildId);
}

module.exports = {
  createEvent,
  deleteEvent,
  getEvent,
  initializeStorage,
  readEvents,
  storageBackend,
  updateEvent
};
