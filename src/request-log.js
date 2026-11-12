/** Per-chat diagnostics, independent of state revisions. Never store credentials. */
export const REQUEST_LOG_KEY = "st_state_manager_requests";
const listeners = new Set();
const LIMIT = 10;
const live = new Set();
const privateKey = /^(authorization|proxy_password|password|api[_-]?key|secret[_-]?id|custom_include_headers|headers)$/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, privateKey.test(key) ? "[скрыто]" : redact(item)]));
  return value;
}

export function getRequestLog() {
  const ctx = SillyTavern.getContext();
  const entries = ctx.getCurrentChatId?.() && ctx.chatMetadata?.[REQUEST_LOG_KEY] || [];
  return structuredClone(entries.map(entry => entry.status === "running" && !live.has(entry.id)
    ? { ...entry, status: "interrupted" } : entry));
}

export function subscribeRequests(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function beginRequest(request) {
  const ctx = SillyTavern.getContext();
  const metadata = ctx.getCurrentChatId?.() ? ctx.chatMetadata : null;
  const entry = { id: globalThis.crypto.randomUUID(), startedAt: Date.now(), status: "running", request: redact(request) };
  live.add(entry.id);
  if (metadata) metadata[REQUEST_LOG_KEY] = [entry, ...(metadata[REQUEST_LOG_KEY] || [])].slice(0, LIMIT);
  const update = patch => {
    Object.assign(entry, redact(patch));
    if (entry.status !== "running") live.delete(entry.id);
    if (metadata && SillyTavern.getContext().chatMetadata === metadata) {
      ctx.saveMetadataDebounced();
      for (const listener of listeners) {
        try { listener(); }
        catch (error) { console.error("[ST-State-Manager] Request log listener failed", error); }
      }
    }
  };
  update({});
  return update;
}
