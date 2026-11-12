/** Per-chat scene state. Public reads and writes use detached snapshots. */
import { boundedInteger, getSettings } from "./settings.js";

export const STATE_KEY = "st_state_manager";
export const COUNTER_KEY = "st_state_manager_counter";
export const STATE_VERSION = 1;
const listeners = new Set();
let stopHooks = null;

export function isStateObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const isStateData = value => typeof value === "string" || isStateObject(value) || Array.isArray(value);
export const dataText = data => typeof data === "string" ? data : JSON.stringify(data, null, 2);
export const stateText = state => typeof state.text === "string" ? state.text : dataText(state.data);

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
    data: isStateData(raw.data) ? structuredClone(raw.data) : {},
    ...(typeof raw.text === "string" ? { text: raw.text } : {}),
    ...(typeof raw.trigger === "string" ? { trigger: raw.trigger } : {}),
    history: Array.isArray(raw.history) ? raw.history
      .filter(entry => isStateObject(entry) && isStateData(entry.data)
        && Number.isInteger(entry.revision) && entry.revision > 0 && entry.revision < revision)
      .map(entry => ({ revision: entry.revision, updatedAt: Number(entry.updatedAt) || 0,
        data: structuredClone(entry.data), trigger: String(entry.trigger || "manual"),
        ...(typeof entry.text === "string" ? { text: entry.text } : {}) })) : [],
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

export function setState(data, { merge = false, trigger = "manual", text } = {}) {
  if (!isStateData(data)) throw new Error("State must be text, an object or an array");
  const snapshot = JSON.parse(JSON.stringify(data));
  if (!isStateData(snapshot)) throw new Error("State must serialize to text, an object or an array");
  const ctx = activeContext();
  const current = getState();
  const limit = boundedInteger(getSettings().historyLimit, 50, 0, 200);
  const history = current.history;
  if (current.revision > 0) history.push({ revision: current.revision,
    updatedAt: current.updatedAt, data: current.data, trigger: current.trigger || "manual",
    ...(typeof current.text === "string" ? { text: current.text } : {}) });
  if (merge && (!isStateObject(current.data) || !isStateObject(snapshot))) throw new Error("Only objects can be merged");
  const next = {
    version: STATE_VERSION,
    revision: current.revision + 1,
    updatedAt: Date.now(),
    data: merge ? { ...current.data, ...snapshot } : snapshot,
    ...(typeof text === "string" && !merge ? { text } : {}),
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
  return setState(entry.data, { trigger: "rollback", text: entry.text });
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
  let parsed = json;
  if (typeof json === "string") { try { parsed = JSON.parse(json); } catch { /* Plain text state. */ } }
  const document = isStateObject(parsed) && Object.hasOwn(parsed, "version") && Object.hasOwn(parsed, "data");
  return setState(document ? parsed.data : parsed, { trigger: "import", text: document ? parsed.text : undefined });
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
  if (stopHooks) return stopHooks;
  const ctx = SillyTavern.getContext();
  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, notifyStateChanged);
  stopHooks = () => {
    ctx.eventSource.removeListener(ctx.eventTypes.CHAT_CHANGED, notifyStateChanged);
    stopHooks = null;
  };
  return stopHooks;
}
