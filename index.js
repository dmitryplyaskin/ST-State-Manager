/**
 * ST-State-Manager
 * Extension entry point.
 *
 * Responsibilities of this file:
 *  - load persisted settings;
 *  - initialize the settings panel when SillyTavern is ready;
 *  - register the extension event hooks.
 *
 * All model calls live in `src/llm-client.js`, the per-chat state lives in
 * `src/state-store.js`, and the settings panel is rendered by `src/ui.js`.
 */

import { loadSettings } from "./src/settings.js";
import { initStateHooks } from "./src/state-store.js";
import { initSettingsUI } from "./src/ui.js";

const LOG_PREFIX = "[ST-State-Manager]";

let initialized = false;

/**
 * Initializes the extension. Safe to call multiple times.
 */
function init() {
  if (initialized) {
    return;
  }
  initialized = true;

  const context = SillyTavern.getContext();

  loadSettings();
  initStateHooks();

  // The extensions panel is built after the app is ready; the settings panel
  // template can only be appended once its container exists.
  context.eventSource.on(context.eventTypes.APP_READY, () => {
    void initSettingsUI();
  });
  context.eventSource.on(context.eventTypes.EXTENSION_SETTINGS_LOADED, () => {
    void initSettingsUI();
  });

  // A hot reload can happen after APP_READY, so try immediately as well.
  void initSettingsUI();

  console.log(`${LOG_PREFIX} Extension initialized`);
}

try {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(init, 0));
  } else {
    setTimeout(init, 0);
  }
} catch (error) {
  console.error(`${LOG_PREFIX} Initialization failed`, error);
}
