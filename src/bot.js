const {
  ActionRowBuilder,
  ChannelType,
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  Routes,
  StringSelectMenuBuilder
} = require("discord.js");
const { getGuild, loadConfig } = require("./config");
const { getEvent, readEvents, updateEvent } = require("./storage");
const { buildEventMessage } = require("./discord/render");
const { envFlag } = require("./utils/env");

function createDiscordClient() {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ];

  if (envFlag("DISCORD_ENABLE_GUILD_MEMBERS_INTENT")) {
    intents.push(GatewayIntentBits.GuildMembers);
  }

  return new Client({
    intents
  });
}

function slugChannelPart(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function cleanChannelPrefix(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/<a?:\w{2,32}:\d{15,25}>/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function eventChannelName(event) {
  const prefix = cleanChannelPrefix(event.channelPrefix || "");
  const base = slugChannelPart(`${event.date || ""} ${event.title || "event"}`) || "event";
  return [prefix, base].filter(Boolean).join("-").slice(0, 90) || "event";
}

async function fetchPublishChannel(client, channelId) {
  try {
    return await client.channels.fetch(channelId);
  } catch (error) {
    if (error.code === 50001) {
      throw new Error(
        "Discord refuse l'accès au salon configuré. Vérifie que le salon choisi est sur le serveur configuré, que le bot y est invité, et qu'il a les permissions Voir le salon / Envoyer des messages / Intégrer des liens."
      );
    }
    throw error;
  }
}

async function assertPublishPermissions(channel) {
  if (!channel?.isTextBased()) {
    throw new Error(`Salon Discord invalide ou non textuel: ${channel?.id || "inconnu"}`);
  }

  const guild = channel.guild;
  const me = guild?.members?.me || await guild?.members?.fetchMe?.();
  const permissions = channel.permissionsFor?.(me);
  if (
    permissions &&
    (
      !permissions.has(PermissionFlagsBits.ViewChannel) ||
      !permissions.has(PermissionFlagsBits.SendMessages) ||
      !permissions.has(PermissionFlagsBits.EmbedLinks) ||
      !permissions.has(PermissionFlagsBits.UseExternalEmojis)
    )
  ) {
    throw new Error("Le bot n'a pas les permissions Voir le salon / Envoyer des messages / Intégrer des liens / Utiliser des emojis externes dans ce salon.");
  }
}

async function createEventChannel(client, config, event) {
  const guildId = event.guildId;
  if (!guildId) {
    throw new Error("Aucun serveur Discord configuré.");
  }

  const categoryId = event.categoryId;
  if (event.discord?.createdChannel && event.discord?.categoryId === categoryId && event.discord?.channelId) {
    try {
      const existing = await fetchPublishChannel(client, event.discord.channelId);
      await assertPublishPermissions(existing);
      return existing;
    } catch (error) {
      if (![10003, 50001].includes(error.code)) {
        throw error;
      }
    }
  }

  if (!categoryId) {
    throw new Error("Aucune catégorie Discord configurée pour cet event.");
  }

  const guild = await client.guilds.fetch(guildId);
  const category = await client.channels.fetch(categoryId);
  if (!category || category.guildId !== guildId || category.type !== ChannelType.GuildCategory) {
    throw new Error("Catégorie Discord invalide pour cet event.");
  }

  const me = guild.members.me || await guild.members.fetchMe();
  const permissions = category.permissionsFor?.(me) || guild.members.me?.permissions;
  if (permissions && !permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error("Le bot n'a pas la permission Gérer les salons dans cette catégorie.");
  }

  const channel = await guild.channels.create({
    name: eventChannelName(event),
    type: ChannelType.GuildText,
    parent: categoryId,
    reason: `Salon event créé pour ${event.title}`
  });
  await assertPublishPermissions(channel);
  return channel;
}

async function resolvePublishChannel(client, config, event) {
  if (event.publicationMode === "category") {
    return createEventChannel(client, config, event);
  }

  const channelId = event.channelId;
  if (!channelId) {
    throw new Error("Aucun salon Discord configuré pour cet event.");
  }

  const channel = await fetchPublishChannel(client, channelId);
  await assertPublishPermissions(channel);
  return channel;
}

async function publishEvent(client, event) {
  const config = await loadConfig();
  const channel = await resolvePublishChannel(client, config, event);

  const messagePayload = buildEventMessage(config, event);
  let message;
  try {
    const canEditExisting = event.discord?.messageId && event.discord.channelId === channel.id;
    if (event.discord?.messageId && event.discord.channelId && event.discord.channelId !== channel.id) {
      await deleteEventMessage(client, event);
    }

    message = canEditExisting
      ? await channel.messages.fetch(event.discord.messageId).then((msg) => msg.edit(messagePayload))
      : await channel.send(messagePayload);
  } catch (error) {
    if (error.code === 50001) {
      throw new Error(
        "Discord refuse l'accès au message ou au salon. Vérifie les permissions du bot dans le salon d'events."
      );
    }
    if (error.code === 50013) {
      throw new Error(
        "Le bot n'a pas les permissions nécessaires dans ce salon. Ajoute Voir le salon, Envoyer des messages, Intégrer des liens et Utiliser les commandes/composants."
      );
    }
    throw error;
  }

  return updateEvent(event.id, (current) => ({
    ...current,
    status: "published",
    discord: {
      ...(current.discord || {}),
      channelId: message.channelId,
      messageId: message.id,
      url: message.url,
      categoryId: event.publicationMode === "category" ? event.categoryId : null,
      createdChannel: event.publicationMode === "category"
    }
  }));
}

async function deleteEventMessage(client, event, options = {}) {
  if (!event?.discord?.channelId) {
    return;
  }

  try {
    const channel = await client.channels.fetch(event.discord.channelId);
    if (event.discord.messageId) {
      const message = await channel.messages.fetch(event.discord.messageId);
      await message.delete();
    }
    if (options.deleteCreatedChannel && event.discord.createdChannel) {
      await channel.delete("Suppression de l'event associé");
    }
  } catch (error) {
    if ([10003, 10008, 50001, 50013].includes(error.code)) {
      return;
    }
    throw error;
  }
}

function eventCleanupAtSeconds(config, event) {
  const start = Number(event.timestampSeconds || 0);
  if (!start) {
    return null;
  }
  const durationMinutes = Number(config.defaults?.durationMinutes ?? 120);
  const cleanupDelayMinutes = Number(config.defaults?.cleanupDelayMinutes ?? 0);
  return start + Math.max(durationMinutes, 0) * 60 + Math.max(cleanupDelayMinutes, 0) * 60;
}

function cleanupEnabled(config) {
  return config.defaults?.cleanupEnabled !== false;
}

async function cleanupFinishedEvents(client) {
  const config = await loadConfig();
  if (!cleanupEnabled(config)) {
    console.log("Cleanup automatique désactivé.");
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const events = await readEvents();
  let publishedCount = 0;
  let dueCount = 0;
  let nextCleanupAt = null;
  for (const event of events) {
    if (event.status !== "published" || !event.discord?.channelId) {
      continue;
    }
    publishedCount += 1;
    const cleanupAt = eventCleanupAtSeconds(config, event);
    if (!cleanupAt || cleanupAt > nowSeconds) {
      if (cleanupAt && (!nextCleanupAt || cleanupAt < nextCleanupAt)) {
        nextCleanupAt = cleanupAt;
      }
      continue;
    }

    dueCount += 1;
    try {
      await deleteEventMessage(client, event, { deleteCreatedChannel: Boolean(event.discord.createdChannel) });
      await updateEvent(event.id, (current) => ({
        ...current,
        status: "archived",
        discord: {
          ...(current.discord || {}),
          deletedAt: new Date().toISOString()
        }
      }));
      console.log(`Event archivé automatiquement: ${event.id} (${event.title})`);
    } catch (error) {
      console.error(`Cleanup event impossible ${event.id}: ${error.message}`);
    }
  }
  const nextText = nextCleanupAt ? ` prochain=${new Date(nextCleanupAt * 1000).toISOString()}` : "";
  console.log(`Cleanup automatique: ${publishedCount} event(s) publié(s), ${dueCount} archivé(s).${nextText}`);
}

async function startEventCleanupScheduler(client) {
  let running = false;
  const run = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await cleanupFinishedEvents(client);
    } catch (error) {
      console.error(`Cleanup automatique impossible: ${error.message}`);
    } finally {
      running = false;
    }
  };

  const config = await loadConfig();
  const intervalMinutes = Number(
    process.env.EVENT_CLEANUP_INTERVAL_MINUTES ||
    config.defaults?.cleanupIntervalMinutes ||
    5
  );
  const intervalMs = Math.max(intervalMinutes, 1) * 60 * 1000;
  console.log(`Cleanup automatique actif: intervalle ${Math.max(intervalMinutes, 1)} min, durée event ${config.defaults?.durationMinutes ?? 120} min, délai ${config.defaults?.cleanupDelayMinutes ?? 0} min.`);
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  setTimeout(run, 30_000).unref?.();
}

async function refreshEventMessage(client, eventId) {
  const event = await getEvent(eventId);
  if (!event?.discord?.channelId || !event.discord.messageId) {
    return;
  }

  const config = await loadConfig();
  const channel = await client.channels.fetch(event.discord.channelId);
  const message = await channel.messages.fetch(event.discord.messageId);
  await message.edit(buildEventMessage(config, event));
}

async function notifySignupWebhook(event, signup, action) {
  const webhookUrl = process.env.SIGNUP_WEBHOOK_URL;
  if (!webhookUrl) {
    return;
  }

  const secret = process.env.SIGNUP_WEBHOOK_SECRET;
  const payload = {
    type: "signup.updated",
    action,
    occurredAt: new Date().toISOString(),
    event: {
      id: event.id,
      title: event.title,
      date: event.date,
      time: event.time,
      timezone: event.timezone,
      discordUrl: event.discord?.url || null
    },
    signup
  };

  const headers = { "Content-Type": "application/json" };
  if (secret) {
    headers["X-GW-Events-Secret"] = secret;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      console.error(`Webhook inscription refusé: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error(`Webhook inscription impossible: ${error.message}`);
  }
}

function signupForUser(event, userId) {
  return event.signups.find((signup) => signup.userId === userId) || null;
}

function memberHasAllowedRole(interaction, allowedRoleIds) {
  if (!Array.isArray(allowedRoleIds) || allowedRoleIds.length === 0) {
    return true;
  }

  const roles = interaction.member?.roles;
  if (Array.isArray(roles)) {
    return allowedRoleIds.some((roleId) => roles.includes(roleId));
  }

  if (roles?.cache) {
    return allowedRoleIds.some((roleId) => roles.cache.has(roleId));
  }

  return false;
}

function assertSignupAllowed(interaction, event) {
  if (memberHasAllowedRole(interaction, event.allowedRoleIds)) {
    return;
  }

  const error = new Error("Cet event est réservé à certains rôles Discord.");
  error.status = 403;
  throw error;
}

function upsertSignup(event, user, patch) {
  const others = event.signups.filter((signup) => signup.userId !== user.id);
  const existing = event.signups.find((signup) => signup.userId === user.id) || {};
  const member = patch.member;
  delete patch.member;
  return {
    ...event,
    signups: [
      ...others,
      {
        ...existing,
        userId: user.id,
        userName: user.username,
        userDisplayName: member?.displayName || user.globalName || user.username,
        userAvatarUrl: user.displayAvatarURL?.() || null,
        state: "confirmed",
        updatedAt: new Date().toISOString(),
        ...patch
      }
    ]
  };
}

function optionRoleIds(option) {
  return Array.isArray(option?.roleIds) && option.roleIds.length
    ? option.roleIds
    : [option?.roleId].filter(Boolean);
}

function eventRoleById(event, roleId) {
  return (event.roles || []).find((slot) => slot.roleId === roleId) || null;
}

function compatibleRoleIdsForOption(event, option) {
  const openRoleIds = new Set((event.roles || []).map((slot) => slot.roleId));
  const roleIds = optionRoleIds(option).filter((roleId) => openRoleIds.size === 0 || openRoleIds.has(roleId));
  return roleIds.length ? roleIds : [option?.roleId].filter(Boolean);
}

function roleChoiceLabel(event, roleId) {
  const role = eventRoleById(event, roleId);
  return role?.label || roleId;
}

function roleChoiceEmoji(event, roleId) {
  return eventRoleById(event, roleId)?.emoji || "";
}

function safeComponentEmoji(emoji) {
  const value = String(emoji || "").trim();
  if (!value) {
    return undefined;
  }
  return /^<a?:\w{2,32}:\d{15,25}>$/.test(value) || /^\p{Extended_Pictographic}$/u.test(value)
    ? value
    : undefined;
}

async function acknowledgeInteraction(interaction) {
  if (interaction.deferred || interaction.replied) {
    return true;
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return true;
  } catch (error) {
    if ([10062, 40060].includes(error.code)) {
      console.warn(`Interaction Discord expirée ou déjà acquittée: ${error.message}`);
      return false;
    }
    throw error;
  }
}

async function respondToInteraction(interaction, contentOrPayload) {
  const payload = typeof contentOrPayload === "string" ? { content: contentOrPayload } : contentOrPayload;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    if ([10062, 40060].includes(error.code)) {
      console.warn(`Réponse Discord impossible pour cette interaction: ${error.message}`);
      return;
    }
    throw error;
  }
}

async function respondEventMissing(interaction, eventId) {
  try {
    await interaction.message?.edit?.({ components: [] });
  } catch (error) {
    if (![10003, 10008, 50001, 50013].includes(error.code)) {
      console.warn(`Impossible de désactiver une annonce orpheline ${eventId}: ${error.message}`);
    }
  }
  await respondToInteraction(
    interaction,
    "Event introuvable en base. Cette annonce Discord est orpheline: republie l'event depuis le panel."
  );
}

function isMissingEventError(error) {
  return /^Event introuvable:/.test(String(error?.message || ""));
}

async function handleRoleSelect(client, interaction) {
  const acknowledged = await acknowledgeInteraction(interaction);
  if (!acknowledged) {
    return;
  }
  const selected = interaction.values[0];
  const [, eventId] = interaction.customId.split(":");
  const [, , ...selectedParts] = selected.split(":");
  const selectedId = selectedParts.join(":");
  if (!eventId || !selectedId) {
    throw new Error("Interaction d'inscription invalide. Republie l'annonce de l'event.");
  }
  const event = await getEvent(eventId);
  if (!event) {
    await respondEventMissing(interaction, eventId);
    return;
  }
  assertSignupAllowed(interaction, event);
  const signupOption = (event.signupOptions || []).find((option) => option.id === selectedId);
  const compatibleRoleIds = signupOption ? compatibleRoleIdsForOption(event, signupOption) : [selectedId];
  if (signupOption && compatibleRoleIds.length > 1) {
    const options = compatibleRoleIds.slice(0, 25).map((roleId) => ({
      label: roleChoiceLabel(event, roleId).slice(0, 100),
      value: roleId,
      description: `Jouer ${signupOption.label} en ${roleChoiceLabel(event, roleId)}`.slice(0, 100),
      emoji: safeComponentEmoji(roleChoiceEmoji(event, roleId))
    }));
    await respondToInteraction(interaction, {
      content: `Tu as choisi **${signupOption.label}**. Dans quel rôle tu le joues pour cet event ?`,
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`signup-role-target:${event.id}:${signupOption.id}`)
            .setPlaceholder("Choisir le rôle joué")
            .addOptions(options)
        )
      ]
    });
    return;
  }

  const roleId = compatibleRoleIds[0] || signupOption?.roleId || selectedId;
  let updated;
  try {
    updated = await updateEvent(eventId, (event) => {
      return upsertSignup(event, interaction.user, {
        roleId,
        signupOptionId: signupOption?.id || null,
        signupOptionLabel: signupOption?.label || null,
        state: "confirmed",
        member: interaction.member
      });
    });
  } catch (error) {
    if (isMissingEventError(error)) {
      await respondEventMissing(interaction, eventId);
      return;
    }
    throw error;
  }
  await refreshEventMessage(client, updated.id);
  await notifySignupWebhook(updated, signupForUser(updated, interaction.user.id), "role-selected");
  await respondToInteraction(interaction, "Inscription mise à jour.");
}

async function handleRoleTargetSelect(client, interaction) {
  const acknowledged = await acknowledgeInteraction(interaction);
  if (!acknowledged) {
    return;
  }
  const selected = interaction.values[0];
  const [, eventId, optionId] = interaction.customId.split(":");
  const selectedRoleId = selected;
  if (!eventId || !optionId || !selectedRoleId) {
    throw new Error("Interaction d'inscription invalide. Republie l'annonce de l'event.");
  }
  const event = await getEvent(eventId);
  if (!event) {
    await respondEventMissing(interaction, eventId);
    return;
  }

  let updated;
  try {
    updated = await updateEvent(eventId, (event) => {
      assertSignupAllowed(interaction, event);
      const signupOption = (event.signupOptions || []).find((option) => option.id === optionId);
      if (!signupOption) {
        throw new Error("Option d'inscription introuvable sur cet event.");
      }
      const compatibleRoleIds = compatibleRoleIdsForOption(event, signupOption);
      if (!compatibleRoleIds.includes(selectedRoleId)) {
        throw new Error("Ce rôle n'est pas compatible avec cette option sur cet event.");
      }
      return upsertSignup(event, interaction.user, {
        roleId: selectedRoleId,
        signupOptionId: signupOption.id,
        signupOptionLabel: signupOption.label,
        state: "confirmed",
        member: interaction.member
      });
    });
  } catch (error) {
    if (isMissingEventError(error)) {
      await respondEventMissing(interaction, eventId);
      return;
    }
    throw error;
  }
  await refreshEventMessage(client, updated.id);
  await notifySignupWebhook(updated, signupForUser(updated, interaction.user.id), "role-selected");
  await respondToInteraction(interaction, { content: "Inscription mise à jour.", components: [] });
}

async function handleStateButton(client, interaction) {
  const acknowledged = await acknowledgeInteraction(interaction);
  if (!acknowledged) {
    return;
  }
  const [, eventId, state] = interaction.customId.split(":");
  const event = await getEvent(eventId);
  if (!event) {
    await respondEventMissing(interaction, eventId);
    return;
  }
  let updated;
  try {
    updated = await updateEvent(eventId, (event) => {
      assertSignupAllowed(interaction, event);
      const previous = event.signups.find((signup) => signup.userId === interaction.user.id);
      const roleId = state === "absence" ? null : previous?.roleId ?? null;
      return upsertSignup(event, interaction.user, {
        roleId,
        state,
        member: interaction.member
      });
    });
  } catch (error) {
    if (isMissingEventError(error)) {
      await respondEventMissing(interaction, eventId);
      return;
    }
    throw error;
  }
  await refreshEventMessage(client, updated.id);
  await notifySignupWebhook(updated, signupForUser(updated, interaction.user.id), "state-selected");
  await respondToInteraction(interaction, "Statut mis à jour.");
}

async function getGuildOptions(client, guildId) {
  if (!guildId) {
    throw new Error("Aucun serveur Discord configuré. Configure le serveur cible dans le setup.");
  }

  const guild = await client.guilds.fetch(guildId);
  const rawChannels = await client.rest.get(Routes.guildChannels(guildId));
  const fetchedChannels = await guild.channels.fetch();
  const roles = await guild.roles.fetch();
  const emojis = await guild.emojis.fetch();
  let externalEmojis = [];
  const configuredGuild = await getGuild(guildId);
  const emojiGuildId = String(configuredGuild?.emojiGuildId || "").trim();
  if (emojiGuildId && emojiGuildId !== guildId) {
    const emojiGuild = await client.guilds.fetch(emojiGuildId).catch(() => null);
    if (!emojiGuild) {
      throw new Error("Le serveur source d'emojis est configuré, mais le bot n'a pas accès à ce serveur.");
    }
    const emojiGuildEmojis = await emojiGuild.emojis.fetch();
    externalEmojis = [...emojiGuildEmojis.values()].map((emoji) => ({
      id: emoji.id,
      name: emoji.name,
      animated: emoji.animated,
      value: `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`,
      url: emoji.imageURL(),
      sourceGuildId: emojiGuild.id,
      sourceGuildName: emojiGuild.name,
      external: true
    }));
  }
  const me = guild.members.me || await guild.members.fetchMe();
  const eventChannelTypes = new Set([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
    ChannelType.GuildForum,
    ChannelType.GuildMedia
  ]);
  const channelsById = new Map(rawChannels.map((channel) => [channel.id, channel]));

  return {
    channels: rawChannels
      .filter(Boolean)
      .map((channel) => {
        const cachedChannel = fetchedChannels.get(channel.id) || guild.channels.cache.get(channel.id);
        const permissions = cachedChannel?.permissionsFor?.(me);
        const canView = Boolean(permissions?.has(PermissionFlagsBits.ViewChannel));
        const canSend = Boolean(permissions?.has(PermissionFlagsBits.SendMessages));
        const canEmbed = Boolean(permissions?.has(PermissionFlagsBits.EmbedLinks));
        const canManageChannels = Boolean(permissions?.has(PermissionFlagsBits.ManageChannels));
        const isText = Boolean(cachedChannel?.isTextBased?.() || eventChannelTypes.has(channel.type));
        const isCategory = channel.type === ChannelType.GuildCategory;
        const parent = channel.parent_id ? channelsById.get(channel.parent_id) : null;
        return {
          id: channel.id,
          name: channel.name,
          type: channel.type,
          isText,
          isCategory,
          canView,
          canSend,
          canEmbed,
          canManageChannels,
          usableForEvents: isText && canView && canSend && canEmbed,
          usableForEventChannels: isCategory && canManageChannels,
          parentId: channel.parent_id || null,
          parentName: parent?.name || null
        };
      })
      .sort((left, right) => {
        const leftGroup = left.parentName || "";
        const rightGroup = right.parentName || "";
        return leftGroup.localeCompare(rightGroup) || left.name.localeCompare(right.name);
      }),
    roles: [...roles.values()]
      .filter((role) => role.name !== "@everyone")
      .map((role) => ({
        id: role.id,
        name: role.name,
        color: role.hexColor,
        position: role.position
      }))
      .sort((left, right) => right.position - left.position),
    emojis: [
      ...[...emojis.values()]
      .map((emoji) => ({
        id: emoji.id,
        name: emoji.name,
        animated: emoji.animated,
        value: `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`,
        url: emoji.imageURL(),
        sourceGuildId: guild.id,
        sourceGuildName: guild.name,
        external: false
      })),
      ...externalEmojis
    ]
      .sort((left, right) => left.name.localeCompare(right.name))
  };
}

function registerInteractionHandlers(client) {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith("signup-role-target:")) {
        await handleRoleTargetSelect(client, interaction);
      }

      if (interaction.isStringSelectMenu() && interaction.customId.startsWith("signup-role:")) {
        await handleRoleSelect(client, interaction);
      }

      if (interaction.isButton() && interaction.customId.startsWith("signup-state:")) {
        await handleStateButton(client, interaction);
      }
    } catch (error) {
      console.error(error);
      await respondToInteraction(interaction, `Erreur: ${error.message}`);
    }
  });
}

async function startBot() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error("DISCORD_TOKEN est manquant.");
  }

  const client = createDiscordClient();
  registerInteractionHandlers(client);
  await client.login(token);
  await startEventCleanupScheduler(client);
  return client;
}

module.exports = {
  createDiscordClient,
  deleteEventMessage,
  getGuildOptions,
  publishEvent,
  registerInteractionHandlers,
  startBot
};

if (require.main === module) {
  require("./utils/env").loadEnv();
  startBot()
    .then((client) => console.log(`Connecté en tant que ${client.user.tag}`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
