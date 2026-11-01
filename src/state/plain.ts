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
import { LIMITS } from "../music/catalog";
import type { InstrumentId } from "../music/catalog";
import type { MusicConfig, Project, TrackName } from "../types";
import { fittedTiming, scoreFacts, silentStem } from "./score";
import type { Job, LoadedAudio } from "./types";

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

/** A whole number of seconds said the way people do: "30 秒", "1 分钟", "1 分 30 秒". */
function wholeLength(total: number): string {
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`;
}

/**
 * A length as it is said: "30 秒", "1 分钟", "1 分 30 秒". `asked` is the
 * length the piece was asked for: audio within half a second of it is that
 * length, audio a little off it (a loop is fitted to whole bars, at most a
 * bar away) is "约 1 分钟" — never "1 分 3 秒" next to a player that shows
 * 1:02. Any other length is told in whole seconds, rounded down exactly as
 * the player's clock does, so the two always agree.
 */
export function plainDuration(seconds: number, asked?: number): string {
  const real = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (asked !== undefined && Number.isFinite(asked) && asked >= 1) {
    const target = Math.round(asked);
    const off = Math.abs(real - target);
    if (off < 0.5) return wholeLength(target);
    if (off <= Math.max(2, target * 0.1)) return `约 ${wholeLength(target)}`;
  }
  return wholeLength(Math.floor(real));
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
    plainDuration(length, project.config.duration),
    cloud ? "AI 服务生成" : project.config.loop ? "可以循环播放" : "有完整结尾",
  ].join(" · ");
}

/**
 * The line after a new piece is made: not its description again (that is
 * right above it) but what to do next. `saved`: it is in 「我的音乐」.
 */
export function newPieceLine(saved = true): string {
  return `${saved ? "做好了，已经存进「我的音乐」。" : "做好了。"}满意就点「下载音乐」；想改哪里，点下面的按钮。`;
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
 * (cloud services always write a new one: pass "new"). Only two sets of
 * settings that are the same in every way answer NOTHING_CHANGED; a version
 * that differs by a nudge below what is usually worth saying still says
 * which way it moved — a new version never reads "nothing changed".
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
  let smallest = NOTICEABLE;
  const nudged = (key: "energy" | "complexity" | "reverb") =>
    Math.abs(after[key] - before[key]) >= smallest
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
    const now = plainDuration(
      options.seconds ?? lengthOf(after, cloud),
      after.duration,
    );
    // "现在 1 分钟", "现在约 1 分钟"
    const at = now.startsWith("约") ? `现在${now}` : `现在 ${now}`;
    items.push(
      after.duration > before.duration ? `变长了，${at}` : `变短了，${at}`,
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

  if (items.length === 0 && before.mood === after.mood) {
    // A version was made: even a small nudge is said, never "nothing".
    smallest = Number.EPSILON;
    const energy = nudged("energy");
    if (energy) items.push(energy > 0 ? "更有活力了" : "更安静了");
    const richness = nudged("complexity");
    if (richness) items.push(richness > 0 ? "旋律更丰富了" : "旋律更简单了");
    const space = nudged("reverb");
    if (space) items.push(space > 0 ? "更空旷了" : "更贴近了");
  }

  const melody = MELODY_WORDS[continuity] ?? MELODY_WORDS.new;
  if (items.length === 0) {
    if (continuity !== "identical") return `改好了：${melody}。`;
    const { prompt: _a, ...was } = before;
    const { prompt: _b, ...now } = after;
    return JSON.stringify(was) === JSON.stringify(now)
      ? NOTHING_CHANGED
      : `改好了：变化很细微，${melody}。`;
  }
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

/** Said after the result line when the language model failed and the offline rules answered. */
export const FALLBACK_NOTE = "大模型这次没有回应，用的是内置的方式。";

/** Said where the change line was, right after 撤销. */
export const UNDONE_LINE = "已撤销，回到了上一版。";

/**
 * Drums one can hear in a piece: written into it (a local work's own score,
 * or the drum stem of its audio) and not turned down to nothing. Decides
 * between 去掉鼓 and 加点鼓.
 */
export function drumsHeard(
  project: Pick<Project, "config" | "provider">,
  audio?: LoadedAudio | null,
): boolean {
  const { config } = project;
  if (!(config.volumes.drums > 0)) return false;
  if (project.provider !== "local") return true;
  if (config.arrangement?.drums === "none") return false;
  if (audio?.kind === "stems") return !silentStem(audio.stemPeaks?.drums);
  return scoreFacts(config)?.playing.drums ?? true;
}

/**
 * The plain answer when a one-tap tweak cannot change anything (the offline
 * rules return the piece unchanged): at a limit it says which one, instead
 * of a vague "nothing to change".
 */
export function tweakAnswer(
  id: string,
  config: Pick<MusicConfig, "loop">,
  drums: boolean,
): string {
  switch (id) {
    case "longer":
      return config.loop
        ? `已经是最长的 ${plainDuration(LIMITS.duration[1])}了。它可以无缝循环，想放多久都行。`
        : `已经是最长的 ${plainDuration(LIMITS.duration[1])}了。想一直放的话，可以点「做成循环」。`;
    case "shorter":
      return `已经是最短的 ${plainDuration(LIMITS.duration[0])}了。`;
    case "faster":
      return "已经是最快的了，没法再快。";
    case "slower":
      return "已经是最慢的了，没法再慢。";
    case "happier":
      return "已经是最欢快的了。";
    case "calmer":
      return "已经是最安静的了。";
    case "drums":
      return drums
        ? "这首的鼓没法再去掉了，试试「更安静」吧。"
        : "这首不太适合加鼓，试试「更欢快」吧。";
    default:
      return NOTHING_CHANGED;
  }
}

/**
 * The plain answer when words the user typed change nothing, from the
 * producer's own (app-written) reply: praise is thanked, a sentence with
 * nothing to act on gets examples, anything else is already so.
 */
export function sayAnswer(reply: string): string {
  if (/很高兴你喜欢/.test(reply))
    return "很高兴你喜欢！想再改的话，点下面的按钮或者接着说就行。";
  if (/没有听出要调整什么|没有.*识别到/.test(reply))
    return "没听出这句话想怎么改。可以说得具体一点，比如「鼓声小一点」「换成钢琴」「再欢快一点」。";
  return "这首已经是这样了，没有可以改的地方。";
}

/**
 * Why a generation failed, in words anyone understands — the services' own
 * messages name keys, status codes and protocols. `cloud`: an AI service
 * was asked.
 */
export function plainFailure(message: string | null, cloud: boolean): string {
  const text = message ?? "";
  if (
    cloud &&
    /密钥|API\s*Key|AK\/SK|凭据|鉴权|认证|授权|签名|\b40[13]\b|unauthori[sz]ed|forbidden|invalid.*key/i.test(
      text,
    )
  )
    return "AI 服务没有接受这次请求，可能是密钥不对或已经过期。请到「设置」里检查一下。";
  if (
    cloud &&
    /余额|欠费|额度|配额|充值|频繁|限流|\b402\b|\b429\b|quota|rate.?limit|insufficient/i.test(
      text,
    )
  )
    return "AI 服务暂时不接受新的请求，可能是余额不足或请求太频繁。请稍后再试。";
  if (
    /网络|连接|超时|代理|offline|timed? ?out|ENOTFOUND|ECONN|EAI_AGAIN|network/i.test(
      text,
    )
  )
    return "网络好像不通，请检查网络后再试一次。";
  return cloud
    ? "AI 服务这次没有做成，请稍后再试一次。"
    : "这次没做成，可能是临时出了点问题，再试一次就好。";
}

/**
 * The app's own messages, as 简单模式 names things: the library is
 * 「我的音乐」, saving a file is 下载, the cloud is the AI service, the
 * offline rules are the built-in way. Applied to every toast and question
 * shown in 简单模式 (Kernel.toast / Kernel.ask); the sentences that need
 * more than a word swapped are written for 简单模式 where they are made.
 * Brand names ("火山引擎") are never touched.
 */
const PLAIN_WORDS: readonly [RegExp, string][] = [
  [/^创作完成，/, "做好了，"],
  [/^已导出到选定位置$/, "已保存"],
  [/^已取消本地生成$/, "已取消"],
  [/^已取消本次编排$/, "已取消"],
  [/，制作人已切换为大模型。$/, "，之后你写的话会交给它来理解。"],
  [/，制作人改用离线规则。$/, "，之后用内置的方式理解你写的话。"],
  [/先告诉制作人想怎么改/g, "先写下想怎么改"],
  // a record that cannot be read (我的音乐's 打不开的音乐): its two buttons
  [/已导出这条记录的原始数据/g, "已保存这条记录"],
  [/请再导出原始音频/g, "请再点「下载声音」"],
  [/已导出这条记录的原始音频/g, "已下载这条记录里的声音"],
  [
    /格式无法识别，暂按 MP3 命名，/g,
    "认不出是什么格式，先按常见的格式命名了，",
  ],
  [/「我的作品」/g, "「我的音乐」"],
  [/「导出」/g, "「下载音乐」"],
  [/「新建创作」/g, "「重新挑」"],
  [/导出原始音频/g, "下载音乐"],
  [/无法解码试听/g, "没法在这里播放"],
  [/导出/g, "下载"],
  [/云端结果/g, "AI 服务的结果"],
  [/云端生成/g, "AI 服务生成"],
  [/云端音乐/g, "AI 服务做的音乐"],
  [/云端/g, "AI 服务"],
  [/制作人大模型/g, "大模型"],
  [/离线规则/g, "内置的方式"],
  [/本地作曲引擎/g, "本机作曲"],
  [/生成引擎/g, "做音乐的方式"],
  [/作品/g, "音乐"],
];

export function plainWords(text: string): string {
  let out = text;
  for (const [pattern, words] of PLAIN_WORDS) out = out.replace(pattern, words);
  return out;
}
