/**
 * 简单模式's ready-made choices: the twelve scene cards, the other styles
 * behind 更多风格, the length options, and the one-tap tweaks of a finished
 * piece (each a fixed sentence for the producer). Pure data and small
 * functions; the producer and the pins do the rest, exactly as in 专业模式.
 */
import { planWithRules } from "../agent/rules";
import { INSTRUMENT_IDS, instrumentLabel, styleLabel } from "../music/catalog";
import type { InstrumentId, StyleId } from "../music/catalog";
import type { MusicConfig, Project } from "../types";
import { exportChoices } from "../services/exporter";
import { newPieceBase } from "./plan";
import type { ExportRequest, LoadedAudio, Pins } from "./types";

export interface Scene {
  /** data-scene of the card */
  id: string;
  /** what the card is called */
  title: string;
  /** one line: what it is good for */
  use: string;
  mood: StyleId;
  /** seconds, used when the length is left on 自动 */
  duration: number;
  /** true: plays on seamlessly; false: has a proper ending */
  loop: boolean;
}

export const SCENES: readonly Scene[] = [
  {
    id: "vlog",
    title: "日常 Vlog",
    use: "轻快明亮，适合记录生活",
    mood: "bright",
    duration: 60,
    loop: false,
  },
  {
    id: "cafe",
    title: "咖啡馆",
    use: "慵懒放松，适合店里播放",
    mood: "chill",
    duration: 60,
    loop: true,
  },
  {
    id: "travel",
    title: "旅行风景",
    use: "温暖的木吉他",
    mood: "acoustic",
    duration: 60,
    loop: false,
  },
  {
    id: "pets",
    title: "可爱萌宠",
    use: "俏皮活泼",
    mood: "cute",
    duration: 30,
    loop: false,
  },
  {
    id: "study",
    title: "学习专注",
    use: "安静不打扰",
    mood: "focus",
    duration: 120,
    loop: true,
  },
  {
    id: "sleep",
    title: "睡前放松",
    use: "舒缓助眠",
    mood: "ambient",
    duration: 120,
    loop: true,
  },
  {
    id: "workout",
    title: "运动健身",
    use: "动感有力",
    mood: "dance",
    duration: 60,
    loop: false,
  },
  {
    id: "game",
    title: "游戏关卡",
    use: "8-bit 像素风",
    mood: "chiptune",
    duration: 30,
    loop: true,
  },
  {
    id: "epic",
    title: "史诗大片",
    use: "宏大燃情",
    mood: "epic",
    duration: 60,
    loop: false,
  },
  {
    id: "guofeng",
    title: "国风古韵",
    use: "古筝与竹笛",
    mood: "guofeng",
    duration: 60,
    loop: false,
  },
  {
    id: "romantic",
    title: "浪漫温馨",
    use: "婚礼、纪念日",
    mood: "romantic",
    duration: 60,
    loop: false,
  },
  {
    id: "tech",
    title: "科技产品",
    use: "发布会、产品介绍",
    mood: "corporate",
    duration: 30,
    loop: false,
  },
];

/** The other styles, as small buttons under the cards (名字 = the catalog's own). */
export const MORE_STYLES: readonly Scene[] = (
  [
    ["sad", false],
    ["jazz", false],
    ["hiphop", false],
    ["retro", false],
    ["cinematic", false],
    ["dreamy", false],
    ["tension", true],
    ["battle", true],
    ["rock", false],
    ["festive", false],
  ] as const
).map(([mood, loop]) => ({
  id: mood,
  title: styleLabel(mood),
  use: "",
  mood,
  duration: 60,
  loop,
}));

/** 长度：自动 · 30 秒 · 1 分钟 · 2 分钟 (null = 自动). */
export const LENGTH_CHOICES: readonly {
  value: number | null;
  label: string;
}[] = [
  { value: null, label: "自动" },
  { value: 30, label: "30 秒" },
  { value: 60, label: "1 分钟" },
  { value: 120, label: "2 分钟" },
];

/**
 * The pins a scene (or a style button) sends: its style and structure, and
 * its own length unless the user picked one.
 */
export function scenePins(scene: Scene, length?: number | null): Pins {
  return {
    mood: scene.mood,
    duration: length ?? scene.duration,
    loop: scene.loop,
  };
}

/** The length a sentence gets when nobody says one (spec: 默认 60 秒). */
export const SENTENCE_LENGTH = 60;

/**
 * The sentence names a length of its own ("两分钟的睡前音乐"): the offline
 * rules give the same length whatever the piece would otherwise last.
 */
export function saysLength(text: string): boolean {
  const request = {
    text,
    mode: "new" as const,
    current: { ...newPieceBase({}), duration: 45 },
    provider: "local" as const,
    history: [],
    nextSeed: 0,
  };
  const heard = (seconds: number) =>
    planWithRules({
      ...request,
      current: { ...request.current, duration: seconds },
    }).config.duration;
  return heard(45) !== 45 || heard(75) !== 75;
}

/**
 * The pins of 做一首: the length the user picked; with 自动 the length the
 * sentence itself names, else one minute. Style and structure are left to
 * the producer.
 */
export function sentencePins(text: string, length?: number | null): Pins {
  if (length) return { duration: length };
  return saysLength(text) ? {} : { duration: SENTENCE_LENGTH };
}

/* ------------------------------------------------------------------ */
/* 换个乐器: the lead instruments that suit each style, in turn         */
/* ------------------------------------------------------------------ */

/**
 * Leads that sit well in each style, in the order 换个乐器 offers them. A
 * small fixed table, so the same piece always gets the same next one.
 */
export const STYLE_LEADS: Readonly<Record<StyleId, readonly InstrumentId[]>> = {
  bright: ["piano", "guitar", "marimba", "pluck", "bell"],
  chill: ["epiano", "piano", "guitar", "vibes"],
  cinematic: ["piano", "strings", "flute", "bell"],
  dreamy: ["bell", "musicbox", "piano", "flute"],
  focus: ["piano", "epiano", "guitar", "marimba"],
  retro: ["synth", "pluck", "epiano"],
  epic: ["strings", "synth", "piano"],
  chiptune: ["chip", "synth", "pluck"],
  guofeng: ["guzheng", "dizi", "flute", "piano"],
  jazz: ["vibes", "epiano", "piano", "guitar"],
  acoustic: ["guitar", "piano", "flute", "marimba"],
  tension: ["strings", "piano", "synth"],
  cute: ["marimba", "musicbox", "bell", "pluck"],
  battle: ["synth", "strings", "chip"],
  ambient: ["bell", "piano", "flute", "strings"],
  corporate: ["pluck", "piano", "synth", "marimba"],
  sad: ["piano", "strings", "guitar", "flute"],
  dance: ["synth", "pluck", "piano"],
  hiphop: ["epiano", "piano", "vibes", "guitar"],
  rock: ["guitar", "synth", "piano"],
  romantic: ["piano", "strings", "guitar", "flute"],
  festive: ["bell", "marimba", "dizi", "piano"],
};

/** The lead that 换个乐器 brings next: never the one playing now. */
export function nextInstrument(
  style: StyleId,
  current: InstrumentId,
): InstrumentId {
  const list: readonly InstrumentId[] = STYLE_LEADS[style] ?? INSTRUMENT_IDS;
  const at = list.indexOf(current);
  const next = list[(at + 1) % list.length];
  if (next !== current) return next;
  // a one-entry list that holds the current lead: any other one will do
  return INSTRUMENT_IDS[
    (INSTRUMENT_IDS.indexOf(current) + 1) % INSTRUMENT_IDS.length
  ];
}

/* ------------------------------------------------------------------ */
/* the one-tap tweaks of a finished piece                               */
/* ------------------------------------------------------------------ */

export type TweakId =
  | "happier"
  | "calmer"
  | "faster"
  | "slower"
  | "longer"
  | "shorter"
  | "instrument"
  | "drums"
  | "structure";

export interface Tweak {
  /** data-testid: tweak-<id> */
  id: TweakId;
  /** what the button says */
  label: string;
  /** the sentence sent to the producer */
  phrase: string;
}

/**
 * The tweak buttons for a piece: fixed sentences the producer understands,
 * with the instrument, drum and structure buttons following the piece.
 * `drums`: the piece has drums one can hear.
 */
export function tweaksFor(
  config: Pick<MusicConfig, "mood" | "instrument" | "loop">,
  drums: boolean,
): Tweak[] {
  const lead = nextInstrument(config.mood, config.instrument);
  return [
    { id: "happier", label: "更欢快", phrase: "更欢快" },
    { id: "calmer", label: "更安静", phrase: "更安静" },
    { id: "faster", label: "快一点", phrase: "快一点" },
    { id: "slower", label: "慢一点", phrase: "慢一点" },
    { id: "longer", label: "长一点", phrase: "长一点" },
    { id: "shorter", label: "短一点", phrase: "短一点" },
    {
      id: "instrument",
      label: "换个乐器",
      phrase: `换成${instrumentLabel(lead)}`,
    },
    drums
      ? { id: "drums", label: "去掉鼓", phrase: "去掉鼓" }
      : { id: "drums", label: "加点鼓", phrase: "加点鼓" },
    config.loop
      ? { id: "structure", label: "加个结尾", phrase: "加个结尾" }
      : { id: "structure", label: "做成循环", phrase: "做成循环" },
  ];
}

/**
 * 下载音乐: the whole piece as one file, named by its title — the mix as WAV
 * for a local piece, the audio exactly as the service sent it for one made
 * by an AI service. A v0.2 piece with an ending gets the short fade in and
 * out 专业模式's 导出 gives it by default (exportChoices.canFade).
 */
export function downloadRequest(
  project: Project,
  audio?: LoadedAudio | null,
): ExportRequest {
  if (project.provider !== "local")
    return { kind: "original", plainName: true };
  return exportChoices(project, audio ?? null).canFade
    ? { kind: "mix", plainName: true, fade: true }
    : { kind: "mix", plainName: true };
}
