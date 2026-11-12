/** Regression: an empty saved preset must not erase the active profile's provider. */
import assert from "node:assert/strict";

const profiles = [
  { id: "active", api: "openrouter", name: "Active", model: "deepseek-test", preset: "empty-routing" },
  { id: "other", api: "openrouter", name: "Other", model: "other-model", preset: "other-routing" },
  { id: "no-preset", api: "openrouter", name: "Automatic", model: "other-model" },
  { id: "custom", api: "custom", model: "custom-model" },
];
const presets = {
  "empty-routing": { openrouter_providers: [], openrouter_allow_fallbacks: false },
  "other-routing": { openrouter_providers: ["OtherProvider"], openrouter_allow_fallbacks: false, openrouter_quantizations: ["fp8"] },
};
let captured;
const rawResponse = { id: "gen-test", provider: "DeepSeek", choices: [{ message: { content: '{"ok":true}', reasoning: "Reasoning text" } }] };
const ctx = {
  extensionSettings: { disabledExtensions: [], connectionManager: { profiles, selectedProfile: "active" } },
  mainApi: "openai",
  chatCompletionSettings: {},
  CONNECT_API_MAP: { openrouter: { selected: "openai", source: "openrouter" }, custom: { selected: "openai", source: "custom" } },
  getPresetManager: () => ({ getCompletionPresetByName: name => presets[name] }),
  saveSettingsDebounced() {},
  getChatCompletionModel: () => "deepseek-test",
  extractMessageFromData: raw => raw.choices[0].message.content,
  ConnectionManagerRequestService: { async sendRequest(profileId, messages, maxTokens, options, overrides) {
    captured = { profileId, messages, maxTokens, options, payload: overrides };
    return options.extractData ? { content: "custom reply", reasoning: "" } : structuredClone(rawResponse);
  } },
  ChatCompletionService: {
    createRequestData: data => data,
    async presetToGeneratePayload(_preset, _overrides, payload) { return { provider: [], allow_fallbacks: true, ...payload }; },
    async sendRequest(payload, extractData) { captured = { payload, extractData }; return structuredClone(rawResponse); },
  },
};
globalThis.SillyTavern = { getContext: () => ctx };
const settings = await import("../src/settings.js");
const llm = await import("../src/llm-client.js");
let passed = 0;
function fixture() {
  settings.resetSettings();
  ctx.extensionSettings.connectionManager.selectedProfile = "active";
  ctx.chatCompletionSettings = { chat_completion_source: "openrouter", openrouter_providers: ["DeepSeek"],
    openrouter_allow_fallbacks: false, openrouter_use_fallback: false, openrouter_quantizations: [], openrouter_middleout: "on" };
  profiles[0].preset = "empty-routing";
  captured = null;
}
async function test(name, callback) {
  fixture(); await callback(); passed++; console.log(`ok    ${name}`);
}
const generate = (profileId = "active", options = {}) => llm.generate({ profileId, messages: [{ role: "user", content: "OK?" }], ...options });

await test("active profile: an empty saved provider list cannot erase the visible DeepSeek selection", async () => {
  await generate();
  assert.deepEqual(captured.payload.provider, ["DeepSeek"]);
  assert.equal(captured.payload.allow_fallbacks, false);
});
await test("generation preset off: routing still applies", async () => {
  await generate("active", { includePreset: false });
  assert.equal(captured.options.includePreset, false);
  assert.deepEqual(captured.payload.provider, ["DeepSeek"]);
  assert.equal(captured.payload.allow_fallbacks, false);
});
await test("independent worker: remember the profile routing across main connection switches", async () => {
  llm.rememberActiveRouting("active");
  ctx.extensionSettings.connectionManager.selectedProfile = "other";
  ctx.chatCompletionSettings.openrouter_providers = ["UnrelatedProvider"];
  await generate();
  assert.deepEqual(captured.payload.provider, ["DeepSeek"]);
  assert.equal(llm.getOpenRouterRouting("active").source, "remembered");
});
await test("native provider edits: refresh the remembered profile instead of retaining stale restrictions", async () => {
  llm.rememberActiveRouting("active");
  ctx.chatCompletionSettings.openrouter_providers = ["NewSelection"];
  ctx.chatCompletionSettings.openrouter_allow_fallbacks = true;
  llm.rememberActiveRouting("active");
  ctx.extensionSettings.connectionManager.selectedProfile = "other";
  await generate();
  assert.deepEqual(captured.payload.provider, ["NewSelection"]);
  assert.equal(captured.payload.allow_fallbacks, true);
});
await test("inactive profile: use its own preset, never the main profile's provider", async () => {
  await generate("other");
  assert.deepEqual(captured.payload.provider, ["OtherProvider"]);
  assert.equal(captured.payload.allow_fallbacks, false);
  assert.deepEqual(captured.payload.quantizations, ["fp8"]);
});
await test("inactive profile without restrictions: override inherited global routing with explicit defaults", async () => {
  await generate("no-preset");
  assert.deepEqual(captured.payload.provider, []);
  assert.equal(captured.payload.allow_fallbacks, true);
});
await test("changed profile preset: ignore the snapshot from its old preset", async () => {
  llm.rememberActiveRouting("active");
  profiles[0].preset = "other-routing";
  ctx.extensionSettings.connectionManager.selectedProfile = "other";
  await generate();
  assert.deepEqual(captured.payload.provider, ["OtherProvider"]);
});
await test("response diagnostics: expose the actual provider, request ID and reasoning", async () => {
  const result = await generate();
  assert.deepEqual([result.content, result.reasoning, result.provider, result.requestId],
    ['{"ok":true}', "Reasoning text", "DeepSeek", "gen-test"]);
  assert.equal(captured.options.extractData, false);
});
await test("explicit caller override: it wins over resolved routing", async () => {
  await generate("active", { overridePayload: { provider: ["Explicit"], allow_fallbacks: false } });
  assert.deepEqual(captured.payload.provider, ["Explicit"]);
});
await test("main connection: retain routing even when the preset switch is off", async () => {
  await generate("", { includePreset: false });
  assert.deepEqual(captured.payload.provider, ["DeepSeek"]);
  assert.equal(captured.payload.allow_fallbacks, false);
  assert.equal(captured.extractData, false);
});
await test("other APIs: do not add OpenRouter constraints or change data extraction", async () => {
  await generate("custom");
  assert.deepEqual(captured.payload, { model: "custom-model" });
  assert.equal(captured.options.extractData, true);
});
await test("connection check: use the same routing, one completion and at most 128 tokens", async () => {
  settings.updateSetting("profileId", "active");
  const result = await llm.runTestRequest("OK?");
  assert.equal(captured.maxTokens, 128);
  assert.deepEqual(captured.payload.provider, ["DeepSeek"]);
  assert.equal(captured.payload.n, 1);
  assert.equal(result.provider, "DeepSeek");
});
console.log(`\n${passed}/${passed} provider routing checks passed`);
