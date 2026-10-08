/**
 * Putting a configuration into Chinese words: the prompt sent to a cloud
 * text-to-music model, and the short "what changed" phrases shown in the chat.
 *
 * Parameters and tracks are called what the inspector and the mixer call them
 * (情绪能量, 旋律丰富度, 空间混响, 主奏乐器, 旋律 / 和声 / 贝斯 / 鼓组), so a
 * reasoning chip can be found on screen by its name.
 */
import type { ArrangementHints, MusicConfig, TrackName } from "../types";
import {
  instrumentLabel,
  parseKey,
  styleInfo,
  styleLabel,
  type BassFeel,
  type DrumFeel,
} from "../music/catalog";
import { DEFAULT_VOLUMES } from "../music/defaults";

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
const REGISTER_LABELS = { low: "低音区", mid: "中音区", high: "高音区" } as const;
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

/**
 * Short Chinese phrases for every audible difference between two
 * configurations, in the order a listener would notice them. Returns [] when
 * nothing audible changed (the description text alone does not count).
 */
export function describeChanges(
  before: MusicConfig,
  after: MusicConfig,
): string[] {
  const out: string[] = [];
  if (before.mood !== after.mood)
    out.push(`风格改为「${styleLabel(after.mood)}」`);
  if (before.bpm !== after.bpm)
    out.push(`速度 ${before.bpm} → ${after.bpm} BPM`);
  if (before.key !== after.key)
    out.push(`调性 ${keyLabel(before.key)} → ${keyLabel(after.key)}`);
  if (before.instrument !== after.instrument)
    out.push(`主奏乐器换成${instrumentLabel(after.instrument)}`);
  if (before.duration !== after.duration)
    out.push(`时长 ${before.duration} → ${after.duration} 秒`);
  for (const field of ["energy", "complexity", "reverb"] as const)
    if (Math.abs(before[field] - after[field]) > 1e-6)
      out.push(
        `${AMOUNT_LABELS[field]} ${percent(before[field])} → ${percent(after[field])}`,
      );
  if (before.loop !== after.loop)
    out.push(after.loop ? "改为无缝循环" : "改为带结尾的完整版本");
  for (const track of TRACK_ORDER) {
    const from = before.volumes[track];
    const to = after.volumes[track];
    if (Math.abs(from - to) <= 1e-6) continue;
    out.push(
      to === 0
        ? `关闭${TRACK_LABELS[track]}`
        : from === 0
          ? `恢复${TRACK_LABELS[track]}`
          : `${TRACK_LABELS[track]}音量 ${percent(from)} → ${percent(to)}`,
    );
  }
  out.push(...describeArrangement(before.arrangement, after.arrangement));
  if (before.seed !== after.seed) out.push("换一组新的旋律");
  if (before.engine !== after.engine) out.push("改用新版音色引擎");
  return out;
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

function trackEmphasis(config: MusicConfig): string[] {
  const notes: string[] = [];
  for (const track of TRACK_ORDER) {
    const value = config.volumes[track];
    const reference = DEFAULT_VOLUMES[track];
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
 * A natural Chinese description of `config` for a text-to-music model. The
 * user's own words come first; the result always ends with the instrumental
 * requirement and never exceeds CLOUD_PROMPT_MAX characters.
 */
export function buildCloudPrompt(config: MusicConfig, extra?: string): string {
  const info = styleInfo(config.mood);
  const derived = [
    `风格：${info.label}，${tidy(info.description)}`,
    `速度约 ${config.bpm} BPM（${tempoWord(config.bpm)}），${keyLabel(config.key)}，主奏乐器为${instrumentLabel(config.instrument)}`,
    `整体${energyWord(config.energy)}，${complexityWord(config.complexity)}，${reverbWord(config.reverb)}`,
    ...[trackEmphasis(config).join("，")].filter(Boolean),
    config.loop
      ? "需要能无缝循环播放，首尾自然衔接"
      : "有完整的开头和自然的结尾",
    `时长约 ${config.duration} 秒`,
    INSTRUMENTAL_ONLY,
  ].join("。");
  const addition = tidy(extra ?? "").slice(0, 400);
  const tail =
    (addition ? `补充要求：${addition}。` : "") + derived;
  const room = CLOUD_PROMPT_MAX - tail.length - 1;
  const own = tidy(config.prompt).slice(0, Math.max(0, room));
  const head = tidy(own);
  const prompt = head ? `${head}。${tail}` : tail;
  return prompt.length <= CLOUD_PROMPT_MAX
    ? prompt
    : prompt.slice(0, CLOUD_PROMPT_MAX - INSTRUMENTAL_ONLY.length - 1) +
        "。" +
        INSTRUMENTAL_ONLY;
}
