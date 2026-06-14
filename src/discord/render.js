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

function formatRelativeTime(event) {
  return event.timestampSeconds ? `<t:${event.timestampSeconds}:R>` : "";
}

function truncateDiscord(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
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

function roleStats(event, slot) {
  const current = countForRole(event, slot.roleId);
  const capacity = Number(slot.capacity || 0);
  return {
    current,
    capacity,
    remaining: Math.max(capacity - current, 0)
  };
}

function renderSignupLines(event, slot) {
  const signups = event.signups.filter((signup) => signupGroupId(event, signup) === slot.roleId && signup.state === "confirmed");
  if (signups.length === 0) {
    return "_Aucune inscription pour le moment._";
  }

  const lines = signups
    .map((signup, index) => {
      const option = optionById(event, signup.signupOptionId);
      const optionText = option ? ` · ${option.emoji || ""} ${option.label}` : "";
      const noteText = signup.note ? ` · ${signup.note}` : "";
      return `**${index + 1}.** <@${signup.userId}>${optionText}${noteText}`;
    })
    .join("\n\n");

  return truncateDiscord(lines, 1024);
}

function renderStateLines(event, stateId) {
  const signups = event.signups.filter((signup) => signup.state === stateId);
  if (signups.length === 0) {
    return null;
  }

  return truncateDiscord(signups.map((signup) => `<@${signup.userId}>`).join(", "), 900);
}

function renderLeader(event) {
  if (event.leaderUserId) {
    return `<@${event.leaderUserId}>`;
  }

  return event.leader || "Non défini";
}

function renderInfoBlock(event) {
  const relative = formatRelativeTime(event);
  return [
    `📅 **Date**: ${formatDateTime(event)}${relative ? ` (${relative})` : ""}`,
    `⚔️ **Difficulté**: ${event.difficulty || "Non précisée"}`,
    `👑 **Leader**: ${renderLeader(event)}`
  ].join("\n\n");
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

function renderSpecialStates(config, event) {
  const lines = [];
  for (const signupState of config.signupStates || []) {
    const stateLines = renderStateLines(event, signupState.id);
    if (stateLines) {
      lines.push(`${signupState.emoji || ""} **${signupState.label}**: ${stateLines}`);
    }
  }

  return lines.length > 0 ? truncateDiscord(lines.join("\n"), 1024) : null;
}

function quoteBlock(value) {
  return String(value || "")
    .split("\n")
    .map((line) => `> ${line || "\u200b"}`)
    .join("\n");
}

function renderRoleBlock(event, slot, compact = false) {
  const stats = roleStats(event, slot);
  const header = compact
    ? [`**${stats.current}/${slot.capacity}** inscrits`, `**${stats.remaining}** libre${stats.remaining > 1 ? "s" : ""}`].join("\n")
    : [
      `**Places**: ${stats.current}/${slot.capacity}`,
      `**Disponibles**: ${stats.remaining}`
    ].join("  •  ");

  return truncateDiscord(`${header}\n\n${quoteBlock(renderSignupLines(event, slot))}\n\u200b`, 1024);
}

function fieldCount(embed) {
  return embed.data.fields?.length || 0;
}

function createContinuationEmbed(color, index) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`Places disponibles ${index + 1}`);
}

function spacerField() {
  return {
    name: "\u200b",
    value: "\u200b",
    inline: true
  };
}

function addRoleFields(embed, event, color, reservedMainFields = 0) {
  const slots = Array.isArray(event.roles) ? event.roles : [];
  const extraEmbeds = [];
  if (slots.length === 0) {
    return extraEmbeds;
  }

  const inlineRoles = slots.length >= 4;
  const makeField = (slot) => ({
    name: `${slot.emoji || ""} ${roleLabel(event, slot)}`,
    value: renderRoleBlock(event, slot, inlineRoles),
    inline: inlineRoles
  });

  let currentEmbed = embed;
  const addField = (field) => {
    const maxFields = currentEmbed === embed ? 25 - reservedMainFields : 25;
    if (fieldCount(currentEmbed) >= maxFields) {
      if (extraEmbeds.length >= 9) {
        return false;
      }
      currentEmbed = createContinuationEmbed(color, extraEmbeds.length);
      extraEmbeds.push(currentEmbed);
    }
    currentEmbed.addFields(field);
    return true;
  };

  for (const [index, slot] of slots.entries()) {
    if (!addField(makeField(slot))) {
      break;
    }

    const shouldForceTwoColumns = inlineRoles && index % 2 === 1 && index < slots.length - 1;
    if (shouldForceTwoColumns && !addField(spacerField())) {
      break;
    }
  }

  return extraEmbeds;
}

function buildEventMessage(config, event) {
  const color = Number.parseInt((config.branding.color || "#9d3b35").replace("#", ""), 16);
  const description = event.description
    ? truncateDiscord(`${event.description}\n\nUtilise le menu ci-dessous pour choisir ta classe ou spécialisation.`, 3500)
    : "Choisis ta classe ou spécialisation avec le menu d'inscription.";
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(event.title)
    .setDescription(description)
    .addFields({ name: "Infos", value: renderInfoBlock(event), inline: false })
    .setFooter({ text: config.branding.footer || config.branding.name || "GW Events" });

  if (event.imageUrl) {
    embed.setImage(event.imageUrl);
  }

  if (Array.isArray(event.allowedRoleIds) && event.allowedRoleIds.length > 0) {
    embed.addFields({
      name: "Accès requis",
      value: event.allowedRoleIds.map((roleId) => `<@&${roleId}>`).join(", "),
      inline: false
    });
  }

  const specialStates = renderSpecialStates(config, event);
  const roleEmbeds = addRoleFields(embed, event, color, specialStates ? 1 : 0);

  if (specialStates) {
    embed.addFields({ name: "Statuts", value: specialStates, inline: false });
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

    const emoji = safeEmoji(signupState.emoji);
    if (emoji) {
      button.setEmoji(emoji);
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

  return { embeds: [embed, ...roleEmbeds], components };
}

module.exports = { buildEventMessage };
