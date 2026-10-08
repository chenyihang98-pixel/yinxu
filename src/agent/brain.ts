/**
 * The producer agent as the app sees it: ask the user's language model when
 * one is configured, validate everything it returns, and fall back to the
 * offline rules brain whenever that fails — a request is never lost.
 */
import type { ArrangementHints, DesktopAPI, MusicConfig } from "../types";
import {
  LIMITS,
  instrumentLabel,
  isInstrumentId,
  isKey,
  isStyleId,
  styleInfo,
  styleLabel,
} from "../music/catalog";
import { cleanArrangement, clampConfig, stylePreset } from "../music/defaults";
import type {
  AgentPlan,
  AgentPlanInput,
  AgentRequest,
  RawAgentPlan,
} from "./types";
import {
  CLOUD_PROMPT_MAX,
  INSTRUMENTAL_ONLY,
  buildCloudPrompt,
  describeChanges,
} from "./cloudPrompt";
import { planWithRules } from "./rules";

export { describeChanges };

export const HISTORY_TURNS = 12;
export const HISTORY_CHARS = 600;
const REPLY_CHARS = 400;
const TITLE_CHARS = 40;
const REASON_CHARS = 100;
const MAX_REASONS = 8;

/** An LLM plan also carries the id of the model that wrote it, for display. */
export interface LlmAgentPlan extends AgentPlan {
  model?: string;
}

type Bag = Record<string, unknown>;
const isRecord = (value: unknown): value is Bag =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** Own properties only: nothing inherited (or smuggled through a prototype) is read. */
const own = (bag: Bag, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : undefined;
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const flag = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;
const line = (value: unknown, max: number): string =>
  typeof value === "string"
    ? value
        .slice(0, max * 4)
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
        .trim()
    : "";
const round2 = (value: number) => Math.round(value * 100) / 100;

/** AgentPlanInput plus the piece's arrangement, which the main process accepts when refining. */
export type AgentPlanInputWithArrangement = AgentPlanInput & {
  current: { arrangement?: RawAgentPlan["arrangement"] };
};

/**
 * What the main process needs to ask the model: sizes capped, no free-text
 * prompt in `current`. A refinement also carries the piece's arrangement so
 * the model can keep what it is not asked to change.
 */
export function toAgentPlanInput(
  request: AgentRequest,
): AgentPlanInputWithArrangement {
  const current = clampConfig(request.current ?? {});
  const turns = Array.isArray(request.history) ? request.history : [];
  const mode = request.mode === "refine" ? "refine" : "new";
  return {
    mode,
    request: (typeof request.text === "string" ? request.text : "")
      .trim()
      .slice(0, LIMITS.promptChars),
    provider: request.provider,
    history: turns
      .filter(
        (turn) =>
          !!turn &&
          (turn.role === "user" || turn.role === "agent") &&
          typeof turn.text === "string" &&
          turn.text.trim().length > 0 &&
          !turn.error,
      )
      .slice(-HISTORY_TURNS)
      .map((turn) => ({
        role: turn.role,
        text: turn.text.trim().slice(0, HISTORY_CHARS),
      })),
    current: {
      style: current.mood,
      instrument: current.instrument,
      key: current.key,
      bpm: current.bpm,
      duration: current.duration,
      energy: round2(current.energy),
      complexity: round2(current.complexity),
      reverb: round2(current.reverb),
      loop: current.loop,
      volumes: {
        melody: round2(current.volumes.melody),
        chords: round2(current.volumes.chords),
        bass: round2(current.volumes.bass),
        drums: round2(current.volumes.drums),
      },
      ...(mode === "refine"
        ? { arrangement: rawArrangement(current.arrangement) }
        : {}),
    },
  };
}

/** Copy only known, own, size-limited fields before handing them to cleanArrangement. */
function arrangementFromRaw(value: unknown): ArrangementHints | undefined {
  if (!isRecord(value)) return undefined;
  const list = (item: unknown) =>
    Array.isArray(item) ? item.slice(0, 32) : undefined;
  const pick = (item: unknown, keys: string[]) =>
    isRecord(item)
      ? Object.fromEntries(keys.map((key) => [key, own(item, key)]))
      : undefined;
  return cleanArrangement({
    progression: list(own(value, "progression")),
    form: list(own(value, "form"))?.map((section) =>
      pick(section, ["type", "bars", "energy"]),
    ),
    drums: own(value, "drums"),
    bass: own(value, "bass"),
    swing: own(value, "swing"),
    layers: pick(own(value, "layers"), ["pad", "arp", "counter", "perc"]),
    melody: pick(own(value, "melody"), ["density", "register", "motion"]),
  });
}

const LAYERS = ["pad", "arp", "counter", "perc"] as const;
/**
 * The plan format has no "style default" for a layer, so layers the piece
 * never fixed are shown to the model with these stand-in values.
 */
const STAND_IN_LAYERS = { pad: true, arp: false, counter: false, perc: false };

/** Arrangement hints in the shape the model reads and writes ("auto", [] and -1 = style default). */
export function rawArrangement(
  hints: ArrangementHints | undefined,
): RawAgentPlan["arrangement"] {
  return {
    progression: [...(hints?.progression ?? [])],
    form: (hints?.form ?? []).map(({ type, bars, energy }) => ({
      type,
      bars,
      energy,
    })),
    drums: hints?.drums ?? "auto",
    bass: hints?.bass ?? "auto",
    swing: hints?.swing ?? -1,
    layers: {
      pad: hints?.layers?.pad ?? STAND_IN_LAYERS.pad,
      arp: hints?.layers?.arp ?? STAND_IN_LAYERS.arp,
      counter: hints?.layers?.counter ?? STAND_IN_LAYERS.counter,
      perc: hints?.layers?.perc ?? STAND_IN_LAYERS.perc,
    },
    melody: {
      density: hints?.melody?.density ?? -1,
      register: hints?.melody?.register ?? "auto",
      motion: hints?.melody?.motion ?? "auto",
    },
  };
}

/**
 * A refinement: the model saw the piece's arrangement (rawArrangement) and
 * was told to copy what it does not change. A valid value replaces the hint,
 * "auto" / [] / -1 hands the field back to the style, anything invalid keeps
 * the current hint. A layer the piece never fixed becomes a hint only when the
 * model moved it away from the stand-in value — or when the request plainly
 * asks for it (the rules brain reads that), so "不要琶音" is never lost.
 */
function refinedArrangement(
  current: ArrangementHints | undefined,
  value: unknown,
  request: AgentRequest,
): ArrangementHints | undefined {
  if (!isRecord(value)) return current;
  const told = arrangementFromRaw(value) ?? {};
  const next: ArrangementHints = { ...current };
  const progression = own(value, "progression");
  if (told.progression) next.progression = told.progression;
  else if (Array.isArray(progression) && !progression.length)
    delete next.progression;
  const form = own(value, "form");
  if (told.form) next.form = told.form;
  else if (Array.isArray(form) && !form.length) delete next.form;
  if (told.drums) next.drums = told.drums;
  else if (own(value, "drums") === "auto") delete next.drums;
  if (told.bass) next.bass = told.bass;
  else if (own(value, "bass") === "auto") delete next.bass;
  const swing = finite(own(value, "swing"));
  if (told.swing !== undefined) next.swing = told.swing;
  else if (swing !== undefined && swing < 0) delete next.swing;

  const melody = own(value, "melody");
  if (isRecord(melody)) {
    const shape = { ...current?.melody };
    const density = finite(own(melody, "density"));
    if (told.melody?.density !== undefined) shape.density = told.melody.density;
    else if (density !== undefined && density < 0) delete shape.density;
    for (const field of ["register", "motion"] as const)
      if (told.melody?.[field]) Object.assign(shape, { [field]: told.melody[field] });
      else if (own(melody, field) === "auto") delete shape[field];
    next.melody = shape;
  }

  const layers = own(value, "layers");
  if (isRecord(layers)) {
    const shape = { ...current?.layers };
    let asked: ArrangementHints["layers"] | null = null;
    for (const name of LAYERS) {
      const given = flag(own(layers, name));
      if (given === undefined) continue;
      if (shape[name] !== undefined || given !== STAND_IN_LAYERS[name])
        shape[name] = given;
      else {
        asked ??=
          planWithRules({ ...request, mode: "refine", provider: "local" })
            .config.arrangement?.layers ?? {};
        if (asked[name] !== undefined) shape[name] = asked[name];
      }
    }
    next.layers = shape;
  }
  return cleanArrangement(next);
}

/**
 * Turn whatever a model returned into a safe plan. Unknown enums keep the
 * current value, numbers are clamped, text is trimmed and length-limited,
 * and only own properties of plain objects are read. Throws (with a message
 * the UI can show) only when nothing usable is there at all.
 */
export function agentPlanFromRaw(
  raw: unknown,
  request: AgentRequest,
  model?: string,
): LlmAgentPlan {
  if (!isRecord(raw)) throw new Error("大模型没有返回可用的编曲方案");
  const mode = request.mode === "refine" ? "refine" : "new";
  const current = clampConfig(request.current ?? {});
  const text = (typeof request.text === "string" ? request.text : "")
    .trim()
    .slice(0, LIMITS.promptChars);

  const style = own(raw, "style");
  const instrument = own(raw, "instrument");
  const key = own(raw, "key");
  const numbers = {
    bpm: finite(own(raw, "bpm")),
    duration: finite(own(raw, "duration")),
    energy: finite(own(raw, "energy")),
    complexity: finite(own(raw, "complexity")),
    reverb: finite(own(raw, "reverb")),
  };
  const loop = flag(own(raw, "loop"));
  const newMelody = flag(own(raw, "newMelody"));
  const rawVolumes = own(raw, "volumes");
  const givenArrangement = own(raw, "arrangement");
  const reply = line(own(raw, "reply"), REPLY_CHARS);

  const usable =
    isStyleId(style) ||
    isInstrumentId(instrument) ||
    isKey(key) ||
    Object.values(numbers).some((value) => value !== undefined) ||
    loop !== undefined ||
    newMelody !== undefined ||
    isRecord(rawVolumes) ||
    isRecord(givenArrangement) ||
    reply.length > 0;
  if (!usable) throw new Error("大模型返回的内容里没有可用的编曲方案");

  const mood = isStyleId(style) ? style : current.mood;
  const restyled = mood !== current.mood;
  // a new style brings its own tempo, key and lead unless the model set them
  const base: MusicConfig = restyled
    ? { ...current, ...stylePreset(mood) }
    : current;
  const volumes = isRecord(rawVolumes)
    ? Object.fromEntries(
        (["melody", "chords", "bass", "drums"] as const).flatMap((track) => {
          const value = finite(own(rawVolumes, track));
          return value === undefined ? [] : [[track, value]];
        }),
      )
    : {};
  const arrangement =
    mode === "refine" && !restyled
      ? refinedArrangement(current.arrangement, givenArrangement, request)
      : arrangementFromRaw(givenArrangement);

  const config = clampConfig(
    {
      prompt: mode === "new" && text ? text : current.prompt,
      mood,
      ...Object.fromEntries(
        Object.entries(numbers).filter(([, value]) => value !== undefined),
      ),
      ...(isKey(key) ? { key } : {}),
      ...(isInstrumentId(instrument) ? { instrument } : {}),
      ...(loop !== undefined ? { loop } : {}),
      volumes: volumes as MusicConfig["volumes"],
      seed:
        mode === "new" || newMelody === true ? request.nextSeed : current.seed,
      arrangement,
    },
    base,
  );

  const changes = describeChanges(current, config);
  const unchanged = mode === "refine" && changes.length === 0;
  const info = styleInfo(config.mood);
  const rawReasons = own(raw, "reasoning");
  const reasoning = (Array.isArray(rawReasons) ? rawReasons.slice(0, 32) : [])
    .map((item) => line(item, REASON_CHARS))
    .filter(Boolean)
    .slice(0, MAX_REASONS);
  const keptTitle = (request as { title?: unknown }).title;
  const title =
    (mode === "refine" ? line(keptTitle, TITLE_CHARS) : "") ||
    line(own(raw, "title"), TITLE_CHARS) ||
    info.titles[config.seed % info.titles.length];

  let cloudPrompt: string | undefined;
  if (request.provider !== "local") {
    const written = line(own(raw, "cloudPrompt"), CLOUD_PROMPT_MAX);
    if ([...written].length < 12)
      cloudPrompt = buildCloudPrompt(config, mode === "refine" ? text : undefined);
    else if (/无人声|纯音乐|no vocals?|instrumental/i.test(written))
      cloudPrompt = written;
    else
      cloudPrompt =
        written
          .slice(0, CLOUD_PROMPT_MAX - INSTRUMENTAL_ONLY.length - 1)
          .replace(/[。.，,;；\s]+$/, "") +
        "。" +
        INSTRUMENTAL_ONLY;
  }
  const modelName = line(model, 80);

  return {
    config,
    title,
    reply:
      reply ||
      (mode === "new"
        ? `好的，做一段「${info.label}」风格的音乐。`
        : changes.length
          ? `好的：${changes.slice(0, 3).join("，")}。`
          : "这次没有需要改动的地方，作品保持不变。"),
    reasoning: reasoning.length
      ? reasoning
      : mode === "new"
        ? [`风格定为「${styleLabel(config.mood)}」`]
        : changes.slice(0, MAX_REASONS),
    tags: [
      info.label,
      `${config.bpm} BPM`,
      instrumentLabel(config.instrument),
    ],
    unchanged,
    brain: "llm",
    ...(cloudPrompt ? { cloudPrompt } : {}),
    ...(modelName ? { model: modelName } : {}),
  };
}

/** Ask the configured model (through the desktop bridge) and validate its answer. */
export async function planWithLlm(
  request: AgentRequest,
  agentPlan: DesktopAPI["agentPlan"],
): Promise<LlmAgentPlan> {
  const output: unknown = await agentPlan(toAgentPlanInput(request));
  if (!isRecord(output)) throw new Error("大模型没有返回可用的编曲方案");
  const model = own(output, "model");
  return agentPlanFromRaw(
    own(output, "plan"),
    request,
    typeof model === "string" ? model : undefined,
  );
}

/** A short Chinese explanation of why the model could not be used. */
function fallbackReason(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const message = raw
    .replace(/^Error invoking remote method '[^']*':\s*/i, "")
    .replace(/^(?:[A-Za-z]*Error:\s*)+/, "")
    .trim();
  const detail = /[一-鿿]/.test(message)
    ? line(message, 60).replace(/[。.!！\s]+$/, "")
    : /timeout|timed out|ETIMEDOUT|abort/i.test(message)
      ? "请求超时"
      : /\b401\b|\b403\b|unauthori[sz]ed|api key|forbidden/i.test(message)
        ? "密钥无效或没有权限"
        : /\b429\b|rate limit|quota|insufficient/i.test(message)
          ? "请求过于频繁或额度不足"
          : /ENOTFOUND|ECONNREFUSED|ECONNRESET|network|fetch failed/i.test(
                message,
              )
            ? "网络连接失败"
            : "";
  return detail
    ? `大模型不可用（${detail}），已改用内置规则`
    : "大模型暂时不可用，已改用内置规则";
}

/**
 * The one entry point for the UI. Uses the language model when a bridge is
 * given; on any failure the offline rules answer instead and `fallbackReason`
 * says why, so the user's request always produces a plan.
 */
export async function producePlan(
  request: AgentRequest,
  options: { llm?: DesktopAPI["agentPlan"] } = {},
): Promise<AgentPlan & { fallbackReason?: string }> {
  const hasText =
    typeof request.text === "string" && request.text.trim().length > 0;
  if (!options.llm || !hasText) return planWithRules(request);
  try {
    return await planWithLlm(request, options.llm);
  } catch (error) {
    return { ...planWithRules(request), fallbackReason: fallbackReason(error) };
  }
}
