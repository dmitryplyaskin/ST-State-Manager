import assert from "node:assert/strict";

const hooks = new Map();
const eventTypes = Object.fromEntries([
  "CHAT_CHANGED", "MESSAGE_SENT", "GENERATION_AFTER_COMMANDS", "MESSAGE_RECEIVED", "GENERATION_ENDED",
  "MESSAGE_SWIPED", "GENERATION_STOPPED", "MESSAGE_EDITED", "MESSAGE_UPDATED", "MESSAGE_DELETED",
  "CHAT_COMPLETION_PROMPT_READY",
].map(name => [name, name]));
let calls = [];
let answer = async () => ({ content: '{"location":"library"}' });
let chatId = "test-chat";
const injections = new Map();
const ctx = {
  extensionSettings: { disabledExtensions: [], connectionManager: { profiles: [{ id: "test", api: "openrouter", model: "deepseek-test" }] } },
  chatMetadata: {}, chat: [], name1: "Сузуме", name2: "Норико", mainApi: "openai",
  getCurrentChatId: () => chatId,
  saveSettingsDebounced() {}, saveMetadataDebounced() {},
  eventTypes, eventSource: { on(name, callback) {
    const list = hooks.get(name) || []; list.push(callback); hooks.set(name, list);
  }, removeListener(name, callback) {
    hooks.set(name, (hooks.get(name) || []).filter(listener => listener !== callback));
  } },
  setExtensionPrompt(key, value, position, depth, scan, role) { injections.set(key, { value, position, depth, scan, role }); },
  ConnectionManagerRequestService: { async sendRequest(...args) { calls.push(args); return answer(...args); } },
};
globalThis.SillyTavern = { getContext: () => ctx };
globalThis.toastr = { error() {} };
const settings = await import("../src/settings.js");
const state = await import("../src/state-store.js");
const worker = await import("../src/worker.js");
const injector = await import("../src/injector.js");
settings.loadSettings();
settings.updateSetting("enabled", false);
const { initRuntime } = await import("../src/runtime.js");
initRuntime();
assert.equal([...hooks.values()].flat().length, 0, "Disabled startup must not attach chat hooks");
assert.equal(injections.size, 0, "Disabled startup must not create an injection entry");
settings.updateSetting("enabled", true);
async function emit(name, ...args) { for (const callback of hooks.get(name) || []) await callback(...args); }
const flush = () => new Promise(resolve => setImmediate(resolve));
function configure(values) { for (const [key, value] of Object.entries(values)) settings.updateSetting(key, value); }
function fixture() {
  worker.cancelWorker();
  settings.resetSettings();
  configure({ profileId: "test", autoUpdate: true });
  ctx.chatMetadata = {}; chatId = "test-chat";
  ctx.chat = [{ name: "Сузуме", is_user: true, mes: "Я в библиотеке." }, { name: "Норико", is_user: false, mes: "Я рядом." }];
  ctx.streamingProcessor = null;
  calls = [];
  answer = async () => ({ content: '{"location":"library"}' });
  worker.onGenerationStarted("normal", {}, false);
}
let passed = 0;
async function test(name, callback) {
  fixture();
  await callback();
  passed++;
  console.log(`ok    ${name}`);
}

await test("settings: automatic calls require an explicit opt-in", () => {
  settings.resetSettings(); assert.equal(settings.getSettings().autoUpdate, false);
  configure({ frequency: -3, lastMessagesCount: 9999, injectDepth: -2, historyLimit: "bad" });
  assert.deepEqual([settings.getSettings().frequency, settings.getSettings().lastMessagesCount,
    settings.getSettings().injectDepth, settings.getSettings().historyLimit], [1, 200, 0, 50]);
});
await test("settings: migrate only the exact old bundled prompt", () => {
  const legacy = settings.DEFAULT_PROMPT.replace("Current state:", "Current state (JSON):")
    .replace(/Return the complete updated scene state[\s\S]*$/, "Previous state history (most recent first):\n{{history}}\n\nReturn ONLY a compact JSON object containing the new full scene state (not a patch or storage metadata). Track locations, characters, clothing, possessions and relevant facts when established; omit unknown fields. No commentary.");
  configure({ promptTemplate: legacy });
  settings.loadSettings();
  assert.equal(settings.getSettings().promptTemplate, settings.DEFAULT_PROMPT);
  assert(!settings.DEFAULT_PROMPT.includes("{{history}}"));
  configure({ promptTemplate: legacy + "\nMy own instruction" });
  settings.loadSettings();
  assert.equal(settings.getSettings().promptTemplate, legacy + "\nMy own instruction");
});
await test("history: migrate old documents and preserve the previous state", () => {
  ctx.chatMetadata[state.STATE_KEY] = { version: 1, revision: 3, updatedAt: 100, data: { old: true } };
  state.setState({ new: true }, { trigger: "auto-after" });
  assert.deepEqual(state.getHistory(), [{ revision: 3, updatedAt: 100, data: { old: true }, trigger: "manual" }]);
});
await test("history: trim oldest snapshots and restore into a new revision", () => {
  configure({ historyLimit: 2 });
  for (let i = 1; i <= 4; i++) state.setState({ i });
  assert.deepEqual(state.getHistory().map(entry => entry.revision), [2, 3]);
  const restored = state.rollbackTo(2);
  assert.deepEqual([restored.revision, restored.data, restored.trigger], [5, { i: 2 }, "rollback"]);
  assert.deepEqual(state.getHistory().map(entry => entry.revision), [3, 4]);
  assert.throws(() => state.rollbackTo(1), /no longer/);
});
await test("history: snapshots do not alias model data or public reads", () => {
  const data = { actor: { clothes: "coat" } };
  const written = state.setState(data);
  data.actor.clothes = "changed"; written.data.actor.clothes = "changed again";
  state.setState({ actor: { clothes: "shirt" } });
  const history = state.getHistory(); history[0].data.actor.clothes = "changed";
  assert.equal(state.getHistory()[0].data.actor.clothes, "coat");
});
await test("history: zero disables retention, invalid data cannot erase state", () => {
  state.setState({ keep: true }); configure({ historyLimit: 0 }); state.setState({ current: true });
  assert.deepEqual(state.getHistory(), []);
  for (const value of [null, 1, undefined]) assert.throws(() => state.setState(value));
  assert.deepEqual(state.getState().data, { current: true });
});
await test("template: replace once, preserve braces in source messages", () => {
  const output = worker.renderTemplate("{{state}} {{ last_messages }} {{char_name}} {{chat_name}} {{history}}", {
    state: "{}", last_messages: "{{state}}", char_name: "Норико", chat_name: "test", history: "[]",
  });
  assert.equal(output, "{} {{state}} Норико test []");
});
await test("prompt: read the configured non-system tail with role and name", () => {
  ctx.chat.unshift({ is_system: true, mes: "not source material" });
  configure({ lastMessagesCount: 1, promptTemplate: "{{last_messages}}" });
  assert.equal(worker.buildWorkerPrompt(), "[assistant] Норико: Я рядом.");
});
await test("parser: retain structured data and preserve arbitrary formats", () => {
  assert.deepEqual(worker.parseStateResponse('{"ok":true}'), { ok: true });
  assert.deepEqual(worker.parseStateResponse('[{"ok":true}]'), [{ ok: true }]);
  for (const text of ["# Сцена\nТекст", "<scene>library</scene>", '```json\n{"ok":true}\n```', 'Result: {"ok":true} Done.', '{"ok":', "null", "3"]) {
    assert.equal(worker.parseStateResponse(text), text);
  }
  assert.throws(() => worker.parseStateResponse("  "), /no state text/);
});
await test("text: history, rollback, injection and prompt preserve exact output", () => {
  const text = "# Сцена\n  Две кружки\n<location>Комната</location>\n";
  state.setState(text);
  assert.equal(state.stateText(state.getState()), text);
  configure({ promptTemplate: "{{state}}" });
  assert.equal(worker.buildWorkerPrompt(), text);
  assert.equal(injections.get(injector.PROMPT_KEY).value, injector.formatInjection(text));
  state.setState(["next"]);
  assert.equal(state.stateText(state.rollbackTo(1)), text);
  assert.throws(() => state.updateState({ key: true }), /Only objects/);
});
await test("manual: commit a full state, force one non-streaming response", async () => {
  await emit("GENERATION_ENDED");
  answer = async () => ({ content: '{"location":"library"}', provider: "DeepSeek", requestId: "gen-worker-test" });
  ctx.chatMetadata[state.COUNTER_KEY] = 2;
  const result = await worker.runWorker();
  assert.equal(result.ok, true);
  assert.deepEqual(state.getState().data, { location: "library" });
  assert.equal(worker.getTurnCounter(), 2);
  assert.equal(calls[0][3].stream, false); assert.equal(calls[0][4].n, 1);
  assert.equal(calls[0][4].use_fallback, false);
  assert.equal(ctx.chat.length, 2);
  assert.equal(worker.getWorkerStatus().provider, "DeepSeek");
  assert.equal(worker.getWorkerStatus().requestId, "gen-worker-test");
});
await test("worker: plain text becomes state and exact JSON whitespace survives injection", async () => {
  await emit("GENERATION_ENDED");
  answer = async () => ({ content: "В комнате две кружки." });
  assert.equal((await worker.runWorker()).ok, true);
  assert.equal(state.getState().data, "В комнате две кружки.");
  const text = ' { "location" : "library" }\n';
  answer = async () => ({ content: text });
  await worker.runWorker();
  assert.deepEqual(state.getState().data, { location: "library" });
  assert.equal(state.stateText(state.getState()), text);
  assert.equal(injections.get(injector.PROMPT_KEY).value, injector.formatInjection(text));
});
await test("worker: explain a reasoning-only response without overwriting state", async () => {
  state.setState({ keep: true }); await emit("GENERATION_ENDED");
  answer = async () => ({ content: "", reasoning: "token budget exhausted" });
  const result = await worker.runWorker();
  assert.match(result.error, /reasoning but no state text/);
  assert.deepEqual(state.getState().data, { keep: true });
});
await test("worker: explicit token truncation cannot replace the previous state", async () => {
  state.setState("Keep this scene"); await emit("GENERATION_ENDED");
  answer = async () => ({ content: "Truncated scene", finishReason: "length" });
  const result = await worker.runWorker();
  assert.equal(result.ok, false);
  assert.equal(state.getState().data, "Keep this scene");
  assert.match(result.error, /лимитом токенов/);
});
await test("before: the MESSAGE_SENT emitter waits for the worker", async () => {
  configure({ trigger: "before" }); ctx.chat.pop();
  let release; answer = () => new Promise(resolve => { release = resolve; });
  let completed = false;
  const event = emit("MESSAGE_SENT", 0).then(() => { completed = true; });
  await flush(); assert.equal(completed, false); assert.equal(calls.length, 1);
  release({ content: '{"ready":true}' }); await event;
  assert.equal(completed, true); assert.deepEqual(state.getState().data, { ready: true });
  assert.equal(worker.getTurnCounter(), 0);
});
await test("frequency: count only new user messages, not duplicate events or assistant/system messages", async () => {
  configure({ trigger: "before", frequency: 2 }); ctx.chat.pop();
  await emit("MESSAGE_SENT", 0); await emit("MESSAGE_SENT", 0);
  assert.equal(worker.getTurnCounter(), 1); assert.equal(calls.length, 0);
  ctx.chat.push({ is_user: true, is_system: true, mes: "system" }); await emit("MESSAGE_SENT", 1);
  ctx.chat.push({ is_user: false, mes: "assistant" }); await emit("MESSAGE_SENT", 2);
  assert.equal(worker.getTurnCounter(), 1);
  ctx.chat.push({ is_user: true, mes: "Second turn" }); await emit("MESSAGE_SENT", 3);
  assert.equal(calls.length, 1); assert.equal(worker.getTurnCounter(), 0);
});
await test("after: non-streaming RECEIVED then ENDED triggers one update", async () => {
  ctx.chat.pop(); await emit("MESSAGE_SENT", 0);
  ctx.chat.push({ is_user: false, mes: "Done" });
  await emit("MESSAGE_RECEIVED", 1, "normal"); assert.equal(calls.length, 0);
  await emit("GENERATION_ENDED"); await flush();
  await emit("GENERATION_ENDED"); await flush();
  assert.equal(calls.length, 1); assert.equal(state.getState().trigger, "auto-after");
});
await test("after: streaming ENDED then RECEIVED waits for actual output", async () => {
  ctx.chat.pop(); await emit("MESSAGE_SENT", 0);
  await emit("GENERATION_ENDED"); await flush(); assert.equal(calls.length, 0);
  ctx.chat.push({ is_user: false, mes: "Done streaming" });
  await emit("MESSAGE_RECEIVED", 1, "normal"); await flush(); assert.equal(calls.length, 1);
});
await test("after: failed or stopped generations do not consume a pending turn", async () => {
  ctx.chat.pop(); await emit("MESSAGE_SENT", 0);
  await emit("GENERATION_ENDED"); await flush(); assert.equal(calls.length, 0);
  await emit("GENERATION_STOPPED"); ctx.chat.push({ is_user: false, mes: "partial" });
  await emit("MESSAGE_RECEIVED", 1, "normal"); await flush();
  assert.equal(calls.length, 0); assert.equal(worker.getTurnCounter(), 1);
});
await test("after: remember a streaming failure even after ST clears the processor", async () => {
  ctx.chat.pop(); await emit("MESSAGE_SENT", 0);
  ctx.streamingProcessor = { isStopped: true };
  await emit("GENERATION_ENDED"); ctx.streamingProcessor = null;
  ctx.chat.push({ is_user: false, mes: "partial response" });
  await emit("MESSAGE_RECEIVED", 1, "normal"); await flush();
  assert.equal(calls.length, 0); assert.equal(worker.getTurnCounter(), 1);
});
await test("swipes: existing choices update without advancing the turn counter", async () => {
  configure({ frequency: 5 });
  ctx.chat[1].swipe_id = 0; ctx.chat[1].swipes = ["Я рядом."];
  await emit("MESSAGE_SWIPED", 1);
  assert.equal(calls.length, 1); assert.equal(worker.getTurnCounter(), 0);
  assert.equal(state.getState().trigger, "swipe");
});
await test("swipes: a new choice waits for its generated reply and updates once", async () => {
  ctx.chat[1].swipe_id = 1; ctx.chat[1].swipes = ["Я рядом."]; ctx.chat[1].mes = "";
  await emit("MESSAGE_SWIPED", 1); assert.equal(calls.length, 0);
  await emit("GENERATION_AFTER_COMMANDS", "swipe", {}, false);
  ctx.chat[1].mes = "Новый ответ";
  await emit("MESSAGE_RECEIVED", 1, "swipe"); await emit("GENERATION_ENDED"); await flush();
  assert.equal(calls.length, 1); assert.equal(state.getState().trigger, "swipe");
});
await test("swipes: disabling swipe updates suppresses existing and generated choices", async () => {
  configure({ regenOnSwipe: false });
  ctx.chat[1].swipe_id = 0; ctx.chat[1].swipes = [ctx.chat[1].mes];
  await emit("MESSAGE_SWIPED", 1);
  await emit("GENERATION_AFTER_COMMANDS", "swipe", {}, false);
  await emit("MESSAGE_RECEIVED", 1, "swipe"); await emit("GENERATION_ENDED"); await flush();
  assert.equal(calls.length, 0);
});
await test("scheduler: disabled automation, dry runs and quiet calls do not trigger paid calls", async () => {
  configure({ autoUpdate: false }); ctx.chat.pop(); await emit("MESSAGE_SENT", 0);
  await emit("GENERATION_ENDED"); await flush(); assert.equal(calls.length, 0);
  assert.equal(worker.getTurnCounter(), 0);
  configure({ autoUpdate: true });
  await emit("GENERATION_AFTER_COMMANDS", "quiet", {}, false);
  await emit("MESSAGE_RECEIVED", 0, "quiet"); await emit("GENERATION_ENDED"); await flush();
  assert.equal(calls.length, 0);
});
await test("concurrency: skip a second update and cancel without committing late output", async () => {
  await emit("GENERATION_ENDED");
  let release; answer = () => new Promise(resolve => { release = resolve; });
  const first = worker.runWorker(); await flush();
  assert.match((await worker.runWorker()).skipped, /already running/);
  worker.cancelWorker(); assert.equal((await first).ok, false);
  release({ content: '{"late":true}' }); await flush(); assert.equal(state.getState().revision, 0);
});
await test("settings: changing the worker model invalidates its in-flight result", async () => {
  await emit("GENERATION_ENDED");
  let release; answer = () => new Promise(resolve => { release = resolve; });
  const pending = worker.runWorker(); await flush(); configure({ model: "different-model" });
  assert.equal((await pending).ok, false);
  release({ content: '{"late":true}' }); await flush(); assert.equal(state.getState().revision, 0);
});
await test("chat switch: abort and discard even if the provider ignores its signal", async () => {
  await emit("GENERATION_ENDED");
  let release; answer = () => new Promise(resolve => { release = resolve; });
  const pending = worker.runWorker(); await flush(); const oldMetadata = ctx.chatMetadata;
  chatId = "other-chat"; ctx.chatMetadata = {}; await emit("CHAT_CHANGED");
  await pending; release({ content: '{"wrong_chat":true}' }); await flush();
  assert.equal(ctx.chatMetadata[state.STATE_KEY], undefined); assert.equal(oldMetadata[state.STATE_KEY], undefined);
});
await test("reset and rollback: cancel an in-flight worker before it can overwrite user changes", async () => {
  await emit("GENERATION_ENDED"); state.setState({ old: true }); state.setState({ current: true });
  let release; answer = () => new Promise(resolve => { release = resolve; });
  const pending = worker.runWorker(); await flush(); state.rollbackTo(1); await pending;
  release({ content: '{"late":true}' }); await flush(); assert.deepEqual(state.getState().data, { old: true });
  answer = () => new Promise(resolve => { release = resolve; });
  const next = worker.runWorker(); await flush(); state.resetState(); await next;
  release({ content: '{"late":true}' }); await flush(); assert.equal(state.getState().revision, 0);
});
await test("edits: a changed chat is rejected even without an event", async () => {
  await emit("GENERATION_ENDED");
  let release; answer = () => new Promise(resolve => { release = resolve; });
  const pending = worker.runWorker(); await flush(); ctx.chat[0].mes = "Edited";
  release({ content: '{"stale":true}' }); assert.equal((await pending).ok, false);
  assert.equal(state.getState().revision, 0);
});
await test("master switch: disable cancels the worker and clears injection", async () => {
  await emit("GENERATION_ENDED"); state.setState({ scene: true });
  let release; answer = () => new Promise(resolve => { release = resolve; });
  const pending = worker.runWorker(); await flush(); configure({ enabled: false });
  await pending; release({ content: '{"late":true}' }); await flush();
  assert.equal(injections.get(injector.PROMPT_KEY).value, "");
  assert.deepEqual(state.getState().data, { scene: true });
});
await test("injection: update role, position and depth immediately, clear on chat change/reset", async () => {
  configure({ injectRole: "assistant", injectPosition: 1, injectDepth: 3 }); state.setState({ scene: true });
  assert.deepEqual(injections.get(injector.PROMPT_KEY), {
    value: injector.formatInjection({ scene: true }), position: 1, depth: 3, scan: false, role: 2,
  });
  ctx.chatMetadata = {}; await emit("CHAT_CHANGED"); assert.equal(injections.get(injector.PROMPT_KEY).value, "");
  state.setState({ scene: true }); state.resetState(); assert.equal(injections.get(injector.PROMPT_KEY).value, "");
});
await test("merge: merge only state into adjacent same-role text and preserve other extensions", () => {
  const text = injector.formatInjection({ scene: true });
  const messages = [{ role: "assistant", content: "Reply" }, { role: "assistant", content: `Other extension\n${text}` }];
  injector.mergeStateMessage(messages, text); injector.mergeStateMessage(messages, text);
  assert.deepEqual(messages, [{ role: "assistant", content: `Reply\n\n${text}` }, { role: "assistant", content: "Other extension" }]);
});
await test("merge: keep multimodal content, tool messages and unrelated roles intact", () => {
  const text = injector.formatInjection({ scene: true });
  const messages = [{ role: "user", content: text }, { role: "user", content: [{ type: "image_url", image_url: { url: "test" } }] }];
  injector.mergeStateMessage(messages, text);
  assert.equal(messages.length, 1); assert.equal(messages[0].content[0].type, "text"); assert.equal(messages[0].content[1].type, "image_url");
  const tools = [{ role: "assistant", tool_calls: [{ id: "tool" }], content: "" }, { role: "assistant", content: text }, { role: "user", content: "Hi" }];
  const before = structuredClone(tools); injector.mergeStateMessage(tools, text); assert.deepEqual(tools, before);
});
await test("merge toggle: separate-role placement remains unchanged when merge is off", async () => {
  configure({ injectRole: "assistant", injectMerge: false }); state.setState({ scene: true });
  const text = injections.get(injector.PROMPT_KEY).value;
  const chat = [{ role: "assistant", content: "Reply" }, { role: "assistant", content: text }];
  await emit("CHAT_COMPLETION_PROMPT_READY", { chat }); assert.equal(chat.length, 2);
  configure({ injectMerge: true }); await emit("CHAT_COMPLETION_PROMPT_READY", { chat }); assert.equal(chat.length, 1);
});

await test("master switch: detach all hooks, preserve data and resume once", async () => {
  state.setState({ keep: true });
  const expectedHooks = [...hooks.values()].map(list => list.length);
  const metadata = structuredClone(ctx.chatMetadata);
  for (let i = 0; i < 3; i++) {
    configure({ enabled: false });
    assert.equal([...hooks.values()].flat().length, 0);
    const prompt = injections.get(injector.PROMPT_KEY);
    await emit("MESSAGE_SENT", 0);
    await emit("GENERATION_AFTER_COMMANDS", "normal");
    await emit("MESSAGE_RECEIVED", 1);
    await emit("GENERATION_ENDED");
    await emit("CHAT_CHANGED");
    await flush();
    assert.deepEqual(ctx.chatMetadata, metadata);
    assert.equal(injections.get(injector.PROMPT_KEY), prompt);
    assert.equal((await worker.runWorker()).ok, false);
    assert.equal(calls.length, 0);
    configure({ enabled: true });
    assert.deepEqual([...hooks.values()].map(list => list.length), expectedHooks);
    assert.match(injections.get(injector.PROMPT_KEY).value, /keep/);
  }
});

await test("panel: disabled startup and late templates cannot create UI", async () => {
  const panel = await import("../src/panel.js");
  const releases = [];
  let inserted = 0;
  const holder = { insertAdjacentHTML() { inserted++; } };
  globalThis.document = { getElementById: id => id === "top-settings-holder" ? holder : null };
  ctx.renderExtensionTemplateAsync = () => new Promise(resolve => releases.push(resolve));
  configure({ enabled: false });
  await panel.initPanel();
  assert.equal(releases.length, 0);
  configure({ enabled: true });
  const pending = panel.initPanel();
  assert.equal(panel.initPanel(), pending, "Concurrent initialization is shared");
  configure({ enabled: false }); panel.destroyPanel();
  configure({ enabled: true });
  const next = panel.initPanel();
  releases[0]("old panel"); await pending;
  assert.equal(inserted, 0, "An earlier enabled session cannot append its template");
  configure({ enabled: false }); panel.destroyPanel();
  releases[1]("new panel"); await next;
  assert.equal(inserted, 0);
  delete globalThis.document;
});

await test("master switch: reloaded settings resynchronize existing hooks", () => {
  settings.getSettings().enabled = false;
  initRuntime();
  assert.equal([...hooks.values()].flat().length, 0);
  settings.getSettings().enabled = true;
  initRuntime();
  const count = [...hooks.values()].flat().length;
  assert.ok(count > 0);
  initRuntime();
  assert.equal([...hooks.values()].flat().length, count);
});

console.log(`\n${passed}/${passed} state manager checks passed`);
