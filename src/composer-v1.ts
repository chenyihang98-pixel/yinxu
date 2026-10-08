import type { CompositionPlan, Instrument, Mood, MusicConfig } from "./types";

export const MOODS: {
  id: Mood;
  label: string;
  english: string;
  description: string;
  bpm: number;
  tags: string[];
}[] = [
  {
    id: "bright",
    label: "青春欢快",
    english: "Sunny days",
    description: "轻盈的旋律与跳动的节奏，给日常多一点阳光。",
    bpm: 112,
    tags: ["青春", "欢快", "日常"],
  },
  {
    id: "chill",
    label: "慵懒松弛",
    english: "Slow afternoon",
    description: "温暖的和弦、轻轻摇摆的鼓点，适合慢一点的时光。",
    bpm: 82,
    tags: ["松弛", "咖啡", "Lo-fi"],
  },
  {
    id: "cinematic",
    label: "电影叙事",
    english: "A little story",
    description: "低音铺陈与渐进的和声，营造有故事感的氛围。",
    bpm: 88,
    tags: ["电影", "叙事", "氛围"],
  },
  {
    id: "dreamy",
    label: "梦幻空灵",
    english: "Into a dream",
    description: "清澈的音色和流动的琶音，像缓缓展开的一场梦。",
    bpm: 76,
    tags: ["梦幻", "空灵", "治愈"],
  },
  {
    id: "focus",
    label: "安静专注",
    english: "In the flow",
    description: "克制的旋律与稳定的律动，让思绪自然流动。",
    bpm: 92,
    tags: ["专注", "学习", "极简"],
  },
  {
    id: "retro",
    label: "复古电子",
    english: "Neon memories",
    description: "温暖的合成器、循环琶音与电子节奏。",
    bpm: 120,
    tags: ["复古", "电子", "律动"],
  },
];

export const INSTRUMENTS: { id: Instrument; label: string }[] = [
  { id: "piano", label: "柔和钢琴" },
  { id: "guitar", label: "清新吉他" },
  { id: "synth", label: "温暖合成器" },
  { id: "bell", label: "空灵钟琴" },
];

export const DEFAULT_CONFIG: MusicConfig = {
  prompt: "青春欢快，像晴天散步一样轻松，适合日常 Vlog",
  mood: "bright",
  bpm: 112,
  duration: 30,
  key: "C major",
  instrument: "piano",
  energy: 0.62,
  complexity: 0.5,
  reverb: 0.25,
  seed: 42017,
  loop: true,
  volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 },
};

const presets: Record<Mood, Partial<MusicConfig>> = {
  bright: {
    bpm: 112,
    key: "C major",
    instrument: "piano",
    energy: 0.62,
    complexity: 0.5,
    reverb: 0.25,
  },
  chill: {
    bpm: 82,
    key: "G major",
    instrument: "guitar",
    energy: 0.3,
    complexity: 0.42,
    reverb: 0.2,
  },
  cinematic: {
    bpm: 88,
    key: "A minor",
    instrument: "piano",
    energy: 0.55,
    complexity: 0.42,
    reverb: 0.55,
  },
  dreamy: {
    bpm: 76,
    key: "D major",
    instrument: "bell",
    energy: 0.28,
    complexity: 0.42,
    reverb: 0.65,
  },
  focus: {
    bpm: 92,
    key: "C major",
    instrument: "piano",
    energy: 0.24,
    complexity: 0.22,
    reverb: 0.25,
  },
  retro: {
    bpm: 120,
    key: "A minor",
    instrument: "synth",
    energy: 0.72,
    complexity: 0.62,
    reverb: 0.32,
  },
};
const moodPatterns: [Mood, RegExp][] = [
  ["chill", /慵懒|松弛|咖啡|放松|爵士|chill|lo[ -]?fi|relax|jazzy/i],
  [
    "cinematic",
    /电影|叙事|史诗|悲伤|伤感|忧郁|悬疑|cinematic|epic|dramatic|sad/i,
  ],
  ["dreamy", /梦幻|空灵|治愈|星空|梦境|dream|ambient|ethereal|healing/i],
  ["focus", /专注|学习|工作|极简|冥想|focus|study|minimal|meditat/i],
  [
    "retro",
    /复古|电子|霓虹|赛博|游戏|retro|synthwave|8.?bit|cyber|electronic/i,
  ],
  [
    "bright",
    /青春|欢快|活泼|快乐|阳光|清新|开心|bright|happy|upbeat|cheerful|sunny/i,
  ],
];
const instrumentPatterns: [Instrument, RegExp][] = [
  ["piano", /钢琴|piano/i],
  ["guitar", /吉他|guitar|ukulele|尤克里里/i],
  ["synth", /合成器|synth(?!wave)/i],
  ["bell", /钟琴|铃铛|风铃|bell|celesta|music box|八音盒/i],
];
const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));

/** Stable text seed: a prompt always starts from the same musical material. */
export function promptSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}

function applyInstructions(
  config: MusicConfig,
  text: string,
  isRefinement: boolean,
): string[] {
  const reasons: string[] = [];
  const bpm =
    text.match(/(?:bpm|速度|节拍)\s*[:：=]?\s*(\d{2,3})\b/i) ??
    text.match(/\b(\d{2,3})\s*bpm\b/i);
  if (bpm) {
    config.bpm = clamp(Number(bpm[1]), 60, 160);
    reasons.push(`速度设为 ${config.bpm} BPM`);
  } else if (/更慢|慢一点|放慢|慢一些|slower|slow down/i.test(text)) {
    config.bpm = clamp(config.bpm - 12, 60, 160);
    reasons.push("放慢速度，留出更多呼吸感");
  } else if (/更快|快一点|加快|快一些|faster|speed up/i.test(text)) {
    config.bpm = clamp(config.bpm + 12, 60, 160);
    reasons.push("加快节奏，让律动更轻快");
  }
  const duration = text.match(
    /(\d+(?:\.\d+)?)\s*(?:秒|seconds?\b|secs?\b|s\b)/i,
  );
  const minutes = text.match(/(\d+(?:\.\d+)?)\s*(?:分钟|minutes?\b|mins?\b)/i);
  if (duration || minutes) {
    config.duration = clamp(
      Math.round(duration ? Number(duration[1]) : Number(minutes![1]) * 60),
      15,
      120,
    );
    reasons.push(`片段长度 ${config.duration} 秒`);
  }
  for (const [instrument, pattern] of instrumentPatterns) {
    if (pattern.test(text)) {
      config.instrument = instrument;
      reasons.push(
        `主旋律使用${INSTRUMENTS.find((x) => x.id === instrument)!.label}`,
      );
      break;
    }
  }
  const keyMatch =
    text.match(/\b([CDGA])\s*(major|minor)\b/i) ??
    text.match(/([CDGA])\s*(大调|小调)/i);
  if (keyMatch) {
    const key = `${keyMatch[1].toUpperCase()} ${/minor|小调/i.test(keyMatch[2]) ? "minor" : "major"}`;
    if (["C major", "D major", "G major", "A minor", "D minor"].includes(key)) {
      config.key = key;
      reasons.push(`调性采用 ${key}`);
    }
  }
  if (
    /更安静|轻柔|柔和|温柔|不要太吵|平静|soft|gentle|quieter|calm/i.test(text)
  ) {
    config.energy = clamp(config.energy - 0.2, 0, 1);
    reasons.push("降低力度，使用更轻柔的演奏");
  }
  if (
    /更有活力|更强|更燃|激昂|强烈|energetic|powerful|intense|more energy/i.test(
      text,
    )
  ) {
    config.energy = clamp(config.energy + 0.22, 0, 1);
    reasons.push("提高力度与节奏密度");
  }
  if (/简单|简洁|少一点音符|更稀疏|simpler|sparse|less complex/i.test(text)) {
    config.complexity = clamp(config.complexity - 0.25, 0, 1);
    reasons.push("减少音符，让编曲更简洁");
  }
  if (
    /丰富|复杂|更多音符|更密集|richer|complex|more notes/i.test(text) &&
    !/less complex/i.test(text)
  ) {
    config.complexity = clamp(config.complexity + 0.25, 0, 1);
    reasons.push("增加装饰音与和声层次");
  }
  if (/减少混响|混响少|更干|干一点|less reverb|dry/i.test(text)) {
    config.reverb = clamp(config.reverb - 0.25, 0, 1);
    reasons.push("收短空间混响");
  } else if (
    /更多混响|增加混响|更空灵|空间感|more reverb|spacious/i.test(text)
  ) {
    config.reverb = clamp(config.reverb + 0.25, 0, 1);
    reasons.push("增加空间混响");
  }
  if (/不要循环|关闭循环|不循环|no loop|disable loop/i.test(text)) {
    config.loop = false;
    reasons.push("以自然淡出结束");
  } else if (/循环|loop/i.test(text)) {
    config.loop = true;
    reasons.push("保留循环衔接");
  }
  const trackPatterns = {
    drums: "鼓点?|打击乐|drums?|percussion",
    bass: "低音|贝斯|bass",
    melody: "主旋律|旋律|melody",
    chords: "和弦|和声|chords?|harmony",
  } as const;
  for (const [track, terms] of Object.entries(trackPatterns) as [
    keyof MusicConfig["volumes"],
    string,
  ][]) {
    if (
      new RegExp(
        `(?:不要|去掉|移除|关闭|静音|\\b(?:no|without|remove|mute))\\s*(?:${terms})|(?:${terms})\\s*(?:静音|关掉|off)`,
        "i",
      ).test(text)
    ) {
      config.volumes[track] = 0;
      reasons.push(
        `关闭${{ drums: "鼓组", bass: "低音", melody: "旋律", chords: "和声" }[track]}`,
      );
    } else if (
      new RegExp(
        `(?:恢复|打开|开启|加回|unmute|enable|add)\\s*(?:${terms})|(?:${terms})\\s*(?:打开|on)`,
        "i",
      ).test(text)
    ) {
      config.volumes[track] = DEFAULT_CONFIG.volumes[track];
      reasons.push(
        `恢复${{ drums: "鼓组", bass: "低音", melody: "旋律", chords: "和声" }[track]}`,
      );
    } else if (
      new RegExp(
        `(?:${terms}).{0,4}(?:小一点|轻一点|轻一些|弱一些|降低|quieter|softer)|(?:降低|减少|less)\\s*(?:${terms})`,
        "i",
      ).test(text)
    ) {
      config.volumes[track] = clamp(config.volumes[track] - 0.2, 0, 1);
      reasons.push("降低对应声部的音量");
    } else if (
      new RegExp(
        `(?:${terms}).{0,4}(?:大一点|强一点|强一些|突出|louder)|(?:提高|增加|more)\\s*(?:${terms})`,
        "i",
      ).test(text)
    ) {
      config.volumes[track] = clamp(config.volumes[track] + 0.2, 0, 1);
      reasons.push("提高对应声部的音量");
    }
  }
  if (
    isRefinement &&
    /换一版|重新编曲|新旋律|variation|new melody|another version/i.test(text)
  ) {
    config.seed = (config.seed + 7919) >>> 0;
    reasons.push("保留当前设置，生成一组新旋律");
  }
  return reasons;
}

function describe(config: MusicConfig, reasoning: string[]): CompositionPlan {
  const mood = MOODS.find((x) => x.id === config.mood)!;
  const titles: Record<Mood, string[]> = {
    bright: ["晴天漫游", "夏日小事", "今天有好心情"],
    chill: ["午后留白", "街角咖啡", "慢一点也很好"],
    cinematic: ["故事的序章", "远方来信", "光影之间"],
    dreamy: ["星河入梦", "漂浮的云", "月光收藏家"],
    focus: ["安静的片刻", "思绪缓缓流动", "留一束光"],
    retro: ["霓虹回声", "午夜磁带", "昨日未来"],
  };
  return {
    title: titles[config.mood][config.seed % 3],
    description: mood.description,
    config,
    tags: [
      mood.label,
      `${config.bpm} BPM`,
      INSTRUMENTS.find((x) => x.id === config.instrument)!.label,
    ],
    reasoning: reasoning.length
      ? reasoning
      : ["保留当前音乐设置；可用速度、音色、混响或声部指令进一步调整"],
  };
}

export function planFromPrompt(
  prompt: string,
  base: Partial<MusicConfig> = {},
): CompositionPlan {
  const text = prompt.trim() || DEFAULT_CONFIG.prompt;
  const mood =
    moodPatterns.find(([, re]) => re.test(text))?.[0] ??
    base.mood ??
    DEFAULT_CONFIG.mood;
  const config: MusicConfig = {
    ...DEFAULT_CONFIG,
    ...base,
    ...presets[mood],
    prompt: text,
    mood,
    duration: base.duration ?? DEFAULT_CONFIG.duration,
    loop: base.loop ?? DEFAULT_CONFIG.loop,
    seed: promptSeed(text),
    volumes: { ...DEFAULT_CONFIG.volumes, ...base.volumes },
  };
  const reasoning = [
    `根据描述匹配「${MOODS.find((x) => x.id === mood)!.label}」编曲模板`,
    ...applyInstructions(config, text, false),
  ];
  return describe(config, reasoning);
}

export function refineFromPrompt(
  current: MusicConfig,
  instruction: string,
): CompositionPlan {
  const config = { ...current, volumes: { ...current.volumes } };
  const reasoning: string[] = [];
  const mood = moodPatterns.find(([, re]) => re.test(instruction))?.[0];
  if (mood && mood !== config.mood) {
    config.mood = mood;
    reasoning.push(
      `编曲风格改为「${MOODS.find((x) => x.id === mood)!.label}」`,
    );
  }
  reasoning.push(...applyInstructions(config, instruction, true));
  return describe(config, reasoning);
}
