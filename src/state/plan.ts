/**
 * From a user action to an AgentPlan: the request a brain receives, the pins
 * the user set in the composer, the plans of the direct controls (应用调整,
 * 换一版旋律) and the offline preview line. Pure; runs under Node.
 */
import { buildCloudPrompt, describeChanges, keyLabel } from "../agent/cloudPrompt";
import { planWithRules } from "../agent/rules";
import type { AgentPlan, AgentRequest, AgentTurn } from "../agent/types";
import {
  LIMITS,
  instrumentLabel,
  isStyleId,
  styleLabel,
} from "../music/catalog";
import {
  DEFAULT_CONFIG,
  DEFAULT_VOLUMES,
  clampConfig,
  promptSeed,
  stylePreset,
} from "../music/defaults";
import type { MusicConfig, Project, Provider } from "../types";
import { cleanMessage, configFromDraft } from "./logic";
import type { Draft, Pins } from "./types";

export const DURATION_CHOICES = [15, 30, 60, 90, 120] as const;

/** Only well-formed pins leave the composer. */
export function cleanPins(pins: Pins | null | undefined): Pins {
  const result: Pins = {};
  if (!pins) return result;
  if (isStyleId(pins.mood)) result.mood = pins.mood;
  if (typeof pins.duration === "number" && Number.isFinite(pins.duration))
    result.duration = Math.round(
      Math.max(LIMITS.duration[0], Math.min(LIMITS.duration[1], pins.duration)),
    );
  if (typeof pins.loop === "boolean") result.loop = pins.loop;
  return result;
}

/** Parameters a new piece starts from: defaults, with the pins already in. */
export function newPieceBase(pins: Pins): MusicConfig {
  const clean = cleanPins(pins);
  return {
    ...DEFAULT_CONFIG,
    prompt: "",
    volumes: { ...DEFAULT_VOLUMES },
    ...(clean.mood ? stylePreset(clean.mood) : {}),
    ...(clean.duration !== undefined ? { duration: clean.duration } : {}),
    ...(clean.loop !== undefined ? { loop: clean.loop } : {}),
  };
}

/**
 * The request for one composer message. With a work loaded it is a
 * refinement of the COMMITTED configuration (never the inspector draft), so
 * the seed and every untouched parameter are the audible ones.
 */
export function buildAgentRequest(input: {
  text: string;
  project: Project | null;
  thread: readonly AgentTurn[];
  pins: Pins;
  provider: Provider;
  nextSeed: number;
}): AgentRequest {
  const text = cleanMessage(input.text);
  const nextSeed = input.nextSeed >>> 0;
  if (input.project)
    return {
      text,
      mode: "refine",
      current: input.project.config,
      provider: input.provider,
      history: [...input.thread],
      title: input.project.title,
      nextSeed,
    };
  const pins = cleanPins(input.pins);
  return {
    text,
    mode: "new",
    current: newPieceBase(pins),
    provider: input.provider,
    history: [],
    nextSeed,
    ...(Object.keys(pins).length ? { pins } : {}),
  };
}

/** Style / tempo / lead tags follow the configuration; the rest are kept. */
function retag(tags: string[], before: MusicConfig, after: MusicConfig) {
  const swaps = new Map([
    [styleLabel(before.mood), styleLabel(after.mood)],
    [`${before.bpm} BPM`, `${after.bpm} BPM`],
    [instrumentLabel(before.instrument), instrumentLabel(after.instrument)],
  ]);
  return [...new Set(tags.map((tag) => swaps.get(tag) ?? tag))];
}

/**
 * Both brains apply `request.pins` themselves (agent/pins.ts). This is the
 * app's own last check that what the user chose in the composer really is in
 * the plan that gets generated — for a compliant plan it returns the plan
 * itself.
 */
export function enforcePins(plan: AgentPlan, request: AgentRequest): AgentPlan {
  const pins = cleanPins(request.pins);
  const before = plan.config;
  if (
    (pins.mood === undefined || pins.mood === before.mood) &&
    (pins.duration === undefined || pins.duration === before.duration) &&
    (pins.loop === undefined || pins.loop === before.loop)
  )
    return plan;
  const config = clampConfig(
    {
      ...before,
      ...(pins.mood && pins.mood !== before.mood
        ? stylePreset(pins.mood)
        : {}),
      ...pins,
    },
    before,
  );
  return {
    ...plan,
    config,
    tags: retag(plan.tags, before, config),
    ...(request.provider !== "local"
      ? { cloudPrompt: buildCloudPrompt(config) }
      : {}),
  };
}

/** The rules brain said it could not hear a style and fell back. */
export function isUnsure(plan: AgentPlan): boolean {
  return (
    plan.brain === "rules" &&
    plan.reasoning.some((line) =>
      /^没有(?:听出明确的风格|从.*听出风格)/.test(line),
    )
  );
}

export interface PlanPreview {
  /** ready-to-show line for under the composer */
  line: string;
  /** the brain fell back to a default style: invite the user to pick one */
  unsure: boolean;
  config: MusicConfig;
}

/**
 * "理解预览": what the offline brain would make of the text right now. Never
 * touches state; null for an empty composer.
 */
export function planPreview(text: string, pins: Pins): PlanPreview | null {
  const message = cleanMessage(text);
  if (!message) return null;
  const request = buildAgentRequest({
    text: message,
    project: null,
    thread: [],
    pins,
    provider: "local",
    nextSeed: promptSeed(message),
  });
  const plan = enforcePins(planWithRules(request), request);
  const { config } = plan;
  const unsure = isUnsure(plan) && !cleanPins(pins).mood;
  const label = styleLabel(config.mood);
  return {
    unsure,
    config,
    line: unsure
      ? `还没听懂风格，将按「${label}」创作——可以点下面的风格，或再多描述一点`
      : `将创作：${label} · ${config.bpm} BPM · ${keyLabel(config.key)} · ${instrumentLabel(config.instrument)} · ${config.duration} 秒 · ${config.loop ? "循环" : "完整结尾"}`,
  };
}

/** Text + plan of a direct control, shaped like a producer exchange. */
export interface DirectPlan {
  /** what the thread shows as the user's side */
  request: string;
  plan: AgentPlan;
}

function directTags(project: Project, config: MusicConfig): string[] {
  return retag(
    project.tags.length
      ? project.tags
      : [
          styleLabel(project.config.mood),
          `${project.config.bpm} BPM`,
          instrumentLabel(project.config.instrument),
        ],
    project.config,
    config,
  );
}

const cloudPromptFor = (provider: Provider, config: MusicConfig) =>
  provider === "local" ? {} : { cloudPrompt: buildCloudPrompt(config) };

/** 应用调整: the draft on top of the committed work, same seed. */
export function planFromDraft(
  project: Project,
  draft: Draft,
  provider: Provider,
): DirectPlan {
  const config = configFromDraft(project.config, draft);
  const changes = describeChanges(project.config, config);
  const listed = `${changes.slice(0, 3).join("，")}${changes.length > 3 ? " 等" : ""}`;
  return {
    request: changes.length ? `应用调整：${changes.join("，")}` : "应用调整",
    plan: {
      config,
      title: project.title,
      reply: changes.length
        ? `已按你的调整生成新版本：${listed}。旋律素材保持不变。`
        : "参数没有变化，作品保持不变。",
      reasoning: changes.slice(0, 8),
      tags: directTags(project, config),
      unchanged: changes.length === 0,
      brain: "rules",
      ...cloudPromptFor(provider, config),
    },
  };
}

/** 换一版旋律: the committed settings with a new seed. */
export function planVariation(
  project: Project,
  nextSeed: number,
  provider: Provider,
): DirectPlan {
  const base = clampConfig(project.config);
  let seed = nextSeed >>> 0;
  if (seed === base.seed) seed = (seed + 1) >>> 0;
  const config = clampConfig({ ...base, seed }, base);
  const upgraded = project.config.engine !== config.engine;
  return {
    request: "换一版旋律",
    plan: {
      config,
      title: project.title,
      reply:
        provider === "local"
          ? "换了一组新的旋律，其余设置保持不变。"
          : "按相同的设置重新生成了一版。",
      reasoning: ["换一组新的旋律", ...(upgraded ? ["改用新版音色引擎"] : [])],
      tags: directTags(project, config),
      unchanged: false,
      brain: "rules",
      ...cloudPromptFor(provider, config),
    },
  };
}

/**
 * Refinement chips for the thread's composer. Each one is a phrase the
 * offline brain understands and that would change THIS work.
 */
export function suggestionsFor(project: Project | null): string[] {
  if (!project) return [];
  const config = project.config;
  return [
    config.bpm <= LIMITS.bpm[0] + 12 ? "快一点" : "慢一点",
    config.energy >= 0.85 ? "安静一点" : "更有活力",
    config.instrument === "guzheng" ? "换成钢琴" : "换成古筝",
    config.volumes.drums <= 0 ? "加上鼓" : "不要鼓",
    config.arrangement?.layers?.pad ? "混响大一点" : "加点弦乐铺底",
    "换一版旋律",
  ];
}
