/**
 * ST-State-Manager — settings panel.
 *
 * The panel is rendered from `settings.html` into the third-party column of the
 * Extensions drawer and wired to the settings store, the model client and the
 * chat state store.
 */

import { DEFAULT_PROMPT, DEFAULT_SETTINGS, getSettings, isEnabled, loadSettings, updateSetting } from "./settings.js";
import { confirmReset, initPanel, runManualUpdate } from "./panel.js";
import { getWorkerStatus, subscribeWorker } from "./worker.js";
import {
  describeError,
  fetchModels,
  getMainApiModel,
  getProfile,
  getSupportedProfiles,
  isConnectionManagerAvailable,
  resolveModel,
  runTestRequest,
} from "./llm-client.js";
import { getState, subscribeState } from "./state-store.js";

const LOG_PREFIX = "[ST-State-Manager]";
const TEMPLATE_EXTENSION = "third-party/ST-State-Manager";
const TEMPLATE_ID = "settings";
const MAX_INIT_ATTEMPTS = 40;
const MIN_TOKENS = 16;
const MAX_TOKENS = 8192;

/** @type {ReturnType<typeof getSettings> | null} */
let settings = null;
let uiInitialized = false;
/** @type {Promise<void> | null} */
let initPromise = null;
let initAttempts = 0;
let modelRequestId = 0;
let lastModelListKey = "";
let lastModelListAt = 0;

function context() {
  return SillyTavern.getContext();
}

/**
 * Appends the settings template once the Extensions panel is available.
 * Safe to call from several events: concurrent calls share one promise.
 * @returns {Promise<void>}
 */
export function initSettingsUI() {
  if (uiInitialized) {
    refreshDynamic();
    return Promise.resolve();
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = doInit().finally(() => {
    initPromise = null;
  });

  return initPromise;
}

/**
 * @returns {Promise<void>}
 */
async function doInit() {
  if (document.getElementById("stsm_settings")) {
    markReady();
    return;
  }

  const container =
    document.getElementById("extensions_settings2") ??
    document.getElementById("extensions_settings");

  if (!container) {
    scheduleRetry();
    return;
  }

  try {
    const html = await context().renderExtensionTemplateAsync(
      TEMPLATE_EXTENSION,
      TEMPLATE_ID,
    );
    // The panel could have been added by a concurrent call while we were awaiting.
    if (!document.getElementById("stsm_settings")) {
      container.insertAdjacentHTML("beforeend", html);
    }
    markReady();
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to render the settings panel`, error);
    scheduleRetry();
  }
}

function scheduleRetry() {
  if (initAttempts >= MAX_INIT_ATTEMPTS) {
    console.warn(`${LOG_PREFIX} Settings container was not found, giving up`);
    return;
  }
  initAttempts += 1;
  setTimeout(() => {
    void initSettingsUI();
  }, 250);
}

function markReady() {
  uiInitialized = true;
  settings = loadSettings();
  bindSettings();
  renderAll();
  initPanel();
}

/**
 * Refreshes data that can change after the panel was first rendered
 * (profiles, current model, chat state).
 */
function refreshDynamic() {
  if (!uiInitialized) {
    return;
  }
  settings = getSettings();
  renderProfiles();
  updateHints();
  renderChatState();
  void refreshModelList();
}

function bindSettings() {
  const $panel = $("#stsm_settings");
  if ($panel.data("stsm-bound")) {
    return;
  }
  $panel.data("stsm-bound", true);

  $("#stsm_enabled").on("change", function () {
    updateSetting("enabled", Boolean($(this).prop("checked")));
    applyEnabledState();
  });

  $("#stsm_profile").on("change", function () {
    updateSetting("profileId", String($(this).val() ?? ""));
    updateHints();
    void refreshModelList();
  });

  $("#stsm_model").on("input change", function () {
    updateSetting("model", String($(this).val() ?? ""));
    updateHints();
  });

  $("#stsm_refresh_models").on("click", () => {
    void refreshModelList({ force: true });
  });

  $("#stsm_max_tokens").on("input change", function () {
    updateSetting("maxTokens", clampTokens(Number($(this).val())));
  });

  $("#stsm_temperature").on("input change", function () {
    const raw = String($(this).val() ?? "").trim();
    const value = raw === "" ? null : Number(raw);
    updateSetting("temperature", Number.isFinite(value) ? clampTemperature(Number(value)) : null);
  });

  $("#stsm_include_preset").on("change", function () {
    updateSetting("includePreset", Boolean($(this).prop("checked")));
  });

  $("#stsm_settings [data-stsm-setting]").on("change", function () {
    const key = this.dataset.stsmSetting;
    const value = this.type === "checkbox" ? this.checked : this.type === "number" ? Number(this.value) : this.value;
    const saved = updateSetting(key, value);
    if (this.type !== "checkbox") this.value = String(saved);
    applyEnabledState();
  });
  $("#stsm_promptTemplate").on("input", function () { updateSetting("promptTemplate", this.value); });
  $("#stsm_restore_prompt").on("click", () => {
    updateSetting("promptTemplate", DEFAULT_PROMPT);
    $("#stsm_promptTemplate").val(DEFAULT_PROMPT);
  });
  $("#stsm_manual_update").on("click", () => void runManualUpdate());
  subscribeWorker(() => {
    const worker = getWorkerStatus();
    $("#stsm_worker_status").text(worker.message);
    $("#stsm_manual_update").prop("disabled", !isEnabled() || worker.status === "running");
  });

  $("#stsm_test_run").on("click", () => {
    void runTest();
  });

  $("#stsm_state_reset").on("click", () => void confirmReset());

  subscribeState(() => renderChatState());
}

/**
 * Fills static controls from the settings object.
 */
function renderAll() {
  renderStatic();
  renderProfiles();
  updateHints();
  renderChatState();
  applyEnabledState();
  void refreshModelList();
}

function renderStatic() {
  $("#stsm_enabled").prop("checked", settings.enabled !== false);
  $("#stsm_model").val(String(settings.model ?? ""));
  $("#stsm_max_tokens").val(Number(settings.maxTokens) || DEFAULT_SETTINGS.maxTokens);
  $("#stsm_temperature").val(
    settings.temperature === null || settings.temperature === undefined
      ? ""
      : String(settings.temperature),
  );
  $("#stsm_include_preset").prop("checked", settings.includePreset !== false);
  for (const input of document.querySelectorAll("#stsm_settings [data-stsm-setting]")) {
    const value = settings[input.dataset.stsmSetting];
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = String(value ?? "");
  }
  $("#stsm_worker_status").text(getWorkerStatus().message);
}

function renderProfiles() {
  const $select = $("#stsm_profile");
  const available = isConnectionManagerAvailable();
  const current = String(settings.profileId ?? "");

  $select.empty();
  $select.append(new Option("Main SillyTavern connection", ""));

  const profiles = available
    ? getSupportedProfiles()
      .slice()
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")))
    : [];

  for (const profile of profiles) {
    const option = new Option(profile.name || profile.id, profile.id);
    option.title = [profile.api, profile.model].filter(Boolean).join(" · ");
    $select.append(option);
  }

  if (current && !profiles.some((profile) => profile.id === current)) {
    // Keep a missing profile selected: never silently switch paid background
    // requests to the main connection when a profile disappears.
    $select.append(new Option(`Unavailable profile: ${current}`, current));
    $select.val(current);
  } else {
    $select.val(current);
  }

  $select.prop("disabled", !available || !isEnabled());
  $("#stsm_cm_warning").prop("hidden", available);
  $("#stsm_profile_hint").text(
    available
      ? profiles.length
        ? `${profiles.length} supported profile(s). The profile decides the API, endpoint, secret and preset.`
        : "No supported profiles yet. Create one in Extensions → Connection Manager."
      : "Connection Manager is disabled, so only the main connection can be used.",
  );

  return profiles;
}

/**
 * Updates the "effective model" and backend hints.
 */
function updateHints() {
  const profile = getProfile(settings.profileId);
  const fallback = settings.profileId
    ? String(profile?.model ?? "")
    : String(getMainApiModel() ?? "");
  const effective = resolveModel(settings.profileId, settings.model);

  $("#stsm_model").attr(
    "placeholder",
    fallback ? `Default: ${fallback}` : "Default model",
  );
  $("#stsm_model_hint").text(
    effective
      ? `Effective model: ${effective}`
      : "No model resolved — type a model id or refresh the list.",
  );

  const backend = settings.profileId
    ? `Profile: ${profile?.name || settings.profileId} · API: ${profile?.api || "unknown"}`
    : "Main SillyTavern connection (chat completion only)";
  $("#stsm_backend_hint").text(backend);
}

/**
 * Loads model ids into the datalist of the model input.
 * @param {{ force?: boolean }} [options] Force a reload even if the list was
 * fetched recently for the same profile.
 * @returns {Promise<void>}
 */
async function refreshModelList({ force = false } = {}) {
  const profileKey = String(settings.profileId ?? "");
  if (!force && profileKey === lastModelListKey && Date.now() - lastModelListAt < 10000) {
    return;
  }
  lastModelListKey = profileKey;
  lastModelListAt = Date.now();

  const requestId = ++modelRequestId;
  const $status = $("#stsm_model_status");
  const $button = $("#stsm_refresh_models");

  $status.text("Loading model list…");
  $button.prop("disabled", true);

  try {
    const { models, error } = await fetchModels(settings.profileId);
    if (requestId !== modelRequestId) {
      return;
    }

    const datalist = document.getElementById("stsm_model_list");
    datalist?.replaceChildren();
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.id;
      if (model.name && model.name !== model.id) {
        option.label = model.name;
      }
      datalist?.append(option);
    }

    $status.text(
      error
        ? `Model list unavailable: ${error}. You can still type the model id.`
        : `${models.length} model(s) loaded`,
    );
  } catch (error) {
    if (requestId === modelRequestId) {
      console.warn(`${LOG_PREFIX} Model list request failed`, error);
      $status.text(`Model list unavailable: ${describeError(error)}. You can still type the model id.`);
    }
  } finally {
    if (requestId === modelRequestId) {
      $button.prop("disabled", !isEnabled());
    }
  }
}

/**
 * Renders the state document of the current chat.
 */
function renderChatState() {
  try {
    const state = getState();
    const stamp = state.updatedAt
      ? ` · ${new Date(state.updatedAt).toLocaleString()}`
      : "";
    $("#stsm_state_info").text(
      state.revision ? `revision ${state.revision}${stamp}` : "empty",
    );
    $("#stsm_state_preview").text(JSON.stringify(state.data, null, 2));
  } catch (error) {
    console.warn(`${LOG_PREFIX} Could not read the chat state`, error);
    $("#stsm_state_info").text("unavailable");
    $("#stsm_state_preview").text("");
  }
}

/**
 * Enables/disables the panel controls according to the master switch.
 */
function applyEnabledState() {
  const enabled = isEnabled();
  $("#stsm_body")
    .find("input, select, textarea, button")
    .prop("disabled", !enabled);
  $("#stsm_settings").toggleClass("stsm-disabled", !enabled);

  if (enabled && !isConnectionManagerAvailable()) {
    $("#stsm_profile").prop("disabled", true);
  }
  $("#stsm_manual_update").prop("disabled", !enabled || getWorkerStatus().status === "running");
  $("#stsm_injectRole, #stsm_injectDepth").prop("disabled", !enabled || Number(settings.injectPosition) !== 1);
  $("#stsm_injectMerge").prop("disabled", !enabled || Number(settings.injectPosition) !== 1 || settings.injectRole === "system");
}

/**
 * Sends one test request with the current settings.
 */
async function runTest() {
  if (!isEnabled()) {
    return;
  }

  const prompt = String($("#stsm_test_prompt").val() ?? "").trim();
  if (!prompt) {
    toastr.warning("Enter a prompt for the test request first.", "ST-State-Manager");
    return;
  }

  const $output = $("#stsm_test_output");
  const $button = $("#stsm_test_run");

  $button.prop("disabled", true);
  $output.text("Waiting for the model…");

  try {
    const result = await runTestRequest(prompt);
    /** @type {string[]} */
    const lines = [
      `backend: ${result.backend}${result.profileId ? ` (${result.profileId})` : ""}`,
      `model: ${result.model || "(default)"}`,
      `elapsed: ${result.elapsedMs} ms`,
    ];
    if (result.reasoning) {
      lines.push("", "--- reasoning ---", result.reasoning);
    }
    lines.push("", "--- content ---", result.content || "(empty response)");
    $output.text(lines.join("\n"));
  } catch (error) {
    console.error(`${LOG_PREFIX} Test request failed`, error);
    const message = describeError(error);
    $output.text(`Error: ${message}`);
    toastr.error(message, "ST-State-Manager");
  } finally {
    $button.prop("disabled", !isEnabled());
  }
}

/**
 * @param {number} value
 * @returns {number}
 */
function clampTokens(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_SETTINGS.maxTokens;
  }
  return Math.min(Math.max(Math.floor(value), MIN_TOKENS), MAX_TOKENS);
}

/**
 * @param {number} value
 * @returns {number}
 */
function clampTemperature(value) {
  return Math.min(Math.max(value, 0), 2);
}
