/**
 * From a user action to an AgentPlan: the request a brain receives, the pins
 * the user set in the composer, the plans of the direct controls (应用调整,
 * 换一版旋律) and the offline preview line. Pure; runs under Node.
 */
import {
  CLOUD_MELODY_NOTE,
  TRACK_LABELS,
  buildCloudPrompt,
  describeChanges,
  keyLabel,
  melodyNote,
} from "../agent/cloudPrompt";
import { planWithRules } from "../agent/rules";
import type {
  AgentPlan,
  AgentRequest,
  AgentTurn,
  BrainKind,
} from "../agent/types";
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
import { TRACKS } from "../music/score";
import { providerName } from "../providers";
import type { MusicConfig, Project, Provider } from "../types";
import { formatBpm, formatSeconds, structureLabel } from "./format";
import { cleanMessage, configFromDraft, joinText } from "./logic";
import { audibleKey, fittedTiming, scoreFacts } from "./score";
import type { Draft, PaidNotice, Pins } from "./types";

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

/**
 * A pinned style with no description is a complete request: the message is
 * empty and only the pins travel, so nothing the app wrote itself (a style's
 * blurb) is ever parsed as the user's words.
 */
export function canSendPinsOnly(text: string, pins: Pins): boolean {
  return !cleanMessage(text) && !!cleanPins(pins).mood;
}

/** What the thread shows as the user's side of a pins-only request. */
export function pinsOnlyText(pins: Pins): string {
  const mood = cleanPins(pins).mood;
  return mood ? `「${styleLabel(mood)}」风格` : "";
}

/**
 * After a pins-only request the work's stored description is the style's
 * label — never empty, never the blurb.
 */
export function withStylePrompt(
  plan: AgentPlan,
  request: AgentRequest,
): AgentPlan {
  const mood = cleanPins(request.pins).mood;
  if (request.mode !== "new" || request.text || !mood || plan.config.prompt)
    return plan;
  return { ...plan, config: { ...plan.config, prompt: styleLabel(mood) } };
}

/* ------------------------------------------------------------------ */
/* honesty: what a generation costs and what it keeps                  */
/* ------------------------------------------------------------------ */

/**
 * The notice shown wherever a generation can be started while a cloud engine
 * is selected. `refining`: a work is loaded, so the request replaces a tune
 * the user already has in their ear.
 */
export function paidNotice(
  provider: Provider,
  refining: boolean,
): PaidNotice | null {
  if (provider === "local") return null;
  const name = providerName(provider);
  return {
    provider,
    name,
    text: joinText(
      "将向",
      name,
      refining
        ? "发送一次新的生成请求，按该服务计费；云端每次都是重新生成，不保留原旋律。"
        : "发送一次新的生成请求，按该服务计费。",
    ),
  };
}

/** A sentence that promises the tune survives. */
const KEEPS_MELODY =
  /(?:旋律|素材|动机)[^，。；！？!?]*(?:保持不变|不变|保留|延续|沿用|一致)/;
/** A sentence that already says the tune is made anew. */
const SAYS_NEW =
  /重新生成|不保留原旋律|旋律会和上一版不同|新的旋律|重新编写旋律|重新作曲/;

const LEGACY_TRUTH = "新版引擎会重新编写旋律，原作品保留。";

/**
 * What a new version made from `base` on `provider` does to the tune, when
 * it is NOT simply kept: a cloud service composes a new piece from text
 * every time, and a v0.2 work is recomposed by the current engine. null for a
 * local engine-2 work (the producer's own wording applies).
 */
export function melodyTruth(
  provider: Provider,
  base: Project | null,
): string | null {
  if (!base) return null;
  // one sentence for it, the same one the producer's own replies use
  if (provider !== "local") return CLOUD_MELODY_NOTE;
  if (base.provider !== "local")
    return "改用本地作曲后，会按这些设置重新写一首。";
  return base.config.engine === 1 ? LEGACY_TRUTH : null;
}

/**
 * Make a plan's words true for the engine that will carry it out: a reply
 * that says the melody stays is corrected whenever it will not (cloud
 * regeneration, engine-1 → engine-2), whichever brain wrote it.
 */
export function honestPlan(
  plan: AgentPlan,
  provider: Provider,
  base: Project | null,
): AgentPlan {
  const truth = melodyTruth(provider, base);
  if (!truth || plan.unchanged) return plan;
  const sentences = plan.reply.match(/[^。！？!?]+[。！？!?]?/g) ?? [
    plan.reply,
  ];
  // "不保留原旋律" is the truth, not a promise: only real promises go.
  const promises = (text: string) =>
    KEEPS_MELODY.test(text) && !SAYS_NEW.test(text);
  const kept = sentences.filter((sentence) => !promises(sentence));
  const stated = kept.some((sentence) => SAYS_NEW.test(sentence));
  const reasoning = plan.reasoning.filter((line) => !promises(line));
  if (
    stated &&
    kept.length === sentences.length &&
    reasoning.length === plan.reasoning.length
  )
    return plan;
  // The producer's own wording stands when it already says so; said once.
  const reply = `${kept.join("").trim()}${stated ? "" : truth}`;
  return { ...plan, reply, reasoning };
}

/**
 * The line under 应用调整: what applying does to the earlier version and to
 * the tune, for the engine that will do it. With the `draft` of a current
 * local work it is the composer's own account of this very change — the
 * melody stays, is adapted, or is a new one — never a blanket promise.
 */
export function applyHint(
  project: Project | null,
  provider: Provider,
  draft?: Draft,
): string {
  const kept = "之前的版本会保留。";
  if (!project) return "";
  if (provider !== "local")
    return joinText(
      "应用调整会让",
      providerName(provider),
      `按新的参数重新生成一首并计费，不保留原旋律；${kept}`,
    );
  if (project.provider !== "local")
    return `应用调整会改用本地作曲，按这些参数重新写一首，不计费；${kept}`;
  if (project.config.engine === 1)
    return `应用调整会用新版引擎重新编写旋律，生成新版本；${kept}`;
  const next = draft ? configFromDraft(project.config, draft) : null;
  const tune =
    next && describeChanges(project.config, next).length
      ? melodyNote(project.config, next, "local")
      : "";
  return `应用调整会生成一个新版本，${kept}${tune}`;
}

/** Label of the 换一版旋律 button: on a cloud engine it is a paid request. */
export function variationLabel(provider: Provider): string {
  return provider === "local" ? "换一版旋律" : "重新生成一版（计费）";
}

/** Style / tempo / lead tags follow the configuration; the rest are kept. */
function retag(tags: string[], before: MusicConfig, after: MusicConfig) {
  const swaps = new Map([
    [styleLabel(before.mood), styleLabel(after.mood)],
    [`${before.bpm} BPM`, `${after.bpm} BPM`],
    // the tag of a loop carries the tempo it was fitted to (truthfulTiming)
    ...(before.engine === 2
      ? ([
          [`${formatBpm(fittedTiming(before).bpm)} BPM`, `${after.bpm} BPM`],
        ] as [string, string][])
      : []),
    [instrumentLabel(before.instrument), instrumentLabel(after.instrument)],
  ]);
  return [...new Set(tags.map((tag) => swaps.get(tag) ?? tag))];
}

/* ------------------------------------------------------------------ */
/* honesty: the tempo and length a loop really gets                    */
/* ------------------------------------------------------------------ */

/**
 * A sentence or chip that quotes a setting ("按你的设定：15 秒") or a limit
 * ("速度范围是 50–200 BPM"), not what the piece turned out to be.
 */
const QUOTES_A_SETTING = /设定|范围|已经是最/;

/**
 * Put `to` wherever `text` states `from` in front of `unit` as the value of
 * the piece ("140 BPM", "速度 132 → 140 BPM"), and `earlier.to` for the left
 * side of an arrow. Positions inside the piece ("前 15 秒") are not its length.
 */
function restate(
  text: string,
  unit: string,
  from: string,
  to: string,
  earlier: { from: string; to: string } | null,
): string {
  if (QUOTES_A_SETTING.test(text)) return text;
  let result = text;
  if (earlier && earlier.from !== earlier.to)
    result = result.replace(
      new RegExp(
        `(^|[^\\d.])${earlier.from}(\\s*→\\s*[\\d.]+\\s*${unit})`,
        "g",
      ),
      `$1${earlier.to}$2`,
    );
  if (from !== to)
    result = result.replace(
      new RegExp(`(^|[^\\d.前第后每])${from}(\\s*${unit})`, "g"),
      `$1${to}$2`,
    );
  return result;
}

/**
 * Make a plan's numbers true for the local engine. A loop is fitted to whole
 * bars: its tempo moves a little so the asked length closes on a bar line, or
 * the tempo stays and the length moves. The producer (rules or a language
 * model) writes the settings into its reply — "80 BPM … 15 秒" — while the
 * audio comes out at 80 BPM and 18 seconds. Wherever the reply, its chips or
 * the tags state the tempo or length of the piece, the audio's own value is
 * put there; a chip that quotes the user's setting stays as it is, and one
 * chip says what the fit did. For a plan that already comes out as written
 * this returns the plan itself.
 */
export function truthfulTiming(
  plan: AgentPlan,
  provider: Provider,
  base: Project | null,
): AgentPlan {
  const { config } = plan;
  if (provider !== "local" || config.engine !== 2) return plan;
  const fitted = fittedTiming(config);
  const bpm = { from: String(config.bpm), to: formatBpm(fitted.bpm) };
  const seconds = {
    from: String(config.duration),
    to: formatSeconds(fitted.duration),
  };
  if (plan.unchanged) {
    // Nothing was made, so nothing is restated. But "速度已经是 68 BPM"
    // under a header that reads 64 BPM needs its other half: the setting is
    // 68, the loop is fitted to 64.
    const said = [plan.reply, ...plan.reasoning].join("\n");
    const mentions = (value: string, unit: string) =>
      new RegExp(`(^|[^\\d.])${value}\\s*${unit}`).test(said);
    const notes = [
      ...(bpm.from !== bpm.to && mentions(bpm.from, "BPM")
        ? [`循环片段按整小节对齐：实际 ${bpm.to} BPM（设定 ${bpm.from}）`]
        : []),
      ...(seconds.from !== seconds.to && mentions(seconds.from, "秒")
        ? [
            `循环片段按整小节对齐：实际 ${seconds.to} 秒（设定 ${seconds.from} 秒）`,
          ]
        : []),
    ].filter((line) => !plan.reasoning.includes(line));
    return notes.length
      ? {
          ...plan,
          reasoning: [...plan.reasoning.slice(0, 8 - notes.length), ...notes],
        }
      : plan;
  }
  if (bpm.from === bpm.to && seconds.from === seconds.to) {
    // Nothing to restate — unless an arrow starts from a fitted earlier tempo.
    if (!base || base.provider !== "local" || base.config.engine !== 2)
      return plan;
  }
  const before =
    base && base.provider === "local" && base.config.engine === 2
      ? fittedTiming(base.config)
      : null;
  const earlierBpm =
    base && before
      ? { from: String(base.config.bpm), to: formatBpm(before.bpm) }
      : null;
  const earlierSeconds =
    base && before
      ? {
          from: String(base.config.duration),
          to: formatSeconds(before.duration),
        }
      : null;
  const fix = (text: string) =>
    restate(
      restate(text, "BPM", bpm.from, bpm.to, earlierBpm),
      "秒",
      seconds.from,
      seconds.to,
      earlierSeconds,
    );
  const sentences = plan.reply.match(/[^。！？!?]+[。！？!?]?/g) ?? [
    plan.reply,
  ];
  const reply = sentences.map(fix).join("");
  const explained: string[] = [];
  if (bpm.from !== bpm.to)
    explained.push(
      `循环片段按整小节对齐：实际 ${bpm.to} BPM（设定 ${bpm.from}）`,
    );
  if (seconds.from !== seconds.to)
    explained.push(
      `循环片段按整小节对齐：实际 ${seconds.to} 秒（设定 ${seconds.from} 秒）`,
    );
  // The thread shows at most eight chips: the explanation is one of them.
  const reasoning = [
    ...plan.reasoning.map(fix).slice(0, 8 - explained.length),
    ...explained,
  ];
  const tags = plan.tags.map((tag) =>
    tag === `${bpm.from} BPM` ? `${bpm.to} BPM` : tag,
  );
  const same =
    reply === plan.reply &&
    reasoning.length === plan.reasoning.length &&
    reasoning.every((line, index) => line === plan.reasoning[index]) &&
    tags.every((tag, index) => tag === plan.tags[index]);
  return same ? plan : { ...plan, reply, reasoning, tags: [...new Set(tags)] };
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
      ...(pins.mood && pins.mood !== before.mood ? stylePreset(pins.mood) : {}),
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
 * touches state; null when there is nothing to send (no text, no pinned
 * style). For a cloud engine the line is worded as a target: the service
 * gets a description, not these parameters. When the language model is the
 * producer, the line is only what the offline rules make of the text — the
 * model plans for itself, so nothing here is worded as a promise.
 */
export function planPreview(
  text: string,
  pins: Pins,
  provider: Provider = "local",
  brain: BrainKind = "rules",
): PlanPreview | null {
  const message = cleanMessage(text);
  if (!message && !canSendPinsOnly(text, pins)) return null;
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
  // The local engine fits a loop to whole bars: the line says what will be
  // heard, with the setting next to it when the two differ. A cloud service
  // only gets a description, so there the settings are a target.
  const fitted = provider === "local" ? fittedTiming(config) : null;
  const tempo =
    fitted && formatBpm(fitted.bpm) !== String(config.bpm)
      ? `${formatBpm(fitted.bpm)} BPM（设定 ${config.bpm}）`
      : `${config.bpm} BPM`;
  const length =
    fitted && formatSeconds(fitted.duration) !== String(config.duration)
      ? `${formatSeconds(fitted.duration)} 秒（设定 ${config.duration} 秒）`
      : `${config.duration} 秒`;
  const settings = `${tempo} · ${keyLabel(config.key)} · ${instrumentLabel(config.instrument)} · ${length} · ${structureLabel(config.loop)}`;
  const summary = `${label} · ${settings}`;
  if (brain === "llm")
    return {
      unsure,
      config,
      line: unsure
        ? "发送后由大模型来理解这段描述（离线规则没有听出风格）"
        : `离线规则的理解：${summary}；发送后由大模型重新理解，方案可能不同`,
    };
  return {
    unsure,
    config,
    line: unsure
      ? // Tempo, key, length and structure may well have been understood:
        // say so, and say that only the style is a stand-in.
        `将创作：${settings}；还没听出风格，暂按「${label}」——可以点下面的风格，或再多描述一点`
      : provider === "local"
        ? `将创作：${summary}`
        : `目标：${summary}（云端按描述生成，结果可能不同）`,
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

/** `before`: the version being changed — a part it had switched off and that is back is named. */
const cloudPromptFor = (
  provider: Provider,
  config: MusicConfig,
  before?: MusicConfig,
) =>
  provider === "local" ? {} : { cloudPrompt: buildCloudPrompt(config, before) };

/**
 * 应用调整: the draft on top of the committed work, same seed. What the reply
 * says about the tune depends on who makes the new version: only the local
 * engine-2 composer works from the seed at all.
 */
export function planFromDraft(
  project: Project,
  draft: Draft,
  provider: Provider,
): DirectPlan {
  const config = configFromDraft(project.config, draft);
  const changes = describeChanges(project.config, config);
  const listed = `${changes.slice(0, 3).join("，")}${changes.length > 3 ? " 等" : ""}`;
  // A local engine-2 work: the composer's own account of what the change
  // does to the tune (identical, adapted or new) — never a blanket promise.
  const tune =
    melodyTruth(provider, project) ??
    melodyNote(project.config, config, "local");
  return {
    request: changes.length ? `应用调整：${changes.join("，")}` : "应用调整",
    plan: {
      config,
      title: project.title,
      reply: changes.length
        ? `已按你的调整生成新版本：${listed}。${tune}`
        : "参数没有变化，作品保持不变。",
      reasoning: changes.slice(0, 8),
      tags: directTags(project, config),
      unchanged: changes.length === 0,
      brain: "rules",
      ...cloudPromptFor(provider, config, project.config),
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
    request: provider === "local" ? "换一版旋律" : "重新生成一版",
    plan: {
      config,
      title: project.title,
      reply:
        provider === "local"
          ? "换了一组新的旋律，其余设置保持不变。"
          : joinText(
              "已让",
              providerName(provider),
              "按相同的设置重新生成了一首：这是一次新的生成，不保留原旋律。",
            ),
      reasoning:
        provider === "local"
          ? ["换一组新的旋律", ...(upgraded ? ["改用新版引擎"] : [])]
          : ["云端重新生成"],
      tags: directTags(project, config),
      unchanged: false,
      brain: "rules",
      ...cloudPromptFor(provider, config),
    },
  };
}

/**
 * Would this phrase, sent to the offline producer for this local work, give a
 * version that sounds different? "不要鼓" on a piece that has no drums, or
 * "加点弦乐铺底" where the pad already plays throughout, would make a new
 * version identical to the old one.
 */
export function wouldChange(config: MusicConfig, text: string): boolean {
  const plan = withAskedDrums(
    planWithRules({
      text,
      mode: "refine",
      current: config,
      provider: "local",
      history: [],
      nextSeed: config.seed,
    }),
    config,
  );
  if (plan.unchanged) return false;
  const before = audibleKey(config);
  const after = audibleKey(plan.config);
  return before === null || after === null || before !== after;
}

/** How the rules answer "bring it back" for a track whose fader is already up. */
const ALREADY_ON = "本来就是打开的";

/**
 * 加上鼓 on a piece whose arrangement has no drum part. The drum fader is up,
 * so the producer sees nothing to do ("鼓组本来就是打开的") or raises a fader
 * nobody can hear — it reads the settings, not the score. The score knows
 * that this style writes no kit at this energy: the piece gets a light one
 * (an arrangement hint, the fader stays where it is) and the reply says so.
 * Returns the plan itself when drums already play, were not asked for, were
 * switched off on purpose, or when the score is not known.
 */
export function withAskedDrums(plan: AgentPlan, base: MusicConfig): AgentPlan {
  if (base.engine !== 2 || base.volumes.drums <= 0) return plan;
  if (base.arrangement?.drums === "none") return plan;
  const label = TRACK_LABELS.drums;
  const louder =
    !plan.unchanged &&
    plan.config.volumes.drums > base.volumes.drums + 1e-6 &&
    plan.config.arrangement?.drums === base.arrangement?.drums;
  const restore =
    plan.unchanged && plan.reasoning.includes(`${label}${ALREADY_ON}`);
  if (!louder && !restore) return plan;
  const start = restore ? base : plan.config;
  // no kit before, and none after what the producer planned
  if (scoreFacts(base)?.playing.drums !== false) return plan;
  if (scoreFacts(start)?.playing.drums !== false) return plan;
  const config = clampConfig(
    {
      ...start,
      // the fader was never the problem
      volumes: { ...start.volumes, drums: base.volumes.drums },
      arrangement: { ...start.arrangement, drums: "light" },
    },
    start,
  );
  if (scoreFacts(config)?.playing.drums !== true) return plan;
  const added = `加入${label}（轻打）`;
  const others = describeChanges(base, config).filter(
    (line) => !line.startsWith(`${label}律动`),
  );
  return {
    ...plan,
    config,
    unchanged: false,
    reply:
      `好的：这一版的编曲里原本没有${label}，已经加入一组轻打的鼓` +
      (others.length ? `；另外${others.slice(0, 2).join("，")}` : "") +
      `。${melodyNote(base, config, "local")}`,
    reasoning: [added, ...others].slice(0, 8),
  };
}

/**
 * A plan for a local version that would sound exactly like the work it
 * starts from: a tempo nudge that a loop fits back onto the same bars, drums
 * taken out of a piece that has none, a pad added where one already plays
 * throughout. Such a plan is answered, not generated — a "new version" that
 * sounds the same would be a false entry in the library, whatever the reply
 * claims was changed. Returns the plan itself when the change can be heard,
 * and when that cannot be told (cloud audio, v0.2 works).
 */
export function inaudiblePlan(
  plan: AgentPlan,
  provider: Provider,
  base: Project | null,
): AgentPlan {
  if (!base || plan.unchanged) return plan;
  if (provider !== "local" || base.provider !== "local") return plan;
  const before = audibleKey(base.config);
  if (before === null || before !== audibleKey(plan.config)) return plan;
  const facts = scoreFacts(base.config);
  const why = TRACKS.filter(
    (track) =>
      facts &&
      !facts.playing[track] &&
      Math.abs(base.config.volumes[track] - plan.config.volumes[track]) > 1e-6,
  ).map((track) => `这一版的编曲里没有${TRACK_LABELS[track]}`);
  if (
    base.config.loop &&
    plan.config.loop &&
    (base.config.bpm !== plan.config.bpm ||
      base.config.duration !== plan.config.duration)
  )
    why.push("循环片段的速度和时长按整小节对齐，对齐后和现在一样");
  return {
    ...plan,
    unchanged: true,
    reply: "这样改完，听起来会和现在这一版完全一样，所以没有生成新版本。",
    reasoning: why,
  };
}

/** The suggestions of the last few works; working them out composes a score or two. */
const chipCache = new Map<string, string[]>();

/**
 * Refinement chips for the thread's composer. Each one is a phrase the
 * offline brain understands and that would change THIS work: for a current
 * local work every chip is checked against the score it would produce, so
 * the list follows what the piece really contains (加点沙锤 where there are
 * no drums to remove, 混响大一点 where the pad already plays).
 */
export function suggestionsFor(project: Project | null): string[] {
  if (!project) return [];
  const config = project.config;
  const slots: string[][] = [
    config.bpm <= LIMITS.bpm[0] + 12 ? ["快一点"] : ["慢一点", "快一点"],
    config.energy >= 0.85 ? ["安静一点"] : ["更有活力", "安静一点"],
    config.instrument === "guzheng" ? ["换成钢琴"] : ["换成古筝", "换成钢琴"],
    config.volumes.drums <= 0 ? ["加上鼓"] : ["不要鼓", "加点沙锤"],
    config.arrangement?.layers?.pad
      ? ["混响大一点", "混响小一点"]
      : ["加点弦乐铺底", "混响大一点", "混响小一点"],
  ];
  // A cloud mix or a v0.2 work has no score to check against.
  if (project.provider !== "local" || config.engine !== 2)
    return [...slots.map((slot) => slot[0]), "换一版旋律"];
  // The answer depends on the music and on which faders are up, not on
  // where exactly a fader stands: moving one does not work it out again.
  const { prompt: _words, volumes, ...musical } = config;
  const key = JSON.stringify([
    musical,
    TRACKS.map((track) => volumes[track] > 0),
  ]);
  const known = chipCache.get(key);
  if (known) return known;
  const chips = [
    ...slots.flatMap((slot) => {
      const chip = slot.find((text) => wouldChange(config, text));
      return chip ? [chip] : [];
    }),
    "换一版旋律",
  ];
  if (chipCache.size >= 8) {
    const oldest = chipCache.keys().next().value;
    if (oldest !== undefined) chipCache.delete(oldest);
  }
  chipCache.set(key, chips);
  return chips;
}
