/**
 * ST-State-Manager — per-chat state storage.
 *
 * The state document is stored in `chat_metadata.st_state_manager`, so it is
 * saved together with the chat file and travels with exports/backups.
 *
 * Shape of the document:
 * {
 *   version: 1,
 *   revision: 0,        // incremented on every write
 *   updatedAt: 0,       // unix timestamp in ms
 *   data: {}            // the actual state; the schema is up to the feature
 * }
 *
 * This module is intentionally schema-agnostic: extraction prompts, schema
 * validation and prompt injection can be built on top of it later.
 */

const LOG_PREFIX = "[ST-State-Manager]";

export const STATE_KEY = "st_state_manager";
export const STATE_VERSION = 1;

/** @type {Set<(state: StateDocument) => void>} */
const listeners = new Set();

/**
 * @typedef {object} StateDocument
 * @property {number} version
 * @property {number} revision
 * @property {number} updatedAt
 * @property {Record<string, unknown>} data
 */

function context() {
  return SillyTavern.getContext();
}

/**
 * @returns {StateDocument}
 */
function createEmptyState() {
  return { version: STATE_VERSION, revision: 0, updatedAt: 0, data: {} };
}

/**
 * @param {unknown} raw
 * @returns {StateDocument}
 */
function normalize(raw) {
  const state = createEmptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return state;
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  state.version = Number(record.version) || STATE_VERSION;
  state.revision = Number(record.revision) || 0;
  state.updatedAt = Number(record.updatedAt) || 0;
  state.data =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? /** @type {Record<string, unknown>} */ (record.data)
      : {};
  return state;
}

/**
 * Returns the state document of the current chat.
 * @returns {StateDocument}
 */
export function getState() {
  const metadata = context().chatMetadata;
  return normalize(metadata?.[STATE_KEY]);
}

/**
 * Replaces (or shallow-merges) the state data of the current chat.
 * @param {Record<string, unknown>} data
 * @param {{ merge?: boolean }} [options]
 * @returns {StateDocument}
 */
export function setState(data, { merge = false } = {}) {
  const ctx = context();
  if (!ctx.getCurrentChatId?.()) {
    throw new Error("No active chat");
  }

  const metadata = ctx.chatMetadata;
  const current = normalize(metadata[STATE_KEY]);
  const nextData = merge ? { ...current.data, ...data } : data;

  /** @type {StateDocument} */
  const next = {
    version: STATE_VERSION,
    revision: current.revision + 1,
    updatedAt: Date.now(),
    data: nextData && typeof nextData === "object" && !Array.isArray(nextData) ? nextData : {},
  };

  metadata[STATE_KEY] = next;
  ctx.saveMetadataDebounced();
  notifyStateChanged(next);
  return next;
}

/**
 * Shallow-merges a patch into the current state data.
 * @param {Record<string, unknown>} patch
 * @returns {StateDocument}
 */
export function updateState(patch) {
  return setState(patch, { merge: true });
}

/**
 * Removes the state document from the current chat.
 * @returns {StateDocument}
 */
export function resetState() {
  const ctx = context();
  const metadata = ctx.chatMetadata;
  if (metadata && Object.hasOwn(metadata, STATE_KEY)) {
    delete metadata[STATE_KEY];
    ctx.saveMetadataDebounced();
  }
  const state = createEmptyState();
  notifyStateChanged(state);
  return state;
}

/**
 * @returns {string} Pretty-printed state JSON.
 */
export function exportState() {
  return JSON.stringify(getState(), null, 2);
}

/**
 * Replaces the state from a JSON document produced by `exportState()`.
 * @param {string | Record<string, unknown>} json
 * @returns {StateDocument}
 */
export function importState(json) {
  const parsed = typeof json === "string" ? JSON.parse(json) : json;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid state document");
  }
  const record = /** @type {Record<string, unknown>} */ (parsed);
  const data =
    record.data && typeof record.data === "object" ? record.data : record;
  return setState(/** @type {Record<string, unknown>} */ (data));
}

/**
 * Subscribes to state changes.
 * @param {(state: StateDocument) => void} listener
 * @returns {() => void} Unsubscribe function.
 */
export function subscribeState(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Notifies subscribers about a state change.
 * @param {StateDocument} [state] State to broadcast; read from the chat when omitted.
 */
export function notifyStateChanged(state) {
  const value = state ?? getState();
  for (const listener of listeners) {
    try {
      listener(value);
    } catch (error) {
      console.error(`${LOG_PREFIX} State listener failed`, error);
    }
  }
}

/**
 * Registers extension event hooks. Called once from `index.js`.
 */
export function initStateHooks() {
  const ctx = context();
  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
    notifyStateChanged();
  });
}
