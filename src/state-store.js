/** Per-chat scene state. Public reads and writes use detached snapshots. */
import { boundedInteger, getSettings } from "./settings.js";

export const STATE_KEY = "st_state_manager";
export const COUNTER_KEY = "st_state_manager_counter";
export const STATE_VERSION = 1;
const listeners = new Set();
let hooksInitialized = false;

export function isStateObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptyState() {
  return { version: STATE_VERSION, revision: 0, updatedAt: 0, data: {}, history: [] };
}

function normalize(raw) {
  if (!isStateObject(raw)) return emptyState();
  const revision = boundedInteger(raw.revision, 0, 0, Number.MAX_SAFE_INTEGER);
  return {
    version: STATE_VERSION,
    revision,
    updatedAt: Number(raw.updatedAt) || 0,
    data: isStateObject(raw.data) ? structuredClone(raw.data) : {},
    ...(typeof raw.trigger === "string" ? { trigger: raw.trigger } : {}),
    history: Array.isArray(raw.history) ? raw.history
      .filter(entry => isStateObject(entry) && isStateObject(entry.data)
        && Number.isInteger(entry.revision) && entry.revision > 0 && entry.revision < revision)
      .map(entry => ({ revision: entry.revision, updatedAt: Number(entry.updatedAt) || 0,
        data: structuredClone(entry.data), trigger: String(entry.trigger || "manual") })) : [],
  };
}

function activeContext() {
  const ctx = SillyTavern.getContext();
  if (!ctx.getCurrentChatId?.() || !ctx.chatMetadata) throw new Error("No active chat");
  return ctx;
}

export function getState() {
  return normalize(SillyTavern.getContext().chatMetadata?.[STATE_KEY]);
}

/** History contains previous revisions; the current revision lives at the root. */
export function getHistory() {
  return getState().history;
}

export function setState(data, { merge = false, trigger = "manual" } = {}) {
  if (!isStateObject(data)) throw new Error("State must be a JSON object");
  const snapshot = JSON.parse(JSON.stringify(data));
  if (!isStateObject(snapshot)) throw new Error("State must serialize to a JSON object");
  const ctx = activeContext();
  const current = getState();
  const limit = boundedInteger(getSettings().historyLimit, 50, 0, 200);
  const history = current.history;
  if (current.revision > 0) history.push({ revision: current.revision,
    updatedAt: current.updatedAt, data: current.data, trigger: current.trigger || "manual" });
  const next = {
    version: STATE_VERSION,
    revision: current.revision + 1,
    updatedAt: Date.now(),
    data: merge ? { ...current.data, ...snapshot } : snapshot,
    trigger,
    history: limit ? history.slice(-limit) : [],
  };
  ctx.chatMetadata[STATE_KEY] = next;
  ctx.saveMetadataDebounced();
  notifyStateChanged();
  return getState();
}

export function updateState(patch) {
  return setState(patch, { merge: true });
}

export function rollbackTo(revision) {
  const entry = getHistory().find(item => item.revision === Number(revision));
  if (!entry) throw new Error("This revision is no longer in the history");
  return setState(entry.data, { trigger: "rollback" });
}

export function resetState() {
  const ctx = activeContext();
  delete ctx.chatMetadata[STATE_KEY];
  delete ctx.chatMetadata[COUNTER_KEY];
  ctx.saveMetadataDebounced();
  notifyStateChanged();
  return getState();
}

export function exportState() {
  return JSON.stringify(getState(), null, 2);
}

export function importState(json) {
  const parsed = typeof json === "string" ? JSON.parse(json) : json;
  if (!isStateObject(parsed)) throw new Error("Invalid state document");
  return setState(Object.hasOwn(parsed, "version") && Object.hasOwn(parsed, "data")
    ? parsed.data : parsed, { trigger: "import" });
}

export function subscribeState(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyStateChanged() {
  for (const listener of listeners) {
    try { listener(getState()); }
    catch (error) { console.error("[ST-State-Manager] State listener failed", error); }
  }
}

export function initStateHooks() {
  if (hooksInitialized) return;
  hooksInitialized = true;
  const ctx = SillyTavern.getContext();
  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => notifyStateChanged());
}
