const { Pool } = require("pg");

const CONFIG_KEY = "guild";
const DEFAULT_CONFIG = {
  branding: {
    name: "GW Events",
    color: "#9d3b35",
    footer: "Inscriptions via le bot GW Events"
  },
  defaults: {
    timezone: "Europe/Paris",
    durationMinutes: 120,
    lateToleranceMinutes: 15
  },
  discord: {
    guildId: "",
    adminRoleIds: []
  },
  difficulties: ["Normal", "Hard mode", "CM", "Training", "Progress"],
  signupStates: [
    { id: "bench", emoji: "🪑", label: "Bench" },
    { id: "late", emoji: "🕘", label: "Retard" },
    { id: "tentative", emoji: "⚖️", label: "Tentative" },
    { id: "absence", emoji: "🚫", label: "Absence" }
  ],
  links: [],
  roles: [
    { id: "tank", label: "Tank", emoji: "🛡️", defaultCapacity: 1 },
    { id: "heal", label: "Heal", emoji: "💚", defaultCapacity: 2 },
    { id: "boon", label: "Support / Boons", emoji: "✨", defaultCapacity: 2 },
    { id: "dps", label: "DPS", emoji: "⚔️", defaultCapacity: 5 }
  ],
  signupOptions: [
    { id: "heal", label: "Heal", emoji: "💚", roleId: "heal" },
    { id: "tank", label: "Tank", emoji: "🛡️", roleId: "tank" },
    { id: "support", label: "Support", emoji: "✨", roleId: "boon" },
    { id: "dps", label: "DPS", emoji: "⚔️", roleId: "dps" }
  ],
  templates: [
    {
      id: "custom",
      label: "Composition libre",
      game: "Guild Wars / Guild Wars 2",
      roles: [],
      signupOptions: []
    },
    {
      id: "raid10",
      label: "Raid 10",
      game: "Guild Wars 2",
      roles: [
        { roleId: "tank", capacity: 1 },
        { roleId: "heal", capacity: 2 },
        { roleId: "boon", capacity: 2 },
        { roleId: "dps", capacity: 5 }
      ],
      signupOptions: [
        { id: "heal", label: "Heal", emoji: "💚", roleId: "heal" },
        { id: "tank", label: "Tank", emoji: "🛡️", roleId: "tank" },
        { id: "support", label: "Support", emoji: "✨", roleId: "boon" },
        { id: "dps", label: "DPS", emoji: "⚔️", roleId: "dps" }
      ]
    }
  ],
  emojiPalette: ["🛡️", "💚", "✨", "⚔️", "🪑", "🕘", "⚖️", "🚫"]
};

let pool = null;
let schemaReady = null;

function requireDatabaseUrl() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL est obligatoire. Le stockage JSON a été supprimé.");
  }
}

function configBackend() {
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
    schemaReady = (async () => {
      await getPool().query(`
        create table if not exists app_config (
          key text primary key,
          value jsonb not null,
          updated_at timestamptz not null default now()
        );

        create table if not exists app_templates (
          id text primary key,
          label text not null,
          game text not null default '',
          tags jsonb not null default '[]'::jsonb,
          roles jsonb not null default '[]'::jsonb,
          signup_options jsonb not null default '[]'::jsonb,
          sort_order integer not null default 0,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );

        create table if not exists app_roles (
          id text primary key,
          label text not null,
          emoji text not null default '',
          default_capacity integer not null default 1,
          sort_order integer not null default 0,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );

        create table if not exists app_signup_options (
          id text primary key,
          label text not null,
          emoji text not null default '',
          role_id text not null references app_roles(id) on update cascade on delete restrict,
          sort_order integer not null default 0,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );

        create table if not exists app_emoji_palette (
          value text primary key,
          label text not null default '',
          source text not null default 'custom',
          sort_order integer not null default 0,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `);
      await migrateStructuredConfigFromAppConfig();
    })();
  }

  await schemaReady;
}

async function migrateStructuredConfigFromAppConfig() {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await client.query("select value from app_config where key = $1", [CONFIG_KEY]);
    const currentConfig = result.rows[0]?.value;
    if (!currentConfig) {
      await client.query("commit");
      return;
    }

    const rolesCount = await client.query("select count(*)::int as count from app_roles");
    if (rolesCount.rows[0].count === 0 && Array.isArray(currentConfig.roles)) {
      for (const [index, role] of currentConfig.roles.entries()) {
        await upsertRolePg(client, role, index);
      }
    }

    const signupOptionsCount = await client.query("select count(*)::int as count from app_signup_options");
    if (signupOptionsCount.rows[0].count === 0 && Array.isArray(currentConfig.signupOptions)) {
      for (const [index, option] of currentConfig.signupOptions.entries()) {
        await upsertSignupOptionPg(client, option, index);
      }
    }

    const templatesCount = await client.query("select count(*)::int as count from app_templates");
    if (templatesCount.rows[0].count === 0 && Array.isArray(currentConfig.templates)) {
      for (const [index, template] of currentConfig.templates.entries()) {
        await upsertTemplatePg(client, template, index);
      }
    }

    const emojiPaletteCount = await client.query("select count(*)::int as count from app_emoji_palette");
    if (emojiPaletteCount.rows[0].count === 0 && Array.isArray(currentConfig.emojiPalette)) {
      for (const [index, emoji] of currentConfig.emojiPalette.entries()) {
        await upsertEmojiPalettePg(client, emoji, index);
      }
    }

    const configWithoutTemplates = { ...currentConfig };
    delete configWithoutTemplates.roles;
    delete configWithoutTemplates.signupOptions;
    delete configWithoutTemplates.templates;
    delete configWithoutTemplates.emojiPalette;
    await client.query(
      "update app_config set value = $2, updated_at = now() where key = $1",
      [CONFIG_KEY, JSON.stringify(configWithoutTemplates)]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function splitConfig(config) {
  const globalConfig = { ...config };
  delete globalConfig.roles;
  delete globalConfig.signupOptions;
  delete globalConfig.templates;
  delete globalConfig.emojiPalette;
  return {
    globalConfig,
    roles: config.roles || [],
    signupOptions: config.signupOptions || [],
    templates: config.templates || [],
    emojiPalette: config.emojiPalette || []
  };
}

function rowToRole(row) {
  return {
    id: row.id,
    label: row.label,
    emoji: row.emoji,
    defaultCapacity: row.default_capacity
  };
}

function rowToSignupOption(row) {
  return {
    id: row.id,
    label: row.label,
    emoji: row.emoji,
    roleId: row.role_id
  };
}

function rowToEmojiPaletteValue(row) {
  return row.value;
}

function rowToTemplate(row) {
  return {
    id: row.id,
    label: row.label,
    game: row.game,
    ...(row.tags?.length ? { tags: row.tags } : {}),
    roles: row.roles || [],
    signupOptions: row.signup_options || []
  };
}

async function readConfigPg() {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    const configResult = await client.query("select value from app_config where key = $1", [CONFIG_KEY]);

    if (configResult.rowCount === 0) {
      return null;
    }

    const rolesResult = await client.query("select * from app_roles order by sort_order asc, label asc");
    const signupOptionsResult = await client.query("select * from app_signup_options order by sort_order asc, label asc");
    const templatesResult = await client.query("select * from app_templates order by sort_order asc, label asc");
    const emojiPaletteResult = await client.query("select * from app_emoji_palette order by sort_order asc, label asc, value asc");

    return {
      ...configResult.rows[0].value,
      roles: rolesResult.rows.map(rowToRole),
      signupOptions: signupOptionsResult.rows.map(rowToSignupOption),
      templates: templatesResult.rows.map(rowToTemplate),
      emojiPalette: emojiPaletteResult.rows.map(rowToEmojiPaletteValue)
    };
  } finally {
    client.release();
  }
}

async function upsertRolePg(client, role, sortOrder) {
  await client.query(
    `
      insert into app_roles (
        id, label, emoji, default_capacity, sort_order, updated_at
      )
      values ($1, $2, $3, $4, $5, now())
      on conflict (id) do update set
        label = excluded.label,
        emoji = excluded.emoji,
        default_capacity = excluded.default_capacity,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `,
    [
      role.id,
      role.label,
      role.emoji || "",
      Number(role.defaultCapacity || 1),
      sortOrder
    ]
  );
}

async function upsertSignupOptionPg(client, option, sortOrder) {
  await client.query(
    `
      insert into app_signup_options (
        id, label, emoji, role_id, sort_order, updated_at
      )
      values ($1, $2, $3, $4, $5, now())
      on conflict (id) do update set
        label = excluded.label,
        emoji = excluded.emoji,
        role_id = excluded.role_id,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `,
    [
      option.id,
      option.label,
      option.emoji || "",
      option.roleId,
      sortOrder
    ]
  );
}

async function upsertEmojiPalettePg(client, value, sortOrder) {
  const emojiValue = String(value || "").trim();
  if (!emojiValue) {
    return;
  }

  await client.query(
    `
      insert into app_emoji_palette (
        value, label, source, sort_order, updated_at
      )
      values ($1, $2, $3, $4, now())
      on conflict (value) do update set
        label = excluded.label,
        source = excluded.source,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `,
    [
      emojiValue,
      emojiValue,
      emojiValue.startsWith("<:") || emojiValue.startsWith("<a:") ? "discord" : "unicode",
      sortOrder
    ]
  );
}

async function upsertTemplatePg(client, template, sortOrder) {
  await client.query(
    `
      insert into app_templates (
        id, label, game, tags, roles, signup_options, sort_order, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, now())
      on conflict (id) do update set
        label = excluded.label,
        game = excluded.game,
        tags = excluded.tags,
        roles = excluded.roles,
        signup_options = excluded.signup_options,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `,
    [
      template.id,
      template.label,
      template.game || "",
      JSON.stringify(template.tags || []),
      JSON.stringify(template.roles || []),
      JSON.stringify(template.signupOptions || []),
      sortOrder
    ]
  );
}

async function saveConfigPg(config) {
  await ensureSchema();
  const { globalConfig, roles, signupOptions, templates, emojiPalette } = splitConfig(config);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(
      `
        insert into app_config (key, value, updated_at)
        values ($1, $2, now())
        on conflict (key) do update set
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      [CONFIG_KEY, JSON.stringify(globalConfig)]
    );

    for (const [index, role] of roles.entries()) {
      await upsertRolePg(client, role, index);
    }

    for (const [index, option] of signupOptions.entries()) {
      await upsertSignupOptionPg(client, option, index);
    }

    const signupOptionIds = signupOptions.map((option) => option.id);
    if (signupOptionIds.length > 0) {
      await client.query("delete from app_signup_options where not (id = any($1::text[]))", [signupOptionIds]);
    } else {
      await client.query("delete from app_signup_options");
    }

    const roleIds = roles.map((role) => role.id);
    if (roleIds.length > 0) {
      await client.query("delete from app_roles where not (id = any($1::text[]))", [roleIds]);
    } else {
      await client.query("delete from app_roles");
    }

    const templateIds = templates.map((template) => template.id);
    if (templateIds.length > 0) {
      await client.query("delete from app_templates where not (id = any($1::text[]))", [templateIds]);
    } else {
      await client.query("delete from app_templates");
    }

    for (const [index, template] of templates.entries()) {
      await upsertTemplatePg(client, template, index);
    }

    const emojiValues = emojiPalette.map((value) => String(value || "").trim()).filter(Boolean);
    if (emojiValues.length > 0) {
      await client.query("delete from app_emoji_palette where not (value = any($1::text[]))", [emojiValues]);
    } else {
      await client.query("delete from app_emoji_palette");
    }

    for (const [index, value] of emojiValues.entries()) {
      await upsertEmojiPalettePg(client, value, index);
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function loadConfig() {
  const loadedConfig = await readConfigPg();
  if (loadedConfig) {
    const config = loadedConfig;
    validateConfig(config);
    return config;
  }

  const config = structuredClone(DEFAULT_CONFIG);
  validateConfig(config);
  await saveConfig(config);
  return config;
}

async function saveConfig(config) {
  validateConfig(config);
  await saveConfigPg(config);
  return config;
}

function validateConfig(config) {
  if (!Array.isArray(config.roles) || config.roles.length === 0) {
    throw new Error("La configuration doit contenir au moins un rôle.");
  }

  if (!Array.isArray(config.templates) || config.templates.length === 0) {
    throw new Error("La configuration doit contenir au moins un template.");
  }

  if (!Array.isArray(config.signupStates)) {
    throw new Error("La configuration doit contenir signupStates.");
  }

  const roleIds = new Set(config.roles.map((role) => role.id));
  for (const option of config.signupOptions || []) {
    if (!roleIds.has(option.roleId)) {
      throw new Error(`L'option ${option.id} référence un rôle inconnu: ${option.roleId}`);
    }
  }

  for (const template of config.templates) {
    for (const slot of template.roles || []) {
      if (!roleIds.has(slot.roleId)) {
        throw new Error(`Le template ${template.id} référence un rôle inconnu: ${slot.roleId}`);
      }
    }

    for (const option of template.signupOptions || []) {
      if (!roleIds.has(option.roleId)) {
        throw new Error(`L'option ${option.id} du template ${template.id} référence un rôle inconnu: ${option.roleId}`);
      }
    }
  }
}

module.exports = { configBackend, loadConfig, saveConfig, validateConfig };
