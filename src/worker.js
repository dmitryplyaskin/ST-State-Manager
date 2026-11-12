/** Independent, non-streaming state extraction and chat-event scheduling. */
import { boundedInteger, getSettings, isEnabled, subscribeSettings } from "./settings.js";
import { describeError, generate } from "./llm-client.js";
import { COUNTER_KEY, STATE_KEY, getState, isStateObject, setState, subscribeState } from "./state-store.js";

const listeners = new Set();
const countedMessages = new WeakSet();
const REQUEST_TIMEOUT_MS = 120000;
let active = null;
let generation = null;
let initialized = false;
let status = { status: "idle", message: "Ready", trigger: "", elapsedMs: 0, response: "" };

function publish(next) {
  status = { ...status, ...next };
  for (const listener of listeners) {
    try { listener(getWorkerStatus()); }
    catch (error) { console.error("[ST-State-Manager] Worker listener failed", error); }
  }
}

export function getWorkerStatus() { return { ...status }; }
export function subscribeWorker(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function renderTemplate(template, variables) {
  return String(template).replace(/\{\{\s*(last_messages|state|history|chat_name|char_name)\s*\}\}/g,
    (_, name) => String(variables[name] ?? ""));
}

export function buildWorkerPrompt(ctx = SillyTavern.getContext(), settings = getSettings()) {
  const state = getState();
  const messages = (ctx.chat || []).filter(message => !message.is_system)
    .slice(-boundedInteger(settings.lastMessagesCount, 2, 1, 200));
  return renderTemplate(settings.promptTemplate, {
    state: JSON.stringify(state.data, null, 2),
    history: JSON.stringify([...state.history].reverse(), null, 2),
    last_messages: messages.map(message =>
      `[${message.is_user ? "user" : "assistant"}] ${message.name || (message.is_user ? ctx.name1 : ctx.name2) || "Unknown"}: ${String(message.mes || "")}`).join("\n\n"),
    chat_name: ctx.getCurrentChatId?.() || "",
    char_name: ctx.name2 || "",
  });
}

/** Accept a full object, a fenced object, or a single object surrounded by prose. */
export function parseStateResponse(response) {
  const text = String(response ?? "").trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(text);
  const source = fenced ? fenced[1].trim() : text;
  let parsed;
  try { parsed = JSON.parse(source); }
  catch {
    // Balanced scanning keeps braces inside JSON strings intact and rejects
    // multiple/truncated objects instead of silently committing a partial state.
    const start = source.indexOf("{");
    if (start < 0 || /^[\s\[]/.test(source[0] || "")) throw new Error("The model did not return a JSON object");
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) { end = i; break; }
    }
    if (end < 0 || /[{}\[\]]/.test(source.slice(end + 1))) throw new Error("The model returned incomplete or ambiguous JSON");
    try { parsed = JSON.parse(source.slice(start, end + 1)); }
    catch { throw new Error("The model returned invalid JSON"); }
  }
  if (!isStateObject(parsed)) throw new Error("State must be a JSON object, not an array or a primitive");
  return parsed;
}

function chatSignature(ctx) {
  return JSON.stringify((ctx.chat || []).map(message =>
    [message.is_user, message.is_system, message.name, message.mes, message.swipe_id]));
}

function currentJob(job) {
  const ctx = SillyTavern.getContext();
  return active === job && !job.controller.signal.aborted && isEnabled()
    && ctx.getCurrentChatId?.() === job.chatId && ctx.chatMetadata === job.metadata
    && ctx.chatMetadata[STATE_KEY] === job.stateRef && chatSignature(ctx) === job.signature;
}

export function cancelWorker(message = "Cancelled") {
  if (!active) return;
  const job = active;
  active = null;
  job.controller.abort(new DOMException(message, "AbortError"));
  publish({ status: "idle", message, elapsedMs: Date.now() - job.started });
}

export async function runWorker(trigger = "manual", { consumeCounter = false } = {}) {
  if (!isEnabled()) return { ok: false, skipped: "Extension is disabled" };
  if (active) return { ok: false, skipped: "A state update is already running" };
  const ctx = SillyTavern.getContext();
  if (!ctx.getCurrentChatId?.() || !ctx.chatMetadata) return { ok: false, skipped: "Open a chat first" };
  if (trigger === "manual" && generation && !generation.ended && generation.metadata === ctx.chatMetadata) {
    return { ok: false, skipped: "Wait for the chat response to finish" };
  }
  const settings = { ...getSettings() };
  const job = { controller: new AbortController(), started: Date.now(),
    metadata: ctx.chatMetadata, chatId: ctx.getCurrentChatId(),
    signature: chatSignature(ctx), stateRef: ctx.chatMetadata[STATE_KEY], committing: false };
  active = job;
  publish({ status: "running", message: "Updating scene state…", trigger, elapsedMs: 0, response: "" });
  let timeout;
  let onAbort;
  try {
    const prompt = buildWorkerPrompt(ctx, settings);
    if (!prompt.trim()) throw new Error("The worker prompt is empty");
    if (consumeCounter) {
      ctx.chatMetadata[COUNTER_KEY] = 0;
      ctx.saveMetadataDebounced();
    }
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(job.controller.signal.reason || new DOMException("Cancelled", "AbortError"));
      job.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    timeout = setTimeout(() => job.controller.abort(new Error("State update timed out after 120 seconds")), REQUEST_TIMEOUT_MS);
    const result = await Promise.race([generate({
      profileId: settings.profileId, model: settings.model,
      messages: [{ role: "user", content: prompt }],
      maxTokens: settings.maxTokens, temperature: settings.temperature,
      includePreset: settings.includePreset, stream: false, signal: job.controller.signal,
      overridePayload: { n: 1, use_fallback: false, enable_web_search: false },
    }), aborted]);
    if (!currentJob(job)) {
      if (active === job) publish({ status: "idle", message: "Discarded: chat or state changed" });
      return { ok: false, skipped: "Chat or state changed while the request was running" };
    }
    publish({ response: result.content });
    if (!result.content.trim()) throw new Error(result.reasoning
      ? "The model returned reasoning but no state JSON. Increase Max tokens or reduce reasoning in the profile preset."
      : "The model returned no state text. Increase Max tokens or check the profile preset.");
    const data = parseStateResponse(result.content);
    if (!currentJob(job)) return { ok: false, skipped: "Chat or state changed" };
    job.committing = true;
    const state = setState(data, { trigger });
    const elapsedMs = Date.now() - job.started;
    publish({ status: "idle", message: `Updated to revision ${state.revision}`, elapsedMs });
    console.info(`[ST-State-Manager] ${trigger}: revision ${state.revision}, ${result.model}, ${elapsedMs} ms`);
    return { ok: true, state, elapsedMs };
  } catch (error) {
    if (active !== job) return { ok: false, skipped: "Cancelled" };
    const detail = describeError(error);
    const message = /incomplete/.test(detail) ? `${detail}. Increase Max tokens or simplify the worker prompt.` : detail;
    const cancelled = error?.name === "AbortError";
    publish({ status: cancelled ? "idle" : "error", message, elapsedMs: Date.now() - job.started });
    if (!cancelled) {
      console.error("[ST-State-Manager] State update failed", error);
      globalThis.toastr?.error(message, "ST-State-Manager");
    }
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
    if (onAbort) job.controller.signal.removeEventListener("abort", onAbort);
    if (active === job) active = null;
  }
}

function automatic() { return isEnabled() && getSettings().autoUpdate; }
export function getTurnCounter() {
  return boundedInteger(SillyTavern.getContext().chatMetadata?.[COUNTER_KEY], 0, 0, Number.MAX_SAFE_INTEGER);
}

export async function onMessageSent(id) {
  const ctx = SillyTavern.getContext();
  const message = ctx.chat?.[id];
  if (!automatic() || !ctx.getCurrentChatId?.() || !message?.is_user || message.is_system
    || Number(id) !== ctx.chat.length - 1 || countedMessages.has(message)) return;
  countedMessages.add(message);
  ctx.chatMetadata[COUNTER_KEY] = getTurnCounter() + 1;
  ctx.saveMetadataDebounced();
  publish({});
  if (getSettings().trigger === "before" && getTurnCounter() >= getSettings().frequency) {
    await runWorker("auto-before", { consumeCounter: true });
  }
}

export function onGenerationStarted(type, _options, dryRun) {
  if (dryRun || ![undefined, "normal", "swipe", "regenerate", "continue"].includes(type)) return;
  cancelWorker("Cancelled: a new chat generation started");
  generation = { type: type || "normal", metadata: SillyTavern.getContext().chatMetadata,
    ended: false, received: false, stopped: false, handled: false };
}

function maybeRunAfter() {
  const ctx = SillyTavern.getContext();
  const gen = generation;
  if (!automatic() || !gen || gen.handled || gen.stopped || !gen.ended || !gen.received
    || gen.metadata !== ctx.chatMetadata || ctx.streamingProcessor?.isStopped) return;
  gen.handled = true;
  if (["swipe", "regenerate"].includes(gen.type)) {
    if (getSettings().regenOnSwipe) void runWorker("swipe");
  } else if (getSettings().trigger === "after" && getTurnCounter() >= getSettings().frequency) {
    void runWorker("auto-after", { consumeCounter: true });
  }
}

export function onMessageReceived(id, type) {
  const ctx = SillyTavern.getContext();
  const message = ctx.chat?.[id];
  if (!generation || ["quiet", "impersonate", "first_message"].includes(type)
    || !message || message.is_user || message.is_system || !String(message.mes || "").trim()) return;
  generation.received = true;
  if (ctx.streamingProcessor?.isStopped || ctx.streamingProcessor?.abortController?.signal.aborted) generation.stopped = true;
  maybeRunAfter();
}

export function onGenerationEnded() {
  if (generation) {
    generation.ended = true;
    const stream = SillyTavern.getContext().streamingProcessor;
    if (stream?.isStopped || stream?.abortController?.signal.aborted) generation.stopped = true;
  }
  // Streaming emits ENDED before RECEIVED; non-streaming does the reverse.
  // Deferring also lets a synchronous STOPPED event suppress a partial update.
  queueMicrotask(maybeRunAfter);
}

export async function onMessageSwiped(id) {
  const message = SillyTavern.getContext().chat?.[id];
  cancelWorker("Cancelled: swipe changed");
  if (!automatic() || !getSettings().regenOnSwipe || !message || message.is_user || message.is_system) return;
  // A new swipe has no stored text yet. Its RECEIVED/ENDED pair runs the worker.
  if (typeof message.swipes?.[message.swipe_id] !== "string" || !String(message.mes || "").trim()) return;
  await runWorker("swipe");
}

export function initWorkerHooks() {
  if (initialized) return;
  initialized = true;
  const ctx = SillyTavern.getContext();
  const on = (name, callback) => { if (ctx.eventTypes[name]) ctx.eventSource.on(ctx.eventTypes[name], callback); };
  on("MESSAGE_SENT", onMessageSent);
  on("GENERATION_AFTER_COMMANDS", onGenerationStarted);
  on("MESSAGE_RECEIVED", onMessageReceived);
  on("GENERATION_ENDED", onGenerationEnded);
  on("MESSAGE_SWIPED", onMessageSwiped);
  on("GENERATION_STOPPED", () => { if (generation) generation.stopped = true; cancelWorker(); });
  on("CHAT_CHANGED", () => {
    cancelWorker("Cancelled: chat changed");
    generation = null;
    publish({ status: "idle", message: "Ready", trigger: "", elapsedMs: 0, response: "" });
  });
  for (const event of ["MESSAGE_EDITED", "MESSAGE_UPDATED", "MESSAGE_DELETED"]) {
    on(event, () => cancelWorker("Cancelled: messages changed"));
  }
  subscribeSettings((key, settings) => {
    if (key === null || ["profileId", "model", "promptTemplate", "lastMessagesCount", "includePreset", "maxTokens", "temperature"].includes(key)) {
      cancelWorker("Cancelled: worker settings changed");
    }
    if (!settings.enabled || (!settings.autoUpdate && status.trigger !== "manual")) cancelWorker();
    if (["autoUpdate", "trigger"].includes(key) && generation) generation.handled = true;
  });
  subscribeState(() => {
    if (active && !active.committing) cancelWorker("Cancelled: state changed");
  });
}
