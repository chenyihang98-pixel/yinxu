/**
 * What can be chosen right now (engines, producers), what stops a generation
 * before it starts, and the words for a job's phases. Pure.
 */
import type { BrainKind } from "../agent/types";
import type { Platform } from "../platform";
import { CLOUD_PROVIDERS, cloudProviderInfo, providerName } from "../providers";
import type { CloudProvider, MusicConfig, Provider } from "../types";
import { joinText } from "./logic";
import type {
  BrainOption,
  EngineOption,
  Job,
  JobStage,
  SettingsState,
} from "./types";

export const DESKTOP_ONLY = "桌面版可用";
/** Said with every usable cloud engine in the selector. */
export const PAID_LABEL = "按服务商计费";

type Capabilities = Pick<Platform, "canUseCloud" | "canUseLlm">;

/** 生成引擎: local first, then every cloud service with its availability. */
export function engineOptions(
  platform: Capabilities,
  settings: Pick<SettingsState, "providers">,
): EngineOption[] {
  const local: EngineOption = {
    id: "local",
    label: "本地作曲 · 免费",
    available: true,
  };
  return [
    local,
    ...CLOUD_PROVIDERS.map((info): EngineOption => {
      if (!platform.canUseCloud)
        return {
          id: info.id,
          label: info.name,
          available: false,
          hint: DESKTOP_ONLY,
          desktopOnly: true,
        };
      const status = settings.providers[info.id];
      if (status?.damaged)
        return {
          id: info.id,
          label: info.name,
          available: false,
          hint: "凭据需重新保存",
        };
      if (!status?.configured)
        return {
          id: info.id,
          label: info.name,
          available: false,
          hint: "需先在设置中配置",
        };
      return {
        id: info.id,
        label: info.name,
        billing: PAID_LABEL,
        available: true,
      };
    }),
  ];
}

/** 制作人: the offline rules, and the user's own model when it is usable. */
export function brainOptions(
  platform: Capabilities,
  settings: Pick<SettingsState, "llm">,
): BrainOption[] {
  const rules: BrainOption = {
    id: "rules",
    label: "离线规则",
    available: true,
  };
  if (!platform.canUseLlm)
    return [
      rules,
      {
        id: "llm",
        label: "大模型",
        available: false,
        hint: DESKTOP_ONLY,
        desktopOnly: true,
      },
    ];
  const { llm } = settings;
  if (llm.damaged)
    return [
      rules,
      { id: "llm", label: "大模型", available: false, hint: "设置需重新保存" },
    ];
  if (!llm.configured)
    return [
      rules,
      {
        id: "llm",
        label: "大模型",
        available: false,
        hint: "需先在设置中配置",
      },
    ];
  return [
    rules,
    {
      id: "llm",
      label: llm.model ? `大模型 ${llm.model}` : "大模型",
      available: true,
    },
  ];
}

/** The producer that will really answer, whatever the selector says. */
export function activeBrain(
  preferred: BrainKind,
  options: readonly BrainOption[],
): BrainKind {
  return preferred === "llm" &&
    options.some((option) => option.id === "llm" && option.available)
    ? "llm"
    : "rules";
}

export interface Refusal {
  message: string;
  /** open the settings modal on this tab so the user can fix it */
  settingsTab?: "music" | "llm";
  /** with settingsTab "music": the service that needs attention */
  provider?: CloudProvider;
}

/** Why `provider` cannot be used at all right now, or null. */
export function engineProblem(
  provider: Provider,
  options: readonly EngineOption[],
): Refusal | null {
  if (provider === "local") return null;
  const option = options.find((item) => item.id === provider);
  const name = providerName(provider);
  if (!option || option.desktopOnly)
    return { message: "云端生成只在 Windows 桌面版中可用。" };
  if (option.available) return null;
  return {
    message:
      option.hint === "凭据需重新保存"
        ? joinText(name, "的凭据无法读取，请在设置中重新保存。")
        : joinText("请先在设置中保存", name, "的服务凭据。"),
    settingsTab: "music",
    provider,
  };
}

/**
 * Limits a service enforces, checked against the configuration that will
 * actually be generated (after the producer has planned), before any paid
 * request is made.
 */
export function configProblem(
  provider: Provider,
  config: MusicConfig,
): Refusal | null {
  if (provider === "local") return null;
  const info = cloudProviderInfo(provider);
  if (!info?.duration) return null;
  const [low, high] = info.duration;
  if (config.duration >= low && config.duration <= high) return null;
  return {
    message: joinText(
      info.name,
      `支持 ${low}–${high} 秒，这次的时长是 ${config.duration} 秒。请调整时长，或换一个生成引擎。`,
    ),
  };
}

/* ------------------------------------------------------------------ */
/* job wording                                                         */
/* ------------------------------------------------------------------ */

/**
 * Shown instead of "正在作曲与合成 · 0%" while the local engine's render
 * worker has been started and has not answered yet.
 */
export const ENGINE_STARTING = "正在启动作曲引擎";

export function phaseText(
  stage: JobStage,
  job: Pick<Job, "kind" | "provider" | "brain">,
): string {
  switch (stage) {
    case "planning":
      return job.brain === "llm"
        ? "制作人（大模型）正在理解你的想法，本机模型可能需要一两分钟"
        : "制作人正在理解你的想法";
    case "asking":
      return "等待你的选择";
    case "rendering":
      return job.kind === "open" ? "正在重建这首作品" : "正在作曲与合成";
    case "cloud":
      return joinText(
        providerName(job.provider),
        "正在创作，通常需要几十秒到几分钟",
      );
    case "downloading":
      return "正在重新下载已经生成的音乐，不会再次计费";
    case "saving":
      return "正在把生成的音频保存到「我的作品」";
    case "decoding":
      return job.kind === "open" ? "正在打开作品" : "正在解码音频";
    case "cancelling":
      return "正在取消";
  }
}

/**
 * What to tell the user after 取消 — derived from the job that was running,
 * never from the composer's current selection.
 */
export function cancelText(job: Pick<Job, "kind" | "stage">): string {
  if (job.kind === "open") return "已取消打开作品";
  switch (job.stage) {
    case "cloud":
      return "已取消等待。已提交的云端生成可能仍会计费。";
    case "downloading":
      return "已取消下载，没有发送新的生成请求。";
    case "planning":
      return "已取消本次编排";
    default:
      return "已取消本地生成";
  }
}
