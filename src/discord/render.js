const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder
} = require("discord.js");

function formatDateTime(event) {
  const timestamp = event.timestampSeconds;
  if (!timestamp) {
    return `${event.date} ${event.time}`;
  }

  return `<t:${timestamp}:F>`;
}

function roleLabel(event, slot) {
  return slot.label || slot.roleId;
}

function optionById(event, optionId) {
  return (event.signupOptions || []).find((option) => option.id === optionId) || null;
}

function signupGroupId(event, signup) {
  return signup.roleId || optionById(event, signup.signupOptionId)?.roleId || null;
}

function countForRole(event, roleId) {
  return event.signups.filter((signup) => signupGroupId(event, signup) === roleId && signup.state === "confirmed").length;
}

function renderSignupLines(event, slot) {
  const signups = event.signups.filter((signup) => signupGroupId(event, signup) === slot.roleId && signup.state === "confirmed");
  if (signups.length === 0) {
    return "_Aucune inscription_";
  }

  return signups
    .map((signup, index) => {
      const option = optionById(event, signup.signupOptionId);
      const optionText = option ? ` - ${option.emoji || ""} ${option.label}` : "";
      return `**${index + 1}.** <@${signup.userId}>${optionText}${signup.note ? ` (${signup.note})` : ""}`;
    })
    .join("\n");
}

function renderStateLines(event, stateId) {
  const signups = event.signups.filter((signup) => signup.state === stateId);
  if (signups.length === 0) {
    return null;
  }

  return signups.map((signup) => `<@${signup.userId}>`).join(", ");
}

function renderLeader(event) {
  if (event.leaderUserId) {
    return `<@${event.leaderUserId}>`;
  }

  return event.leader || "Non défini";
}

function renderInfoBlock(event) {
  return [
    `📅 **Date**: ${formatDateTime(event)}`,
    `⚔️ **Difficulté**: ${event.difficulty || "Non précisée"}`,
    `👑 **Leader**: ${renderLeader(event)}`
  ].join("\n");
}

function safeEmoji(emoji) {
  const value = String(emoji || "").trim();
  if (!value) {
    return undefined;
  }

  return /^<a?:\w{2,32}:\d{15,25}>$/.test(value) || /^\p{Extended_Pictographic}$/u.test(value)
    ? value
    : undefined;
}

function buildEventMessage(config, event) {
  const color = Number.parseInt((config.branding.color || "#9d3b35").replace("#", ""), 16);
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(event.title)
    .setDescription(event.description || "Sélectionnez votre rôle pour vous inscrire.")
    .addFields({ name: "Infos", value: renderInfoBlock(event), inline: false })
    .setFooter({ text: config.branding.footer || config.branding.name || "GW Events" });

  if (event.imageUrl) {
    embed.setImage(event.imageUrl);
  }

  if (Array.isArray(event.allowedRoleIds) && event.allowedRoleIds.length > 0) {
    embed.addFields({
      name: "Accès",
      value: event.allowedRoleIds.map((roleId) => `<@&${roleId}>`).join(", "),
      inline: false
    });
  }

  embed.addFields({
    name: "Composition",
    value: "Choisissez votre classe ou spécialisation avec le menu d'inscription.",
    inline: false
  });

  for (const slot of event.roles) {
    const current = countForRole(event, slot.roleId);
    embed.addFields({
      name: `${slot.emoji || ""} ${roleLabel(event, slot)} · ${current}/${slot.capacity}`,
      value: renderSignupLines(event, slot),
      inline: false
    });
  }

  for (const signupState of config.signupStates || []) {
    const lines = renderStateLines(event, signupState.id);
    if (!lines) {
      continue;
    }

    embed.addFields({
      name: `${signupState.emoji || ""} ${signupState.label}`,
      value: lines,
      inline: false
    });
  }

  const signupOptions = (event.signupOptions?.length ? event.signupOptions : event.roles).slice(0, 25);
  const roleOptions = signupOptions.map((option) => {
    const groupId = option.roleId || option.id;
    const group = event.roles.find((slot) => slot.roleId === groupId);
    return {
      label: (option.label || roleLabel(event, option)).slice(0, 100),
      value: `role:${event.id}:${option.id || option.roleId}`,
      description: `${roleLabel(event, group || option)} · ${countForRole(event, groupId)}/${group?.capacity ?? option.capacity ?? "?"} inscrits`.slice(0, 100),
      emoji: safeEmoji(option.emoji)
    };
  });

  const components = [];
  if (roleOptions.length > 0) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`signup-role:${event.id}`)
          .setPlaceholder("Sélectionnez votre rôle")
          .addOptions(roleOptions)
      )
    );
  }

  const stateButtons = (config.signupStates || []).slice(0, 5).map((signupState) => {
    const button = new ButtonBuilder()
      .setCustomId(`signup-state:${event.id}:${signupState.id}`)
      .setLabel(signupState.label.slice(0, 80))
      .setStyle(ButtonStyle.Secondary);

    if (signupState.emoji) {
      button.setEmoji(signupState.emoji);
    }

    return button;
  });

  if (stateButtons.length > 0) {
    components.push(new ActionRowBuilder().addComponents(stateButtons));
  }

  if (Array.isArray(event.links) && event.links.length > 0) {
    const buttons = event.links.slice(0, 5).map((link) =>
      new ButtonBuilder()
        .setLabel(link.label.slice(0, 80))
        .setURL(link.url)
        .setStyle(ButtonStyle.Link)
    );
    components.push(new ActionRowBuilder().addComponents(buttons));
  }

  return { embeds: [embed], components };
}

module.exports = { buildEventMessage };
