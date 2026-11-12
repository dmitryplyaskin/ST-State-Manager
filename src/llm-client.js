/**
 * ST-State-Manager — model call client.
 *
 * Two ways of calling a model are supported:
 *
 *  1. Through a Connection Manager profile (`profileId` is set). This is the
 *     recommended path: the profile carries the API source, endpoint, secret,
 *     preset and instruct template, and the profile's model can be overridden
 *     for this single call.
 *
 *  2. Through the main SillyTavern connection (`profileId` is empty). Only chat
 *     completion APIs are supported here; the payload is assembled from the
 *     current chat completion settings.
 *
 * See RESEARCH.md for the full write-up and for the source references.
 */

import { getSettings } from "./settings.js";

const LOG_PREFIX = "[ST-State-Manager]";

export const CHAT_STATUS_URL = "/api/backends/chat-completions/status";
export const TEXT_STATUS_URL = "/api/backends/text-completions/status";
export const CHAT_GENERATE_URL = "/api/backends/chat-completions/generate";

/**
 * @typedef {object} ChatMessage
 * @property {"system" | "user" | "assistant"} role
 * @property {string} content
 */

/**
 * @typedef {object} GenerateOptions
 * @property {string} [profileId] Connection profile id, "" = main connection.
 * @property {string} [model] Model override, "" = profile/main model.
 * @property {ChatMessage[]} messages Messages to send.
 * @property {number} [maxTokens] Maximum number of generated tokens.
 * @property {number | null} [temperature] Sampling temperature, null = leave as is.
 * @property {boolean} [includePreset] Apply the profile's generation preset.
 * @property {boolean} [stream] Request a streaming response.
 * @property {AbortSignal | null} [signal] Abort signal.
 * @property {((text: string, reasoning: string) => void) | null} [onToken] Streaming callback.
 * @property {Record<string, unknown>} [overridePayload] Extra payload fields.
 */

/**
 * @typedef {object} GenerateResult
 * @property {string} content Generated text.
 * @property {string} reasoning Extracted reasoning, if any.
 * @property {string} backend "profile" or "main".
 * @property {string} profileId Profile id, "" for the main connection.
 * @property {string} model Model that was requested.
 */

function context() {
  return SillyTavern.getContext();
}

/**
 * @returns {boolean} Whether a Connection Manager profile can be used.
 */
export function isConnectionManagerAvailable() {
  const { extensionSettings } = context();
  const disabled = Array.isArray(extensionSettings?.disabledExtensions)
    ? extensionSettings.disabledExtensions
    : [];
  return !disabled.includes("connection-manager");
}

/**
 * Returns profiles that ConnectionManagerRequestService can work with
 * (chat completion and text completion APIs).
 * @returns {Array<Record<string, any>>}
 */
export function getSupportedProfiles() {
  if (!isConnectionManagerAvailable()) {
    return [];
  }
  try {
    return context().ConnectionManagerRequestService.getSupportedProfiles();
  } catch (error) {
    console.warn(`${LOG_PREFIX} Could not list connection profiles`, error);
    return [];
  }
}

/**
 * @param {string} profileId
 * @returns {Record<string, any> | null}
 */
export function getProfile(profileId) {
  if (!profileId) {
    return null;
  }
  const profiles = context().extensionSettings?.connectionManager?.profiles ?? [];
  return profiles.find((profile) => profile.id === profileId) ?? null;
}

/**
 * Returns the model of the main SillyTavern connection.
 * @returns {string}
 */
export function getMainApiModel() {
  const ctx = context();
  if (ctx.mainApi !== "openai") {
    return "";
  }
  return ctx.getChatCompletionModel(ctx.chatCompletionSettings) ?? "";
}

/**
 * Resolves the model that will be sent with a request.
 * @param {string} profileId
 * @param {string} modelOverride
 * @returns {string}
 */
export function resolveModel(profileId, modelOverride) {
  const override = String(modelOverride ?? "").trim();
  if (override) {
    return override;
  }
  if (profileId) {
    return String(getProfile(profileId)?.model ?? "");
  }
  return String(getMainApiModel() ?? "");
}

/**
 * Finds the proxy preset referenced by a connection profile.
 * @param {Record<string, any>} profile
 * @returns {{ name: string, url: string, password: string } | null}
 */
function getProxyPreset(profile) {
  const presets = context().chatCompletionSettings?.proxies;
  if (!profile?.proxy || !Array.isArray(presets)) {
    return null;
  }
  return presets.find((preset) => preset.name === profile.proxy) ?? null;
}

/**
 * Builds a `/status` request body for a connection profile.
 * @param {Record<string, any>} profile
 * @returns {{ url: string, body: Record<string, unknown> }}
 */
function buildProfileStatusRequest(profile) {
  const map = context().CONNECT_API_MAP?.[profile.api];
  if (!map) {
    throw new Error(`Unknown API type "${profile.api ?? ""}"`);
  }

  if (map.selected === "openai" && map.source) {
    const proxy = getProxyPreset(profile);
    const body = {
      chat_completion_source: map.source,
      secret_id: profile["secret-id"],
      custom_url: profile["api-url"],
      reverse_proxy: proxy?.url ?? "",
    };
    if (proxy?.url) {
      body.proxy_password = proxy.password ?? "";
    }
    return { url: CHAT_STATUS_URL, body };
  }

  if (map.selected === "textgenerationwebui" && map.type) {
    if (!profile["api-url"]) {
      throw new Error("The profile has no server URL");
    }
    return {
      url: TEXT_STATUS_URL,
      body: { api_type: map.type, api_server: profile["api-url"] },
    };
  }

  throw new Error(`API type "${profile.api}" does not support model listing`);
}

/**
 * Builds a `/status` request body for the main SillyTavern connection.
 * @returns {{ url: string, body: Record<string, unknown> }}
 */
function buildMainStatusRequest() {
  const ctx = context();
  if (ctx.mainApi !== "openai") {
    throw new Error("Model listing is available only for chat completion connections");
  }

  const settings = ctx.chatCompletionSettings;
  const includeHeaders = typeof settings.custom_include_headers === "string"
    && typeof ctx.substituteParams === "function"
    ? ctx.substituteParams(settings.custom_include_headers)
    : settings.custom_include_headers;

  return {
    url: CHAT_STATUS_URL,
    body: {
      chat_completion_source: settings.chat_completion_source,
      reverse_proxy: settings.reverse_proxy || "",
      proxy_password: settings.proxy_password || "",
      custom_url: settings.custom_url,
      custom_include_headers: includeHeaders,
      azure_base_url: settings.azure_base_url,
      azure_deployment_name: settings.azure_deployment_name,
      azure_api_version: settings.azure_api_version,
      siliconflow_endpoint: settings.siliconflow_endpoint,
      minimax_endpoint: settings.minimax_endpoint,
      pollinations_endpoint: settings.pollinations_endpoint,
      workers_ai_account_id: settings.workers_ai_account_id,
    },
  };
}

/**
 * Fetches the model list for a profile (or for the main connection).
 * Never throws: failures are reported through the `error` field so the UI can
 * fall back to free-form model input.
 * @param {string} [profileId]
 * @returns {Promise<{ models: Array<{ id: string, name: string }>, error: string | null }>}
 */
export async function fetchModels(profileId = "") {
  try {
    let request;
    if (profileId) {
      const profile = getProfile(profileId);
      if (!profile) {
        return { models: [], error: "Connection profile not found" };
      }
      request = buildProfileStatusRequest(profile);
    } else {
      request = buildMainStatusRequest();
    }

    const response = await fetch(request.url, {
      method: "POST",
      headers: context().getRequestHeaders(),
      body: JSON.stringify(request.body),
      cache: "no-cache",
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const detail = data?.message ?? data?.error?.message;
      return { models: [], error: detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}` };
    }
    if (data?.error) {
      return { models: [], error: String(data.message ?? "The provider rejected the model list request") };
    }

    const raw = Array.isArray(data?.data) ? data.data : [];
    const models = normalizeModels(raw);
    return { models, error: models.length ? null : "The provider returned an empty model list" };
  } catch (error) {
    console.warn(`${LOG_PREFIX} Model list request failed`, error);
    return { models: [], error: describeError(error) };
  }
}

/**
 * @param {unknown[]} raw
 * @returns {Array<{ id: string, name: string }>}
 */
function normalizeModels(raw) {
  const byId = new Map();
  for (const item of raw) {
    let id = "";
    let name = "";
    if (typeof item === "string") {
      id = item;
    } else if (item && typeof item === "object") {
      const record = /** @type {Record<string, unknown>} */ (item);
      id = String(record.id ?? record.name ?? record.model ?? "");
      name = String(record.name ?? record.id ?? "");
    }
    id = id.trim();
    if (!id) {
      continue;
    }
    byId.set(id, { id, name: name.trim() || id });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Sends a generation request.
 *
 * With a profile id the request goes through `ConnectionManagerRequestService`
 * and the model is replaced for this single call through `overridePayload`.
 * Without a profile id the main chat completion connection is used.
 *
 * @param {GenerateOptions} options
 * @returns {Promise<GenerateResult>}
 */
export async function generate(options) {
  const {
    profileId = "",
    model = "",
    messages,
    maxTokens = 512,
    temperature = null,
    includePreset = true,
    stream = false,
    signal = null,
    onToken = null,
    overridePayload = {},
  } = options ?? {};

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("At least one message is required");
  }

  const resolvedModel = resolveModel(profileId, model);
  const tokenLimit = Math.max(1, Math.floor(Number(maxTokens) || 512));

  if (profileId) {
    return generateWithProfile({
      profileId,
      resolvedModel,
      messages,
      maxTokens: tokenLimit,
      temperature,
      includePreset,
      stream,
      signal,
      onToken,
      overridePayload,
    });
  }

  return generateWithMainApi({
    resolvedModel,
    messages,
    maxTokens: tokenLimit,
    temperature,
    stream,
    signal,
    onToken,
    includePreset,
    overridePayload,
  });
}

/**
 * @param {object} options
 * @param {string} options.profileId
 * @param {string} options.resolvedModel
 * @param {ChatMessage[]} options.messages
 * @param {number} options.maxTokens
 * @param {number | null} options.temperature
 * @param {boolean} options.includePreset
 * @param {boolean} options.stream
 * @param {AbortSignal | null} options.signal
 * @param {((text: string, reasoning: string) => void) | null} options.onToken
 * @param {Record<string, unknown>} options.overridePayload
 * @returns {Promise<GenerateResult>}
 */
async function generateWithProfile(options) {
  const ctx = context();

  if (!isConnectionManagerAvailable()) {
    throw new Error(
      "Connection Manager is disabled. Enable the Connection Manager extension or use the main connection.",
    );
  }

  const service = ctx.ConnectionManagerRequestService;
  if (!service) {
    throw new Error("ConnectionManagerRequestService is not available");
  }

  /**
   * The override payload is merged into the request payload after the profile
   * values, so `model` wins. Important: never pass `{ model: undefined }` —
   * undefined keys are deleted from the payload by `createRequestData`, which
   * would remove the model entirely.
   */
  const overrides = { ...(options.overridePayload ?? {}) };
  const trimmedModel = String(options.resolvedModel ?? "").trim();
  if (trimmedModel) {
    overrides.model = trimmedModel;
  }
  if (Number.isFinite(options.temperature)) {
    overrides.temperature = Number(options.temperature);
  }

  const result = await service.sendRequest(
    options.profileId,
    options.messages,
    options.maxTokens,
    {
      stream: options.stream,
      extractData: true,
      includePreset: options.includePreset,
      signal: options.signal ?? undefined,
    },
    overrides,
  );

  return consumeResult(result, options.onToken, {
    backend: "profile",
    profileId: options.profileId,
    model: trimmedModel || String(getProfile(options.profileId)?.model ?? ""),
  });
}

/**
 * @param {object} options
 * @param {string} options.resolvedModel
 * @param {ChatMessage[]} options.messages
 * @param {number} options.maxTokens
 * @param {number | null} options.temperature
 * @param {boolean} options.stream
 * @param {AbortSignal | null} options.signal
 * @param {((text: string, reasoning: string) => void) | null} options.onToken
 * @returns {Promise<GenerateResult>}
 */
async function generateWithMainApi(options) {
  const ctx = context();

  if (ctx.mainApi !== "openai") {
    throw new Error(
      "The main connection is not a chat completion API. Select a Connection Manager profile instead.",
    );
  }

  const settings = ctx.chatCompletionSettings;
  const service = ctx.ChatCompletionService;

  /** @type {Record<string, unknown>} */
  const payload = {
    stream: options.stream,
    messages: options.messages,
    model: options.resolvedModel,
    chat_completion_source: settings.chat_completion_source,
    max_tokens: options.maxTokens,
    custom_prompt_post_processing: settings.custom_prompt_post_processing,
  };

  if (Number.isFinite(options.temperature)) {
    payload.temperature = Number(options.temperature);
  }
  if (settings.chat_completion_source === "custom" && settings.custom_url) {
    payload.custom_url = settings.custom_url;
  }
  if (settings.reverse_proxy) {
    payload.reverse_proxy = settings.reverse_proxy;
    payload.proxy_password = settings.proxy_password;
  }

  if (settings.chat_completion_source === "openrouter") {
    Object.assign(payload, {
      use_fallback: Boolean(settings.openrouter_use_fallback),
      provider: settings.openrouter_providers,
      allow_fallbacks: settings.openrouter_allow_fallbacks,
      middleout: settings.openrouter_middleout,
    });
  }
  Object.assign(payload, options.overridePayload || {});
  if (options.resolvedModel) payload.model = options.resolvedModel;

  const data = options.includePreset && typeof service.presetToGeneratePayload === "function"
    ? await service.presetToGeneratePayload(settings, {}, payload)
    : service.createRequestData(payload);
  const result = await service.sendRequest(data, true, options.signal);
  const model = String(options.resolvedModel || ctx.getChatCompletionModel(settings) || "");

  return consumeResult(result, options.onToken, {
    backend: "main",
    profileId: "",
    model,
  });
}

/**
 * Turns a non-streaming result or a streaming generator into a single result.
 * @param {any} result
 * @param {((text: string, reasoning: string) => void) | null} onToken
 * @param {{ backend: string, profileId: string, model: string }} meta
 * @returns {Promise<GenerateResult>}
 */
async function consumeResult(result, onToken, meta) {
  if (typeof result === "function") {
    let content = "";
    let reasoning = "";
    for await (const chunk of result()) {
      if (typeof chunk?.text === "string") {
        content = chunk.text;
      }
      if (typeof chunk?.state?.reasoning === "string") {
        reasoning = chunk.state.reasoning;
      }
      if (onToken) {
        try {
          onToken(content, reasoning);
        } catch (error) {
          console.error(`${LOG_PREFIX} onToken callback failed`, error);
        }
      }
    }
    return { ...meta, content, reasoning };
  }

  return {
    ...meta,
    content: typeof result?.content === "string" ? result.content : "",
    reasoning: typeof result?.reasoning === "string" ? result.reasoning : "",
  };
}

/**
 * Produces a readable error message, including the `cause` that
 * ConnectionManagerRequestService wraps provider errors into.
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  if (!error) {
    return "Unknown error";
  }
  const err = /** @type {{ message?: string, cause?: { message?: string } }} */ (error);
  const message = err.message || String(error);
  const cause = err.cause?.message;
  return cause && cause !== message ? `${message}: ${cause}` : message;
}

/**
 * Convenience helper for the settings panel: sends a single user message with
 * the current extension settings.
 * @param {string} prompt
 * @returns {Promise<GenerateResult & { elapsedMs: number }>}
 */
export async function runTestRequest(prompt) {
  const settings = getSettings();
  const started = performance.now();
  const result = await generate({
    profileId: settings.profileId,
    model: settings.model,
    messages: [{ role: "user", content: prompt }],
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
    includePreset: settings.includePreset,
    stream: false,
  });
  return { ...result, elapsedMs: Math.round(performance.now() - started) };
}
