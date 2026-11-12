/** Native chat drawer: scene, history and all working configuration. */
import { getSettings, isEnabled, subscribeSettings, updateSetting } from "./settings.js";
import { getState, resetState, rollbackTo, stateText, subscribeState } from "./state-store.js";
import { getRequestLog, subscribeRequests } from "./request-log.js";
import { cancelWorker, getTurnCounter, getWorkerStatus, runWorker, subscribeWorker } from "./worker.js";
import { bindPanelSettings } from "./panel-settings.js";
import { renderStateView } from "./state-view.js";

let initialized = false;
let selectedRevision = null;
let selectedRequest = null;
let activeTab = "scene";
let settingsController;
let movingBound = false;
let initialization = null;
let lifecycle = 0;
let cleanups = [];
const element = id => document.getElementById(id);
const triggerNames = { manual: "Вручную", "auto-before": "До ответа", "auto-after": "После ответа", swipe: "Свайп", rollback: "Восстановление", import: "Импорт" };
const triggerLabel = trigger => triggerNames[trigger] || trigger;
const toastError = error => toastr.error(error.message || String(error), "Состояние сцены");

export async function runManualUpdate() {
  if (!isEnabled()) return { ok: false, skipped: "Extension is disabled" };
  const result = await runWorker("manual");
  if (result.skipped === "Cancelled" || result.skipped?.startsWith("Chat or state changed")) return result;
  if (result.skipped) {
    const reason = !isEnabled() ? "Расширение выключено." : !SillyTavern.getContext().getCurrentChatId?.()
      ? "Сначала откройте чат." : getWorkerStatus().status === "running" ? "Обновление уже выполняется." : "Дождитесь окончания ответа модели.";
    toastr.info(reason, "Состояние сцены");
  }
  return result;
}

export async function confirmReset() {
  const ctx = SillyTavern.getContext();
  const metadata = ctx.chatMetadata;
  if (!ctx.getCurrentChatId?.() || !isEnabled()) return;
  const confirmed = await ctx.callGenericPopup("Сбросить состояние этого чата? История ревизий и счётчик обновлений тоже будут удалены. Восстановить их будет нельзя.", ctx.POPUP_TYPE.CONFIRM, "", { okButton: "Сбросить состояние", cancelButton: "Отмена" });
  if (confirmed && metadata === SillyTavern.getContext().chatMetadata && isEnabled()) resetState();
}

export async function showState() {
  if (!isEnabled()) return;
  const pre = document.createElement("pre");
  pre.className = "stsm-code";
  pre.textContent = stateText(getState());
  const ctx = SillyTavern.getContext();
  await ctx.callGenericPopup(pre, ctx.POPUP_TYPE.TEXT, "", { wide: true, allowVerticalScrolling: true, okButton: "Закрыть" });
}

function selectTab(name, focus = false) {
  activeTab = name;
  for (const tab of element("stsm-panel").querySelectorAll("[data-stsm-tab]")) {
    const selected = tab.dataset.stsmTab === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    element(`stsm_view_${tab.dataset.stsmTab}`).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  element("stsm-panel").querySelector(".stsm-panel-body").scrollTop = 0;
  if (name === "settings") settingsController.activate();
  if (name === "requests") renderRequests();
}

function renderStatus() {
  if (!initialized) return;
  const settings = getSettings();
  const worker = getWorkerStatus();
  const hasChat = Boolean(SillyTavern.getContext().getCurrentChatId?.());
  const running = worker.status === "running";
  let message = !settings.enabled ? "Расширение выключено" : !hasChat ? "Откройте чат" : "";
  if (settings.enabled && hasChat) {
    if (running) message = "Обновляю состояние…";
    else if (worker.status === "error") message = "Ошибка обновления · подробности во вкладке «Запросы»";
    else if (worker.message.startsWith("Cancelled")) message = "Обновление отменено";
    else if (worker.elapsedMs) message = `Обновление завершено${worker.provider ? ` · ${worker.provider}` : ""} · ${(worker.elapsedMs / 1000).toFixed(1)} с`;
  }
  element("stsm_panel_status").textContent = message;
  element("stsm_panel_status").hidden = !message;
  element("stsm_panel_status").dataset.status = worker.status;
  element("stsm_panel_automation").textContent = settings.autoUpdate
    ? `${settings.trigger === "before" ? "До ответа" : "После ответа"} · счётчик сообщений ${getTurnCounter()}/${settings.frequency}`
    : "Автообновление выключено";
  element("stsm_panel_automation").hidden = !settings.autoUpdate;
  element("stsm_update_now").disabled = !settings.enabled || !hasChat || running;
  element("stsm_cancel").hidden = !running;
  element("stsm_worker_output").hidden = worker.status !== "error";
  element("stsm_worker_error").textContent = worker.message;
  element("stsm_worker_response").textContent = worker.response || "";
  element("stsm_panel_reset").disabled = !settings.enabled || !hasChat || !getState().revision;
  element("stsm_rollback").disabled = !settings.enabled || selectedRevision === null || !hasChat;
  element("stsm_panel_copy").disabled = !hasChat || !getState().revision;
}

function renderHistory(state = getState()) {
  const history = [...state.history].reverse();
  element("stsm_history_count").textContent = `${history.length} из ${getSettings().historyLimit}`;
  element("stsm_history_empty").hidden = history.length > 0;
  const list = element("stsm_history_list");
  list.replaceChildren();
  for (const entry of history) {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    const title = document.createElement("strong"); title.textContent = `Ревизия ${entry.revision}`;
    const stamp = document.createElement("span"); stamp.textContent = new Date(entry.updatedAt).toLocaleString();
    const trigger = document.createElement("small"); trigger.textContent = triggerLabel(entry.trigger);
    button.append(title, stamp, trigger);
    button.addEventListener("click", () => {
      selectedRevision = entry.revision; renderHistory(); renderStatus();
      element("stsm_history_heading").focus();
    });
    row.append(button); list.append(row);
  }
  const selected = history.find(entry => entry.revision === selectedRevision);
  if (!selected) selectedRevision = null;
  element("stsm_history_browser").hidden = Boolean(selected);
  element("stsm_history_detail").hidden = !selected;
  if (selected) {
    element("stsm_history_heading").textContent = `Ревизия ${selected.revision}`;
    element("stsm_history_stamp").textContent = `${new Date(selected.updatedAt).toLocaleString()} · ${triggerLabel(selected.trigger)}`;
    renderStateView(element("stsm_history_preview"), selected);
  }
}

function renderScene() {
  if (!initialized) return;
  const state = getState();
  const ctx = SillyTavern.getContext();
  element("stsm_panel_revision").textContent = state.revision
    ? `Ревизия ${state.revision} · ${new Date(state.updatedAt).toLocaleString()} · ${triggerLabel(state.trigger || "manual")}` : "";
  element("stsm_scene_empty").hidden = state.revision > 0;
  renderStateView(element("stsm_panel_state"), state);
  element("stsm_view_scene").setAttribute("aria-label", ctx.name2 ? `Состояние сцены: ${ctx.name2}` : "Состояние сцены");
  renderHistory(state); renderStatus();
}

const requestStatus = { running: "Выполняется", success: "Получен ответ", error: "Ошибка", cancelled: "Отменён", interrupted: "Прерван загрузкой страницы" };
const requestPurpose = purpose => purpose === "connection-test" ? "Проверка подключения" : triggerLabel(purpose);
const currentRequest = () => getRequestLog().find(item => item.id === selectedRequest);

function renderRequests() {
  if (!initialized) return;
  const entries = getRequestLog();
  if (!entries.some(item => item.id === selectedRequest)) selectedRequest = entries[0]?.id || null;
  element("stsm_requests_empty").hidden = entries.length > 0;
  element("stsm_request_browser").hidden = !entries.length;
  const select = element("stsm_request_select");
  select.replaceChildren(...entries.map(entry => new Option(
    `${new Date(entry.startedAt).toLocaleString()} · ${requestPurpose(entry.request.purpose)} · ${requestStatus[entry.status] || entry.status}`, entry.id)));
  select.value = selectedRequest || "";
  const entry = entries.find(item => item.id === selectedRequest);
  if (!entry) return;
  element("stsm_request_meta").textContent = [entry.model || entry.payload?.model || entry.request.model,
    entry.provider, entry.elapsedMs !== undefined ? `${(entry.elapsedMs / 1000).toFixed(1)} с` : "",
    entry.requestId].filter(Boolean).join(" · ");
  element("stsm_request_error").hidden = !entry.error;
  element("stsm_request_error").textContent = entry.error || "";
  const messages = entry.payload?.messages || entry.request.messages || [];
  const container = element("stsm_request_messages");
  container.replaceChildren();
  for (const message of messages) {
    const block = document.createElement("div");
    const label = document.createElement("h5"); label.textContent = message.role;
    const pre = document.createElement("pre"); pre.className = "stsm-code"; pre.tabIndex = 0;
    pre.textContent = typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2);
    block.append(label, pre); container.append(block);
  }
  element("stsm_request_payload").textContent = JSON.stringify(entry.payload || entry.request, null, 2);
  element("stsm_request_response").textContent = entry.response ?? (entry.status === "running" ? "Ожидание ответа…" : "Ответ не получен");
  element("stsm_request_reasoning_block").hidden = !entry.reasoning;
  element("stsm_request_reasoning").textContent = entry.reasoning || "";
  element("stsm_request_raw_block").hidden = !entry.rawResponse;
  element("stsm_request_raw").textContent = entry.rawResponse ? JSON.stringify(entry.rawResponse, null, 2) : "";
  element("stsm_request_response_copy").disabled = !entry.response;
}

function renderPin() {
  if (!initialized) return;
  const pinned = getSettings().panelPinned;
  element("stsm-panel").classList.toggle("pinnedOpen", pinned);
  element("stsm-drawer").querySelector(".drawer-icon").classList.toggle("drawerPinnedOpen", pinned);
  element("stsm_pin").setAttribute("aria-pressed", String(pinned));
  element("stsm_pin").setAttribute("aria-label", pinned ? "Открепить панель" : "Закрепить панель");
  element("stsm_pin").querySelector("i").className = `fa-solid ${pinned ? "fa-lock" : "fa-unlock"}`;
}

async function ensureMovingUI() {
  const ctx = SillyTavern.getContext();
  if (!initialized || !isEnabled() || !ctx.powerUserSettings?.movingUI || movingBound) return;
  const panel = element("stsm-panel");
  const { dragElement } = await import("/scripts/RossAscends-mods.js");
  if (!initialized || !isEnabled() || panel !== element("stsm-panel") || movingBound) return;
  movingBound = true;
  dragElement($(element("stsm-panel")));
  const saved = ctx.powerUserSettings.movingUIState?.["stsm-panel"];
  if (saved) $(element("stsm-panel")).css(saved);
}

async function togglePanel() {
  const drawer = element("stsm-drawer");
  if (!isEnabled() || !drawer) return;
  const { doNavbarIconClick } = await import("/script.js");
  if (isEnabled() && drawer === element("stsm-drawer")) await doNavbarIconClick.call(drawer.querySelector(".drawer-toggle"));
}

export async function openPanel() {
  await initPanel();
  if (isEnabled() && element("stsm-panel") && !element("stsm-panel").classList.contains("openDrawer")) await togglePanel();
}

export function destroyPanel() {
  lifecycle++;
  initialized = false;
  initialization = null;
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  settingsController?.destroy();
  settingsController = null;
  // Release document handlers if Moving UI is currently dragging this panel.
  if (movingBound) $(element("stsm-panel")).trigger("mouseup");
  if (element("stsm-drawer")) $(element("stsm-drawer")).remove();
  element("stsm_update_state")?.remove();
  movingBound = false;
  selectedRevision = null;
  selectedRequest = null;
  activeTab = "scene";
}

export function initPanel() {
  if (!isEnabled() || initialized) return Promise.resolve();
  if (initialization) return initialization;
  const pending = initializePanel(lifecycle).finally(() => {
    if (initialization === pending) initialization = null;
  });
  initialization = pending;
  return pending;
}

async function initializePanel(version) {
  const ctx = SillyTavern.getContext();
  const holder = element("top-settings-holder");
  if (!holder) return;
  if (!element("stsm-drawer")) {
    const html = await ctx.renderExtensionTemplateAsync("third-party/ST-State-Manager", "panel");
    if (!isEnabled() || version !== lifecycle) return;
    holder.insertAdjacentHTML("beforeend", html);
  }
  const panel = element("stsm-panel");
  const toggle = element("stsm-drawer").querySelector(".drawer-toggle");
  const icon = toggle.querySelector("button");
  settingsController = bindPanelSettings(panel);
  initialized = true;
  toggle.addEventListener("click", event => { event.preventDefault(); event.stopImmediatePropagation(); void togglePanel().catch(toastError); }, true);
  const panelObserver = new MutationObserver(() => icon.setAttribute("aria-expanded", String(panel.classList.contains("openDrawer"))));
  panelObserver.observe(panel, { attributes: true, attributeFilter: ["class"] });
  const movingObserver = new MutationObserver(() => void ensureMovingUI().catch(console.error));
  movingObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  cleanups.push(() => panelObserver.disconnect(), () => movingObserver.disconnect());
  void ensureMovingUI().catch(console.error);
  const on = (event, callback) => {
    if (!event) return;
    ctx.eventSource.on(event, callback);
    cleanups.push(() => ctx.eventSource.removeListener(event, callback));
  };
  on(ctx.eventTypes.MOVABLE_PANELS_RESET, () => panel.removeAttribute("style"));
  element("stsm_panel_close").addEventListener("click", () => { void togglePanel().then(() => icon.focus()); });
  element("stsm_pin").addEventListener("click", () => updateSetting("panelPinned", !getSettings().panelPinned));
  panel.addEventListener("keydown", event => {
    // SillyTavern handles arrows/Enter globally (swipes and generation).
    // Keys used inside this workspace must never reach the chat shortcuts.
    event.stopPropagation();
    if (event.key === "Escape" && panel.classList.contains("openDrawer")) {
      void togglePanel().then(() => icon.focus());
    }
  });
  const tabs = [...panel.querySelectorAll("[data-stsm-tab]")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tab.dataset.stsmTab));
    tab.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const direction = getComputedStyle(tab).direction === "rtl" ? -1 : 1;
      const offset = event.key === "ArrowRight" ? direction : -direction;
      const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (tabs.indexOf(tab) + offset + tabs.length) % tabs.length;
      selectTab(tabs[index].dataset.stsmTab, true);
    });
  }
  element("stsm_update_now").addEventListener("click", () => void runManualUpdate());
  element("stsm_cancel").addEventListener("click", () => cancelWorker());
  element("stsm_panel_reset").addEventListener("click", () => void confirmReset().catch(toastError));
  const copy = value => void navigator.clipboard.writeText(value).then(() => toastr.info("Скопировано", "Состояние сцены")).catch(toastError);
  element("stsm_panel_copy").addEventListener("click", () => copy(stateText(getState())));
  element("stsm_request_select").addEventListener("change", event => { selectedRequest = event.target.value; renderRequests(); });
  element("stsm_request_copy").addEventListener("click", () => copy(JSON.stringify(currentRequest(), null, 2)));
  element("stsm_request_prompt_copy").addEventListener("click", () => {
    const entry = currentRequest();
    copy((entry?.payload?.messages || entry?.request.messages || []).map(message => `[${message.role}]\n${typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2)}`).join("\n\n"));
  });
  element("stsm_request_response_copy").addEventListener("click", () => copy(currentRequest()?.response || ""));
  element("stsm_history_back").addEventListener("click", () => { selectedRevision = null; renderHistory(); renderStatus(); });
  element("stsm_rollback").addEventListener("click", () => {
    try { rollbackTo(selectedRevision); selectedRevision = null; renderHistory(); renderStatus(); selectTab("scene"); }
    catch (error) { toastError(error); }
  });
  const menu = document.querySelector("#options .options-content");
  if (menu && !element("stsm_update_state")) {
    const item = document.createElement("a");
    item.id = "stsm_update_state"; item.tabIndex = 0; item.setAttribute("role", "button");
    item.innerHTML = '<i class="fa-lg fa-solid fa-database" aria-hidden="true"></i><span>Обновить состояние сцены</span>';
    if (element("option_toggle_AN")) element("option_toggle_AN").after(item); else menu.append(item);
    item.addEventListener("click", () => {
      if (getComputedStyle(element("options")).display !== "none") element("options_button")?.click();
      void runManualUpdate();
    });
    item.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); item.click(); } });
  }
  if (ctx.SlashCommandParser && ctx.SlashCommand) {
    const register = props => {
      const command = ctx.SlashCommand.fromProps(props);
      ctx.SlashCommandParser.addCommandObject(command);
      cleanups.push(() => {
        if (ctx.SlashCommandParser.commands[command.name] === command) delete ctx.SlashCommandParser.commands[command.name];
      });
    };
    register({ name: "state_update", helpString: "Обновить состояние сцены отдельным запросом к модели.",
      callback: async () => { const result = await runManualUpdate(); return result.ok ? stateText(result.state) : ""; }, returns: "Текст нового состояния." });
    register({ name: "state_show", helpString: "Посмотреть состояние сцены.",
      callback: async () => { if (!isEnabled()) return ""; await showState(); return stateText(getState()); }, returns: "Текст текущего состояния." });
  }
  cleanups.push(subscribeState(renderScene), subscribeWorker(renderStatus), subscribeRequests(renderRequests),
    subscribeSettings(() => { renderStatus(); renderPin(); }));
  on(ctx.eventTypes.CHAT_CHANGED, () => { selectedRevision = null; selectedRequest = null; renderScene(); renderRequests(); });
  selectTab(activeTab); renderPin(); renderScene(); renderRequests();
}
