/** Chat drawer, revision browser, menu entry and slash commands. */
import { getSettings, isEnabled, subscribeSettings } from "./settings.js";
import { getState, resetState, rollbackTo, subscribeState } from "./state-store.js";
import { cancelWorker, getTurnCounter, getWorkerStatus, runWorker, subscribeWorker } from "./worker.js";

let initialized = false;
let selectedRevision = "";

function element(id) { return document.getElementById(id); }
function toastError(error) { toastr.error(error.message || String(error), "ST-State-Manager"); }

export async function runManualUpdate() {
  const result = await runWorker("manual");
  if (result.skipped) toastr.info(result.skipped, "ST-State-Manager");
  return result;
}

export async function confirmReset() {
  const ctx = SillyTavern.getContext();
  const metadata = ctx.chatMetadata;
  if (!ctx.getCurrentChatId?.() || !isEnabled()) return;
  const confirmed = await ctx.callGenericPopup("Reset the state and revision history of the current chat? This cannot be undone.", ctx.POPUP_TYPE.CONFIRM);
  if (confirmed && metadata === SillyTavern.getContext().chatMetadata && isEnabled()) {
    resetState();
    toastr.info("Chat state reset", "ST-State-Manager");
  }
}

export async function showState() {
  const pre = document.createElement("pre");
  pre.className = "stsm-state-popup";
  pre.textContent = JSON.stringify(getState().data, null, 2);
  await SillyTavern.getContext().callGenericPopup(pre, SillyTavern.getContext().POPUP_TYPE.TEXT);
}

function render() {
  if (!initialized) return;
  const ctx = SillyTavern.getContext();
  const state = getState();
  const settings = getSettings();
  const worker = getWorkerStatus();
  const running = worker.status === "running";
  const activeChat = Boolean(ctx.getCurrentChatId?.());
  element("stsm_panel_status").textContent = `${worker.status === "error" ? "Error: " : ""}${worker.message}${worker.elapsedMs ? ` · ${(worker.elapsedMs / 1000).toFixed(1)} s` : ""}`;
  element("stsm_panel_status").dataset.status = worker.status;
  element("stsm_worker_output").hidden = worker.status !== "error" || !worker.response;
  element("stsm_worker_response").textContent = worker.response || "";
  element("stsm_panel_automation").textContent = !settings.enabled ? "Extension disabled" : settings.autoUpdate
    ? `Automatic: ${settings.trigger} generation · ${getTurnCounter()} / ${settings.frequency} user messages`
    : "Automatic updates off · manual updates available";
  element("stsm_panel_revision").textContent = state.revision
    ? `Revision ${state.revision} · ${new Date(state.updatedAt).toLocaleString()} · ${state.trigger || "manual"}` : "No state yet";
  element("stsm_panel_state").textContent = JSON.stringify(state.data, null, 2);
  element("stsm_update_now").disabled = !settings.enabled || !activeChat || running;
  element("stsm_cancel").hidden = !running;
  element("stsm_panel_reset").disabled = !settings.enabled || !activeChat || !state.revision;
  element("stsm_panel_copy").disabled = !activeChat;
  const select = element("stsm_history");
  select.replaceChildren(new Option("Choose a previous revision…", ""));
  for (const entry of [...state.history].reverse()) {
    select.add(new Option(`r${entry.revision} · ${new Date(entry.updatedAt).toLocaleString()} · ${entry.trigger}`, String(entry.revision)));
  }
  if (!state.history.some(entry => String(entry.revision) === selectedRevision)) selectedRevision = "";
  select.value = selectedRevision;
  select.disabled = state.history.length === 0;
  const entry = state.history.find(item => String(item.revision) === selectedRevision);
  element("stsm_history_preview").textContent = entry ? JSON.stringify(entry.data, null, 2) : "";
  element("stsm_rollback").disabled = !entry || !settings.enabled || !activeChat;
  element("stsm_history_count").textContent = `${state.history.length} previous revision(s) · limit ${settings.historyLimit}`;
}

export function initPanel() {
  if (initialized || !element("top-settings-holder")) return;
  const drawer = document.createElement("div");
  drawer.id = "stsm-drawer";
  drawer.className = "drawer";
  drawer.innerHTML = `
    <div class="drawer-toggle">
      <button type="button" class="drawer-icon stsm-drawer-toggle fa-solid fa-database fa-fw closedIcon" aria-label="State Manager" aria-expanded="false" aria-controls="stsm-panel" title="State Manager"></button>
    </div>
    <section id="stsm-panel" class="drawer-content closedDrawer fillRight stsm-panel" aria-label="State Manager">
      <div class="stsm-panel-heading"><h3>State Manager</h3><button id="stsm_panel_close" type="button" class="menu_button" aria-label="Close State Manager"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>
      <div id="stsm_panel_status" role="status" aria-live="polite"></div>
      <details id="stsm_worker_output" hidden><summary>Inspect the model's last response</summary><pre id="stsm_worker_response" class="stsm-json"></pre></details>
      <small id="stsm_panel_automation" class="text_muted"></small>
      <div class="stsm-panel-actions"><button id="stsm_update_now" type="button" class="menu_button"><i class="fa-solid fa-rotate" aria-hidden="true"></i> Update state now</button><button id="stsm_cancel" type="button" class="menu_button" hidden>Cancel update</button></div>
      <h4>Current scene state</h4><small id="stsm_panel_revision" class="text_muted"></small>
      <pre id="stsm_panel_state" class="stsm-json" tabindex="0" aria-label="Current scene state JSON"></pre>
      <div class="stsm-panel-actions"><button id="stsm_panel_copy" type="button" class="menu_button">Copy JSON</button><button id="stsm_panel_reset" type="button" class="menu_button">Reset state &amp; history</button></div>
      <h4>Revision history</h4><small id="stsm_history_count" class="text_muted"></small>
      <label for="stsm_history">Previous revision</label><select id="stsm_history" class="text_pole"></select>
      <pre id="stsm_history_preview" class="stsm-json" tabindex="0" aria-label="Previous revision JSON"></pre>
      <button id="stsm_rollback" type="button" class="menu_button">Restore as a new revision</button>
    </section>`;
  element("top-settings-holder").append(drawer);
  initialized = true;
  const toggle = drawer.querySelector(".drawer-toggle");
  const iconButton = toggle.querySelector("button");
  // ST binds existing toggles once. Capture avoids double handling when our
  // extension initializes before that binding, while still using ST's drawer.
  toggle.addEventListener("click", event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    void import("/script.js").then(module => module.doNavbarIconClick.call(toggle)).catch(toastError);
  }, true);
  new MutationObserver(() => iconButton.setAttribute("aria-expanded", String(element("stsm-panel").classList.contains("openDrawer"))))
    .observe(element("stsm-panel"), { attributes: true, attributeFilter: ["class"] });
  element("stsm_panel_close").addEventListener("click", () => { toggle.click(); iconButton.focus(); });
  element("stsm-panel").addEventListener("keydown", event => {
    if (event.key === "Escape" && element("stsm-panel").classList.contains("openDrawer")) {
      event.stopPropagation(); toggle.click(); iconButton.focus();
    }
  });
  element("stsm_update_now").addEventListener("click", () => void runManualUpdate());
  element("stsm_cancel").addEventListener("click", () => cancelWorker());
  element("stsm_panel_reset").addEventListener("click", () => void confirmReset().catch(toastError));
  element("stsm_panel_copy").addEventListener("click", () => {
    void navigator.clipboard.writeText(JSON.stringify(getState().data, null, 2))
      .then(() => toastr.info("State JSON copied", "ST-State-Manager")).catch(toastError);
  });
  element("stsm_history").addEventListener("change", event => { selectedRevision = event.target.value; render(); });
  element("stsm_rollback").addEventListener("click", () => {
    try { rollbackTo(Number(selectedRevision)); toastr.info("Revision restored", "ST-State-Manager"); }
    catch (error) { toastError(error); }
  });
  const menu = document.querySelector("#options .options-content");
  if (menu) {
    const item = document.createElement("a");
    item.id = "stsm_update_state";
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.innerHTML = '<i class="fa-lg fa-solid fa-database" aria-hidden="true"></i><span>Update scene state</span>';
    const authorNote = element("option_toggle_AN");
    if (authorNote) authorNote.after(item); else menu.append(item);
    item.addEventListener("click", () => {
      if (getComputedStyle(element("options")).display !== "none") element("options_button")?.click();
      void runManualUpdate();
    });
    item.addEventListener("keydown", event => {
      if (["Enter", " "].includes(event.key)) { event.preventDefault(); item.click(); }
    });
  }
  const ctx = SillyTavern.getContext();
  if (ctx.SlashCommandParser && ctx.SlashCommand) {
    ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
      name: "state_update", helpString: "Update the current scene state using the State Manager model.",
      callback: async () => {
        const result = await runManualUpdate();
        return result.ok ? JSON.stringify(result.state.data) : "";
      }, returns: "Updated scene state JSON, or an empty string if the update did not finish.",
    }));
    ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
      name: "state_show", helpString: "View the current scene state as JSON.",
      callback: async () => { await showState(); return JSON.stringify(getState().data); }, returns: "Current scene state JSON.",
    }));
  }
  subscribeState(render);
  subscribeWorker(render);
  subscribeSettings(render);
  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => { selectedRevision = ""; render(); });
  render();
}
