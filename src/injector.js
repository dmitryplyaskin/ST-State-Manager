/** Keep one extension prompt synchronized with the current chat. */
import { getSettings, subscribeSettings } from "./settings.js";
import { getState, subscribeState } from "./state-store.js";

export const PROMPT_KEY = "st_state_manager";
const roles = { system: 0, user: 1, assistant: 2 };
const processed = new WeakSet();
let initialized = false;
let injectionText = "";

export function formatInjection(data) {
  return `[ST-State-Manager: current scene state]\n${JSON.stringify(data, null, 2)}\n[/ST-State-Manager]`;
}

export function updateInjection() {
  const ctx = SillyTavern.getContext();
  const settings = getSettings();
  const state = getState();
  injectionText = settings.enabled && settings.injectEnabled && ctx.getCurrentChatId?.() && state.revision > 0
    ? formatInjection(state.data) : "";
  ctx.setExtensionPrompt(PROMPT_KEY, injectionText, settings.injectPosition,
    settings.injectDepth, false, roles[settings.injectRole] ?? 0);
}

/** Move only our block into an adjacent same-role message; leave tools and other extensions intact. */
export function mergeStateMessage(messages, text) {
  if (!Array.isArray(messages) || !text || processed.has(messages)) return;
  processed.add(messages);
  const index = messages.findIndex(message => typeof message.content === "string" && message.content.includes(text));
  if (index < 0) return;
  const source = messages[index];
  if (!["user", "assistant"].includes(source.role) || source.tool_calls || source.function_call) return;
  const compatible = target => target && target.role === source.role && !target.tool_calls
    && !target.function_call && !target.tool_call_id
    && (typeof target.content === "string" || Array.isArray(target.content));
  const previous = messages[index - 1];
  const next = messages[index + 1];
  const target = compatible(previous) ? previous : compatible(next) ? next : null;
  if (!target) return;
  const prepend = target === next;
  if (typeof target.content === "string") target.content = prepend
    ? `${text}\n\n${target.content}` : `${target.content}\n\n${text}`;
  else if (prepend) target.content.unshift({ type: "text", text });
  else target.content.push({ type: "text", text });
  const rest = source.content.replace(text, "").trim();
  if (rest) source.content = rest;
  else messages.splice(index, 1);
}

export function initInjector() {
  if (initialized) return;
  initialized = true;
  subscribeState(updateInjection);
  subscribeSettings(updateInjection);
  const ctx = SillyTavern.getContext();
  ctx.eventSource.on(ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY, ({ chat }) => {
    const settings = getSettings();
    if (settings.enabled && settings.injectEnabled && settings.injectMerge
      && settings.injectPosition === 1 && settings.injectRole !== "system") mergeStateMessage(chat, injectionText);
  });
  updateInjection();
}
