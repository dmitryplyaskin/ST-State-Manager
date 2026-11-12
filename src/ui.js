/** The Extensions entry contains only the master switch. */
import { getSettings, isEnabled, loadSettings, subscribeSettings, updateSetting } from "./settings.js";
import { destroyPanel, initPanel } from "./panel.js";
import { initRuntime } from "./runtime.js";

let initialization = null;
let attempts = 0;
let bound = false;

function refreshMasterSwitch() {
  const input = document.getElementById("stsm_enabled");
  if (input) input.checked = getSettings().enabled;
}

async function syncEnabled() {
  refreshMasterSwitch();
  if (isEnabled()) await initPanel();
  else destroyPanel();
}

export function initSettingsUI() {
  if (initialization) return initialization;
  initialization = initialize().catch(error => {
    console.error("[ST-State-Manager] Interface initialization failed", error);
    retry();
  }).finally(() => { initialization = null; });
  return initialization;
}

function retry() {
  if (attempts++ < 40) setTimeout(() => void initSettingsUI(), 250);
}

async function initialize() {
  const ctx = SillyTavern.getContext();
  const container = document.getElementById("extensions_settings2") || document.getElementById("extensions_settings");
  if (!container) { retry(); return; }
  loadSettings();
  initRuntime();
  if (!document.getElementById("stsm_settings")) {
    container.insertAdjacentHTML("beforeend", await ctx.renderExtensionTemplateAsync("third-party/ST-State-Manager", "settings"));
  }
  if (!bound) {
    bound = true;
    document.getElementById("stsm_enabled").addEventListener("change", event => updateSetting("enabled", event.target.checked));
    subscribeSettings(key => {
      if (key === "enabled" || key === null) void syncEnabled().catch(console.error);
    });
  }
  await syncEnabled();
}
