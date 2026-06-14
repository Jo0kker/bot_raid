const state = {
  user: null,
  config: null,
  discordOptions: {
    channels: [],
    roles: [],
    emojis: []
  },
  allowedRoleIds: [],
  roles: [],
  eventSignupOptions: [],
  compositionEditorOpen: false,
  emojiTargetInput: null,
  editingEventId: null,
  activeTab: "eventsView",
  openTemplateIndex: 0,
  templateSearch: "",
  templateTag: "",
  leaderSearchTimeout: null
};

const byId = (id) => document.getElementById(id);
const DEFAULT_EMOJIS = ["🛡️", "💚", "✨", "⚔️", "🪁", "🔧", "🌿", "🔥", "⏳", "⚡", "🩸", "💀", "🧊", "🏹", "🔮", "🐾", "🤖", "🧪", "🪄", "🎯", "🪑", "🕘", "⚖️", "🚫"];

function headers(extra = {}) {
  return { ...extra };
}

function setAuthenticated(authenticated) {
  byId("loginPanel").classList.toggle("hidden", authenticated);
  byId("eventForm").classList.toggle("hidden", !authenticated);
  byId("eventsPanel").classList.toggle("hidden", !authenticated);
  byId("logoutAdmin").classList.toggle("hidden", !authenticated);
  renderTabs();
}

function renderTabs() {
  const authenticated = Boolean(state.user);
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.classList.toggle("active", button.dataset.tab === state.activeTab);
  }

  for (const view of document.querySelectorAll(".tab-view")) {
    const visible = authenticated && (
      view.id === state.activeTab ||
      (state.activeTab === "eventsView" && view.id === "eventsPanel")
    );
    view.classList.toggle("hidden", !visible);
  }
}

function todayForConfiguredTimezone() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: state.config.defaults?.timezone || "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function roleDefinition(roleId) {
  return state.config.roles.find((role) => role.id === roleId);
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function uniqueTemplateId(label) {
  const base = slugify(label) || "nouveau_template";
  const usedIds = new Set((state.config.templates || []).map((template) => template.id));
  if (!usedIds.has(base)) {
    return base;
  }

  let index = 2;
  while (usedIds.has(`${base}_${index}`)) {
    index += 1;
  }
  return `${base}_${index}`;
}

function templateSummary(template) {
  if (!template?.roles?.length) {
    return "Composition libre: ajoute les rôles nécessaires pour cet event.";
  }

  return template.roles
    .map((slot) => {
      const role = roleDefinition(slot.roleId);
      return `${role?.emoji || ""} ${role?.label || slot.roleId} x${slot.capacity ?? role?.defaultCapacity ?? 1}`;
    })
    .join(" · ");
}

function templateTags(template) {
  return [template.game, ...(template.tags || [])]
    .filter(Boolean)
    .map((tag) => String(tag).trim())
    .filter(Boolean);
}

function renderConfig() {
  for (const template of state.config.templates || []) {
    if (!Array.isArray(template.signupOptions)) {
      template.signupOptions = structuredClone(state.config.signupOptions || []);
    }
  }

  const templateSelect = byId("templateSelect");
  templateSelect.innerHTML = state.config.templates
    .map((template) => `<option value="${template.id}">${template.label} - ${templateSummary(template)}</option>`)
    .join("");

  byId("difficultySelect").innerHTML = state.config.difficulties
    .map((difficulty) => `<option value="${difficulty}">${difficulty}</option>`)
    .join("");

  byId("linksJson").value = JSON.stringify(state.config.links, null, 2);
  byId("configJson").value = JSON.stringify(state.config, null, 2);
  document.querySelector("input[name=date]").value = todayForConfiguredTimezone();
  state.eventSignupOptions = structuredClone(state.config.templates[0]?.signupOptions || []);
  applyTemplate(templateSelect.value);
  renderDiscordOptions();
  renderConfigEditors();
}

function renderDiscordOptions() {
  state.discordOptions.channels = state.discordOptions.channels || [];
  state.discordOptions.roles = state.discordOptions.roles || [];
  state.discordOptions.emojis = state.discordOptions.emojis || [];
  const textChannels = state.discordOptions.channels.filter((channel) => channel.isText);
  const usableChannels = textChannels.filter((channel) => channel.usableForEvents);
  byId("channelSelect").innerHTML = [
    `<option value="">Salon par défaut (.env)</option>`,
    ...usableChannels.map((channel) => {
      const label = channel.parentName ? `${channel.parentName} / #${channel.name}` : `#${channel.name}`;
      return `<option value="${channel.id}">${label}</option>`;
    })
  ].join("");

  const hiddenChannels = textChannels.length - usableChannels.length;
  byId("discordOptionsStatus").textContent = state.discordOptions.channels.length > 0
    ? `${usableChannels.length} salons utilisables. ${hiddenChannels} salons masqués faute de permissions bot.`
    : "Aucun salon récupéré pour l'instant. Recharge Discord ou configure le serveur dans le setup.";

  renderAllowedRoles();
}

function renderAllowedRoles() {
  state.discordOptions.roles = state.discordOptions.roles || [];
  const selected = new Set(state.allowedRoleIds);
  if (state.discordOptions.roles.length === 0) {
    byId("allowedRolesEditor").innerHTML = `<p class="hint">Aucun rôle chargé. Clique sur “Rafraîchir salons/rôles”.</p>`;
    return;
  }

  byId("allowedRolesEditor").innerHTML = state.discordOptions.roles
    .map((role) => `
      <label class="role-choice">
        <input type="checkbox" value="${role.id}" ${selected.has(role.id) ? "checked" : ""}>
        <span class="role-dot" style="background:${role.color && role.color !== "#000000" ? role.color : "#6b7280"}"></span>
        <span>${role.name}</span>
      </label>
    `)
    .join("");
}

function applyTemplate(templateId) {
  const template = state.config.templates.find((item) => item.id === templateId);
  byId("templateSummary").textContent = `Template appliqué: ${templateSummary(template)}`;
  state.compositionEditorOpen = templateId === "custom";
  state.eventSignupOptions = structuredClone(template.signupOptions || []);
  state.roles = template.roles.map((slot) => {
    const definition = roleDefinition(slot.roleId);
    return {
      roleId: slot.roleId,
      label: definition?.label ?? slot.roleId,
      emoji: definition?.emoji ?? "",
      capacity: slot.capacity ?? definition?.defaultCapacity ?? 1
    };
  });
  renderRoles();
}

function renderRoles() {
  byId("compositionEditor").classList.toggle("hidden", !state.compositionEditorOpen);
  byId("toggleCompositionEditor").textContent = state.compositionEditorOpen
    ? "Masquer le détail"
    : "Modifier la composition";
  byId("compositionPreview").innerHTML = state.roles.length
    ? state.roles.map((slot) => {
      const definition = roleDefinition(slot.roleId);
      return `<span>${slot.emoji || definition?.emoji || ""} ${slot.label || definition?.label || slot.roleId} x${slot.capacity}</span>`;
    }).join("")
    : `<span>Composition libre</span>`;

  byId("rolesEditor").innerHTML = state.roles
    .map((slot, index) => {
      const options = state.config.roles
        .map((role) => `<option value="${role.id}" ${role.id === slot.roleId ? "selected" : ""}>${role.label}</option>`)
        .join("");
      return `
        <div class="role-row" data-index="${index}">
          <select data-field="roleId">${options}</select>
          <input data-field="capacity" type="number" min="0" max="99" value="${slot.capacity}">
          <input data-field="emoji" data-emoji-input value="${slot.emoji}" placeholder="Emoji">
          <button type="button" class="icon-button danger" data-remove="${index}" aria-label="Supprimer">🗑️</button>
        </div>
      `;
    })
    .join("");
}

function roleOptionsHtml(selectedRoleId, excludedRoleIds = new Set()) {
  return state.config.roles
    .filter((role) => role.id === selectedRoleId || !excludedRoleIds.has(role.id))
    .map((role) => `<option value="${role.id}" ${role.id === selectedRoleId ? "selected" : ""}>${role.label}</option>`)
    .join("");
}

function rolePreviewHtml(roleId) {
  const role = roleDefinition(roleId);
  return role?.emoji ? renderEmojiPreview(role.emoji, { showLabel: false }) : "";
}

function updateRolePreview(select) {
  const preview = select?.closest(".config-row")?.querySelector("[data-role-preview]");
  if (preview) {
    preview.innerHTML = rolePreviewHtml(select.value);
  }
}

function catalogOptionRoleOptionsHtml(selectedRoleId) {
  return [
    selectedRoleId && !state.config.roles.some((role) => role.id === selectedRoleId)
      ? `<option value="${selectedRoleId}" selected>Rôle inconnu (${selectedRoleId})</option>`
      : "",
    roleOptionsHtml(selectedRoleId)
  ].join("");
}

function templateRoleOptionsHtml(template, selectedRoleId) {
  const templateRoleIds = new Set((template.roles || []).map((slot) => slot.roleId));
  const roles = state.config.roles.filter((role) => templateRoleIds.has(role.id));
  const selectedStillAvailable = roles.some((role) => role.id === selectedRoleId);
  return [
    selectedRoleId && !selectedStillAvailable ? `<option value="${selectedRoleId}" selected>Rôle non ouvert (${selectedRoleId})</option>` : "",
    ...roles
    .map((role) => `<option value="${role.id}" ${role.id === selectedRoleId ? "selected" : ""}>${role.label}</option>`)
  ].join("");
}

function templateSignupCatalogOptions(template, selectedOptionId, excludedOptionIds = new Set()) {
  const openRoleIds = new Set((template.roles || []).map((slot) => slot.roleId));
  const options = (state.config.signupOptions || []).filter((option) =>
    (option.id === selectedOptionId || !excludedOptionIds.has(option.id)) &&
    (openRoleIds.size === 0 || openRoleIds.has(option.roleId))
  );
  const selectedStillAvailable = options.some((option) => option.id === selectedOptionId);
  const selectedOption = (state.config.signupOptions || []).find((option) => option.id === selectedOptionId);
  return [
    selectedOption && !selectedStillAvailable
      ? `<option value="${selectedOption.id}" selected>${selectedOption.label} - rôle non ouvert</option>`
      : "",
    ...options.map((option) => {
      const role = roleDefinition(option.roleId);
      return `<option value="${option.id}" ${option.id === selectedOptionId ? "selected" : ""}>${option.label}${role ? ` - ${role.label}` : ""}</option>`;
    })
  ].join("");
}

function catalogOptionById(optionId) {
  return (state.config.signupOptions || []).find((option) => option.id === optionId) || null;
}

function applyCatalogOptionToTemplateRow(row, optionId) {
  const option = catalogOptionById(optionId);
  if (!option) {
    return;
  }

  row.querySelector("[data-template-option-field=id]").value = option.id;
  row.querySelector("[data-template-option-field=label]").value = option.label;
  row.querySelector("[data-template-option-field=emoji]").value = option.emoji || "";
  row.querySelector("[data-template-option-field=roleId]").value = option.roleId;
  const preview = row.querySelector("[data-template-option-preview]");
  if (preview) {
    preview.innerHTML = option.emoji ? renderEmojiPreview(option.emoji, { showLabel: false }) : "";
  }
}

function emojiPickerHtml(selectedEmoji) {
  const label = selectedEmoji ? renderEmojiPreview(selectedEmoji) : "Choisir";
  return `<button type="button" class="secondary emoji-select-button" data-open-emoji-picker>${label}</button>`;
}

function emojiFieldHtml(selectedEmoji, fieldAttribute) {
  const label = selectedEmoji ? renderEmojiPreview(selectedEmoji, { showLabel: false }) : `<span class="emoji-placeholder">Emoji</span>`;
  return `
    <div class="emoji-field">
      <input type="hidden" ${fieldAttribute} data-emoji-input value="${selectedEmoji || ""}">
      <button type="button" class="emoji-field-button" data-open-emoji-picker>${label}</button>
    </div>
  `;
}

function updateEmojiFieldPreview(input) {
  const button = input?.closest(".emoji-field")?.querySelector(".emoji-field-button");
  if (!button) {
    return;
  }

  button.innerHTML = input.value
    ? renderEmojiPreview(input.value, { showLabel: false })
    : `<span class="emoji-placeholder">Emoji</span>`;
}

function parseDiscordEmoji(value) {
  const match = /^<a?:(\w{2,32}):(\d{15,25})>$/.exec(String(value || "").trim());
  if (!match) {
    return null;
  }

  return {
    name: match[1],
    id: match[2],
    animated: String(value).startsWith("<a:")
  };
}

function renderEmojiPreview(value, options = {}) {
  const showLabel = options.showLabel !== false;
  const serverEmoji = (state.discordOptions.emojis || []).find((emoji) => emoji.value === value);
  if (serverEmoji) {
    return `<img src="${serverEmoji.url}" alt=":${serverEmoji.name}:">${showLabel ? `<span>:${serverEmoji.name}:</span>` : ""}`;
  }

  const parsed = parseDiscordEmoji(value);
  if (parsed) {
    const extension = parsed.animated ? "gif" : "png";
    return `<img src="https://cdn.discordapp.com/emojis/${parsed.id}.${extension}" alt=":${parsed.name}:">${showLabel ? `<span>:${parsed.name}:</span>` : ""}`;
  }

  return `<span>${value}</span>`;
}

function allEmojiChoices() {
  const palette = state.config.emojiPalette?.length ? state.config.emojiPalette : DEFAULT_EMOJIS;
  return [
    ...palette.map((emoji) => {
      const parsed = parseDiscordEmoji(emoji);
      return {
        value: emoji,
        label: parsed ? `:${parsed.name}:` : emoji,
        searchable: parsed ? parsed.name : emoji,
        url: parsed ? `https://cdn.discordapp.com/emojis/${parsed.id}.${parsed.animated ? "gif" : "png"}` : null
      };
    }),
    ...(state.discordOptions.emojis || []).map((emoji) => ({
      value: emoji.value,
      label: `:${emoji.name}:`,
      searchable: emoji.name,
      url: emoji.url
    }))
  ];
}

function openEmojiPickerDialog() {
  byId("emojiPicker").classList.remove("hidden");
  byId("emojiSearch").value = "";
  renderEmojiPickerList();
  byId("emojiSearch").focus();
}

function closeEmojiPickerDialog() {
  byId("emojiPicker").classList.add("hidden");
  state.emojiTargetInput = null;
}

function renderEmojiPickerList() {
  const query = byId("emojiSearch").value.trim().toLowerCase();
  const choices = allEmojiChoices()
    .filter((emoji) => !query || emoji.searchable.toLowerCase().includes(query) || emoji.label.toLowerCase().includes(query))
    .slice(0, 120);

  byId("emojiPickerList").innerHTML = choices.map((emoji) => `
    <button type="button" class="emoji-picker-option" data-picker-emoji="${emoji.value}">
      ${emoji.url
        ? `<img src="${emoji.url}" alt="${emoji.label}"><span>${emoji.label}</span>`
        : `<span class="emoji-glyph">${emoji.value}</span>`}
    </button>
  `).join("");
}

function addEmojiToPalette(value) {
  const emoji = String(value || "").trim();
  if (!emoji) {
    return;
  }

  state.config.emojiPalette = state.config.emojiPalette || [];
  if (!state.config.emojiPalette.includes(emoji)) {
    state.config.emojiPalette.push(emoji);
  }
  renderEmojiAdmin();
  byId("configJson").value = JSON.stringify(state.config, null, 2);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

async function createEmojiFromImage() {
  const name = byId("externalEmojiName").value.trim();
  const file = byId("externalEmojiFile").files[0];
  const status = byId("emojiUploadStatus");
  const button = byId("createEmojiFromImage");
  if (!name || !file) {
    status.textContent = "Nom et image obligatoires.";
    return;
  }

  button.disabled = true;
  status.textContent = "Création de l'emoji Discord...";
  try {
    const response = await fetch("/api/discord/emojis", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        name,
        imageDataUrl: await readFileAsDataUrl(file)
      })
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error("Route upload emoji introuvable. Redémarre le serveur Node pour charger la nouvelle API.");
      }
      throw new Error(result.error || "Création impossible.");
    }

    state.config = result.config;
    state.discordOptions.emojis = [
      ...(state.discordOptions.emojis || []).filter((emoji) => emoji.id !== result.emoji.id),
      result.emoji
    ];
    byId("externalEmojiName").value = "";
    byId("externalEmojiFile").value = "";
    renderConfigEditors();
    status.textContent = `Emoji créé et ajouté à la palette: :${result.emoji.name}:`;
  } catch (error) {
    status.textContent = `Erreur: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function renderEmojiAdmin() {
  const palette = state.config.emojiPalette?.length ? state.config.emojiPalette : [];
  byId("emojiPaletteEditor").innerHTML = palette.length
    ? palette.map((emoji, index) => `
      <div class="emoji-admin-item" data-emoji-palette-index="${index}">
        <input type="hidden" data-emoji-palette-value value="${escapeAttr(emoji)}">
        <span class="emoji-admin-preview">${renderEmojiPreview(emoji)}</span>
        <button type="button" class="icon-button danger" data-remove-palette-emoji="${index}" aria-label="Supprimer">🗑️</button>
      </div>
    `).join("")
    : `<p class="hint">Aucun emoji dans la palette.</p>`;

  const query = (byId("serverEmojiSearch")?.value || "").trim().toLowerCase();
  const serverEmojis = (state.discordOptions.emojis || [])
    .filter((emoji) => !query || emoji.name.toLowerCase().includes(query))
    .slice(0, 200);

  byId("serverEmojiCatalog").innerHTML = serverEmojis.length
    ? serverEmojis.map((emoji) => {
      const alreadyAdded = palette.includes(emoji.value);
      return `
        <button type="button" class="emoji-admin-item ${alreadyAdded ? "selected" : ""}" data-add-server-emoji="${escapeAttr(emoji.value)}">
          <span class="emoji-admin-preview">${renderEmojiPreview(emoji.value)}</span>
          <span class="emoji-admin-label">:${escapeHtml(emoji.name)}:</span>
        </button>
      `;
    }).join("")
    : `<p class="hint">Aucun emoji serveur chargé.</p>`;
}

function renderConfigEditors() {
  state.config.emojiPalette = state.config.emojiPalette?.length ? state.config.emojiPalette : [...DEFAULT_EMOJIS];
  state.config.signupOptions = Array.isArray(state.config.signupOptions) ? state.config.signupOptions : [];
  byId("templateSearch").value = state.templateSearch;
  renderEmojiAdmin();

  byId("groupsEditor").innerHTML = (state.config.roles || [])
    .map((role, index) => `
      <div class="config-row group-config-row" data-group-index="${index}">
        <input type="hidden" data-group-field="id" value="${role.id || ""}">
        <input data-group-field="label" value="${role.label || ""}" placeholder="Nom du groupe">
        ${emojiFieldHtml(role.emoji || "", "data-group-field=\"emoji\"")}
        <input type="hidden" data-group-field="defaultCapacity" value="${role.defaultCapacity ?? 1}">
        <button type="button" class="icon-button danger" data-remove-group="${index}" aria-label="Supprimer">🗑️</button>
      </div>
    `)
    .join("");

  byId("classesEditor").innerHTML = state.config.signupOptions
    .map((option, index) => `
      <div class="config-row class-config-row" data-class-index="${index}">
        <input type="hidden" data-class-field="id" value="${option.id || ""}">
        <input data-class-field="label" value="${option.label || ""}" placeholder="Nom affiché">
        ${emojiFieldHtml(option.emoji || "", "data-class-field=\"emoji\"")}
        <span class="role-select-preview" data-role-preview>${rolePreviewHtml(option.roleId)}</span>
        <select data-class-field="roleId">${catalogOptionRoleOptionsHtml(option.roleId)}</select>
        <button type="button" class="icon-button danger" data-remove-class-option="${index}" aria-label="Supprimer">🗑️</button>
      </div>
    `)
    .join("");

  const allTemplates = state.config.templates || [];
  const visibleTemplates = allTemplates
    .map((template, templateIndex) => ({ template, templateIndex }))
    .filter(({ template }) => {
      const haystack = `${template.id || ""} ${template.label || ""} ${template.game || ""} ${(template.tags || []).join(" ")}`.toLowerCase();
      const matchesSearch = !state.templateSearch || haystack.includes(state.templateSearch.toLowerCase());
      const matchesTag = !state.templateTag || templateTags(template).includes(state.templateTag);
      return matchesSearch && matchesTag;
    });

  byId("templateFilterStatus").textContent = state.templateSearch || state.templateTag
    ? `${visibleTemplates.length}/${allTemplates.length} templates affichés${state.templateTag ? ` · filtre: ${state.templateTag}` : ""}${state.templateSearch ? ` · recherche: ${state.templateSearch}` : ""}`
    : `${allTemplates.length} templates affichés`;

  byId("templatesEditor").innerHTML = visibleTemplates
    .map(({ template, templateIndex }) => {
      const isOpen = state.openTemplateIndex === templateIndex;
      return `
      <div class="template-editor ${isOpen ? "open" : ""}" data-template-index="${templateIndex}">
        <button type="button" class="template-accordion" data-toggle-template="${templateIndex}">
          <span>${template.label || template.id}</span>
          <small>${templateSummary(template)}</small>
        </button>
        <div class="template-body ${isOpen ? "" : "hidden"}">
          <div class="template-header">
          <div class="template-title-fields">
            <input data-template-field="id" value="${template.id || ""}" placeholder="id">
            <input data-template-field="label" value="${template.label || ""}" placeholder="Nom du template">
            <input data-template-field="game" value="${template.game || ""}" placeholder="Jeu">
          </div>
          <button type="button" class="icon-button danger" data-remove-template="${templateIndex}" aria-label="Supprimer">🗑️</button>
        </div>
        <div class="template-grid">
          <section>
            <div class="section-title compact-title">
              <h3>Composition</h3>
              <button type="button" class="secondary" data-add-template-role="${templateIndex}">Ajouter</button>
            </div>
            <div class="template-roles">
              ${(template.roles || []).map((slot, slotIndex) => {
                const usedRoleIds = new Set((template.roles || []).map((item, index) => index === slotIndex ? null : item.roleId).filter(Boolean));
                return `
                  <div class="config-row template-role-row" data-template-role-index="${slotIndex}">
                    <span class="role-select-preview" data-role-preview>${rolePreviewHtml(slot.roleId)}</span>
                    <select data-template-role-field="roleId">${roleOptionsHtml(slot.roleId, usedRoleIds)}</select>
                    <input data-template-role-field="capacity" type="number" min="0" max="99" value="${slot.capacity ?? 1}" aria-label="Capacité">
                    <button type="button" class="icon-button danger" data-remove-template-role="${templateIndex}:${slotIndex}" aria-label="Supprimer">🗑️</button>
                  </div>
                `;
              }).join("")}
            </div>
          </section>
          <section>
            <div class="section-title compact-title">
              <h3>Options d'inscription</h3>
              <button type="button" class="secondary" data-add-template-signup-option="${templateIndex}">Ajouter</button>
            </div>
            <div class="template-signup-options">
              ${(template.signupOptions || []).map((option, optionIndex) => {
                const usedOptionIds = new Set((template.signupOptions || []).map((item, index) => index === optionIndex ? null : item.id).filter(Boolean));
                return `
                  <div class="config-row template-option-row" data-template-signup-option-index="${optionIndex}">
                    <input type="hidden" data-template-option-field="id" value="${option.id || ""}">
                    <input type="hidden" data-template-option-field="label" value="${option.label || ""}">
                    <input type="hidden" data-template-option-field="emoji" value="${option.emoji || ""}">
                    <input type="hidden" data-template-option-field="roleId" value="${option.roleId || ""}">
                    <span class="template-option-preview" data-template-option-preview>${option.emoji ? renderEmojiPreview(option.emoji, { showLabel: false }) : ""}</span>
                    <select data-template-option-catalog>${templateSignupCatalogOptions(template, option.id, usedOptionIds)}</select>
                    <button type="button" class="icon-button danger" data-remove-template-signup-option="${templateIndex}:${optionIndex}" aria-label="Supprimer">🗑️</button>
                  </div>
                `;
              }).join("")}
            </div>
          </section>
        </div>
        </div>
      </div>
    `;
    })
    .join("");

  renderTemplateFilters();
}

function renderTemplateFilters() {
  const tags = [...new Set((state.config.templates || []).flatMap(templateTags))].sort();
  const activeStillExists = !state.templateTag || tags.includes(state.templateTag);
  if (!activeStillExists) {
    state.templateTag = "";
  }

  byId("templateTagFilters").innerHTML = [
    `<button type="button" class="tag-filter ${state.templateTag ? "" : "active"}" data-template-tag="">Tous</button>`,
    ...tags.map((tag) => `<button type="button" class="tag-filter ${state.templateTag === tag ? "active" : ""}" data-template-tag="${tag}">${tag}</button>`)
  ].join("");
}

function openTemplateCreateModal() {
  readConfigEditors();
  const modal = byId("templateCreateModal");
  const form = byId("templateCreateForm");
  form.elements.label.value = state.templateSearch || "";
  form.elements.game.value = state.templateTag || "Guild Wars 2";
  form.elements.sourceTemplateId.innerHTML = [
    `<option value="">Template vide</option>`,
    ...(state.config.templates || []).map((template) =>
      `<option value="${escapeHtml(template.id)}">${escapeHtml(template.label || template.id)}</option>`
    )
  ].join("");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  form.elements.label.focus();
}

function closeTemplateCreateModal() {
  const modal = byId("templateCreateModal");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function createTemplateFromModal(event) {
  event.preventDefault();
  const form = event.target;
  const label = form.elements.label.value.trim() || "Nouveau template";
  const game = form.elements.game.value.trim() || "Guild Wars 2";
  const source = state.config.templates.find((template) => template.id === form.elements.sourceTemplateId.value);
  const template = {
    id: uniqueTemplateId(label),
    label,
    game,
    roles: structuredClone(source?.roles || []),
    signupOptions: structuredClone(source?.signupOptions || [])
  };

  state.config.templates.push(template);
  state.openTemplateIndex = state.config.templates.length - 1;
  state.templateSearch = label;
  state.templateTag = game;
  closeTemplateCreateModal();
  renderConfigEditors();
  readConfigEditors();
}

function readConfigEditors() {
  const paletteInputs = [...document.querySelectorAll("[data-emoji-palette-value]")];
  state.config.emojiPalette = paletteInputs.length
    ? paletteInputs.map((input) => input.value.trim()).filter(Boolean)
    : (state.config.emojiPalette?.length ? state.config.emojiPalette : [...DEFAULT_EMOJIS]);

  state.config.roles = [...document.querySelectorAll("[data-group-index]")].map((row) => ({
    id: row.querySelector("[data-group-field=id]").value.trim(),
    label: row.querySelector("[data-group-field=label]").value.trim(),
    emoji: row.querySelector("[data-group-field=emoji]").value.trim(),
    defaultCapacity: Number(row.querySelector("[data-group-field=defaultCapacity]").value || 1)
  })).filter((role) => role.label).map((role) => ({
    id: role.id || slugify(role.label),
    ...role
  }));

  state.config.signupOptions = [...document.querySelectorAll("[data-class-index]")].map((row) => ({
    id: row.querySelector("[data-class-field=id]").value.trim(),
    label: row.querySelector("[data-class-field=label]").value.trim(),
    emoji: row.querySelector("[data-class-field=emoji]").value.trim(),
    roleId: row.querySelector("[data-class-field=roleId]").value
  })).filter((option) => option.label && option.roleId).map((option) => ({
    id: option.id || slugify(option.label),
    ...option
  }));

  const templates = [...state.config.templates];
  for (const templateNode of document.querySelectorAll("[data-template-index]")) {
    const templateIndex = Number(templateNode.dataset.templateIndex);
    const template = {
      id: templateNode.querySelector("[data-template-field=id]").value.trim(),
      label: templateNode.querySelector("[data-template-field=label]").value.trim(),
      game: templateNode.querySelector("[data-template-field=game]").value.trim(),
      roles: [...templateNode.querySelectorAll("[data-template-role-index]")].map((row) => ({
        roleId: row.querySelector("[data-template-role-field=roleId]").value,
        capacity: Number(row.querySelector("[data-template-role-field=capacity]").value || 1)
      })),
      signupOptions: [...templateNode.querySelectorAll("[data-template-signup-option-index]")].map((row) => ({
        id: row.querySelector("[data-template-option-field=id]").value.trim(),
        label: row.querySelector("[data-template-option-field=label]").value.trim(),
        emoji: row.querySelector("[data-template-option-field=emoji]").value.trim(),
        roleId: row.querySelector("[data-template-option-field=roleId]").value
      })).filter((option) => option.label && option.roleId).map((option) => ({
        id: option.id || slugify(option.label),
        ...option
      }))
    };

    if (template.id && template.label) {
      templates[templateIndex] = template;
    }
  }
  state.config.templates = templates.filter((template) => template?.id && template?.label);

  byId("configJson").value = JSON.stringify(state.config, null, 2);
}

function readRolesFromDom() {
  state.roles = [...document.querySelectorAll(".role-row")].map((row) => {
    const roleId = row.querySelector("[data-field=roleId]").value;
    const definition = roleDefinition(roleId);
    return {
      roleId,
      label: definition?.label ?? roleId,
      emoji: row.querySelector("[data-field=emoji]").value || definition?.emoji || "",
      capacity: Number(row.querySelector("[data-field=capacity]").value || definition?.defaultCapacity || 1)
    };
  });
}

async function loadConfig() {
  const response = await fetch("/api/config");
  state.config = await response.json();
  renderConfig();
}

async function loadAuthState() {
  const response = await fetch("/api/auth/me");
  const result = await response.json();
  state.user = result.user;
  byId("inviteBotLink").href = result.inviteUrl || "/auth/discord/invite";
  byId("discordLoginLink").href = result.loginUrl || "/auth/discord/login";
  byId("authHelp").textContent = result.setupConfigured
    ? "Serveur Discord configuré. Connecte-toi avec le compte installateur ou un rôle admin configuré."
    : "Commence par Ajouter à Discord: l'installation enregistrera automatiquement le serveur et ton compte comme admin.";
  setAuthenticated(Boolean(result.authenticated));
  return result;
}

async function authenticate() {
  const response = await fetch("/api/events", { headers: headers() });
  const result = await response.json();
  if (!response.ok) {
    state.user = null;
    throw new Error(result.error || "Connexion impossible.");
  }

  setAuthenticated(true);
  renderEvents(result.events || []);
  try {
    await loadDiscordOptions();
  } catch (error) {
    byId("status").textContent = `Connecté. Discord non chargé: ${error.message}`;
  }
  return result;
}

function setFormMode(eventId) {
  state.editingEventId = eventId;
  byId("submitEvent").textContent = eventId ? "Modifier l'annonce Discord" : "Créer l'annonce Discord";
}

function readJsonTextarea(id, fallback) {
  const raw = byId(id).value.trim();
  if (!raw) {
    return fallback;
  }

  return JSON.parse(raw);
}

function fillForm(event) {
  setFormMode(event.id);
  state.compositionEditorOpen = false;
  const form = byId("eventForm");
  form.elements.title.value = event.title || "";
  form.elements.templateId.value = event.templateId || "custom";
  form.elements.date.value = event.date || "";
  form.elements.time.value = event.time || "";
  form.elements.difficulty.value = event.difficulty || "";
  form.elements.leaderUserId.value = event.leaderUserId ? `<@${event.leaderUserId}>` : (event.leader || "");
  form.elements.channelId.value = event.channelId || event.discord?.channelId || "";
  form.elements.description.value = event.description || "";
  form.elements.imageUrl.value = event.imageUrl || "";
  state.roles = event.roles || [];
  state.eventSignupOptions = event.signupOptions?.length ? event.signupOptions : structuredClone(
    state.config.templates.find((template) => template.id === form.elements.templateId.value)?.signupOptions ||
    []
  );
  state.allowedRoleIds = event.allowedRoleIds || [];
  byId("linksJson").value = JSON.stringify(event.links || [], null, 2);
  renderAllowedRoles();
  renderRoles();
}

function resetEventForm() {
  byId("eventForm").reset();
  setFormMode(null);
  state.allowedRoleIds = [];
  renderConfig();
  byId("status").textContent = "";
}

function renderEvents(events) {
  if (events.length === 0) {
    byId("eventsList").innerHTML = `<p>Aucun event.</p>`;
    return;
  }

  byId("eventsList").innerHTML = events
    .map((event) => `
      <article class="event-row">
        <div>
          <strong>${event.title}</strong>
          <span>${event.date} ${event.time} · ${event.difficulty || "Sans difficulté"} · ${event.signupCount} inscrits</span>
        </div>
        <div class="event-actions">
          ${event.discord?.url ? `<a href="${event.discord.url}" target="_blank" rel="noreferrer">Discord</a>` : ""}
          <button type="button" class="secondary" data-edit-event="${event.id}">Modifier</button>
          <button type="button" class="danger" data-delete-event="${event.id}">Supprimer</button>
        </div>
      </article>
    `)
    .join("");
}

async function loadEvents() {
  const response = await fetch("/api/events", { headers: headers() });
  const result = await response.json();
  if (!response.ok) {
    byId("status").textContent = `Erreur: ${result.error}`;
    return;
  }

  renderEvents(result.events || []);
}

async function loadDiscordOptions() {
  const button = byId("loadDiscordOptions");
  button.disabled = true;
  button.textContent = "Chargement...";
  const response = await fetch("/api/discord/options", { headers: headers() });
  const result = await response.json();
  button.disabled = false;
  button.textContent = "Rafraîchir salons/rôles";
  if (!response.ok) {
    byId("status").textContent = `Erreur: ${result.error}`;
    throw new Error(result.error || "Chargement Discord impossible.");
  }

  state.discordOptions = {
    channels: result.channels || [],
    roles: result.roles || [],
    emojis: result.emojis || []
  };
  renderDiscordOptions();
  renderConfigEditors();
  const textChannels = state.discordOptions.channels.filter((channel) => channel.isText).length;
  const usableChannels = state.discordOptions.channels.filter((channel) => channel.usableForEvents).length;
  byId("status").textContent = `${state.discordOptions.channels.length} salons, ${usableChannels}/${textChannels} salons texte utilisables, ${state.discordOptions.roles.length} rôles, ${state.discordOptions.emojis.length} emojis chargés.`;
  return state.discordOptions;
}

async function saveConfig(useVisualEditors = true) {
  if (useVisualEditors) {
    readConfigEditors();
  }
  const config = JSON.parse(byId("configJson").value);
  const response = await fetch("/api/config", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...headers()
    },
    body: JSON.stringify(config)
  });
  const result = await response.json();
  if (!response.ok) {
    byId("status").textContent = `Erreur: ${result.error}`;
    return;
  }

  state.config = result.config;
  renderConfig();
  byId("status").textContent = "Configuration sauvegardée.";
}

async function loadEventIntoForm(eventId) {
  const response = await fetch(`/api/events/${eventId}`, { headers: headers() });
  const result = await response.json();
  if (!response.ok) {
    byId("status").textContent = `Erreur: ${result.error}`;
    return;
  }

  fillForm(result.event);
  byId("status").textContent = `Event chargé: ${result.event.title}`;
}

async function deleteExistingEvent(eventId) {
  const response = await fetch(`/api/events/${eventId}`, {
    method: "DELETE",
    headers: headers()
  });
  const result = await response.json();
  byId("status").textContent = response.ok
    ? "Event supprimé."
    : `Erreur: ${result.error}`;
  if (response.ok) {
    await loadEvents();
    if (state.editingEventId === eventId) {
      resetEventForm();
    }
  }
}

async function searchLeaderSuggestions(value) {
  const query = String(value || "").trim();
  if (query.length < 2 || /^<@!?\d{15,25}>$/.test(query) || /^\d{15,25}$/.test(query)) {
    byId("leaderSuggestions").innerHTML = "";
    return;
  }

  const response = await fetch(`/api/discord/members?query=${encodeURIComponent(query)}`, {
    headers: headers()
  });
  const result = await response.json();
  if (!response.ok) {
    byId("discordOptionsStatus").textContent = `Recherche leader impossible: ${result.error}`;
    return;
  }

  byId("leaderSuggestions").innerHTML = (result.members || [])
    .map((member) => {
      const label = `${member.displayName || member.globalName || member.username} (${member.username})`;
      return `<option value="${member.mention}" label="${escapeAttr(label)}"></option>`;
    })
    .join("");
}

document.addEventListener("change", (event) => {
  if (event.target.id === "templateSelect") {
    applyTemplate(event.target.value);
  }

  if (event.target.closest(".role-row")) {
    readRolesFromDom();
    renderRoles();
  }

  if (event.target.matches("[data-template-option-catalog]")) {
    applyCatalogOptionToTemplateRow(event.target.closest("[data-template-signup-option-index]"), event.target.value);
  }

  if (
    event.target.matches("[data-class-field=roleId]") ||
    event.target.matches("[data-template-role-field=roleId]")
  ) {
    updateRolePreview(event.target);
  }

  if (event.target.closest("#allowedRolesEditor")) {
    state.allowedRoleIds = [...document.querySelectorAll("#allowedRolesEditor input:checked")]
      .map((input) => input.value);
  }

  if (
    event.target.closest("#templatesView") ||
    event.target.closest("#classesView") ||
    event.target.closest("#emojisView") ||
    event.target.closest("#advancedConfigView")
  ) {
    readConfigEditors();
  }

  if (event.target.matches("[data-template-role-field=roleId]")) {
    renderConfigEditors();
  }

  if (event.target.matches("[data-template-option-catalog]")) {
    renderConfigEditors();
  }
});

document.addEventListener("click", (event) => {
  if (event.target.id === "templateCreateModal") {
    closeTemplateCreateModal();
  }

  const tab = event.target.dataset.tab;
  if (tab) {
    state.activeTab = tab;
    renderTabs();
  }

  const toggleTemplate = event.target.closest("[data-toggle-template]")?.dataset.toggleTemplate;
  if (toggleTemplate !== undefined) {
    state.openTemplateIndex = state.openTemplateIndex === Number(toggleTemplate) ? null : Number(toggleTemplate);
    renderConfigEditors();
  }

  const templateTag = event.target.dataset.templateTag;
  if (templateTag !== undefined) {
    state.templateTag = templateTag;
    renderConfigEditors();
  }

  const remove = event.target.dataset.remove;
  if (remove !== undefined) {
    state.roles.splice(Number(remove), 1);
    renderRoles();
  }

  const editEvent = event.target.dataset.editEvent;
  if (editEvent) {
    loadEventIntoForm(editEvent);
  }

  const deleteEvent = event.target.dataset.deleteEvent;
  if (deleteEvent && confirm("Supprimer cet event et le message Discord associé ?")) {
    deleteExistingEvent(deleteEvent);
  }

  const openEmojiPicker = event.target.closest("[data-open-emoji-picker]");
  if (openEmojiPicker) {
    const field = openEmojiPicker.closest(".emoji-field");
    const row = openEmojiPicker.closest(".config-row");
    state.emojiTargetInput = field?.querySelector("[data-emoji-input]") || row?.querySelector("[data-emoji-input]") || null;
    openEmojiPickerDialog();
  }

  const pickEmoji = event.target.closest("[data-picker-emoji]")?.dataset.pickerEmoji;
  if (pickEmoji && state.emojiTargetInput) {
    state.emojiTargetInput.value = pickEmoji;
    updateEmojiFieldPreview(state.emojiTargetInput);
    state.emojiTargetInput.dispatchEvent(new Event("change", { bubbles: true }));
    closeEmojiPickerDialog();
  }

  const addServerEmoji = event.target.closest("[data-add-server-emoji]")?.dataset.addServerEmoji;
  if (addServerEmoji) {
    addEmojiToPalette(addServerEmoji);
  }

  const removePaletteEmoji = event.target.dataset.removePaletteEmoji;
  if (removePaletteEmoji !== undefined) {
    state.config.emojiPalette.splice(Number(removePaletteEmoji), 1);
    renderEmojiAdmin();
    byId("configJson").value = JSON.stringify(state.config, null, 2);
  }

  const removeGroup = event.target.dataset.removeGroup;
  if (removeGroup !== undefined) {
    const group = state.config.roles[Number(removeGroup)];
    const usedByTemplate = state.config.templates.some((template) =>
      (template.roles || []).some((slot) => slot.roleId === group.id)
    );
    const usedByOption = state.config.templates.some((template) =>
      (template.signupOptions || []).some((option) => option.roleId === group.id)
    );
    if ((usedByTemplate || usedByOption) && !confirm("Ce groupe est utilisé par des templates/classes. Le supprimer peut rendre la config invalide. Continuer ?")) {
      return;
    }

    state.config.roles.splice(Number(removeGroup), 1);
    renderConfigEditors();
    readConfigEditors();
  }

  const removeClassOption = event.target.dataset.removeClassOption;
  if (removeClassOption !== undefined) {
    const option = state.config.signupOptions[Number(removeClassOption)];
    const usedByTemplate = state.config.templates.some((template) =>
      (template.signupOptions || []).some((templateOption) => templateOption.id === option.id)
    );
    if (usedByTemplate && !confirm("Cette option est utilisée par un template. La supprimer du catalogue ne la retire pas automatiquement des templates. Continuer ?")) {
      return;
    }

    state.config.signupOptions.splice(Number(removeClassOption), 1);
    renderConfigEditors();
    readConfigEditors();
  }

  const removeTemplate = event.target.dataset.removeTemplate;
  if (removeTemplate !== undefined) {
    state.config.templates.splice(Number(removeTemplate), 1);
    renderConfigEditors();
    readConfigEditors();
  }

  const addTemplateRole = event.target.dataset.addTemplateRole;
  if (addTemplateRole !== undefined) {
    const template = state.config.templates[Number(addTemplateRole)];
    const usedRoleIds = new Set((template.roles || []).map((slot) => slot.roleId));
    const availableRole = state.config.roles.find((role) => !usedRoleIds.has(role.id));
    if (!availableRole) {
      byId("status").textContent = "Tous les rôles sont déjà dans cette composition.";
      return;
    }

    template.roles.push({
      roleId: availableRole.id,
      capacity: availableRole.defaultCapacity ?? 1
    });
    renderConfigEditors();
    readConfigEditors();
  }

  const removeTemplateRole = event.target.dataset.removeTemplateRole;
  if (removeTemplateRole) {
    const [templateIndex, slotIndex] = removeTemplateRole.split(":").map(Number);
    state.config.templates[templateIndex].roles.splice(slotIndex, 1);
    renderConfigEditors();
    readConfigEditors();
  }

  const addTemplateSignupOption = event.target.dataset.addTemplateSignupOption;
  if (addTemplateSignupOption !== undefined) {
    const template = state.config.templates[Number(addTemplateSignupOption)];
    template.signupOptions = template.signupOptions || [];
    const openRoleIds = new Set((template.roles || []).map((slot) => slot.roleId));
    const usedOptionIds = new Set(template.signupOptions.map((option) => option.id));
    const catalogOption = (state.config.signupOptions || []).find((option) =>
      !usedOptionIds.has(option.id) && (openRoleIds.size === 0 || openRoleIds.has(option.roleId))
    );
    if (!catalogOption) {
      byId("status").textContent = "Toutes les options disponibles sont déjà dans ce template.";
      return;
    }

    template.signupOptions.push({
      id: catalogOption.id,
      label: catalogOption.label,
      emoji: catalogOption?.emoji || "",
      roleId: catalogOption.roleId
    });
    renderConfigEditors();
    readConfigEditors();
  }

  const removeTemplateSignupOption = event.target.dataset.removeTemplateSignupOption;
  if (removeTemplateSignupOption) {
    const [templateIndex, optionIndex] = removeTemplateSignupOption.split(":").map(Number);
    const template = state.config.templates[templateIndex];
    template.signupOptions = template.signupOptions || [];
    template.signupOptions.splice(optionIndex, 1);
    renderConfigEditors();
    readConfigEditors();
  }
});

byId("addRole").addEventListener("click", () => {
  const firstRole = state.config.roles[0];
  state.roles.push({
    roleId: firstRole.id,
    label: firstRole.label,
    emoji: firstRole.emoji,
    capacity: firstRole.defaultCapacity ?? 1
  });
  renderRoles();
});

byId("refreshEvents").addEventListener("click", loadEvents);
byId("resetForm").addEventListener("click", resetEventForm);
byId("toggleCompositionEditor").addEventListener("click", () => {
  state.compositionEditorOpen = !state.compositionEditorOpen;
  renderRoles();
});
byId("loadDiscordOptions").addEventListener("click", loadDiscordOptions);
byId("closeEmojiPicker").addEventListener("click", closeEmojiPickerDialog);
byId("emojiSearch").addEventListener("input", renderEmojiPickerList);
byId("saveConfig").addEventListener("click", () => saveConfig(false));
byId("saveTemplatesConfig").addEventListener("click", () => saveConfig(true));
byId("saveClassesConfig").addEventListener("click", () => saveConfig(true));
byId("saveEmojisConfig").addEventListener("click", () => saveConfig(true));
byId("refreshEmojiSources").addEventListener("click", loadDiscordOptions);
byId("serverEmojiSearch").addEventListener("input", renderEmojiAdmin);
byId("addEmojiToPalette").addEventListener("click", () => {
  addEmojiToPalette(byId("newEmojiValue").value);
  byId("newEmojiValue").value = "";
});
byId("createEmojiFromImage").addEventListener("click", createEmojiFromImage);
byId("newEmojiValue").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addEmojiToPalette(event.target.value);
    event.target.value = "";
  }
});
byId("closeTemplateCreateModal").addEventListener("click", closeTemplateCreateModal);
byId("cancelTemplateCreate").addEventListener("click", closeTemplateCreateModal);
byId("templateCreateForm").addEventListener("submit", createTemplateFromModal);
byId("addGroup").addEventListener("click", () => {
  state.config.roles.push({
    id: "nouveau_groupe",
    label: "Nouveau groupe",
    emoji: "",
    defaultCapacity: 1
  });
  renderConfigEditors();
  readConfigEditors();
});
byId("addClassOption").addEventListener("click", () => {
  const firstRole = state.config.roles[0];
  state.config.signupOptions = state.config.signupOptions || [];
  state.config.signupOptions.push({
    id: "nouvelle_option",
    label: "Nouvelle option",
    emoji: "",
    roleId: firstRole?.id || ""
  });
  renderConfigEditors();
  readConfigEditors();
});
byId("addTemplate").addEventListener("click", openTemplateCreateModal);
byId("templateSearch").addEventListener("input", (event) => {
  state.templateSearch = event.target.value.trim();
  renderConfigEditors();
});
byId("eventForm").elements.leaderUserId.addEventListener("input", (event) => {
  clearTimeout(state.leaderSearchTimeout);
  state.leaderSearchTimeout = setTimeout(() => {
    searchLeaderSuggestions(event.target.value);
  }, 250);
});
byId("logoutAdmin").addEventListener("click", () => {
  fetch("/api/auth/logout", { method: "POST" }).finally(() => {});
  state.user = null;
  setAuthenticated(false);
  byId("status").textContent = "Déconnecté.";
});

byId("eventForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  readRolesFromDom();
  const form = new FormData(event.target);
  const payload = Object.fromEntries(form.entries());
  payload.roles = state.roles;
  payload.signupOptions = state.eventSignupOptions || [];
  payload.links = readJsonTextarea("linksJson", []);
  payload.allowedRoleIds = state.discordOptions.roles.length > 0
    ? [...document.querySelectorAll("#allowedRolesEditor input:checked")].map((input) => input.value)
    : state.allowedRoleIds;
  delete payload.linksJson;

  byId("status").textContent = state.editingEventId ? "Modification en cours..." : "Création en cours...";
  const response = await fetch(state.editingEventId ? `/api/events/${state.editingEventId}` : "/api/events", {
    method: state.editingEventId ? "PUT" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers()
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  byId("status").textContent = response.ok
    ? `Annonce enregistrée: ${result.discordUrl ?? result.id}`
    : `Erreur: ${result.error}`;
  if (response.ok) {
    setFormMode(result.id);
    await loadEvents();
  }
});

loadConfig()
  .then(async () => {
    const auth = await loadAuthState();
    if (auth.authenticated) {
      try {
        await authenticate();
        const name = auth.user?.globalName || auth.user?.username || "Discord";
        if (!byId("status").textContent.startsWith("Connecté.")) {
          byId("status").textContent = `Connecté: ${name}`;
        }
      } catch (error) {
        state.user = null;
        setAuthenticated(false);
        byId("status").textContent = `Session expirée: ${error.message}`;
      }
    }
  })
  .catch((error) => {
    byId("status").textContent = `Impossible de charger la config: ${error.message}`;
  });
