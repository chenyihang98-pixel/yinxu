/**
 * Ready-made connection settings for the language models a user can plug in
 * as the producer. Only Claude's model ids are listed: other vendors rename
 * their models often, so the user copies the id from that vendor's console.
 */
import type { LlmKind } from "./types";

export interface LlmPreset {
  id: string;
  label: string;
  kind: LlmKind;
  /**
   * OpenAI-compatible endpoint, already in the form the main process stores
   * (kind "openai": public https; kind "ollama": http on this computer).
   * Absent for Claude (official SDK) and for "custom" (the user types it).
   */
  baseUrl?: string;
  /** selectable model ids, default first; empty = type the id by hand */
  models: string[];
  modelPlaceholder: string;
  /** where to create an API key */
  keyUrl?: string;
  keyHint: string;
  note?: string;
}

const CONSOLE_MODEL = "填写服务商控制台中的模型名称";

export const LLM_PRESETS: readonly LlmPreset[] = [
  {
    id: "anthropic",
    label: "Claude（Anthropic）",
    kind: "anthropic",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    modelPlaceholder: "claude-opus-5-5",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "在 Anthropic Console 创建的 API Key（以 sk-ant- 开头）",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com",
    models: [],
    modelPlaceholder: CONSOLE_MODEL,
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "在 DeepSeek 开放平台创建的 API Key",
  },
  {
    id: "qwen",
    label: "通义千问（阿里云百炼）",
    kind: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [],
    modelPlaceholder: CONSOLE_MODEL,
    keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    keyHint: "在阿里云百炼控制台创建的 API Key",
  },
  {
    id: "doubao",
    label: "豆包·火山方舟",
    kind: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: [],
    modelPlaceholder: "填写方舟控制台中的接入点 ID 或模型 ID",
    keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    keyHint: "在火山方舟控制台创建的 API Key",
    note: "模型一栏填写火山方舟控制台中的推理接入点 ID 或模型 ID。",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    kind: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: [],
    modelPlaceholder: CONSOLE_MODEL,
    keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    keyHint: "在智谱开放平台创建的 API Key",
  },
  {
    id: "moonshot",
    label: "Kimi（月之暗面）",
    kind: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [],
    modelPlaceholder: CONSOLE_MODEL,
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    keyHint: "在 Moonshot 开放平台创建的 API Key",
  },
  {
    id: "hunyuan",
    label: "腾讯混元",
    kind: "openai",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    models: [],
    modelPlaceholder: CONSOLE_MODEL,
    keyHint: "在腾讯云混元控制台创建的 API Key",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    models: [],
    modelPlaceholder: CONSOLE_MODEL,
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "在 OpenAI 平台创建的 API Key",
  },
  {
    id: "ollama",
    label: "本机 Ollama",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: [],
    modelPlaceholder: "填写本机已下载的模型名称（ollama list 中的名字）",
    keyHint: "本机模型不需要 API Key",
    note: "需要先在这台电脑上启动 Ollama 并下载模型；请求只发往本机，不经过网络。",
  },
  {
    id: "custom",
    label: "自定义 OpenAI 兼容接口",
    kind: "openai",
    models: [],
    modelPlaceholder: CONSOLE_MODEL,
    keyHint: "该服务提供的 API Key",
    note: "填写以 https:// 开头的公网接口地址（通常以 /v1 结尾），不支持 http://、本机或内网地址；本机模型请改选「本机 Ollama」。",
  },
];

export const DEFAULT_LLM_PRESET = LLM_PRESETS[0];

export function llmPreset(id: string | undefined): LlmPreset {
  return LLM_PRESETS.find((preset) => preset.id === id) ?? DEFAULT_LLM_PRESET;
}
