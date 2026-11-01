/**
 * 简单模式's words: what a piece is and what a change did, said the way
 * anyone would say it — no tempo numbers, key names, percentages or
 * engineering terms. Every sentence is derived from the settings themselves
 * (before and after), never from a producer's own phrasing, so it cannot
 * claim a change that did not happen. Pure.
 */
import type { StyleId } from "../music/catalog";
import { melodyContinuity } from "../music/compose";
import type { MelodyContinuity } from "../music/compose";
import type { InstrumentId } from "../music/catalog";
import type { MusicConfig, Project, TrackName } from "../types";
import { fittedTiming, scoreFacts } from "./score";
import type { Job } from "./types";

/** A style as a feeling: "轻快明亮 · 1 分钟", "换成了慵懒放松的感觉". */
export const STYLE_FEEL: Readonly<Record<StyleId, string>> = {
  bright: "轻快明亮",
  chill: "慵懒放松",
  cinematic: "电影氛围",
  dreamy: "梦幻空灵",
  focus: "安静专注",
  retro: "复古电子",
  epic: "宏大燃情",
  chiptune: "像素游戏",
  guofeng: "国风古韵",
  jazz: "爵士小馆",
  acoustic: "温暖木吉他",
  tension: "悬疑紧张",
  cute: "俏皮活泼",
  battle: "热血战斗",
  ambient: "舒缓安宁",
  corporate: "简洁科技",
  sad: "伤感抒情",
  dance: "动感有力",
  hiphop: "嘻哈律动",
  rock: "摇滚有劲",
  romantic: "浪漫温馨",
  festive: "节日喜庆",
};

export function styleFeel(mood: StyleId): string {
  return STYLE_FEEL[mood] ?? "轻松";
}

/** A lead instrument by the name anyone uses for it. */
export const PLAIN_INSTRUMENT: Readonly<Record<InstrumentId, string>> = {
  piano: "钢琴",
  epiano: "电钢琴",
  guitar: "木吉他",
  synth: "电子琴",
  pluck: "电子拨弦",
  bell: "钟琴",
  musicbox: "八音盒",
  marimba: "马林巴",
  vibes: "颤音琴",
  flute: "长笛",
  strings: "弦乐",
  guzheng: "古筝",
  dizi: "竹笛",
  chip: "游戏机音色",
};

export function plainInstrument(id: InstrumentId): string {
  return PLAIN_INSTRUMENT[id] ?? "别的乐器";
}

/**
 * A length as it is said: "30 秒", "1 分钟", "1 分 30 秒". A length within two
 * seconds of whole minutes is those minutes (a loop is fitted to whole bars).
 */
export function plainDuration(seconds: number): string {
  const total =
    Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  const minutes = Math.round(total / 60);
  if (minutes >= 1 && Math.abs(total - minutes * 60) <= 2)
    return `${minutes} 分钟`;
  if (total < 60) return `${total} 秒`;
  return `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
}

/** Seconds a configuration really lasts when nothing better is known. */
function lengthOf(config: MusicConfig, cloud: boolean): number {
  if (cloud || config.engine !== 2) return config.duration;
  try {
    return fittedTiming(config).duration;
  } catch {
    return config.duration;
  }
}

/**
 * "轻快明亮 · 1 分钟 · 可以循环播放": what a piece is. `seconds` is the length
 * of its audio when known. A piece made by an AI service says so instead of
 * promising a seamless loop (nothing measured what it played).
 */
export function plainSummary(project: Project, seconds?: number): string {
  const cloud = project.provider !== "local";
  const length =
    seconds ?? project.audioDuration ?? lengthOf(project.config, cloud);
  return [
    styleFeel(project.config.mood),
    plainDuration(length),
    cloud ? "AI 服务生成" : project.config.loop ? "可以循环播放" : "有完整结尾",
  ].join(" · ");
}

/** The line after a new piece is made. */
export function newPieceLine(project: Project, seconds?: number): string {
  return `做好了：${plainSummary(project, seconds)}`;
}

/** The line when a tweak changed nothing. */
export const NOTHING_CHANGED = "这次没有可以改的地方，试试别的按钮吧。";

const TRACK_WORDS: Record<Exclude<TrackName, "drums">, string> = {
  melody: "主旋律",
  chords: "伴奏",
  bass: "低音",
};

/** Drums one can hear: written into the piece and not turned down to nothing. */
function hearsDrums(config: MusicConfig, cloud: boolean): boolean {
  if (!(config.volumes.drums > 0)) return false;
  if (config.arrangement?.drums === "none") return false;
  if (cloud || config.engine !== 2) return true;
  return scoreFacts(config)?.playing.drums ?? true;
}

const MELODY_WORDS: Record<MelodyContinuity, string> = {
  identical: "旋律没变",
  adapted: "旋律大体没变",
  rhythm: "换了一段新旋律",
  new: "换了一段新旋律",
};

/** Smallest change of a 0..1 control that is worth saying. */
const NOTICEABLE = 0.03;

/**
 * What a new version changed, in a few plain words: "改好了：节奏快了一点、
 * 去掉了鼓，旋律没变。" At most four items (more end in 等); no numbers but a
 * length. `continuity` is what the composer says happened to the tune
 * (cloud services always write a new one: pass "new"). Without any change
 * at all the answer invites another button.
 */
export function plainChanges(
  before: MusicConfig,
  after: MusicConfig,
  continuity: MelodyContinuity,
  options: {
    /** seconds of the new audio, when known */
    seconds?: number;
    /** the new version was made by an AI service */
    cloud?: boolean;
  } = {},
): string {
  const cloud = options.cloud === true;
  const items: string[] = [];
  const nudged = (key: "energy" | "complexity" | "reverb") =>
    Math.abs(after[key] - before[key]) >= NOTICEABLE
      ? Math.sign(after[key] - before[key])
      : 0;

  if (before.mood !== after.mood)
    // a style brings its own tempo, instrument and colour: said as one change
    items.push(`换成了${styleFeel(after.mood)}的感觉`);
  else {
    if (Math.round(after.bpm) !== Math.round(before.bpm)) {
      const ratio = (after.bpm - before.bpm) / Math.max(1, before.bpm);
      const much = Math.abs(ratio) >= 0.25;
      items.push(
        ratio > 0
          ? much
            ? "节奏快了很多"
            : "节奏快了一点"
          : much
            ? "节奏慢了很多"
            : "节奏慢了一点",
      );
    }
    const energy = nudged("energy");
    if (energy) items.push(energy > 0 ? "更有活力了" : "更安静了");
    if (after.instrument !== before.instrument)
      items.push(`主旋律换成了${plainInstrument(after.instrument)}`);
  }

  const drumsBefore = hearsDrums(before, cloud);
  const drumsAfter = hearsDrums(after, cloud);
  if (drumsBefore && !drumsAfter) items.push("去掉了鼓");
  else if (!drumsBefore && drumsAfter)
    items.push(before.volumes.drums > 0 ? "加上了鼓" : "加回了鼓");
  else if (drumsAfter && after.volumes.drums !== before.volumes.drums)
    items.push(
      after.volumes.drums > before.volumes.drums
        ? "鼓声大了一点"
        : "鼓声小了一点",
    );
  for (const track of ["melody", "chords", "bass"] as const) {
    const was = before.volumes[track];
    const now = after.volumes[track];
    if (was === now) continue;
    const name = TRACK_WORDS[track];
    if (now <= 0) items.push(`去掉了${name}`);
    else if (was <= 0) items.push(`加回了${name}`);
    else items.push(`${name}声音${now > was ? "大" : "小"}了一点`);
  }

  if (after.duration !== before.duration) {
    const now = plainDuration(options.seconds ?? lengthOf(after, cloud));
    items.push(
      after.duration > before.duration
        ? `变长了，现在 ${now}`
        : `变短了，现在 ${now}`,
    );
  }
  if (after.loop !== before.loop)
    items.push(after.loop ? "现在可以无缝循环播放" : "现在有完整的结尾");

  if (before.mood === after.mood) {
    if (after.key !== before.key) items.push("音调换了一下");
    const richness = nudged("complexity");
    if (richness) items.push(richness > 0 ? "旋律更丰富了" : "旋律更简单了");
    const space = nudged("reverb");
    if (space) items.push(space > 0 ? "更空旷了" : "更贴近了");
    if (
      items.length === 0 &&
      JSON.stringify(after.arrangement ?? {}) !==
        JSON.stringify(before.arrangement ?? {})
    )
      items.push("伴奏换了一种写法");
  }

  const melody = MELODY_WORDS[continuity] ?? MELODY_WORDS.new;
  if (items.length === 0)
    return continuity === "identical" ? NOTHING_CHANGED : `改好了：${melody}。`;
  const list =
    items.length > 4 ? `${items.slice(0, 4).join("、")}等` : items.join("、");
  return `改好了：${list}，${melody}。`;
}

/**
 * plainChanges for a version and the one it was made from: the tune is
 * compared by the composer itself for two local works; an AI service
 * always writes a new one.
 */
export function changeLine(
  parent: Project,
  project: Project,
  seconds?: number,
): string {
  const cloud = project.provider !== "local";
  let continuity: MelodyContinuity = "new";
  if (!cloud && parent.provider === "local") {
    try {
      continuity = melodyContinuity(parent.config, project.config);
    } catch {
      continuity = "new";
    }
  }
  return plainChanges(parent.config, project.config, continuity, {
    cloud,
    ...(seconds !== undefined ? { seconds } : {}),
  });
}

/** What a running job is doing, in plain words (the percentage is added by the caller). */
export function plainPhase(job: Pick<Job, "kind" | "stage" | "brain">): string {
  switch (job.stage) {
    case "planning":
      return job.brain === "llm"
        ? "正在想怎么写，可能要等一会儿"
        : "正在想怎么写";
    case "asking":
      return "等你决定";
    case "rendering":
      return job.kind === "open" ? "正在打开" : "正在作曲";
    case "cloud":
      return "AI 服务正在作曲，通常要几十秒到几分钟";
    case "downloading":
      return "正在重新下载，不会再收费";
    case "saving":
      return "正在保存";
    case "decoding":
      return job.kind === "open" ? "正在打开" : "马上就好";
    case "cancelling":
      return "正在取消";
  }
}

/**
 * The app's own messages, as 简单模式 names things: the library is
 * 「我的音乐」, saving a file is 「下载音乐」. Anything else is left as it is.
 */
export function plainWords(text: string): string {
  return text
    .replace(/「我的作品」/g, "「我的音乐」")
    .replace(/「导出」/g, "「下载音乐」")
    .replace(/「新建创作」/g, "「重新挑」")
    .replace(/^创作完成，/, "做好了，")
    .replace(/^已导出到选定位置$/, "已保存");
}
