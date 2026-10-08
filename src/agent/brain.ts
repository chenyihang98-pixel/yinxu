/**
 * The producer agent as the app sees it: ask the user's language model when
 * one is configured, validate everything it returns, and fall back to the
 * offline rules brain whenever that fails — a request is never lost.
 */
import type {
  ArrangementHints,
  DesktopAPI,
  MusicConfig,
  TrackName,
} from "../types";
import {
  LIMITS,
  instrumentLabel,
  isInstrumentId,
  isKey,
  isStyleId,
  styleInfo,
  styleLabel,
} from "../music/catalog";
import {
  clamp,
  cleanArrangement,
  clampConfig,
  stylePreset,
} from "../music/defaults";
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
import { describePins, pinNote, readPins, withPins } from "./pins";
import { keptTitle, planWithRules, readMentions } from "./rules";

export { describeChanges };

export const HISTORY_TURNS = 12;
export const HISTORY_CHARS = 600;
const REPLY_CHARS = 400;
const TITLE_CHARS = 40;
const REASON_CHARS = 100;
const MAX_REASONS = 8;
const TRACKS: TrackName[] = ["melody", "chords", "bass", "drums"];
const LAYERS = ["pad", "arp", "counter", "perc"] as const;
/**
 * What a style preset decides. A pinned style re-bases these when the model
 * planned for another style.
 */
const PRESET_FIELDS = [
  "bpm",
  "key",
  "instrument",
  "energy",
  "complexity",
  "reverb",
] as const;
/**
 * Refinements: a change this small on a parameter the user did not mention is
 * the model drifting, not a decision (BPM / the three 0–1 controls).
 */
const DRIFT_BPM = 3;
const DRIFT_UNIT = 0.06;
/** A section plan is kept while its bars are within these factors of what the duration holds. */
const FORM_FIT: [number, number] = [0.6, 1.5];

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
/** The same value as far as a model can tell: it is shown numbers rounded to two decimals. */
const same = (a: string | number, b: string | number) =>
  typeof a === "number" && typeof b === "number"
    ? Math.abs(a - b) < 0.005 + 1e-9
    : a === b;

/**
 * What the main process needs to ask the model: sizes capped, no free-text
 * prompt in `current`. A refinement also carries the piece's arrangement so
 * the model can keep what it is not asked to change, and pinned choices
 * travel as one marked line after the user's words.
 */
export function toAgentPlanInput(request: AgentRequest): AgentPlanInput {
  const current = clampConfig(request.current ?? {});
  const turns = Array.isArray(request.history) ? request.history : [];
  const mode = request.mode === "refine" ? "refine" : "new";
  const note = pinNote(readPins(request));
  const said = (typeof request.text === "string" ? request.text : "")
    .trim()
    .slice(0, LIMITS.promptChars - (note ? note.length + 1 : 0))
    .trimEnd();
  return {
    mode,
    request: [said, note].filter(Boolean).join("\n"),
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

/**
 * Copy only known, own, size-limited fields before handing them to
 * cleanArrangement. "auto", [] and -1 leave a field to the style, so they
 * become no hint at all.
 */
function arrangementFromRaw(value: unknown): ArrangementHints | undefined {
  if (!isRecord(value)) return undefined;
  const list = (item: unknown) =>
    Array.isArray(item) ? item.slice(0, 32) : undefined;
  const pick = (item: unknown, keys: readonly string[]) =>
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
    layers: pick(own(value, "layers"), LAYERS),
    melody: pick(own(value, "melody"), ["density", "register", "motion"]),
  });
}

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
      pad: hints?.layers?.pad ?? "auto",
      arp: hints?.layers?.arp ?? "auto",
      counter: hints?.layers?.counter ?? "auto",
      perc: hints?.layers?.perc ?? "auto",
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
 * "auto" / [] / -1 hands the field back to the style (which also brings back
 * a layer or a part an earlier refinement forced off), anything invalid or
 * missing keeps the current hint.
 */
function refinedArrangement(
  current: ArrangementHints | undefined,
  value: unknown,
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
    for (const name of LAYERS) {
      const given = own(layers, name);
      if (typeof given === "boolean") shape[name] = given;
      else if (given === "auto") delete shape[name];
    }
    next.layers = shape;
  }
  return cleanArrangement(next);
}

/**
 * The model planned for another style than the pinned one: the harmony and
 * groove it wrote belong to that style. What it removed, the layers, the
 * melody shape and the section plan are kept.
 */
function withoutStyleTraits(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const rest: Bag = {};
  for (const name of ["form", "layers", "melody"])
    rest[name] = own(value, name);
  for (const name of ["drums", "bass"])
    if (own(value, name) === "none") rest[name] = "none";
  return rest;
}

/** Do the sections add up to roughly the bars a 4/4 piece of this tempo and length holds? */
function formFits(
  form: NonNullable<ArrangementHints["form"]>,
  config: Pick<MusicConfig, "bpm" | "duration">,
): boolean {
  const bars = form.reduce((sum, section) => sum + section.bars, 0);
  const room = (config.duration * config.bpm) / 240;
  return bars >= room * FORM_FIT[0] && bars <= room * FORM_FIT[1];
}

/**
 * Turn whatever a model returned into a safe plan. Unknown enums keep the
 * current value, numbers are clamped, text is trimmed and length-limited,
 * and only own properties of plain objects are read. Throws (with a message
 * the UI can show) only when nothing usable is there at all.
 *
 * The answer is then held to what the user actually asked for:
 *  - pinned choices (request.pins) replace whatever the model said;
 *  - a new piece keeps the user's faders unless the text is about that track;
 *  - a refinement ignores tiny drifts on parameters the text does not mention;
 *  - a section plan that does not fit the duration is left to the composer.
 */
export function agentPlanFromRaw(
  raw: unknown,
  request: AgentRequest,
  model?: string,
): AgentPlan {
  if (!isRecord(raw)) throw new Error("大模型没有返回可用的编曲方案");
  const mode = request.mode === "refine" ? "refine" : "new";
  const current = clampConfig(request.current ?? {});
  const text = (typeof request.text === "string" ? request.text : "")
    .trim()
    .slice(0, LIMITS.promptChars);
  const pins = readPins(request);

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
  const rawArrangementValue = own(raw, "arrangement");
  const rawReply = line(own(raw, "reply"), REPLY_CHARS);

  const usable =
    isStyleId(style) ||
    isInstrumentId(instrument) ||
    isKey(key) ||
    Object.values(numbers).some((value) => value !== undefined) ||
    loop !== undefined ||
    newMelody !== undefined ||
    isRecord(rawVolumes) ||
    isRecord(rawArrangementValue) ||
    rawReply.length > 0;
  if (!usable) throw new Error("大模型返回的内容里没有可用的编曲方案");

  /** What the model said, in the engine's ranges. */
  const told: Partial<
    Pick<
      MusicConfig,
      | "bpm"
      | "duration"
      | "energy"
      | "complexity"
      | "reverb"
      | "key"
      | "instrument"
      | "loop"
    >
  > = {
    ...(numbers.bpm !== undefined
      ? { bpm: Math.round(clamp(numbers.bpm, ...LIMITS.bpm)) }
      : {}),
    ...(numbers.duration !== undefined
      ? { duration: Math.round(clamp(numbers.duration, ...LIMITS.duration)) }
      : {}),
    ...(numbers.energy !== undefined
      ? { energy: clamp(numbers.energy, 0, 1) }
      : {}),
    ...(numbers.complexity !== undefined
      ? { complexity: clamp(numbers.complexity, 0, 1) }
      : {}),
    ...(numbers.reverb !== undefined
      ? { reverb: clamp(numbers.reverb, 0, 1) }
      : {}),
    ...(isKey(key) ? { key } : {}),
    ...(isInstrumentId(instrument) ? { instrument } : {}),
    ...(loop !== undefined ? { loop } : {}),
  };
  // when the model went against a pin, its own words describe a different piece
  const offStyle = !!pins.mood && isStyleId(style) && style !== pins.mood;
  const overruled =
    offStyle ||
    (["instrument", "key", "bpm", "duration", "loop"] as const).some(
      (field) =>
        pins[field] !== undefined &&
        told[field] !== undefined &&
        told[field] !== pins[field],
    );
  const givenArrangement = offStyle
    ? withoutStyleTraits(rawArrangementValue)
    : rawArrangementValue;

  const chosen = isStyleId(style) ? style : current.mood;
  const mood = pins.mood ?? chosen;
  const restyled = mood !== current.mood;
  // a new style brings its own tempo, key and lead unless the model set them
  const base: MusicConfig =
    restyled || (mode === "new" && !!pins.mood)
      ? { ...current, ...stylePreset(mood) }
      : current;

  if (pins.mood && chosen !== pins.mood) {
    // The model planned for another style. What it merely took from that
    // style's defaults (or, refining, left as it was) follows the pinned style;
    // anything else is treated as the user's explicit wish and kept.
    const theirs = stylePreset(chosen);
    for (const field of PRESET_FIELDS) {
      const value = told[field];
      if (value === undefined) continue;
      if (
        same(value, theirs[field]) ||
        (mode === "refine" && same(value, current[field]))
      )
        delete told[field];
    }
  }

  const mentions = readMentions(text, mode);
  const kept = base === current;
  for (const field of ["energy", "complexity", "reverb"] as const) {
    const value = told[field];
    if (value === undefined || !kept) continue;
    const delta = Math.abs(value - current[field]);
    const drift =
      mode === "refine" &&
      !mentions[field] &&
      Math.round(delta * 1000) < Math.round(DRIFT_UNIT * 1000);
    // an echo of the rounded number the model was shown is not a change either
    if (drift || same(value, round2(current[field]))) delete told[field];
  }
  if (
    mode === "refine" &&
    kept &&
    told.bpm !== undefined &&
    !mentions.tempo &&
    Math.abs(told.bpm - current.bpm) < DRIFT_BPM
  )
    delete told.bpm;

  const arrangement =
    mode === "refine" && !restyled
      ? refinedArrangement(current.arrangement, givenArrangement)
      : arrangementFromRaw(givenArrangement);

  const volumes: Partial<Record<TrackName, number>> = {};
  if (isRecord(rawVolumes))
    for (const track of TRACKS) {
      const value = finite(own(rawVolumes, track));
      if (value === undefined) continue;
      if (same(value, round2(current.volumes[track]))) continue;
      // the faders are the user's: a new piece moves one only when the text
      // is about that track
      if (mode === "new" && !mentions.tracks.has(track)) continue;
      // a part the arrangement removes is silent anyway: its fader stays
      // where it was, ready for the part to return
      if (
        (track === "drums" || track === "bass") &&
        arrangement?.[track] === "none"
      )
        continue;
      volumes[track] = value;
    }

  let config = clampConfig(
    {
      prompt: mode === "new" && text ? text : current.prompt,
      mood,
      ...told,
      ...pins,
      volumes: volumes as MusicConfig["volumes"],
      seed:
        mode === "new" || newMelody === true ? request.nextSeed : current.seed,
      arrangement,
    },
    base,
  );

  // A section plan is checked whenever this answer wrote it, or changed the
  // tempo or the length it has to fit.
  let formNote = "";
  const form = config.arrangement?.form;
  const formAtStake =
    mode === "new" ||
    restyled ||
    config.bpm !== current.bpm ||
    config.duration !== current.duration ||
    JSON.stringify(form) !== JSON.stringify(current.arrangement?.form);
  if (form && formAtStake && !formFits(form, config)) {
    const rest = cleanArrangement({ ...config.arrangement, form: undefined });
    const next = { ...config };
    if (rest) next.arrangement = rest;
    else delete next.arrangement;
    config = next;
    formNote = "段落安排和时长对不上，改由引擎按时长编排";
  }

  const changes = describeChanges(current, config);
  const unchanged = mode === "refine" && changes.length === 0;
  const info = styleInfo(config.mood);
  const reply = overruled ? "" : rawReply;
  const pinNotes = describePins(pins);
  const rawReasons = overruled ? [] : own(raw, "reasoning");
  const theirs = (Array.isArray(rawReasons) ? rawReasons.slice(0, 32) : [])
    .map((item) => line(item, REASON_CHARS))
    .filter(Boolean);
  const ours = theirs.length
    ? theirs
    : mode === "refine"
      ? // the pins are named once, not again as changes
        describeChanges(withPins(current, pins), config)
      : pins.mood
        ? []
        : [`风格定为「${styleLabel(config.mood)}」`];
  const reasoning = [
    ...pinNotes,
    ...ours.slice(0, MAX_REASONS - pinNotes.length - (formNote ? 1 : 0)),
    ...(formNote ? [formNote] : []),
  ];
  const title =
    (mode === "refine" ? keptTitle(request) : "") ||
    (offStyle ? "" : line(own(raw, "title"), TITLE_CHARS)) ||
    info.titles[config.seed % info.titles.length];

  let cloudPrompt: string | undefined;
  if (request.provider !== "local") {
    const written = overruled
      ? ""
      : line(own(raw, "cloudPrompt"), CLOUD_PROMPT_MAX);
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
    reasoning,
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
): Promise<AgentPlan> {
  const output: unknown = await agentPlan(toAgentPlanInput(request));
  if (!isRecord(output)) throw new Error("大模型没有返回可用的编曲方案");
  const model = own(output, "model");
  return agentPlanFromRaw(
    own(output, "plan"),
    request,
    typeof model === "string" ? model : undefined,
  );
}

/** The rules brain, as the interface names it. */
const RULES_NAME = "离线规则";
const NOTICE_CHARS = 30;
const UNAVAILABLE = "大模型暂时不可用";

/**
 * The main process explains a failure in two or three sentences: what
 * happened, then what to do about it. By the time the notice is shown the
 * request has already been carried out by the rules, so only the first clause
 * — what happened — is kept: no advice, no bracketed asides.
 */
function firstClause(message: string): string {
  const clause = line(message, 240)
    .replace(/[（(][^（）()]*[一-鿿][^（）()]*[）)]/g, "")
    .split(/[，。；：！？!?;]/)[0]
    .trim();
  if (/^已取消/.test(clause)) return "大模型编排已取消";
  // an instruction to the user ("请填写…") or a bare "操作失败" says nothing about the model
  if (!clause || /^(?:请|操作失败)/.test(clause) || [...clause].length > NOTICE_CHARS)
    return UNAVAILABLE;
  return clause;
}

/**
 * One short line for the thread and the toast: what went wrong, in a single
 * clause, then that the rules answered instead — for example
 * "大模型超过 90 秒没有回应，已改用离线规则".
 */
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
  const what = /[一-鿿]/.test(message)
    ? firstClause(message)
    : /timeout|timed out|ETIMEDOUT|abort/i.test(message)
      ? "大模型响应超时"
      : /\b401\b|\b403\b|unauthori[sz]ed|api key|forbidden/i.test(message)
        ? "大模型密钥无效或没有权限"
        : /\b429\b|rate limit|quota|insufficient/i.test(message)
          ? "大模型请求过于频繁或额度不足"
          : /ENOTFOUND|ECONNREFUSED|ECONNRESET|network|fetch failed/i.test(
                message,
              )
            ? "无法连接大模型服务"
            : UNAVAILABLE;
  return `${what}，已改用${RULES_NAME}`;
}

/**
 * The one entry point for the UI. Uses the language model when a bridge is
 * given; on any failure the offline rules answer instead and `fallbackReason`
 * says why, so the user's request always produces a plan.
 */
export async function producePlan(
  request: AgentRequest,
  options: { llm?: DesktopAPI["agentPlan"] } = {},
): Promise<AgentPlan> {
  const hasText =
    typeof request.text === "string" && request.text.trim().length > 0;
  if (!options.llm || !hasText) return planWithRules(request);
  try {
    return await planWithLlm(request, options.llm);
  } catch (error) {
    return { ...planWithRules(request), fallbackReason: fallbackReason(error) };
  }
}
