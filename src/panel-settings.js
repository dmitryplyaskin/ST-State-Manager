/** All working configuration belongs to the chat-side workspace. */
import { DEFAULT_PROMPT, getSettings, subscribeSettings, updateSetting } from "./settings.js";
import { describeError, fetchModels, getOpenRouterRouting, getProfile, getSupportedProfiles,
  rememberActiveRouting, resolveModel, runTestRequest } from "./llm-client.js";
import { buildWorkerPrompt } from "./worker.js";

export function bindPanelSettings(root) {
  const controller = new AbortController();
  const { signal } = controller;
  const cleanups = [];
  const field = id => root.querySelector(`#${id}`);
  let loadingModels = false;
  let testing = false;
  let requestId = 0;
  let listKey = null;
  let listTime = 0;

  function refreshProfiles() {
    const selected = getSettings().profileId;
    const profiles = getSupportedProfiles().slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const select = field("stsm_profile");
    select.replaceChildren(new Option("Текущее подключение Таверны", ""));
    for (const profile of profiles) select.add(new Option(profile.name || profile.id, profile.id));
    if (selected && !profiles.some(profile => profile.id === selected)) {
      select.add(new Option("Выбранный профиль недоступен", selected));
    }
    select.value = selected;
  }

  function refreshHints() {
    const settings = getSettings();
    const profile = getProfile(settings.profileId);
    const effective = resolveModel(settings.profileId, settings.model);
    field("stsm_model").placeholder = "Из профиля";
    field("stsm_model_hint").textContent = !settings.model && effective ? `Из профиля: ${effective}` : "";
    field("stsm_profile_hint").textContent = settings.profileId && !profile ? "Профиль недоступен" : "";
    const routing = getOpenRouterRouting(settings.profileId);
    field("stsm_route_info").hidden = !routing;
    if (routing) {
      field("stsm_provider_hint").textContent = `${routing.provider.join(", ") || "Автовыбор провайдера"} · резервные провайдеры ${routing.allow_fallbacks ? "разрешены" : "отключены"}`;
      field("stsm_routing_source").textContent = "";
      field("stsm_route_info").title = { active: "Из текущего подключения", remembered: "Сохранено для этого профиля", preset: "Из пресета профиля" }[routing.source];
    }
  }

  function refreshControls() {
    if (signal.aborted) return;
    const settings = getSettings();
    for (const input of root.querySelectorAll("[data-stsm-setting]")) {
      const value = settings[input.dataset.stsmSetting];
      if (input.type === "checkbox") input.checked = Boolean(value);
      else if (document.activeElement !== input) input.value = value === null ? "" : String(value);
      input.disabled = !settings.enabled;
    }
    for (const id of ["stsm_profile", "stsm_model", "stsm_restore_prompt", "stsm_expand_prompt", "stsm_preview_prompt"]) field(id).disabled = !settings.enabled;
    field("stsm_refresh_models").disabled = !settings.enabled || loadingModels;
    field("stsm_test_run").disabled = !settings.enabled || testing;
    const inChat = settings.enabled && settings.injectEnabled && settings.injectPosition === 1;
    field("stsm_injectPosition").disabled = !settings.enabled || !settings.injectEnabled;
    field("stsm_injectRole").disabled = !inChat;
    field("stsm_injectDepth").disabled = !inChat;
    field("stsm_injectMerge").disabled = !inChat || settings.injectRole === "system";
    if (document.activeElement !== field("stsm_model")) field("stsm_model").value = settings.model;
    refreshHints();
  }

  async function refreshModels(force = false) {
    if (signal.aborted || !getSettings().enabled) return;
    const key = getSettings().profileId;
    if (!force && key === listKey && Date.now() - listTime < 10000) return;
    listKey = key; listTime = Date.now();
    const id = ++requestId;
    loadingModels = true; refreshControls();
    field("stsm_model_status").textContent = "Загружаю список моделей…";
    try {
      const { models, error } = await fetchModels(key, { signal });
      if (signal.aborted || id !== requestId) return;
      field("stsm_model_list").replaceChildren(...models.map(model => new Option(model.name, model.id)));
      field("stsm_model_status").textContent = error
        ? "Список недоступен. Идентификатор модели можно ввести вручную."
        : "";
    } finally {
      if (id === requestId) { loadingModels = false; refreshControls(); }
    }
  }

  for (const input of root.querySelectorAll("[data-stsm-setting]")) {
    input.addEventListener("change", () => {
      const value = input.type === "checkbox" ? input.checked
        : input.type === "number" ? input.value === "" && input.dataset.stsmSetting === "temperature" ? null : Number(input.value)
          : input.value;
      const saved = updateSetting(input.dataset.stsmSetting, value);
      if (input.type !== "checkbox") input.value = saved === null ? "" : String(saved);
    });
  }
  field("stsm_promptTemplate").addEventListener("input", event => updateSetting("promptTemplate", event.target.value));
  field("stsm_model").addEventListener("input", event => updateSetting("model", event.target.value));
  field("stsm_profile").addEventListener("change", event => {
    updateSetting("profileId", event.target.value);
    rememberActiveRouting();
    void refreshModels();
  });
  field("stsm_refresh_models").addEventListener("click", () => void refreshModels(true));
  field("stsm_preview_prompt").addEventListener("click", async () => {
    const ctx = SillyTavern.getContext();
    const pre = document.createElement("pre");
    pre.className = "stsm-code"; pre.textContent = buildWorkerPrompt();
    await ctx.callGenericPopup(pre, ctx.POPUP_TYPE.TEXT, "", { wide: true, large: true, allowVerticalScrolling: true, okButton: "Закрыть" });
  });
  field("stsm_expand_prompt").addEventListener("click", async () => {
    const ctx = SillyTavern.getContext();
    const container = document.createElement("div");
    container.className = "stsm-prompt-dialog";
    const label = document.createElement("label");
    label.htmlFor = "stsm_expanded_prompt"; label.textContent = "Промпт обновления состояния";
    const editor = document.createElement("textarea");
    editor.id = "stsm_expanded_prompt"; editor.className = "text_pole stsm-prompt-editor";
    editor.rows = 20; editor.spellcheck = false; editor.value = getSettings().promptTemplate;
    const original = editor.value;
    container.append(label, editor);
    const confirmed = await ctx.callGenericPopup(container, ctx.POPUP_TYPE.CONFIRM, "", { wide: true, large: true, allowVerticalScrolling: true, okButton: "Применить промпт", cancelButton: "Отмена" });
    if (!signal.aborted && confirmed && getSettings().enabled && getSettings().promptTemplate === original) updateSetting("promptTemplate", editor.value);
  });
  field("stsm_restore_prompt").addEventListener("click", async () => {
    if (getSettings().promptTemplate === DEFAULT_PROMPT) return;
    const ctx = SillyTavern.getContext();
    const confirmed = await ctx.callGenericPopup("Заменить текущий промпт исходным? Пользовательский текст будет потерян.", ctx.POPUP_TYPE.CONFIRM, "", { okButton: "Заменить промпт", cancelButton: "Отмена" });
    if (!signal.aborted && confirmed && getSettings().enabled) updateSetting("promptTemplate", DEFAULT_PROMPT);
  });
  field("stsm_test_run").addEventListener("click", async () => {
    if (signal.aborted || testing || !getSettings().enabled) return;
    const output = field("stsm_test_output");
    testing = true; refreshControls(); output.textContent = "Проверяю подключение…";
    try {
      const result = await runTestRequest("Reply with OK.", { signal });
      if (signal.aborted) return;
      output.textContent = `Подключение отвечает.\nМодель: ${result.model}\n${result.provider ? `Фактический провайдер: ${result.provider}\n` : ""}Время: ${(result.elapsedMs / 1000).toFixed(1)} с${result.content ? `\nОтвет: ${result.content}` : ""}${result.requestId ? `\nID запроса: ${result.requestId}` : ""}`;
    } catch (error) { if (!signal.aborted) output.textContent = `Не удалось выполнить запрос. Проверьте профиль и подключение.\n${describeError(error)}`; }
    finally { testing = false; refreshControls(); }
  });

  function connectionChanged() { if (!signal.aborted) { rememberActiveRouting(); refreshProfiles(); refreshHints(); } }
  const ctx = SillyTavern.getContext();
  for (const event of ["CONNECTION_PROFILE_LOADED", "CONNECTION_PROFILE_UPDATED", "CONNECTION_PROFILE_DELETED",
    "CHATCOMPLETION_MODEL_CHANGED", "CHATCOMPLETION_SOURCE_CHANGED", "MAIN_API_CHANGED", "EXTENSION_SETTINGS_LOADED"]) {
    if (ctx.eventTypes[event]) {
      ctx.eventSource.on(ctx.eventTypes[event], connectionChanged);
      cleanups.push(() => ctx.eventSource.removeListener(ctx.eventTypes[event], connectionChanged));
    }
  }
  $(document).on("change.stsmRouting input.stsmRouting",
    "#openrouter_providers_chat, #openrouter_allow_fallbacks, #openrouter_use_fallback, #openrouter_quantizations_chat, #openrouter_middleout", connectionChanged);
  cleanups.push(subscribeSettings(refreshControls));
  rememberActiveRouting(); refreshProfiles(); refreshControls();
  return {
    activate: () => { if (!signal.aborted) { refreshProfiles(); refreshControls(); void refreshModels(); } },
    destroy: () => {
      controller.abort();
      requestId++;
      for (const cleanup of cleanups) cleanup();
      $(document).off(".stsmRouting");
    },
  };
}
