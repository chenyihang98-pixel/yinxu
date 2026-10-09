/**
 * The words the app itself puts in front of the user: parameter names,
 * ready-made starting points (scenario prompts for the 灵感 page, the quick
 * prompts under the composer, the composer's placeholder) and the examples
 * in the user guide.
 *
 * Every prompt and example here promises something — a style, an instrument,
 * a length. tests/ui-logic.test.ts sends each one through the offline
 * producer and holds the result against that promise, so a card can never
 * say "爵士" and come out as something else.
 */
import { STYLES } from "../music/catalog";
import type { StyleId, StyleInfo } from "../music/catalog";
import type { DraftField, InspirationChoice } from "./types";

/**
 * The one name of each parameter, wherever the interface mentions it: the
 * inspector's labels, the list of pending edits, the user guide.
 */
export const FIELD_LABELS: Record<DraftField, string> = {
  mood: "风格",
  bpm: "速度",
  instrument: "主奏乐器",
  key: "调性",
  energy: "情绪能量",
  complexity: "旋律丰富度",
  reverb: "空间混响",
  duration: "时长",
  loop: "结构",
};

/**
 * What a model name LOOKS like at each vendor, for the 制作人大模型 form: a
 * hint about the format, shown as "形如 …" next to "copy it from the
 * console". Vendors rename and retire models all the time, so these are
 * never offered as values, never pre-filled and never sent anywhere — the
 * name that counts is the one in the vendor's own model list.
 */
export const MODEL_NAME_SHAPES: Readonly<Record<string, string>> = {
  deepseek: "deepseek-chat",
  qwen: "qwen-plus",
  doubao: "ep-20250101000000-abcde",
  zhipu: "glm-4-flash",
  moonshot: "moonshot-v1-8k",
  hunyuan: "hunyuan-lite",
  openai: "gpt-4o-mini",
  ollama: "qwen2.5:7b",
};

/** Where the model name comes from, per kind of service. */
export function modelNameHint(preset: { id: string; kind: string }): string {
  if (preset.id === "doubao")
    return "填写火山方舟控制台里的推理接入点 ID，或模型 ID。";
  if (preset.kind === "ollama")
    return "填写这台电脑上已下载的模型名称（在终端运行 ollama list 可以看到）。";
  if (preset.id === "custom") return "填写该服务文档里给出的模型名称。";
  return "在服务商控制台的模型列表里复制模型名称，名称以控制台为准。";
}

export interface ScenarioPrompt {
  id: string;
  title: string;
  /** a complete description of a NEW piece: no "…一点" that needs something to compare with */
  prompt: string;
  /** the style the offline producer makes of it; also the card's colours */
  style: StyleId;
}

export interface ScenarioGroup {
  id: string;
  label: string;
  prompts: ScenarioPrompt[];
}

export const SCENARIO_GROUPS: readonly ScenarioGroup[] = [
  {
    id: "video",
    label: "视频 Vlog",
    prompts: [
      {
        id: "vlog-daily",
        title: "日常 Vlog",
        prompt: "阳光下的校园午后，青春欢快，轻盈的钢琴，适合日常 Vlog",
        style: "bright",
      },
      {
        id: "vlog-travel",
        title: "旅行记录",
        prompt: "海边公路旅行，温暖的木吉他，轻松治愈，带着向前走的感觉",
        style: "acoustic",
      },
      {
        id: "vlog-food",
        title: "美食与探店",
        prompt: "周末探店的美食视频，可爱俏皮，马林巴跳音，轻快跳跃",
        style: "cute",
      },
      {
        id: "vlog-product",
        title: "产品介绍",
        prompt: "科技产品发布视频，干净现代，积极有前进感，60 秒，完整结尾",
        style: "corporate",
      },
    ],
  },
  {
    id: "game",
    label: "游戏",
    prompts: [
      {
        id: "game-pixel",
        title: "像素冒险",
        prompt: "8-bit 像素风的冒险游戏主题曲，活泼的方波旋律，可以循环",
        style: "chiptune",
      },
      {
        id: "game-battle",
        title: "Boss 战",
        prompt: "热血的 Boss 战斗音乐，高速合成器，鼓点密集，紧张刺激",
        style: "battle",
      },
      {
        id: "game-explore",
        title: "探索与解谜",
        prompt: "悬疑解谜关卡的背景音乐，低沉紧张，稀疏的打击乐，循环播放",
        style: "tension",
      },
      {
        id: "game-village",
        title: "古风村落",
        prompt: "国风游戏里的江南小镇，古筝和竹笛，悠闲，适合循环",
        style: "guofeng",
      },
    ],
  },
  {
    id: "work",
    label: "工作学习",
    prompts: [
      {
        id: "work-focus",
        title: "专注写作",
        prompt:
          "安静专注的极简背景音乐，柔和钢琴，不要鼓，适合阅读和写作，120 秒",
        style: "focus",
      },
      {
        id: "work-lofi",
        title: "Lo-fi 自习",
        prompt: "慵懒的 Lo-fi，温暖的电钢琴和轻轻的鼓点，适合深夜学习，循环",
        style: "chill",
      },
      {
        id: "work-cafe",
        title: "咖啡馆爵士",
        prompt: "雨天咖啡馆里的爵士小曲，行走贝斯和刷子鼓，松弛的摇摆感",
        style: "jazz",
      },
    ],
  },
  {
    id: "event",
    label: "活动庆典",
    prompts: [
      {
        id: "event-wedding",
        title: "婚礼与纪念日",
        prompt: "婚礼入场的浪漫钢琴曲，温柔的弦乐铺底，90 秒，完整结尾",
        style: "romantic",
      },
      {
        id: "event-festival",
        title: "新年与节日",
        prompt: "新年喜庆的节日音乐，清脆的铃声，热闹欢快",
        style: "festive",
      },
      {
        id: "event-sport",
        title: "运动与快剪",
        prompt: "健身运动快剪视频，动感电音，四拍底鼓，充满能量",
        style: "dance",
      },
      {
        id: "event-trailer",
        title: "开场与预告",
        prompt:
          "史诗感的预告片开场，厚重弦乐和大鼓，一路推向高潮，45 秒，完整结尾",
        style: "epic",
      },
    ],
  },
  {
    id: "mood",
    label: "情绪",
    prompts: [
      {
        id: "mood-sleep",
        title: "睡前放松",
        prompt: "睡前冥想的氛围音乐，缓慢的长音，没有鼓，空旷的大混响",
        style: "ambient",
      },
      {
        id: "mood-sad",
        title: "安静的难过",
        prompt: "离别时伤感抒情的钢琴独白，很慢，克制，弦乐轻轻铺底",
        style: "sad",
      },
      {
        id: "mood-dream",
        title: "做一场梦",
        prompt: "梦幻空灵的钟琴和流动的琶音，像漂浮在星空里",
        style: "dreamy",
      },
    ],
  },
];

/** The six cards under the new-piece composer. */
export const QUICK_PROMPTS: readonly ScenarioPrompt[] = [
  "vlog-daily",
  "work-lofi",
  "game-pixel",
  "game-village",
  "event-trailer",
  "mood-sleep",
].flatMap((id) =>
  SCENARIO_GROUPS.flatMap((group) =>
    group.prompts.filter((prompt) => prompt.id === id),
  ),
);

/** A description the app shows as an example, with the style it leads to. */
export interface DescriptionExample {
  text: string;
  style: StyleId;
}

/** "Describe the scene" — the composer's placeholder and the user guide. */
export const DESCRIPTION_EXAMPLES: readonly DescriptionExample[] = [
  { text: "雨夜咖啡馆，慵懒的钢琴和轻轻的鼓点", style: "chill" },
  { text: "国风游戏里的江南小镇，古筝和竹笛，可以循环", style: "guofeng" },
  { text: "60 秒的科技产品发布视频，干净、有前进感", style: "corporate" },
];

/** "…or say the parameters outright" — the user guide. */
export const PARAMETER_EXAMPLE: DescriptionExample = {
  text: "爵士风格，90 BPM，D 小调，一分钟，完整结尾",
  style: "jazz",
};

export const COMPOSER_PLACEHOLDER = `例如：\n${DESCRIPTION_EXAMPLES.map((example) => example.text).join("\n")}`;

/** For narrow composers, where three example lines would not fit. */
export const COMPOSER_PLACEHOLDER_SHORT = `例如：${DESCRIPTION_EXAMPLES[0].text}`;

export const REFINE_PLACEHOLDER = "告诉制作人怎么改…";

/**
 * "制作人听得懂什么" in the user guide: things to say about a piece that
 * exists. Each phrase changes a typical work (checked in tests).
 */
export const REFINE_EXAMPLES: readonly { topic: string; phrases: string[] }[] =
  [
    {
      topic: "速度与情绪",
      phrases: ["慢一点", "更有活力", "安静一点", "更紧张一些"],
    },
    {
      topic: "乐器与分轨",
      phrases: ["换成古筝", "不要鼓", "贝斯轻一点", "加点弦乐铺底"],
    },
    {
      topic: "风格与结构",
      phrases: ["改成爵士风格", "改成完整结尾", "时长改成 60 秒"],
    },
    { topic: "旋律", phrases: ["换一版旋律"] },
  ];

/** The two phrases the empty thread suggests. */
export const THREAD_EXAMPLES: readonly string[] = ["慢一点", "换成古筝"];

/**
 * A style card pins its style and writes nothing: the description stays the
 * user's to fill in (or to leave empty — the pinned style alone can be sent).
 * The style's own blurb is for reading; it is never fed to the producer as
 * if the user had typed it.
 */
export function styleInspiration(style: StyleInfo): InspirationChoice {
  return { text: "", mood: style.id };
}

export function scenarioInspiration(
  scenario: ScenarioPrompt,
): InspirationChoice {
  return { text: scenario.prompt };
}

export const STYLE_CARDS: readonly { style: StyleInfo; id: StyleId }[] =
  STYLES.map((style) => ({ style, id: style.id }));
