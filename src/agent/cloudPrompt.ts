/**
 * Putting a configuration into Chinese words: the prompt sent to a cloud
 * text-to-music model, and the short "what changed" phrases shown in the chat.
 *
 * Parameters, tracks and structures are called what the inspector and the
 * mixer call them (情绪能量, 旋律丰富度, 空间混响, 主奏乐器, 旋律 / 和声 /
 * 贝斯 / 鼓组, 循环片段 / 完整结尾), so a reasoning chip can be found on
 * screen by its name. Whatever is quoted or named stands in 「」.
 */
import type {
  ArrangementHints,
  MusicConfig,
  Provider,
  TrackName,
} from "../types";
import {
  instrumentLabel,
  parseKey,
  styleInfo,
  styleLabel,
  type BassFeel,
  type DrumFeel,
  type StyleId,
} from "../music/catalog";
import { melodyContinuity } from "../music/compose";
import { DEFAULT_VOLUMES } from "../music/defaults";
import { STYLE_COORDS } from "./lexicon";
import { read } from "./reading";

export const CLOUD_PROMPT_MAX = 1800;
/** Every cloud prompt ends with this, whatever the user wrote. */
export const INSTRUMENTAL_ONLY = "纯音乐，无人声，无歌词";

/** The four mixer tracks, as the mixer and the export menu name them. */
export const TRACK_LABELS: Record<TrackName, string> = {
  melody: "旋律",
  chords: "和声",
  bass: "贝斯",
  drums: "鼓组",
};
/** The three 0–1 controls, as the inspector names them. */
export const AMOUNT_LABELS = {
  energy: "情绪能量",
  complexity: "旋律丰富度",
  reverb: "空间混响",
} as const;
const TRACK_ORDER: TrackName[] = ["melody", "chords", "bass", "drums"];

export const DRUM_FEEL_LABELS: Record<DrumFeel, string> = {
  auto: "风格默认",
  none: "无鼓",
  light: "轻打",
  straight: "直拍",
  halftime: "半速",
  fourfloor: "四拍底鼓",
  swing: "摇摆",
  shuffle: "Shuffle",
  breakbeat: "碎拍",
  march: "行进",
  cinematic: "电影大鼓",
};
export const BASS_FEEL_LABELS: Record<BassFeel, string> = {
  auto: "风格默认",
  none: "无贝斯",
  root: "根音",
  octave: "八度",
  walking: "行走低音",
  arpeggio: "分解",
  syncopated: "切分",
  pedal: "持续低音",
};
const LAYER_LABELS = {
  pad: "铺底长音",
  arp: "琶音",
  counter: "副旋律",
  perc: "打击乐点缀",
} as const;
const REGISTER_LABELS = {
  low: "低音区",
  mid: "中音区",
  high: "高音区",
} as const;
const MOTION_LABELS = {
  stepwise: "级进",
  leaps: "跳进",
  arpeggio: "琶音式",
} as const;

/** "F# minor" → "F# 小调". */
export function keyLabel(key: string): string {
  const parsed = parseKey(key);
  return `${parsed.name} ${parsed.minor ? "小调" : "大调"}`;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

function describeArrangement(
  before: ArrangementHints | undefined,
  after: ArrangementHints | undefined,
): string[] {
  const out: string[] = [];
  const a = before ?? {};
  const b = after ?? {};
  const same = (x: unknown, y: unknown) =>
    JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  if (!same(a.progression, b.progression))
    out.push(
      b.progression
        ? `和弦进行改为 ${b.progression.join("–")}`
        : "和弦进行恢复风格默认",
    );
  if (!same(a.form, b.form))
    out.push(b.form ? "重新安排段落结构" : "段落结构恢复风格默认");
  if (a.drums !== b.drums)
    out.push(
      b.drums
        ? `鼓组律动改为${DRUM_FEEL_LABELS[b.drums]}`
        : "鼓组律动恢复风格默认",
    );
  if (a.bass !== b.bass)
    out.push(
      b.bass ? `贝斯改为${BASS_FEEL_LABELS[b.bass]}` : "贝斯律动恢复风格默认",
    );
  if (a.swing !== b.swing)
    out.push(
      b.swing === undefined
        ? "摇摆感恢复风格默认"
        : b.swing === 0
          ? "去掉摇摆感"
          : `摇摆感 ${percent(b.swing / 0.66)}`,
    );
  for (const name of ["pad", "arp", "counter", "perc"] as const) {
    const from = a.layers?.[name];
    const to = b.layers?.[name];
    if (from === to) continue;
    out.push(
      to === undefined
        ? `${LAYER_LABELS[name]}恢复风格默认`
        : `${to ? "加入" : "去掉"}${LAYER_LABELS[name]}`,
    );
  }
  const m0 = a.melody ?? {};
  const m1 = b.melody ?? {};
  if (m0.density !== m1.density)
    out.push(
      m1.density === undefined
        ? "旋律密度恢复风格默认"
        : m0.density === undefined
          ? `旋律密度设为 ${percent(m1.density)}`
          : `旋律${m1.density > m0.density ? "更密集" : "更稀疏"}`,
    );
  if (m0.register !== m1.register)
    out.push(
      m1.register
        ? `旋律移到${REGISTER_LABELS[m1.register]}`
        : "旋律音区恢复风格默认",
    );
  if (m0.motion !== m1.motion)
    out.push(
      m1.motion
        ? `旋律走向改为${MOTION_LABELS[m1.motion]}`
        : "旋律走向恢复风格默认",
    );
  return out;
}

/** What a change line is about, so two lists of changes can be compared by subject. */
export type ChangeField =
  | "mood"
  | "bpm"
  | "key"
  | "instrument"
  | "duration"
  | "energy"
  | "complexity"
  | "reverb"
  | "loop"
  | `vol:${TrackName}`
  | "arrangement"
  | "seed"
  | "engine";
export interface ChangeLine {
  field: ChangeField;
  text: string;
}

/** The parameters as the inspector and the mixer name them. */
export const FIELD_LABELS: Record<ChangeField, string> = {
  mood: "风格",
  bpm: "速度",
  key: "调性",
  instrument: "主奏乐器",
  duration: "时长",
  energy: AMOUNT_LABELS.energy,
  complexity: AMOUNT_LABELS.complexity,
  reverb: AMOUNT_LABELS.reverb,
  loop: "结构",
  "vol:melody": `${TRACK_LABELS.melody}音量`,
  "vol:chords": `${TRACK_LABELS.chords}音量`,
  "vol:bass": `${TRACK_LABELS.bass}音量`,
  "vol:drums": `${TRACK_LABELS.drums}音量`,
  arrangement: "编曲",
  seed: "旋律",
  engine: "引擎",
};

/**
 * Every audible difference between two configurations, one line each, in the
 * order a listener would notice them, with the parameter it belongs to.
 */
export function changeLines(
  before: MusicConfig,
  after: MusicConfig,
): ChangeLine[] {
  const out: ChangeLine[] = [];
  const push = (field: ChangeField, text: string) => out.push({ field, text });
  if (before.mood !== after.mood)
    push("mood", `风格改为「${styleLabel(after.mood)}」`);
  if (before.bpm !== after.bpm)
    push("bpm", `速度 ${before.bpm} → ${after.bpm} BPM`);
  if (before.key !== after.key)
    push("key", `调性 ${keyLabel(before.key)} → ${keyLabel(after.key)}`);
  if (before.instrument !== after.instrument)
    push("instrument", `主奏乐器换成${instrumentLabel(after.instrument)}`);
  if (before.duration !== after.duration)
    push("duration", `时长 ${before.duration} → ${after.duration} 秒`);
  for (const field of ["energy", "complexity", "reverb"] as const)
    if (Math.abs(before[field] - after[field]) > 1e-6)
      push(
        field,
        `${AMOUNT_LABELS[field]} ${percent(before[field])} → ${percent(after[field])}`,
      );
  if (before.loop !== after.loop)
    push("loop", after.loop ? "结构改为循环片段" : "结构改为完整结尾");
  for (const track of TRACK_ORDER) {
    const from = before.volumes[track];
    const to = after.volumes[track];
    if (Math.abs(from - to) <= 1e-6) continue;
    push(
      `vol:${track}`,
      to === 0
        ? `关闭${TRACK_LABELS[track]}`
        : from === 0
          ? `恢复${TRACK_LABELS[track]}`
          : `${TRACK_LABELS[track]}音量 ${percent(from)} → ${percent(to)}`,
    );
  }
  for (const text of describeArrangement(before.arrangement, after.arrangement))
    push("arrangement", text);
  if (before.seed !== after.seed) push("seed", "换一组新的旋律");
  if (before.engine !== after.engine) push("engine", "改用新版引擎");
  return out;
}

/**
 * Short Chinese phrases for every audible difference between two
 * configurations, in the order a listener would notice them. Returns [] when
 * nothing audible changed (the description text alone does not count).
 */
export function describeChanges(
  before: MusicConfig,
  after: MusicConfig,
): string[] {
  return changeLines(before, after).map((line) => line.text);
}

/** How many reasoning chips the thread keeps (src/state/session.ts). */
export const CHIP_SLOTS = 8;

/** How long one chip may be before the thread cuts it (src/state/session.ts). */
export const CHIP_CHARS = 160;

/**
 * Put `lines` into at most `slots` chips: the last chip takes what is left
 * over, and says how many more there are when even that does not fit.
 */
export function packChips(lines: string[], slots: number): string[] {
  const room = Math.max(1, slots);
  if (lines.length <= room) return lines;
  const rest = lines.slice(room - 1);
  let last = rest[0];
  let taken = 1;
  while (
    taken < rest.length &&
    [...`${last}，${rest[taken]}`].length <= CHIP_CHARS - 12
  )
    last += `，${rest[taken++]}`;
  if (taken < rest.length) last += `，另有 ${rest.length - taken} 项`;
  return [...lines.slice(0, room - 1), last];
}

export interface Telling {
  /** every change, as describeChanges has it */
  changes: string[];
  /** which parameters changed */
  fields: Set<ChangeField>;
  /** "好的：…。" with every change in it and the sentence about the tune; "" when nothing changed */
  reply: string;
  /** the same changes as chips, what was asked for first */
  chips: string[];
}

/**
 * The reply and the chips of a refinement, written from the difference
 * between two configurations and from nothing else — whoever planned it.
 *
 * When the style changed, `baseline` is the new style's own preset laid over
 * the old piece: what differs from it is what was asked for on top of the
 * restyle and is named first, in full; what merely came with the style
 * (tempo, key, lead, the three sliders) is named in one clause, so a restyle
 * can never crowd the user's own changes out of the reply.
 */
export function tellChanges(
  before: MusicConfig,
  after: MusicConfig,
  options: {
    baseline?: MusicConfig;
    provider?: Provider;
    heard?: MusicConfig;
  } = {},
): Telling {
  const lines = changeLines(before, after);
  const fields = new Set(lines.map((line) => line.field));
  const changes = lines.map((line) => line.text);
  if (!lines.length) return { changes, fields, reply: "", chips: [] };
  const restyled = before.mood !== after.mood && !!options.baseline;
  const own = restyled
    ? new Set(
        changeLines(options.baseline as MusicConfig, after).map(
          (line) => line.field,
        ),
      )
    : undefined;
  const style = lines.filter((line) => line.field === "mood");
  const asked = lines.filter(
    (line) => line.field !== "mood" && (!own || own.has(line.field)),
  );
  const came = lines.filter(
    (line) => line.field !== "mood" && !!own && !own.has(line.field),
  );
  const cameLabels = [...new Set(came.map((line) => FIELD_LABELS[line.field]))];
  const tune = melodyNote(options.heard ?? before, after, options.provider);
  const reply =
    `好的：${[...style, ...asked].map((line) => line.text).join("，")}` +
    (cameLabels.length ? `；${cameLabels.join("、")}随风格调整` : "") +
    `。${tune}`;
  const chips = [
    ...style.map((line) =>
      cameLabels.length
        ? `${line.text}（${cameLabels.join("、")}随风格）`
        : line.text,
    ),
    ...asked.map((line) => line.text),
  ];
  return { changes, fields, reply, chips: restyled ? chips : changes };
}

/**
 * The same differences for a piece that is being made for the first time:
 * what was chosen, not "from → to" (nothing existed before).
 */
export function describeChoices(
  preset: MusicConfig,
  chosen: MusicConfig,
): string[] {
  const out: string[] = [];
  if (preset.mood !== chosen.mood)
    out.push(`风格用「${styleLabel(chosen.mood)}」`);
  if (preset.bpm !== chosen.bpm) out.push(`速度 ${chosen.bpm} BPM`);
  if (preset.key !== chosen.key) out.push(`调性 ${keyLabel(chosen.key)}`);
  if (preset.instrument !== chosen.instrument)
    out.push(`主奏乐器用${instrumentLabel(chosen.instrument)}`);
  if (preset.duration !== chosen.duration)
    out.push(`时长 ${chosen.duration} 秒`);
  for (const field of ["energy", "complexity", "reverb"] as const)
    if (Math.abs(preset[field] - chosen[field]) > 1e-6)
      out.push(
        `${AMOUNT_LABELS[field]}${chosen[field] > preset[field] ? "调高" : "调低"}到 ${percent(chosen[field])}`,
      );
  if (preset.loop !== chosen.loop)
    out.push(chosen.loop ? "结构：循环片段" : "结构：完整结尾");
  for (const track of TRACK_ORDER) {
    const from = preset.volumes[track];
    const to = chosen.volumes[track];
    if (Math.abs(from - to) <= 1e-6) continue;
    out.push(
      to === 0
        ? `不用${TRACK_LABELS[track]}`
        : `${TRACK_LABELS[track]}音量 ${percent(to)}`,
    );
  }
  out.push(...describeArrangement(preset.arrangement, chosen.arrangement));
  return out;
}

/**
 * What a new version does to the tune when a cloud service makes it: the
 * service composes from the description alone, every time. Said in the reply
 * to any refinement on a cloud engine, whoever wrote the rest of the reply.
 */
export const CLOUD_MELODY_NOTE =
  "云端服务会按新的设置重新生成，旋律会和上一版不同。";

/**
 * The sentence about the tune in the reply to a refinement: what the change
 * does to the melody, by the composer's own account (melodyContinuity):
 * unchanged, the same motifs played anew, the same rhythm on rewritten
 * pitches (another mode), or a new tune. Another take (a new seed) rewrites
 * melody and chord progression while tempo, key and instruments stay.
 */
export function melodyNote(
  before: MusicConfig,
  after: MusicConfig,
  provider: Provider = "local",
): string {
  if (provider !== "local") return CLOUD_MELODY_NOTE;
  if (before.seed !== after.seed) {
    // another take rewrites the harmony as well: the chords are drawn from the seed too
    const kept =
      before.mood === after.mood &&
      before.bpm === after.bpm &&
      before.key === after.key &&
      before.instrument === after.instrument;
    return kept
      ? "旋律与和弦走向都会重写，速度、调性和乐器保持不变。"
      : "旋律与和弦走向都会重写。";
  }
  // a kind this build does not know yet says nothing rather than something untrue
  const kind: string = melodyContinuity(before, after);
  switch (kind) {
    case "identical":
      return "旋律保持不变。";
    case "adapted":
      return "旋律动机不变，会按新的设置重新演绎。";
    case "rhythm":
      // the same rhythm on other pitches: another mode, or another register or progression
      return parseKey(before.key).minor !== parseKey(after.key).minor
        ? "节奏型保持，音高会按新的调式重写。"
        : "节奏型保持，音高会按新的设置重写。";
    case "new":
      return "这是一段新的旋律。";
    default:
      return "";
  }
}

/* ---------- cloud prompt ---------- */

const band = (value: number, steps: [number, string][], last: string) =>
  steps.find(([limit]) => value < limit)?.[1] ?? last;

const tempoWord = (bpm: number) =>
  band(
    bpm,
    [
      [70, "很慢"],
      [90, "舒缓"],
      [110, "中速"],
      [130, "轻快"],
      [150, "快速"],
    ],
    "非常快",
  );
const energyWord = (value: number) =>
  band(
    value,
    [
      [0.2, "非常安静克制"],
      [0.4, "轻柔"],
      [0.6, "力度适中"],
      [0.8, "有活力"],
    ],
    "强烈饱满",
  );
const complexityWord = (value: number) =>
  band(
    value,
    [
      [0.3, "编曲极简"],
      [0.55, "编曲简洁"],
      [0.75, "编曲较丰富"],
    ],
    "编曲华丽、层次很多",
  );
const reverbWord = (value: number) =>
  band(
    value,
    [
      [0.15, "声音干净贴耳"],
      [0.4, "带一点空间感"],
      [0.65, "有明显的空间混响"],
    ],
    "空灵宽广的大混响",
  );

const MUTED: Record<TrackName, string> = {
  melody: "不要突出的旋律，以伴奏氛围为主",
  chords: "不要和声铺底",
  bass: "不要贝斯",
  drums: "不要鼓组",
};
const LOUD: Record<TrackName, string> = {
  melody: "旋律要突出",
  chords: "和声铺底厚一些",
  bass: "贝斯要厚实突出",
  drums: "鼓组要突出有力",
};
const QUIET: Record<TrackName, string> = {
  melody: "旋律靠后一些",
  chords: "和声轻一些",
  bass: "贝斯轻一些",
  drums: "鼓组轻一些",
};

/** A part that was off in the version before and is back now is named, not implied. */
const BACK: Record<TrackName, string> = {
  melody: "有清晰的主旋律",
  chords: "有和声铺底",
  bass: "有贝斯",
  drums: "有鼓组",
};

function trackEmphasis(config: MusicConfig, before?: MusicConfig): string[] {
  const notes: string[] = [];
  for (const track of TRACK_ORDER) {
    const value = config.volumes[track];
    const reference = DEFAULT_VOLUMES[track];
    if (value > 0.02 && before && before.volumes[track] <= 0.02)
      notes.push(BACK[track]);
    if (value <= 0.02) notes.push(MUTED[track]);
    else if (value >= reference + 0.15) notes.push(LOUD[track]);
    else if (value <= reference - 0.2) notes.push(QUIET[track]);
  }
  const hints = config.arrangement;
  if (hints?.swing && hints.swing >= 0.3) notes.push("带摇摆律动");
  if (hints?.drums === "fourfloor") notes.push("四拍底鼓");
  if (hints?.drums === "none" && config.volumes.drums > 0.02)
    notes.push(MUTED.drums);
  if (hints?.bass === "walking") notes.push("行走贝斯");
  if (hints?.layers?.pad) notes.push("有长音铺底");
  return notes;
}

/** One line, no control characters, no trailing sentence punctuation. */
const tidy = (text: string) =>
  text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。.!！;；,，、\s]+$/u, "");

/**
 * Does this clause of the description still hold for `config`? A cloud model
 * is stateless: a clause that names another lead, another length, a part that
 * is back in (or gone), another key or another style would contradict the
 * description derived from the configuration, so it is left out. So is
 * anything relative ("慢一点"): there is no earlier version to compare with.
 */
function stillHolds(clause: string, config: MusicConfig): boolean {
  const { analysis, words } = read(clause, "new");
  const minor = parseKey(config.key).minor;
  if (analysis.key && analysis.key !== config.key) return false;
  const named = new Set<string>();
  const scores = new Map<StyleId, number>();
  for (const word of words) {
    const lex = word.lex;
    const off = word.neg === "hard";
    const qty = lex.qty;
    if (qty?.unit === "bpm" && qty.value !== config.bpm) return false;
    if (
      qty?.unit === "s" &&
      qty.value >= 5 &&
      Math.round(qty.value) !== config.duration
    )
      return false;
    if (qty && qty.unit !== "bpm" && qty.unit !== "s") return false;
    if (lex.shift || lex.relative || lex.seed || lex.reset || lex.other)
      return false;
    // "女声演唱" next to "无人声" would be a contradiction of our own making
    if (lex.unsupported && !word.neg) return false;
    if (
      lex.mode &&
      !lex.w &&
      !lex.dim &&
      (lex.mode === "minor") !== (off ? !minor : minor)
    )
      return false;
    if (lex.inst && !lex.cat) {
      if (off && lex.inst === config.instrument) return false;
      if (!off && !word.replaced) named.add(lex.inst);
    }
    if (
      lex.target === "melody" ||
      lex.target === "chords" ||
      lex.target === "bass" ||
      lex.target === "drums"
    ) {
      const audible = config.volumes[lex.target] > 0.02;
      if (off ? audible : !audible) return false;
    }
    if (
      lex.solo &&
      (["chords", "bass", "drums"] as const).some(
        (track) => config.volumes[track] > 0.02,
      )
    )
      return false;
    if (lex.noDrums && !off && config.volumes.drums > 0.02) return false;
    if (
      lex.loop !== undefined &&
      !lex.w &&
      (off ? !lex.loop : lex.loop) !== config.loop
    )
      return false;
    if (lex.dim && lex.dir && (word.compared || word.too || lex.fixed))
      return false;
    if (lex.dim === "tempo" && lex.dir && !word.neg) {
      if (lex.dir < 0 && config.bpm >= 116) return false;
      if (lex.dir > 0 && (lex.pos ?? 0.7) >= 0.6 && config.bpm < 88)
        return false;
    }
    if (lex.dim === "energy" && lex.dir && !word.neg) {
      if (lex.dir < 0 && config.energy >= 0.7) return false;
      if (lex.dir > 0 && config.energy <= 0.3) return false;
    }
    if ((lex.op === "up" || lex.op === "down") && word.text.length > 1)
      return false;
    if (lex.w && lex.cat && !word.neg && !word.too) {
      const weights = Object.entries(lex.w) as [StyleId, number][];
      // a mood word names a style only when it is that style's own word ("梦幻", "悲伤")
      const telling =
        lex.cat !== "emotion" || weights.some(([, weight]) => weight >= 3);
      if (telling)
        for (const [id, weight] of weights)
          scores.set(id, (scores.get(id) ?? 0) + weight);
      // "欢快" does not describe a piece that has become sad
      const mood = STYLE_COORDS[config.mood][0];
      if (
        lex.cat === "emotion" &&
        Math.abs(lex.v ?? 0) >= 0.4 &&
        Math.abs(mood) >= 0.4 &&
        Math.sign(lex.v ?? 0) !== Math.sign(mood)
      )
        return false;
    }
    if (lex.w && lex.cat && off && (lex.w[config.mood] ?? 0) >= 2) return false;
  }
  if (named.size && !named.has(config.instrument)) return false;
  const strongest = Math.max(0, ...scores.values());
  return !(strongest >= 2 && (scores.get(config.mood) ?? 0) < 0.5 * strongest);
}

/** The user's description without the clauses the configuration has moved away from. */
function validDescription(config: MusicConfig): string {
  const own = tidy(config.prompt);
  if (!own) return "";
  const clauses = own
    .split(/[,，。;；!！?？\n]|\.(?=\s|$)/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  // one endless clause list is not worth reading word by word
  if (clauses.length > 80) return own;
  const kept = clauses.filter((clause) => stillHolds(clause, config));
  return kept.length === clauses.length ? own : kept.join("，");
}

/**
 * A natural Chinese description of `config` for a text-to-music model: the
 * still-valid part of the user's own description first, then the piece as the
 * configuration has it (style, tempo, key, lead, the three sliders, the
 * parts, structure, length). Nothing relative ("慢一点") is ever passed on —
 * the model has no earlier version to compare with. `before` is the version
 * a refinement started from: a part that was off there and is on now is
 * named. The result always ends with the instrumental requirement and never
 * exceeds CLOUD_PROMPT_MAX characters.
 */
export function buildCloudPrompt(
  config: MusicConfig,
  before?: MusicConfig,
): string {
  const info = styleInfo(config.mood);
  const tail = [
    `风格：${info.label}，${tidy(info.description)}`,
    `速度约 ${config.bpm} BPM（${tempoWord(config.bpm)}），${keyLabel(config.key)}，主奏乐器为${instrumentLabel(config.instrument)}`,
    `整体${energyWord(config.energy)}，${complexityWord(config.complexity)}，${reverbWord(config.reverb)}`,
    ...[trackEmphasis(config, before).join("，")].filter(Boolean),
    config.loop
      ? "需要能无缝循环播放，首尾自然衔接"
      : "有完整的开头和自然的结尾",
    `时长约 ${config.duration} 秒`,
    INSTRUMENTAL_ONLY,
  ].join("。");
  const room = CLOUD_PROMPT_MAX - tail.length - 1;
  const head = tidy(validDescription(config).slice(0, Math.max(0, room)));
  const prompt = head ? `${head}。${tail}` : tail;
  return prompt.length <= CLOUD_PROMPT_MAX
    ? prompt
    : prompt.slice(0, CLOUD_PROMPT_MAX - INSTRUMENTAL_ONLY.length - 1) +
        "。" +
        INSTRUMENTAL_ONLY;
}
