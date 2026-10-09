/**
 * Cloud music services the desktop app can call (through the main process
 * only). Facts here mirror electron/providers/* and docs/API配置指南.md.
 */
import type {
  AudioFormat,
  CloudProvider,
  Provider,
  ProviderStatuses,
} from "./types";

export interface CloudProviderInfo {
  id: CloudProvider;
  name: string;
  description: string;
  /** what the user has to enable before a key works */
  requirement: string;
  durationNote: string;
  /** selectable music models, default first; empty = fixed by the service */
  models: { id: string; name: string }[];
  /** accepted target length in seconds, when the service enforces one */
  duration?: [number, number];
  /** which secrets the settings form asks for */
  credentials: "apiKey" | "accessKey";
  /** official pages; both are on the main-process openExternal allow-list */
  docs: string;
  console: string;
}

export const EMPTY_PROVIDER_STATUSES: ProviderStatuses = {
  tencent: { configured: false },
  volcengine: { configured: false },
  aliyun: { configured: false },
  elevenlabs: { configured: false },
};

export const CLOUD_PROVIDERS: readonly CloudProviderInfo[] = [
  {
    id: "tencent",
    name: "腾讯云 TokenHub",
    description: "MiniMax Music v3.0 / v2.6 · 纯音乐生成",
    requirement:
      "开通 TokenHub，并在语音模型中开启所选音乐模型的后付费。使用 TokenHub API Key。",
    durationNote:
      "时长是提示词目标，实际长度由模型决定；按服务商整段输出计费。",
    models: [
      { id: "minimax-music-v3.0", name: "MiniMax Music v3.0" },
      { id: "minimax-music-v2.6", name: "MiniMax Music v2.6" },
    ],
    credentials: "apiKey",
    docs: "https://cloud.tencent.cn/document/product/1823/135323",
    console: "https://console.cloud.tencent.com/tokenhub",
  },
  {
    id: "volcengine",
    name: "火山引擎 AI 音乐",
    description: "纯音乐 v5.0 · 30–120 秒",
    requirement:
      "开通「AI 音乐生成」服务及对应计费方式，配置有音乐权限的 Access Key ID / Secret Access Key。",
    durationNote: "支持 30–120 秒；请选择与你控制台开通项目一致的计费方式。",
    models: [],
    duration: [30, 120],
    credentials: "accessKey",
    docs: "https://docs.volcengine.com/docs/Audiovideounderstandingandprocessing/Generatepuremusic?lang=zh",
    console: "https://console.volcengine.com/ai-music/product",
  },
  {
    id: "aliyun",
    name: "阿里云百炼 Fun-Music",
    description: "Fun-Music · 需申请邀测",
    requirement:
      "先获批 Fun-Music 邀测权限，再准备北京地域百炼 API Key 和该业务空间的 Workspace ID。",
    durationNote: "时长是提示词目标，模型返回长度可能不同；以实际输出计费。",
    models: [
      { id: "fun-music-preview", name: "Fun-Music Preview" },
      { id: "fun-music-v1", name: "Fun-Music v1" },
    ],
    credentials: "apiKey",
    docs: "https://help.aliyun.com/zh/model-studio/fun-music",
    console: "https://bailian.console.aliyun.com/",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs Music",
    description: "海外服务 · 纯音乐生成",
    requirement:
      "使用 ElevenLabs API Key，并确认账户拥有 Music API 权限和可用额度。",
    durationNote: "通过接口传入目标时长；播放和「我的作品」显示实际时长。",
    models: [
      { id: "music_v1", name: "Music v1" },
      { id: "music_v2", name: "Music v2" },
      { id: "music_v2_5", name: "Music v2.5" },
    ],
    credentials: "apiKey",
    docs: "https://elevenlabs.io/docs/api-reference/music/compose",
    console: "https://elevenlabs.io/app/settings/api-keys",
  },
];

export function cloudProviderInfo(
  provider: CloudProvider,
): CloudProviderInfo | undefined {
  return CLOUD_PROVIDERS.find((item) => item.id === provider);
}

export function providerName(provider: Provider): string {
  return provider === "local"
    ? "本地作曲"
    : (cloudProviderInfo(provider)?.name ?? "AI 音乐");
}

const FORMAT_BY_MIME: Record<string, AudioFormat> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "video/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
};

/**
 * File format of a cloud result by its MIME type, or null when this build
 * does not know the type. Never throws: it is called while rendering, and a
 * stored Blob's type is not validated.
 */
export function originalFormat(mimeType: unknown): AudioFormat | null {
  if (typeof mimeType !== "string") return null;
  const type = mimeType.split(";")[0].trim().toLowerCase();
  return Object.hasOwn(FORMAT_BY_MIME, type) ? FORMAT_BY_MIME[type] : null;
}

/** "MP3", "WAV"… or "未知格式" — safe to show for any Blob. */
export function originalFormatLabel(mimeType: unknown): string {
  return originalFormat(mimeType)?.toUpperCase() ?? "未知格式";
}
