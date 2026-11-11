/**
 * ST-State-Manager — settings storage.
 *
 * The settings object lives in `extension_settings.st_state_manager` and is
 * persisted by SillyTavern in the user's settings.json. Every mutation goes
 * through `saveSettingsDebounced()` so changes survive a page reload.
 */

export const SETTINGS_KEY = "st_state_manager";

/**
 * @typedef {object} StateManagerSettings
 * @property {boolean} enabled Master switch.
 * @property {string} profileId Connection Manager profile id; "" = main connection.
 * @property {string} model Model override; "" = model from profile / main connection.
 * @property {number} maxTokens Maximum number of tokens for one call.
 * @property {number | null} temperature Sampling temperature; null = keep the preset value.
 * @property {boolean} includePreset Apply the profile's generation preset.
 * @property {boolean} stream Use streaming responses.
 */

/** @type {Readonly<StateManagerSettings>} */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  profileId: "",
  model: "",
  maxTokens: 512,
  temperature: null,
  includePreset: true,
  stream: false,
});

function context() {
  return SillyTavern.getContext();
}

/**
 * Ensures the settings object exists and contains all default keys.
 * @returns {StateManagerSettings}
 */
export function loadSettings() {
  const { extensionSettings, saveSettingsDebounced } = context();

  let settings = extensionSettings[SETTINGS_KEY];
  let changed = false;

  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    settings = structuredClone(DEFAULT_SETTINGS);
    extensionSettings[SETTINGS_KEY] = settings;
    changed = true;
  }

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(key in settings)) {
      settings[key] = value;
      changed = true;
    }
  }

  if (changed) {
    saveSettingsDebounced();
  }

  return settings;
}

/**
 * Returns the live settings object.
 * @returns {StateManagerSettings}
 */
export function getSettings() {
  const { extensionSettings } = context();
  const settings = extensionSettings[SETTINGS_KEY];
  if (!settings || typeof settings !== "object") {
    return loadSettings();
  }
  return settings;
}

/**
 * Persists settings after a mutation made by the caller.
 */
export function saveSettings() {
  context().saveSettingsDebounced();
}

/**
 * Updates a single setting and schedules a save.
 * @template {keyof StateManagerSettings} K
 * @param {K} key
 * @param {StateManagerSettings[K]} value
 * @returns {StateManagerSettings[K]}
 */
export function updateSetting(key, value) {
  const settings = getSettings();
  settings[key] = value;
  saveSettings();
  return value;
}

/**
 * @returns {boolean}
 */
export function isEnabled() {
  return getSettings().enabled !== false;
}

/**
 * Resets the extension settings to their defaults.
 */
export function resetSettings() {
  const { extensionSettings, saveSettingsDebounced } = context();
  extensionSettings[SETTINGS_KEY] = structuredClone(DEFAULT_SETTINGS);
  saveSettingsDebounced();
}
