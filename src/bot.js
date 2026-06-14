const { ChannelType, Client, GatewayIntentBits, Events, MessageFlags, PermissionFlagsBits, Routes } = require("discord.js");
const { loadConfig } = require("./config");
const { getEvent, updateEvent } = require("./storage");
const { buildEventMessage } = require("./discord/render");

function createDiscordClient() {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ];

  if (process.env.DISCORD_ENABLE_GUILD_MEMBERS_INTENT === "true") {
    intents.push(GatewayIntentBits.GuildMembers);
  }

  return new Client({
    intents
  });
}

function eventChannelName(event) {
  return String(`${event.date || ""} ${event.title || "event"}`)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "event";
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
      !permissions.has(PermissionFlagsBits.EmbedLinks)
    )
  ) {
    throw new Error("Le bot n'a pas les permissions Voir le salon / Envoyer des messages / Intégrer des liens dans ce salon.");
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

async function deleteEventMessage(client, event) {
  if (!event?.discord?.channelId || !event.discord.messageId) {
    return;
  }

  try {
    const channel = await client.channels.fetch(event.discord.channelId);
    const message = await channel.messages.fetch(event.discord.messageId);
    await message.delete();
  } catch (error) {
    if ([10008, 50001, 50013].includes(error.code)) {
      return;
    }
    throw error;
  }
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

async function respondToInteraction(interaction, content) {
  const payload = { content };
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
  const updated = await updateEvent(eventId, (event) => {
    assertSignupAllowed(interaction, event);
    const signupOption = (event.signupOptions || []).find((option) => option.id === selectedId);
    const roleId = signupOption?.roleId || selectedId;
    return upsertSignup(event, interaction.user, {
      roleId,
      signupOptionId: signupOption?.id || null,
      signupOptionLabel: signupOption?.label || null,
      state: "confirmed",
      member: interaction.member
    });
  });
  await refreshEventMessage(client, updated.id);
  await notifySignupWebhook(updated, signupForUser(updated, interaction.user.id), "role-selected");
  await respondToInteraction(interaction, "Inscription mise à jour.");
}

async function handleStateButton(client, interaction) {
  const acknowledged = await acknowledgeInteraction(interaction);
  if (!acknowledged) {
    return;
  }
  const [, eventId, state] = interaction.customId.split(":");
  const updated = await updateEvent(eventId, (event) => {
    assertSignupAllowed(interaction, event);
    const previous = event.signups.find((signup) => signup.userId === interaction.user.id);
    const roleId = state === "absence" ? null : previous?.roleId ?? null;
    return upsertSignup(event, interaction.user, {
      roleId,
      state,
      member: interaction.member
    });
  });
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
    emojis: [...emojis.values()]
      .map((emoji) => ({
        id: emoji.id,
        name: emoji.name,
        animated: emoji.animated,
        value: `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`,
        url: emoji.imageURL()
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  };
}

function registerInteractionHandlers(client) {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
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
