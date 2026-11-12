/**
 * ST-State-Manager — development smoke test.
 *
 * Runs the pure logic (settings, model resolution, payload building, state
 * store) in Node with a stubbed SillyTavern context, so regressions are caught
 * without starting SillyTavern or opening a browser.
 *
 * Run: node dev/smoke-test.mjs
 * Requires Node.js 18+ (structuredClone, top-level await).
 */

let savedSettings = 0;
let savedMetadata = 0;
let capturedSendRequest = null;
let capturedMainPayload = null;
let capturedExtractData = null;
const fetchedRequests = [];

const profiles = [
  { id: "p1", name: "OpenRouter", api: "openrouter", model: "profile-model", proxy: "", "secret-id": "s1" },
  { id: "p2", name: "Custom", api: "custom", model: "", "api-url": "http://localhost:1234/v1" },
  { id: "p3", name: "Proxied", api: "openai", model: "gpt-x", proxy: "px", "secret-id": "s2" },
  { id: "p4", name: "Unsupported", api: "kobold", model: "k" },
];

const store = {
  extensionSettings: {
    disabledExtensions: [],
    connectionManager: { selectedProfile: "", profiles },
  },
  chatCompletionSettings: {
    proxies: [{ name: "px", url: "https://proxy.example/v1", password: "pw" }],
    chat_completion_source: "openrouter",
    reverse_proxy: "",
    proxy_password: "",
    custom_url: "",
  },
  textCompletionSettings: {},
  mainApi: "openai",
  chatMetadata: {},
  getCurrentChatId: () => "chat-1",
  saveMetadataDebounced: () => { savedMetadata += 1; },
  saveSettingsDebounced: () => { savedSettings += 1; },
  CONNECT_API_MAP: {
    openrouter: { selected: "openai", source: "openrouter" },
    custom: { selected: "openai", source: "custom" },
    openai: { selected: "openai", source: "openai" },
    kobold: { selected: "kobold" },
    koboldcpp: { selected: "textgenerationwebui", type: "koboldcpp" },
  },
  getChatCompletionModel: () => "main-model",
  ConnectionManagerRequestService: {
    getSupportedProfiles: () => profiles.filter((p) => p.api !== "kobold"),
    sendRequest: async (...args) => {
      capturedSendRequest = args;
      return { content: "profile-answer", reasoning: "because" };
    },
  },
  ChatCompletionService: {
    createRequestData: (payload) => Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined)),
    sendRequest: async (payload, extractData) => { capturedMainPayload = payload; capturedExtractData = extractData; return payload.secret_id ? { content: "profile-answer", reasoning: "because" } : { content: "main-answer", reasoning: "" }; },
  },
  eventSource: { on: () => {} },
  eventTypes: { CHAT_CHANGED: "chat_changed" },
  getRequestHeaders: () => ({ "Content-Type": "application/json", "X-CSRF-Token": "token" }),
  extractMessageFromData: () => "",
};

globalThis.SillyTavern = { getContext: () => store };
globalThis.fetch = async (url, init) => {
  fetchedRequests.push({ url, init });
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ id: "zeta" }, { id: "alpha", name: "Alpha" }, { id: "alpha" }] }),
  };
};

const results = [];
function check(name, fn, expected) {
  return Promise.resolve()
    .then(fn)
    .then((actual) => {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      results.push({ name, ok, actual, expected });
      return ok;
    })
    .catch((error) => {
      results.push({ name, ok: false, actual: `threw: ${error.message}`, expected });
      return false;
    });
}

const source = new URL("../src/", import.meta.url);

const settingsMod = await import(new URL("settings.js", source));
const llm = await import(new URL("llm-client.js", source));
const state = await import(new URL("state-store.js", source));
const { getState, setState, updateState, resetState, exportState } = state;

// Settings
await check("settings: defaults created", () => {
  const s = settingsMod.loadSettings();
  return [s.enabled, s.profileId, s.model, s.maxTokens, s.temperature, s.includePreset, s.stream];
}, [true, "", "", 2048, null, true, false]);

await check("settings: defaults persisted once", () => savedSettings, 1);

await check("settings: update persists", () => {
  settingsMod.updateSetting("model", "override-model");
  return [settingsMod.getSettings().model, savedSettings];
}, ["override-model", 2]);

// Model resolution
await check("models: profile default", () => llm.resolveModel("p1", ""), "profile-model");
await check("models: override wins", () => llm.resolveModel("p1", "gpt-5"), "gpt-5");
await check("models: main model", () => llm.resolveModel("", ""), "main-model");
await check("models: supported profiles excludes kobold", () => llm.getSupportedProfiles().map((p) => p.id), ["p1", "p2", "p3"]);

// Generation through a profile
await check("generate: profile result", async () => {
  const result = await llm.generate({
    profileId: "p1",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 128,
  });
  return [result.backend, result.model, result.content, result.reasoning];
}, ["profile", "profile-model", "profile-answer", "because"]);

await check("generate: effective profile model is forwarded", () => capturedMainPayload.model, "profile-model");

await check("generate: no model key when profile has no model", async () => {
  await llm.generate({
    profileId: "p2",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 128,
  });
  return capturedMainPayload.model;
}, "");

await check("generate: override payload", async () => {
  const result = await llm.generate({
    profileId: "p1",
    model: "other-model",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 128,
    temperature: 0.2,
  });
  return [capturedMainPayload.model, capturedMainPayload.temperature, result.model];
}, ["other-model", 0.2, "other-model"]);

await check("generate: options passed to service", () => {
  return [capturedMainPayload.stream, capturedExtractData];
}, [false, false]);

// Generation through the main connection
await check("generate: main connection", async () => {
  const result = await llm.generate({
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 64,
  });
  return [result.backend, result.model, result.content];
}, ["main", "main-model", "main-answer"]);

await check("generate: main rejects non-chat API", async () => {
  store.mainApi = "kobold";
  try {
    await llm.generate({ messages: [{ role: "user", content: "hi" }] });
    return "did-not-throw";
  } catch (error) {
    return error.message.startsWith("The main connection is not a chat completion API")
      ? "threw"
      : `wrong error: ${error.message}`;
  } finally {
    store.mainApi = "openai";
  }
}, "threw");

// Model list
await check("generate: main preserves provider restrictions and worker overrides", async () => {
  store.chatCompletionSettings.openrouter_providers = ["DeepSeek"];
  store.chatCompletionSettings.openrouter_allow_fallbacks = false;
  store.chatCompletionSettings.openrouter_use_fallback = true;
  await llm.generate({ messages: [{ role: "user", content: "hi" }], overridePayload: { use_fallback: false, n: 1 } });
  return [capturedMainPayload.provider, capturedMainPayload.allow_fallbacks, capturedMainPayload.use_fallback, capturedMainPayload.n];
}, [["DeepSeek"], false, false, 1]);

await check("generate: main preset is applied before the token/model overrides", async () => {
  store.ChatCompletionService.presetToGeneratePayload = async (_settings, _preset, payload) => ({ temperature: 0.7, ...payload });
  await llm.generate({ messages: [{ role: "user", content: "hi" }], model: "worker-model", maxTokens: 64 });
  delete store.ChatCompletionService.presetToGeneratePayload;
  return [capturedMainPayload.temperature, capturedMainPayload.model, capturedMainPayload.max_tokens];
}, [0.7, "worker-model", 64]);

await check("models: profile list normalized", async () => {
  const { models, error } = await llm.fetchModels("p1");
  return [models.map((m) => m.id), error];
}, [["alpha", "zeta"], null]);

await check("models: status body for profile", () => {
  const body = JSON.parse(fetchedRequests.at(-1).init.body);
  return [fetchedRequests.at(-1).url, body.chat_completion_source, body.secret_id, body.custom_url, body.reverse_proxy];
}, ["/api/backends/chat-completions/status", "openrouter", "s1", undefined, ""]);

await check("models: proxy preset resolved", async () => {
  await llm.fetchModels("p3");
  const body = JSON.parse(fetchedRequests.at(-1).init.body);
  return [body.reverse_proxy, body.proxy_password];
}, ["https://proxy.example/v1", "pw"]);

await check("models: main connection body", async () => {
  await llm.fetchModels("");
  const body = JSON.parse(fetchedRequests.at(-1).init.body);
  return [body.chat_completion_source, body.custom_url];
}, ["openrouter", ""]);

await check("models: unknown profile", async () => {
  const { models, error } = await llm.fetchModels("nope");
  return [models, error];
}, [[], "Connection profile not found"]);

// Errors
await check("errors: cause is appended", () => {
  return llm.describeError(new Error("API request failed", { cause: new Error("401 unauthorized") }));
}, "API request failed: 401 unauthorized");

await check("errors: plain error", () => llm.describeError(new Error("boom")), "boom");

// State store
await check("state: empty by default", () => getState(), { version: 1, revision: 0, updatedAt: 0, data: {}, history: [] });

await check("state: set bumps revision", () => {
  savedMetadata = 0;
  const s = setState({ location: "tavern" });
  return [s.revision, s.data, savedMetadata];
}, [1, { location: "tavern" }, 1]);

await check("state: merge keeps keys", () => {
  const s = updateState({ weather: "rain" });
  return [s.revision, s.data];
}, [2, { location: "tavern", weather: "rain" }]);

await check("state: export/import roundtrip", () => {
  const json = exportState();
  resetState();
  const imported = JSON.parse(json).data;
  const s = state.importState(json);
  return [s.data, imported];
}, [{ location: "tavern", weather: "rain" }, { location: "tavern", weather: "rain" }]);

await check("state: reset clears", () => {
  resetState();
  return getState();
}, { version: 1, revision: 0, updatedAt: 0, data: {}, history: [] });

// Report
let failed = 0;
for (const r of results) {
  if (!r.ok) {
    failed += 1;
    console.log(`FAIL  ${r.name}\n      expected: ${JSON.stringify(r.expected)}\n      actual:   ${JSON.stringify(r.actual)}`);
  } else {
    console.log(`ok    ${r.name}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
