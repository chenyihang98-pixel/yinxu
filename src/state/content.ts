/**
 * Ready-made starting points: scenario prompts for the 灵感 page, the quick
 * prompts under the composer and the composer's placeholder. Every prompt is
 * checked in tests/app-logic.test.ts: the offline brain must recognise a
 * style in it.
 */
import { STYLES } from "../music/catalog";
import type { StyleId, StyleInfo } from "../music/catalog";
import type { InspirationChoice } from "./types";

export interface ScenarioPrompt {
  id: string;
  title: string;
  prompt: string;
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
      },
      {
        id: "vlog-travel",
        title: "旅行记录",
        prompt: "海边公路旅行，温暖的木吉他，轻松治愈，有一点向前走的感觉",
      },
      {
        id: "vlog-food",
        title: "美食与探店",
        prompt: "周末探店的美食视频，可爱俏皮，马林巴跳音，轻快一点",
      },
      {
        id: "vlog-product",
        title: "产品介绍",
        prompt: "科技产品发布视频，干净现代，积极有前进感，60 秒，完整结尾",
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
      },
      {
        id: "game-battle",
        title: "Boss 战",
        prompt: "热血的 Boss 战斗音乐，高速合成器，鼓点密集，紧张刺激",
      },
      {
        id: "game-explore",
        title: "探索与解谜",
        prompt: "悬疑解谜关卡的背景音乐，低沉紧张，稀疏的打击乐，循环播放",
      },
      {
        id: "game-village",
        title: "古风村落",
        prompt: "国风游戏里的江南小镇，古筝和竹笛，悠闲，适合循环",
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
        prompt: "安静专注的极简背景音乐，柔和钢琴，不要鼓，适合阅读和写作，120 秒",
      },
      {
        id: "work-lofi",
        title: "Lo-fi 自习",
        prompt: "慵懒的 Lo-fi，温暖的电钢琴和轻轻的鼓点，适合深夜学习，循环",
      },
      {
        id: "work-cafe",
        title: "咖啡馆爵士",
        prompt: "雨天咖啡馆里的爵士小曲，行走贝斯和刷子鼓，松弛一点",
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
      },
      {
        id: "event-festival",
        title: "新年与节日",
        prompt: "新年喜庆的节日音乐，清脆的铃声，热闹欢快",
      },
      {
        id: "event-sport",
        title: "运动与快剪",
        prompt: "健身运动快剪视频，动感电音，四拍底鼓，充满能量",
      },
      {
        id: "event-trailer",
        title: "开场与预告",
        prompt: "史诗感的预告片开场，厚重弦乐和大鼓，逐渐推向高潮，45 秒",
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
        prompt: "睡前冥想的氛围音乐，缓慢的长音，几乎没有节拍，混响大一点",
      },
      {
        id: "mood-sad",
        title: "安静的难过",
        prompt: "离别时伤感抒情的钢琴独白，很慢，克制，带一点弦乐",
      },
      {
        id: "mood-dream",
        title: "做一场梦",
        prompt: "梦幻空灵的钟琴和流动的琶音，像漂浮在星空里",
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

export const COMPOSER_PLACEHOLDER =
  "例如：\n雨夜咖啡馆，慵懒的钢琴和轻轻的鼓点\n国风游戏里的江南小镇，古筝和竹笛，可以循环\n60 秒的科技产品发布视频，干净、有前进感";

/** For narrow composers, where three example lines would not fit. */
export const COMPOSER_PLACEHOLDER_SHORT =
  "例如：雨夜咖啡馆，慵懒的钢琴和轻轻的鼓点";

export const REFINE_PLACEHOLDER = "告诉制作人怎么改…";

/** What a style card puts into the composer; the style itself gets pinned. */
export function styleInspiration(style: StyleInfo): InspirationChoice {
  return {
    text: `${style.label}：${style.description.replace(/[。.]$/, "")}`,
    mood: style.id,
  };
}

export function scenarioInspiration(scenario: ScenarioPrompt): InspirationChoice {
  return { text: scenario.prompt };
}

export const STYLE_CARDS: readonly { style: StyleInfo; id: StyleId }[] =
  STYLES.map((style) => ({ style, id: style.id }));
