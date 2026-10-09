"use strict";
const { MusicError, cleanSecret } = require("./providers/shared.cjs");
const { validateBaseUrl } = require("./agent/base-url.cjs");

/* ---------- cloud music services ---------- */

const PROVIDERS = ["elevenlabs", "tencent", "volcengine", "aliyun"];
function validateProvider(value = "elevenlabs") {
  if (!PROVIDERS.includes(value))
    throw new MusicError("不支持的音乐生成服务。");
  return value;
}
function secret(value, label) {
  const text = cleanSecret(value);
  if (!text) throw new MusicError(`${label} 格式不正确，请填写完整凭据。`);
  return text;
}
function normalizeCredentials(provider, input) {
  validateProvider(provider);
  if (!input || typeof input !== "object")
    throw new MusicError("请填写所选服务的连接信息。");
  if (provider === "volcengine") {
    const billingMode = input.billingMode ?? "postpaid";
    if (!["postpaid", "prepaid"].includes(billingMode))
      throw new MusicError("请选择正确的火山引擎计费方式。");
    return {
      accessKeyId: secret(input.accessKeyId, "Access Key ID"),
      secretAccessKey: secret(input.secretAccessKey, "Secret Access Key"),
      billingMode,
    };
  }
  const apiKey = secret(input.apiKey, "API Key");
  const models = {
    elevenlabs: ["music_v1", "music_v2", "music_v2_5"],
    tencent: ["minimax-music-v3.0", "minimax-music-v2.6"],
    aliyun: ["fun-music-preview", "fun-music-v1"],
  };
  const model = input.model ?? models[provider][0];
  if (!models[provider].includes(model))
    throw new MusicError("所选音乐模型不受支持。");
  if (provider === "aliyun") {
    const workspaceId =
      typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(workspaceId))
      throw new MusicError(
        "Workspace ID 格式不正确，请从北京地域业务空间详情复制。",
      );
    return { apiKey, workspaceId, model };
  }
  return { apiKey, model };
}

/* ---------- producer agent (large language model) ----------
 * A separate credential kind on purpose: LLM kinds never enter PROVIDERS, so they
 * can never be routed into the music adapters or listed as a music service. */

const LLM_KINDS = ["anthropic", "openai", "ollama"];
/** Claude models offered by the app; the first one is the default. */
const ANTHROPIC_MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
];
/** Free text: vendor model ids such as "deepseek-chat", "ep-2026…", "qwen3.5:9b-q4_K_M", "Qwen/Qwen3-72B". */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PRESET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

function validateLlmKind(value) {
  if (!LLM_KINDS.includes(value)) throw new MusicError("不支持的大模型类型。");
  return value;
}

/** A model id worth showing or sending; otherwise the fallback (which callers have validated). */
function safeModelId(value, fallback = "") {
  return typeof value === "string" && MODEL_PATTERN.test(value)
    ? value
    : fallback;
}

/**
 * Strict form of the user's LLM settings: {kind, preset, apiKey, model, baseUrl}.
 * The key is required on every save (so a stored key can never be re-pointed at
 * another address), except for a local Ollama, which has none.
 */
function normalizeLlmSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new MusicError("请填写大模型的连接信息。");
  const kind = validateLlmKind(input.kind);
  let preset = "custom";
  if (
    input.preset !== undefined &&
    input.preset !== null &&
    input.preset !== ""
  ) {
    if (typeof input.preset !== "string" || !PRESET_PATTERN.test(input.preset))
      throw new MusicError("大模型预设无效，请重新选择。");
    preset = input.preset;
  }
  const rawModel =
    typeof input.model === "string" ? input.model.trim() : input.model;
  if (kind === "anthropic") {
    const model =
      rawModel === undefined || rawModel === null || rawModel === ""
        ? ANTHROPIC_MODELS[0]
        : rawModel;
    if (!ANTHROPIC_MODELS.includes(model))
      throw new MusicError("所选 Claude 模型不受支持，请从列表中选择。");
    return {
      kind,
      preset,
      apiKey: secret(input.apiKey, "API Key"),
      model,
      baseUrl: "",
    };
  }
  if (typeof rawModel !== "string" || !MODEL_PATTERN.test(rawModel))
    throw new MusicError("模型名称格式不正确，请填写服务商提供的模型 ID。");
  if (kind === "ollama")
    return {
      kind,
      preset,
      apiKey: "",
      model: rawModel,
      baseUrl: validateBaseUrl("ollama", input.baseUrl),
    };
  return {
    kind,
    preset,
    apiKey: secret(input.apiKey, "API Key"),
    model: rawModel,
    baseUrl: validateBaseUrl("openai", input.baseUrl),
  };
}

module.exports = {
  PROVIDERS,
  validateProvider,
  normalizeCredentials,
  LLM_KINDS,
  ANTHROPIC_MODELS,
  MODEL_PATTERN,
  validateLlmKind,
  safeModelId,
  normalizeLlmSettings,
};
