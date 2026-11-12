/** Attach chat processing only while the master switch is on. */
import { isEnabled, subscribeSettings } from "./settings.js";
import { initStateHooks } from "./state-store.js";
import { initWorkerHooks } from "./worker.js";
import { initInjector } from "./injector.js";

let initialized = false;
let cleanups = [];

function sync() {
  if (isEnabled()) {
    if (!cleanups.length) cleanups = [initStateHooks(), initWorkerHooks(), initInjector()];
  } else {
    for (const cleanup of cleanups.reverse()) cleanup();
    cleanups = [];
  }
}

export function initRuntime() {
  if (!initialized) {
    initialized = true;
    subscribeSettings(key => { if (key === "enabled" || key === null) sync(); });
  }
  sync();
}
