import assert from "node:assert/strict";
const profile = { id: "test", name: "Test profile", api: "openrouter", model: "deepseek-test", preset: "test-preset", "secret-id": "private-secret-id", proxy: "test-proxy" };
let answer = async () => ({ id: "gen-test", provider: "DeepSeek", choices: [{ message: { content: "# Сцена\nДве кружки", reasoning: "Reason" }, finish_reason: "stop" }] });
let sent;
let saves = 0;
const ctx = {
  mainApi: "openai", chatMetadata: {}, getCurrentChatId: () => "test-chat",
  extensionSettings: { disabledExtensions: [], connectionManager: { selectedProfile: "test", profiles: [profile] } },
  chatCompletionSettings: { chat_completion_source: "openrouter", openrouter_providers: ["DeepSeek"], openrouter_allow_fallbacks: false,
    proxies: [{ name: "test-proxy", url: "https://proxy.test", password: "private-password" }] },
  CONNECT_API_MAP: { openrouter: { selected: "openai", source: "openrouter" } },
  saveSettingsDebounced() {}, saveMetadataDebounced() { saves++; },
  getPresetManager: () => ({ getCompletionPresetByName: () => ({ temperature: 0.6 }) }),
  getChatCompletionModel: () => "deepseek-test",
  extractMessageFromData: raw => Array.isArray(raw.content) ? raw.content.filter(p => p.type === "text").map(p => p.text).join("\n") : raw.choices[0].message.content,
  ConnectionManagerRequestService: {},
  ChatCompletionService: {
    createRequestData: data => Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    presetToGeneratePayload: async (preset, _, data) => ({ temperature: preset.temperature, ...data }),
    async sendRequest(data, extract, signal) { sent = structuredClone(data); assert.equal(extract, false); return answer(signal); },
  },
};
globalThis.SillyTavern = { getContext: () => ctx };
const settings = await import("../src/settings.js");
const log = await import("../src/request-log.js");
const llm = await import("../src/llm-client.js");
settings.loadSettings();
const request = options => llm.generate({ profileId: "test", messages: [{ role: "user", content: "Current state: room\n[assistant] Норико: две кружки" }], maxTokens: 256, ...options });
let passed = 0;
async function test(name, callback) { ctx.chatMetadata = {}; await callback(); passed++; console.log(`ok    ${name}`); }
await test("journal: capture the exact prepared payload, response and reasoning without credentials", async () => {
  const result = await request();
  const entry = log.getRequestLog()[0];
  assert.equal(entry.status, "success");
  assert.deepEqual(entry.payload, log.redact(sent));
  assert.equal(entry.payload.temperature, 0.6);
  assert.equal(entry.payload.secret_id, "[скрыто]");
  assert.equal(entry.payload.proxy_password, "[скрыто]");
  assert.equal(sent.proxy_password, "private-password");
  assert.equal(entry.response, result.content);
  assert.equal(entry.reasoning, "Reason");
  assert.equal(entry.rawResponse.id, "gen-test");
  assert.equal(entry.model, "deepseek-test");
  assert(!JSON.stringify(entry).includes("private-password"));
  assert(!JSON.stringify(entry).includes("private-secret-id"));
  entry.payload.messages[0].content = "mutated";
  assert.notEqual(log.getRequestLog()[0].payload.messages[0].content, "mutated");
  assert.deepEqual(log.getRequestLog(), JSON.parse(JSON.stringify(ctx.chatMetadata[log.REQUEST_LOG_KEY])));
});
await test("journal: retain the latest ten attempts and distinguish API errors", async () => {
  for (let i = 0; i < 12; i++) await request();
  answer = async () => { throw new Error("Provider unavailable"); };
  await assert.rejects(request(), /Provider unavailable/);
  const entries = log.getRequestLog();
  assert.equal(entries.length, 10);
  assert.equal(entries[0].status, "error");
  assert.equal(entries[0].error, "Provider unavailable");
  assert(entries[0].payload.messages[0].content.includes("Норико"));
});
await test("journal: cancellation stays cancelled even if a provider ignores abort", async () => {
  let release;
  answer = () => new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const pending = request({ signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new DOMException("Cancelled", "AbortError"));
  assert.equal(log.getRequestLog()[0].status, "cancelled");
  const previousMetadata = ctx.chatMetadata;
  ctx.chatMetadata = {};
  const saved = saves;
  release({ choices: [{ message: { content: "Late output" } }] });
  await pending;
  assert.equal(saves, saved, "Do not save an old chat into the newly active chat");
  assert.deepEqual(log.getRequestLog(), []);
  assert.equal(previousMetadata[log.REQUEST_LOG_KEY][0].status, "cancelled");
});
await test("raw API: support text blocks and preserve explicit truncation reason", async () => {
  answer = async () => ({ content: [{ type: "thinking", thinking: "Reason" }, { type: "text", text: "Scene" }], stop_reason: "max_tokens" });
  const result = await request();
  assert.equal(result.content, "Scene");
  assert.equal(result.reasoning, "Reason");
  assert.equal(result.finishReason, "max_tokens");
});
await test("journal: restored unfinished attempts are marked interrupted", () => {
  ctx.chatMetadata[log.REQUEST_LOG_KEY] = [{ id: "old", status: "running" }];
  assert.equal(log.getRequestLog()[0].status, "interrupted");
});
console.log(`\n${passed}/${passed} request journal checks passed`);
