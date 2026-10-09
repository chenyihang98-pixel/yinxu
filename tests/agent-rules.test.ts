import assert from "node:assert/strict";
import test from "node:test";
import { describeChanges } from "../src/agent/cloudPrompt";
import { planWithRules, readMentions } from "../src/agent/rules";
import {
  analyse,
  normalizeText,
  parseChineseNumber,
} from "../src/agent/lexicon";
import type { AgentPlan, AgentRequest } from "../src/agent/types";
import {
  STYLES,
  STYLE_IDS,
  isInstrumentId,
  isKey,
  isStyleId,
  parseKey,
  styleInfo,
  type InstrumentId,
  type StyleId,
} from "../src/music/catalog";
import {
  DEFAULT_CONFIG,
  DEFAULT_VOLUMES,
  clampConfig,
  stylePreset,
} from "../src/music/defaults";
import { melodyContinuity } from "../src/music/compose";
import { SCENARIO_GROUPS } from "../src/state/content";
import type { MusicConfig, TrackName } from "../src/types";

const NEXT_SEED = 987654321;
const draft = (): MusicConfig => structuredClone(DEFAULT_CONFIG);
const dreamy = (): MusicConfig => ({
  ...draft(),
  ...stylePreset("dreamy"),
  prompt: "梦幻空灵",
  seed: 1234,
});

function plan(
  text: string,
  mode: "new" | "refine" = "new",
  current: MusicConfig = mode === "new" ? draft() : dreamy(),
  extra: Partial<AgentRequest> = {},
): AgentPlan {
  return planWithRules({
    text,
    mode,
    current,
    provider: "local",
    history: [],
    nextSeed: NEXT_SEED,
    ...extra,
  });
}

interface Expect {
  style?: StyleId | StyleId[];
  notStyle?: StyleId[];
  instrument?: InstrumentId;
  notInstrument?: InstrumentId;
  /** exact value or inclusive [min, max] */
  bpm?: number | [number, number];
  duration?: number | [number, number];
  energy?: [number, number];
  loop?: boolean;
  key?: string;
  notKey?: string;
  minor?: boolean;
  /** "off" = muted, "low" = at most 0.2, "on" = audible */
  drums?: "off" | "low" | "on";
  bass?: "off" | "on";
  says?: RegExp;
  check?: (config: MusicConfig, plan: AgentPlan) => void;
}

const inRange = (value: number, range: number | [number, number]) =>
  typeof range === "number"
    ? value === range
    : value >= range[0] && value <= range[1];

/** Returns the list of unmet expectations (empty = pass). */
function unmet(result: AgentPlan, expect: Expect): string[] {
  const c = result.config;
  const out: string[] = [];
  const styles = expect.style === undefined ? undefined : [expect.style].flat();
  if (styles && !styles.includes(c.mood))
    out.push(`style ${c.mood}, wanted ${styles.join("/")}`);
  if (expect.notStyle?.includes(c.mood))
    out.push(`style must not be ${c.mood}`);
  if (expect.instrument && c.instrument !== expect.instrument)
    out.push(`instrument ${c.instrument}, wanted ${expect.instrument}`);
  if (expect.notInstrument && c.instrument === expect.notInstrument)
    out.push(`instrument must not be ${c.instrument}`);
  if (expect.bpm !== undefined && !inRange(c.bpm, expect.bpm))
    out.push(`bpm ${c.bpm}, wanted ${expect.bpm}`);
  if (expect.duration !== undefined && !inRange(c.duration, expect.duration))
    out.push(`duration ${c.duration}, wanted ${expect.duration}`);
  if (expect.energy && !inRange(c.energy, expect.energy))
    out.push(`energy ${c.energy}, wanted ${expect.energy}`);
  if (expect.loop !== undefined && c.loop !== expect.loop)
    out.push(`loop ${c.loop}`);
  if (expect.key && c.key !== expect.key)
    out.push(`key ${c.key}, wanted ${expect.key}`);
  if (expect.notKey && c.key === expect.notKey)
    out.push(`key must not be ${c.key}`);
  if (expect.minor !== undefined && parseKey(c.key).minor !== expect.minor)
    out.push(`key ${c.key}, wanted ${expect.minor ? "minor" : "major"}`);
  if (expect.drums === "off" && c.volumes.drums !== 0)
    out.push("drums not muted");
  if (expect.drums === "low" && c.volumes.drums > 0.2)
    out.push("drums too loud");
  if (expect.drums === "on" && c.volumes.drums <= 0) out.push("drums muted");
  if (expect.bass === "off" && c.volumes.bass !== 0) out.push("bass not muted");
  if (expect.bass === "on" && c.volumes.bass <= 0) out.push("bass muted");
  if (
    expect.says &&
    !expect.says.test([result.reply, ...result.reasoning].join("\n"))
  )
    out.push(`nothing says ${expect.says}`);
  if (expect.check)
    try {
      expect.check(c, result);
    } catch (error) {
      out.push(error instanceof Error ? error.message : String(error));
    }
  return out;
}

/* 71 prompts from the audit of v0.2 — 48 of them fell back to "happy piano" there. */
// prettier-ignore
const AUDIT_CASES: [string, Expect][] = [
  ["雨天咖啡馆", { style: "chill", bpm: [66, 92] }],
  ["国风古风，古筝和笛子", { style: "guofeng", instrument: "guzheng" }],
  ["游戏战斗BOSS", { style: "battle", bpm: [136, 188], energy: [0.75, 1] }],
  ["8-bit 像素风小游戏", { style: "chiptune", instrument: "chip" }],
  ["婚礼", { style: "romantic", minor: false }],
  ["科技产品发布会", { style: "corporate" }],
  ["恐怖悬疑", { style: "tension", minor: true }],
  ["恐怖", { style: "tension", minor: true }],
  ["可爱", { style: "cute", minor: false }],
  ["爵士", { style: "jazz" }],
  ["史诗", { style: "epic", energy: [0.7, 1] }],
  ["新闻片头", { style: ["corporate", "epic"], duration: [15, 20], loop: false }],
  ["冥想", { style: "ambient", drums: "low", bpm: [50, 76] }],
  ["运动健身", { style: ["dance", "rock"], bpm: [116, 168], energy: [0.75, 1] }],
  ["旅行vlog", { style: ["bright", "acoustic"] }],
  ["赛博朋克", { style: "retro", instrument: "synth" }],
  ["圣诞", { style: "festive" }],
  ["睡前助眠", { style: "ambient", drums: "low", energy: [0, 0.3] }],
  ["紧张刺激的追逐", { style: ["battle", "tension"], bpm: [118, 200] }],
  ["浪漫约会", { style: "romantic" }],
  ["孤独的夜晚", { style: "sad", minor: true, energy: [0, 0.4] }],
  ["热血燃向", { style: "epic", energy: [0.8, 1] }],
  ["摇滚", { style: "rock" }],
  ["嘻哈 trap beat", { style: "hiphop" }],
  ["古典管弦乐", { style: ["cinematic", "epic"], instrument: "strings" }],
  ["民谣", { style: "acoustic", instrument: "guitar" }],
  ["EDM 电音舞曲", { style: "dance", bpm: [116, 140] }],
  ["lofi hip hop study beats", { style: "chill" }],
  ["epic orchestral trailer", { style: "epic" }],
  ["sad piano", { style: "sad", instrument: "piano", minor: true }],
  ["happy ukulele", { style: ["bright", "acoustic"], instrument: "guitar", minor: false }],
  ["corporate upbeat", { style: "corporate" }],
  ["horror ambient drone", { style: ["tension", "ambient"], minor: true }],
  ["funk groove", { style: ["jazz", "hiphop", "dance"] }],
  ["bossa nova", { style: "jazz" }],
  ["企业宣传片", { style: "corporate" }],
  ["美食探店", { style: ["bright", "jazz", "acoustic"] }],
  ["儿童动画", { style: "cute" }],
  ["太空科幻", { style: ["dreamy", "ambient", "retro"] }],
  ["搞笑鬼畜", { style: ["cute", "chiptune"] }],
  ["80s synthwave", { style: "retro", duration: 30 }],
  ["90年代复古", { style: "retro", duration: 30 }],
  ["1分30秒的轻音乐", { duration: 90, style: ["acoustic", "romantic", "dreamy", "chill"] }],
  ["两分钟的钢琴曲", { duration: 120, instrument: "piano" }],
  ["一分钟", { duration: 60, style: "bright", says: /没有.*听出风格/ }],
  ["不要钢琴，用吉他", { instrument: "guitar" }],
  ["不要太欢快，安静一点", { notStyle: ["bright", "festive", "cute"], energy: [0, 0.3] }],
  ["不要电子味", { notStyle: ["retro", "dance", "chiptune"], notInstrument: "synth" }],
  ["F大调 温暖", { key: "F major" }],
  ["E minor 忧伤", { key: "E minor", style: "sad" }],
  ["a minor detail of my day", { key: "C major", says: /没有.*听出风格/ }],
  ["3/4 拍华尔兹", { style: "romantic", says: /三拍子/ }],
  ["140bpm 鼓和贝斯", { bpm: 140, drums: "on", bass: "on" }],
  ["没有鼓的纯钢琴", { instrument: "piano", drums: "off" }],
  ["无鼓", { drums: "off" }],
  ["只要钢琴独奏", { instrument: "piano", drums: "off" }],
  ["悲伤但有希望", { style: ["sad", "cinematic"] }],
  ["欢快的电子游戏", { style: ["chiptune", "bright"], minor: false }],
  ["悲伤的咖啡馆", { style: ["sad", "chill"], minor: true, energy: [0, 0.4] }],
  ["激昂的史诗战斗", { style: ["epic", "battle"], energy: [0.8, 1] }],
  ["安静的史诗", { style: ["epic", "cinematic"], energy: [0, 0.6] }],
  ["小提琴", { instrument: "strings" }],
  ["萨克斯", { style: "jazz", says: /萨克斯/ }],
  ["古筝", { style: "guofeng", instrument: "guzheng" }],
  ["drum and bass", { style: ["dance", "battle"], bpm: [150, 200], drums: "on" }],
  ["加一点贝斯", { check: (c) => assert.ok(c.volumes.bass > DEFAULT_VOLUMES.bass, "bass not raised") }],
  ["piano only, no drums", { instrument: "piano", drums: "off" }],
  ["without percussion", { drums: "off" }],
  ["loopable menu music", { loop: true }],
  ["片尾曲，不循环", { loop: false }],
  ["", { style: "bright", bpm: 112, instrument: "piano", says: /没有收到描述/ }],
];

// prettier-ignore
const MORE_CASES: [string, Expect][] = [
  // scenes and usage
  ["校园青春毕业季", { style: "bright" }],
  ["宠物猫咪日常", { style: "cute" }],
  ["萌娃的搞笑瞬间", { style: "cute" }],
  ["深夜书店", { style: ["chill", "focus"] }],
  ["chillhop 学习用", { style: ["chill", "focus"] }],
  ["感人的纪录片配乐", { style: "cinematic" }],
  ["电影预告片，气势磅礴", { style: "epic" }],
  ["红白机风格的街机游戏", { style: "chiptune", instrument: "chip" }],
  ["仙侠武侠江湖", { style: "guofeng" }],
  ["江南水墨，琵琶和二胡", { style: "guofeng", instrument: "guzheng" }],
  ["布鲁斯酒吧", { style: "jazz" }],
  ["清晨治愈的木吉他", { style: "acoustic", instrument: "guitar" }],
  ["诡异的解谜游戏", { style: "tension", minor: true }],
  ["惊悚恐怖鬼屋", { style: "tension", minor: true }],
  ["俏皮卡通", { style: "cute" }],
  ["瑜伽冥想白噪音", { style: "ambient", drums: "low" }],
  ["创业公司路演", { style: "corporate" }],
  ["失恋后的思念", { style: "sad", minor: true }],
  ["蹦迪舞曲", { style: "dance" }],
  ["跑步健身用的快节奏音乐", { style: ["dance", "rock"], bpm: [128, 170] }],
  ["街头说唱 boombap", { style: "hiphop" }],
  ["朋克乐队", { style: "rock" }],
  ["重金属", { style: "rock" }],
  ["告白情侣纪念日", { style: "romantic" }],
  ["春节喜庆拜年", { style: "festive", minor: false }],
  ["温馨的生日祝福", { style: ["festive", "romantic"] }],
  ["周末派对", { style: "dance" }],
  ["万圣节搞怪", { style: ["cute", "tension"] }],
  ["酒吧里的慵懒爵士钢琴", { style: "jazz", instrument: "piano" }],
  // game contexts
  ["游戏主菜单", { style: ["dreamy", "chill", "chiptune", "cinematic"], loop: true }],
  ["RPG 村庄小镇", { style: "acoustic" }],
  ["地牢探索", { style: "tension", minor: true }],
  ["商店音乐", { style: ["cute", "jazz", "bright"] }],
  ["胜利结算", { style: ["festive", "epic"], loop: false, duration: [15, 20], minor: false }],
  ["游戏失败", { style: "sad", loop: false, minor: true }],
  ["无缝循环的战斗音乐", { style: "battle", loop: true }],
  ["像素风的战斗", { style: ["chiptune", "battle"], bpm: [136, 190] }],
  // tempo, duration, key
  ["很慢的钢琴，60秒，不循环", { instrument: "piano", duration: 60, loop: false, bpm: [50, 80] }],
  ["轻快的尤克里里，100bpm", { instrument: "guitar", bpm: 100 }],
  ["快节奏电子，升F小调", { style: ["dance", "retro"], key: "F# minor", bpm: [120, 140] }],
  ["降B大调的爵士，颤音琴", { style: "jazz", key: "Bb major", instrument: "vibes" }],
  ["70s disco", { style: ["dance", "retro"], duration: 30 }],
  ["1980s pop", { style: "retro", duration: 30 }],
  ["时长90s的lofi", { style: "chill", duration: 90 }],
  ["60s", { duration: 60 }],
  ["时长80s", { duration: 80, notStyle: ["retro"] }],
  ["2:00 的史诗", { style: "epic", duration: 120 }],
  ["三十秒的片头", { duration: 30, loop: false }],
  ["一分半的旅行音乐", { duration: 90, style: ["bright", "acoustic"] }],
  ["upbeat corporate tech presentation 60 seconds", { style: "corporate", duration: 60 }],
  ["fast chase scene 150 bpm", { style: ["battle", "tension"], bpm: 150 }],
  ["in a minor key, happy folk", { style: "acoustic", minor: true, notKey: "A minor" }],
  ["key of D, happy folk", { style: "acoustic", key: "D major" }],
  ["F# minor synthwave 100bpm", { style: "retro", key: "F# minor", bpm: 100 }],
  ["bpm 300", { bpm: 200, says: /速度范围/ }],
  ["10秒", { duration: 15, says: /时长范围/ }],
  ["5分钟", { duration: 120, says: /时长范围/ }],
  ["十分安静的夜", { duration: 30, energy: [0, 0.3] }],
  ["下一秒的心动", { duration: 30, style: "romantic" }],
  ["武侠对决，古筝要快", { style: ["guofeng", "battle"], instrument: "guzheng", bpm: [84, 190] }],
  // instruments
  ["八音盒摇篮曲", { instrument: "musicbox", style: ["ambient", "dreamy"], drums: "low" }],
  ["竹笛独奏", { instrument: "dizi", style: "guofeng", drums: "off" }],
  ["方波芯片音乐", { style: "chiptune", instrument: "chip" }],
  ["给宝宝的八音盒", { instrument: "musicbox", style: ["cute", "dreamy"] }],
  ["钢琴和大提琴", { instrument: "piano", check: (c) => assert.equal(c.arrangement?.layers?.pad, true, "no string pad") }],
  ["relaxing acoustic guitar for cooking video", { style: "acoustic", instrument: "guitar" }],
  ["忧郁的蓝调吉他", { style: ["jazz", "sad"], instrument: "guitar", minor: true }],
  ["国风电音", { style: ["dance", "guofeng"], instrument: "guzheng" }],
  ["摇摆爵士，走路贝斯", { style: "jazz", check: (c) => {
    assert.equal(c.arrangement?.bass, "walking", "no walking bass");
    assert.ok((c.arrangement?.swing ?? 0) > 0, "no swing");
  } }],
  // negation and comparatives
  ["不要鼓，不要贝斯，只有钢琴和弦乐", { instrument: "piano", drums: "off", bass: "off", check: (c) => assert.ok(c.volumes.chords > 0, "chords muted") }],
  ["安静一点的摇滚", { style: "rock", energy: [0.3, 0.8] }],
  ["不要太吵的电音", { style: "dance", energy: [0.3, 0.8] }],
  ["商务风格，不要太激烈，60秒", { style: "corporate", energy: [0.2, 0.55], duration: 60 }],
  ["dark cinematic tension, no drums", { style: ["tension", "cinematic"], minor: true, drums: "off" }],
  ["明亮，但是用小调", { minor: true }],
  ["欢快的摇滚", { style: "rock", minor: false }],
  ["带结尾的完整版婚礼音乐", { style: "romantic", loop: false }],
  ["空灵的女声吟唱", { style: "dreamy", says: /纯音乐/ }],
  ["激烈的摇滚鼓，不要旋律", { style: "rock", check: (c) => assert.equal(c.volumes.melody, 0, "melody not muted") }],
  ["像一只穿雨衣的河马", { style: "bright", says: /没有.*听出风格/ }],
];

test("the test table is large enough to mean something", () => {
  assert.ok(AUDIT_CASES.length === 71, `audit cases: ${AUDIT_CASES.length}`);
  assert.ok(
    AUDIT_CASES.length + MORE_CASES.length >= 120,
    `total cases: ${AUDIT_CASES.length + MORE_CASES.length}`,
  );
  const prompts = [...AUDIT_CASES, ...MORE_CASES].map(([prompt]) => prompt);
  assert.equal(new Set(prompts).size, prompts.length, "duplicate prompt");
});

for (const [name, cases] of [
  ["auditor's prompts", AUDIT_CASES],
  ["further prompts", MORE_CASES],
] as const)
  test(`new pieces: ${name} map to what a producer would choose`, () => {
    const failures: string[] = [];
    for (const [prompt, expect] of cases) {
      const problems = unmet(plan(prompt), expect);
      if (problems.length)
        failures.push(`${JSON.stringify(prompt)}: ${problems.join("; ")}`);
    }
    assert.deepEqual(failures, []);
  });

test("the v0.2 failure is gone: realistic prompts no longer collapse onto one default", () => {
  const outcomes = new Set<string>();
  const untouched: string[] = [];
  for (const [prompt] of AUDIT_CASES) {
    const result = plan(prompt);
    const c = result.config;
    outcomes.add(`${c.mood}|${c.bpm}|${c.key}|${c.instrument}`);
    if (
      c.mood === "bright" &&
      c.bpm === 112 &&
      c.key === "C major" &&
      c.instrument === "piano"
    )
      untouched.push(prompt);
    // whenever the style could not be read, the plan says so instead of pretending
    const explained = /风格定为|没有.*听出|没有收到描述/.test(
      result.reasoning[0],
    );
    assert.ok(explained, `${prompt}: ${result.reasoning[0]}`);
  }
  // v0.2: 48 of 71 resolved to bright / 112 / C major / piano, with 10 distinct outcomes.
  // What is left are requests that really are "bright" or that only set a parameter.
  assert.deepEqual(
    untouched.sort(),
    [
      "",
      "a minor detail of my day",
      "一分钟",
      "不要电子味",
      "加一点贝斯",
      "无鼓",
      "旅行vlog",
      "without percussion",
      "美食探店",
    ].sort(),
  );
  assert.ok(outcomes.size >= 25, `only ${outcomes.size} distinct outcomes`);
  const styles = new Set([...outcomes].map((outcome) => outcome.split("|")[0]));
  assert.ok(styles.size >= 18, `only ${styles.size} of 22 styles reached`);
});

test("every plan is a complete, valid, deterministic engine-2 configuration", () => {
  for (const [prompt] of [...AUDIT_CASES, ...MORE_CASES]) {
    const result = plan(prompt);
    const c = result.config;
    assert.ok(
      isStyleId(c.mood) && isInstrumentId(c.instrument) && isKey(c.key),
      prompt,
    );
    assert.deepEqual(clampConfig(c, c), c, `${prompt}: not already clamped`);
    assert.equal(c.engine, 2);
    assert.equal(
      c.seed,
      NEXT_SEED,
      `${prompt}: new pieces use the supplied seed`,
    );
    assert.equal(c.prompt, prompt.trim() || DEFAULT_CONFIG.prompt);
    assert.equal(result.brain, "rules");
    assert.equal(result.unchanged, false);
    assert.equal(result.cloudPrompt, undefined);
    assert.ok(result.title.length > 0 && result.title.length <= 60, prompt);
    assert.ok(
      result.reply.length > 0 && result.reply.length <= 200,
      `${prompt}: ${result.reply}`,
    );
    assert.ok(result.reasoning.length > 0 && result.tags.length >= 3, prompt);
    assert.ok(
      !/[\u{1F300}-\u{1FAFF}]/u.test(result.reply + result.reasoning.join("")),
      "emoji",
    );
    assert.deepEqual(plan(prompt), result, `${prompt}: not deterministic`);
  }
});

test("a new piece keeps the draft's duration, loop and faders unless the text says otherwise", () => {
  const current: MusicConfig = {
    ...draft(),
    duration: 60,
    loop: false,
    bpm: 150,
    instrument: "bell",
    volumes: { melody: 0.5, chords: 0.4, bass: 0.3, drums: 0.2 },
  };
  const c = plan("雨天咖啡馆", "new", current).config;
  assert.equal(c.mood, "chill");
  assert.equal(c.duration, 60);
  assert.equal(c.loop, false);
  assert.deepEqual(c.volumes, current.volumes);
  // the style brings its own tempo and lead
  assert.equal(c.bpm, styleInfo("chill").bpm);
  assert.equal(c.instrument, styleInfo("chill").instrument);
  // when no style can be read the whole draft survives (APP-03)
  const kept = plan("90秒", "new", current).config;
  assert.equal(kept.bpm, 150);
  assert.equal(kept.instrument, "bell");
  assert.equal(kept.duration, 90);
});

test("titles: the user's own short phrase, otherwise one of the style's titles", () => {
  assert.equal(plan("雨天咖啡馆").title, "雨天咖啡馆");
  assert.equal(plan("孤独的夜晚").title, "孤独的夜晚");
  assert.equal(plan("给我来一首适合雨夜开车的音乐").title, "雨夜开车");
  assert.ok(styleInfo("romantic").titles.includes(plan("婚礼").title));
  assert.ok(styleInfo("retro").titles.includes(plan("80s synthwave").title));
  assert.ok(styleInfo("bright").titles.includes(plan("不要电子味").title));
  // refinements keep the title of the piece
  const before = plan("雨天咖啡馆");
  const after = plan("鼓轻一点", "refine", before.config);
  assert.equal(after.title, before.title);
  const supplied = plan("鼓轻一点", "refine", before.config, {
    title: "我的曲子",
  });
  assert.equal(supplied.title, "我的曲子");
  // … as it is stored, also across a change of style; a new piece is a new work
  assert.equal(
    plan("改成摇滚风格", "refine", before.config, { title: "  我的曲子 " })
      .title,
    "我的曲子",
  );
  assert.equal(
    plan("鼓轻一点", "refine", before.config, { title: "长".repeat(200) }).title
      .length,
    80,
  );
  assert.equal(
    plan("鼓轻一点", "refine", before.config, { title: "   " }).title,
    before.title,
  );
  assert.equal(
    plan("雨天咖啡馆", "new", draft(), { title: "我的曲子" }).title,
    "雨天咖啡馆",
  );
});

test("cloud providers always get a prompt, the local engine never does", () => {
  for (const provider of [
    "tencent",
    "volcengine",
    "aliyun",
    "elevenlabs",
  ] as const) {
    const fresh = plan("雨天咖啡馆", "new", draft(), { provider });
    assert.ok(fresh.cloudPrompt?.startsWith("雨天咖啡馆"), fresh.cloudPrompt);
    assert.ok(fresh.cloudPrompt?.endsWith("纯音乐，无人声，无歌词"));
    const refined = plan("不要鼓点", "refine", dreamy(), { provider });
    // a refinement is described by its result, never by the instruction itself (AGENT-07)
    assert.ok(
      !/不要鼓点|补充要求/.test(refined.cloudPrompt ?? ""),
      refined.cloudPrompt,
    );
    assert.match(refined.cloudPrompt ?? "", /不要鼓组/);
    assert.ok(
      refined.cloudPrompt?.startsWith("梦幻空灵。风格：梦幻空灵"),
      refined.cloudPrompt,
    );
  }
  assert.equal(plan("雨天咖啡馆", "refine").cloudPrompt, undefined);
});

/* ---------- refinements ---------- */

const changedFields = (before: MusicConfig, after: MusicConfig) =>
  (Object.keys(after) as (keyof MusicConfig)[]).filter(
    (field) => JSON.stringify(after[field]) !== JSON.stringify(before[field]),
  );

test("refine changes only what was asked and keeps the melody seed", () => {
  // prettier-ignore
  const cases: [string, (keyof MusicConfig)[], (c: MusicConfig, b: MusicConfig) => void][] = [
    ["换成小提琴", ["instrument"], (c) => assert.equal(c.instrument, "strings")],
    ["把钢琴换成吉他", ["instrument"], (c) => assert.equal(c.instrument, "guitar")],
    ["switch to guitar", ["instrument"], (c) => assert.equal(c.instrument, "guitar")],
    ["旋律用长笛，和声轻一点", ["instrument", "volumes"], (c, b) => {
      assert.equal(c.instrument, "flute");
      assert.ok(c.volumes.chords < b.volumes.chords);
    }],
    ["重低音", ["volumes"], (c, b) => assert.ok(c.volumes.bass > b.volumes.bass)],
    ["我不要这么多鼓", ["volumes"], (c, b) => assert.ok(c.volumes.drums < b.volumes.drums && c.volumes.drums > 0)],
    ["鼓不要了", ["volumes"], (c) => assert.equal(c.volumes.drums, 0)],
    ["without bass and drums", ["volumes"], (c) => assert.deepEqual([c.volumes.bass, c.volumes.drums], [0, 0])],
    // a remark about the lead's loudness moves the melody fader, it does not swap the lead
    ["钢琴不要太响", ["volumes"], (c, b) => assert.ok(c.volumes.melody < b.volumes.melody)],
    ["钟琴太响了", ["volumes"], (c, b) => assert.ok(c.volumes.melody < b.volumes.melody)],
    ["don't use piano, use flute instead", ["instrument"], (c) => assert.equal(c.instrument, "flute")],
    ["鼓快一点", ["bpm"], (c, b) => assert.ok(c.bpm > b.bpm)],
    ["can you make the drums a little quieter", ["volumes"], (c, b) => assert.ok(c.volumes.drums < b.volumes.drums && c.volumes.drums > 0)],
    ["鼓有点吵", ["volumes"], (c, b) => assert.ok(c.volumes.drums < b.volumes.drums)],
    ["贝斯有点小", ["volumes"], (c, b) => assert.ok(c.volumes.bass > b.volumes.bass)],
    ["有点慢", ["bpm"], (c, b) => assert.ok(c.bpm > b.bpm)],
    ["去掉混响", ["reverb"], (c) => assert.equal(c.reverb, 0)],
    ["混响 20%", ["reverb"], (c) => assert.equal(c.reverb, 0.2)],
    ["change the key to G major", ["key"], (c) => assert.equal(c.key, "G major")],
    ["加个副旋律", ["arrangement"], (c) => assert.equal(c.arrangement?.layers?.counter, true)],
    ["make it more upbeat and add some strings", ["energy", "arrangement"], (c, b) => {
      assert.ok(c.energy > b.energy);
      assert.equal(c.arrangement?.layers?.pad, true);
    }],
    ["不要钢琴，用吉他", ["instrument"], (c) => assert.equal(c.instrument, "guitar")],
    ["鼓再重一点", ["volumes"], (c, b) => assert.ok(c.volumes.drums > b.volumes.drums)],
    ["加点低音", ["volumes"], (c, b) => assert.ok(c.volumes.bass > b.volumes.bass)],
    ["more bass", ["volumes"], (c, b) => assert.ok(c.volumes.bass > b.volumes.bass)],
    ["bass boost", ["volumes"], (c, b) => assert.ok(c.volumes.bass > b.volumes.bass)],
    ["turn the drums down", ["volumes"], (c, b) => assert.ok(c.volumes.drums < b.volumes.drums)],
    ["鼓太重了", ["volumes"], (c, b) => assert.ok(c.volumes.drums < b.volumes.drums)],
    ["鼓不要太重", ["volumes"], (c, b) => assert.ok(c.volumes.drums < b.volumes.drums && c.volumes.drums > 0)],
    ["旋律小一点", ["volumes"], (c, b) => assert.ok(c.volumes.melody < b.volumes.melody)],
    ["鼓的音量调到 30%", ["volumes"], (c) => assert.equal(c.volumes.drums, 0.3)],
    ["高潮部分加鼓", ["volumes"], (c, b) => assert.ok(c.volumes.drums > b.volumes.drums)],
    ["太吵了", ["energy"], (c, b) => assert.ok(c.energy < b.energy)],
    ["不要太吵", ["energy"], (c, b) => assert.ok(c.energy < b.energy)],
    ["更有活力", ["energy"], (c, b) => assert.ok(c.energy > b.energy)],
    ["副歌更燃", ["energy"], (c, b) => assert.ok(c.energy > b.energy)],
    ["再欢快一点", ["energy"], (c, b) => assert.ok(c.energy > b.energy)],
    ["太单调了", ["complexity"], (c, b) => assert.ok(c.complexity > b.complexity)],
    ["更有层次", ["complexity"], (c, b) => assert.ok(c.complexity > b.complexity)],
    ["简单一点", ["complexity"], (c, b) => assert.ok(c.complexity < b.complexity)],
    ["少一点音符", ["complexity"], (c, b) => assert.ok(c.complexity < b.complexity)],
    ["less complex", ["complexity"], (c, b) => assert.ok(c.complexity < b.complexity)],
    ["混响大一点", ["reverb"], (c, b) => assert.ok(c.reverb > b.reverb)],
    ["more reverb", ["reverb"], (c, b) => assert.ok(c.reverb > b.reverb)],
    ["太干了", ["reverb"], (c, b) => assert.ok(c.reverb > b.reverb)],
    ["干一点", ["reverb"], (c, b) => assert.ok(c.reverb < b.reverb)],
    ["减少混响", ["reverb"], (c, b) => assert.ok(c.reverb < b.reverb)],
    ["降到 F 大调", ["key"], (c) => assert.equal(c.key, "F major")],
    ["小调", ["key"], (c) => assert.equal(c.key, "D minor")],
    ["速度 96", ["bpm"], (c) => assert.equal(c.bpm, 96)],
    ["节拍 140", ["bpm"], (c) => assert.equal(c.bpm, 140)],
    ["加快到 200 bpm", ["bpm"], (c) => assert.equal(c.bpm, 200)],
    ["慢一点", ["bpm"], (c, b) => assert.ok(b.bpm - c.bpm >= 10 && b.bpm - c.bpm <= 12)],
    ["slower", ["bpm"], (c, b) => assert.ok(b.bpm - c.bpm >= 10 && b.bpm - c.bpm <= 12)],
    ["慢很多", ["bpm"], (c, b) => assert.ok(b.bpm - c.bpm > 12)],
    ["稍微快一点", ["bpm"], (c, b) => assert.ok(c.bpm - b.bpm > 0 && c.bpm - b.bpm < 10)],
    ["太快了", ["bpm"], (c, b) => assert.ok(c.bpm < b.bpm)],
    ["别太慢", ["bpm"], (c, b) => assert.ok(c.bpm > b.bpm)],
    ["45秒", ["duration"], (c) => assert.equal(c.duration, 45)],
    ["长一点", ["duration"], (c, b) => assert.ok(c.duration > b.duration)],
    ["不循环", ["loop"], (c) => assert.equal(c.loop, false)],
    ["结尾渐弱", ["loop"], (c) => assert.equal(c.loop, false)],
    ["disable loop", ["loop"], (c) => assert.equal(c.loop, false)],
    ["加点弦乐铺底", ["arrangement"], (c) => assert.equal(c.arrangement?.layers?.pad, true)],
    ["不要琶音", ["arrangement"], (c) => assert.equal(c.arrangement?.layers?.arp, false)],
    ["摇摆一点", ["arrangement"], (c) => assert.ok((c.arrangement?.swing ?? 0) > 0.2)],
    ["四四拍底鼓", ["arrangement"], (c) => assert.equal(c.arrangement?.drums, "fourfloor")],
    ["four on the floor", ["arrangement"], (c) => assert.equal(c.arrangement?.drums, "fourfloor")],
    ["走路贝斯", ["arrangement"], (c) => assert.equal(c.arrangement?.bass, "walking")],
    ["鼓轻一点，贝斯重一点", ["volumes"], (c, b) => {
      assert.ok(c.volumes.drums < b.volumes.drums);
      assert.ok(c.volumes.bass > b.volumes.bass);
    }],
    ["只要鼓和贝斯", ["volumes"], (c) => {
      assert.equal(c.volumes.melody, 0);
      assert.equal(c.volumes.chords, 0);
      assert.ok(c.volumes.drums > 0 && c.volumes.bass > 0);
    }],
    ["不要鼓和贝斯", ["volumes"], (c) => {
      assert.equal(c.volumes.drums, 0);
      assert.equal(c.volumes.bass, 0);
      assert.ok(c.volumes.melody > 0 && c.volumes.chords > 0);
    }],
  ];
  for (const [text, fields, check] of cases) {
    const before = dreamy();
    const result = plan(text, "refine", before);
    assert.deepEqual(changedFields(before, result.config), fields, text);
    assert.equal(result.config.seed, before.seed, `${text}: seed must be kept`);
    assert.equal(result.unchanged, false, text);
    assert.ok(result.reasoning.length > 0, text);
    check(result.config, before);
    assert.deepEqual(before, dreamy(), `${text}: the request was mutated`);
  }
});

test("a new take changes the seed and nothing else", () => {
  for (const text of [
    "换一版",
    "再来一首",
    "换个旋律",
    "再来一个",
    "another take",
    "换一版新旋律",
    "new melody",
  ]) {
    const before = dreamy();
    const result = plan(text, "refine", before);
    assert.deepEqual(changedFields(before, result.config), ["seed"], text);
    assert.equal(result.config.seed, NEXT_SEED);
    assert.equal(result.unchanged, false);
  }
});

test("a style change re-applies that style's tempo, key and lead unless the message pins them", () => {
  const before = dreamy();
  const swapped = plan("改成赛博朋克风格", "refine", before).config;
  assert.equal(swapped.mood, "retro");
  assert.equal(swapped.bpm, styleInfo("retro").bpm);
  assert.equal(swapped.key, styleInfo("retro").key);
  assert.equal(swapped.instrument, styleInfo("retro").instrument);
  assert.equal(swapped.seed, before.seed);
  assert.equal(swapped.duration, before.duration);
  assert.deepEqual(swapped.volumes, before.volumes);

  const pinned = plan(
    "改成赛博朋克风格，速度 90，用钢琴",
    "refine",
    before,
  ).config;
  assert.equal(pinned.mood, "retro");
  assert.equal(pinned.bpm, 90);
  assert.equal(pinned.instrument, "piano");

  assert.equal(plan("摇滚", "refine", before).config.mood, "rock");
  assert.equal(plan("把爵士换成摇滚", "refine", before).config.mood, "rock");
  assert.equal(
    plan("换个风格，史诗一点", "refine", before).config.mood,
    "epic",
  );
  assert.equal(
    plan("我想要更像电影配乐", "refine", before).config.mood,
    "cinematic",
  );
  const vague = plan("换个风格", "refine", before);
  assert.equal(vague.unchanged, true);
  assert.match(vague.reply, /想换成什么风格/);
  assert.equal(plan("换成爵士风格", "refine", before).config.mood, "jazz");
});

test("mood words and flavours adjust the piece without replacing its style", () => {
  const before = dreamy();
  for (const text of [
    "再欢快一点",
    "更温柔一点",
    "安静一点",
    "更悲伤一点",
    "来点爵士味",
    "换成小提琴",
    "摇摆一点",
  ])
    assert.equal(plan(text, "refine", before).config.mood, "dreamy", text);
  // EM-16: "再欢快一点" used to add 12 BPM through the substring "快一点"
  assert.equal(plan("再欢快一点", "refine", before).config.bpm, before.bpm);
  assert.equal(
    parseKey(plan("更悲伤一点", "refine", before).config.key).minor,
    true,
  );
  const jazzy = plan("来点爵士味", "refine", before).config;
  assert.equal(jazzy.instrument, styleInfo("jazz").instrument);
  assert.ok((jazzy.arrangement?.swing ?? 0) > 0);
});

test("English unmute restores each muted track instead of matching mute within unmute", () => {
  for (const track of ["drums", "bass", "melody", "chords"] as TrackName[]) {
    const original = draft();
    const muted = plan(`mute ${track}`, "refine", original).config;
    assert.equal(muted.volumes[track], 0);
    const restored = plan(`unmute ${track}`, "refine", muted).config;
    assert.equal(restored.volumes[track], DEFAULT_VOLUMES[track], track);
    assert.equal(restored.seed, original.seed);
    assert.equal(restored.bpm, original.bpm);
    assert.deepEqual(original, DEFAULT_CONFIG);
  }
});

test("every v0.2 way of muting and restoring a track still works", () => {
  const words: Record<TrackName, string[]> = {
    drums: ["鼓点", "鼓", "打击乐", "drums", "percussion"],
    bass: ["低音", "贝斯", "bass"],
    melody: ["主旋律", "旋律", "melody"],
    chords: ["和弦", "和声", "chords", "harmony"],
  };
  for (const [track, names] of Object.entries(words) as [TrackName, string[]][])
    for (const name of names) {
      const latin = /[a-z]/.test(name);
      const mutes = latin
        ? [
            `no ${name}`,
            `without ${name}`,
            `remove ${name}`,
            `mute ${name}`,
            `${name} off`,
          ]
        : [
            `不要${name}`,
            `去掉${name}`,
            `移除${name}`,
            `关闭${name}`,
            `静音${name}`,
            `${name}静音`,
            `${name}关掉`,
            `没有${name}`,
          ];
      for (const text of mutes)
        assert.equal(
          plan(text, "refine", draft()).config.volumes[track],
          0,
          text,
        );
      const muted = { ...draft(), volumes: { ...DEFAULT_VOLUMES, [track]: 0 } };
      const restores = latin
        ? [`unmute ${name}`, `enable ${name}`, `add ${name}`, `${name} on`]
        : [
            `恢复${name}`,
            `打开${name}`,
            `开启${name}`,
            `加回${name}`,
            `${name}打开`,
          ];
      for (const text of restores)
        assert.equal(
          plan(text, "refine", muted).config.volumes[track],
          DEFAULT_VOLUMES[track],
          text,
        );
      const up = latin
        ? [`more ${name}`, `${name} louder`]
        : [
            `${name}大一点`,
            `${name}强一些`,
            `突出${name}`,
            `提高${name}`,
            `增加${name}`,
          ];
      for (const text of up)
        assert.ok(
          plan(text, "refine", draft()).config.volumes[track] >
            DEFAULT_VOLUMES[track],
          text,
        );
      const down = latin
        ? [`less ${name}`, `${name} quieter`, `${name} softer`]
        : [
            `${name}小一点`,
            `${name}轻一点`,
            `${name}弱一些`,
            `降低${name}`,
            `减少${name}`,
          ];
      for (const text of down) {
        const value = plan(text, "refine", draft()).config.volumes[track];
        assert.ok(value < DEFAULT_VOLUMES[track] && value > 0, text);
      }
    }
});

test("gentler instructions never increase energy, even at the minimum", () => {
  for (const energy of [0, 0.01, 0.05, 0.2, 0.7, 1])
    for (const text of [
      "更温柔一点",
      "更安静",
      "轻柔",
      "calm",
      "quieter",
      "不要太吵",
    ]) {
      const result = plan(text, "refine", { ...draft(), energy }).config;
      assert.ok(
        result.energy <= energy,
        `${text} at ${energy} became ${result.energy}`,
      );
      assert.ok(result.energy >= 0);
    }
});

test("Chinese mute and restore preserve an existing melody and other parameters", () => {
  const initial = plan("青春吉他，94 BPM，45秒，D major").config;
  assert.equal(initial.bpm, 94);
  assert.equal(initial.duration, 45);
  assert.equal(initial.key, "D major");
  assert.equal(initial.instrument, "guitar");
  const muted = plan("不要鼓点", "refine", initial).config;
  const restored = plan("恢复鼓点", "refine", muted).config;
  assert.equal(muted.volumes.drums, 0);
  assert.equal(restored.volumes.drums, DEFAULT_VOLUMES.drums);
  for (const field of [
    "seed",
    "bpm",
    "duration",
    "key",
    "instrument",
    "mood",
  ] as const)
    assert.equal(restored[field], initial[field]);
});

test("an instruction that is not understood is a true no-op and says so helpfully", () => {
  for (const text of [
    "像一只穿雨衣的河马",
    "xyzzy",
    "嗯嗯",
    "a minor detail of my day",
    "",
  ]) {
    const before = dreamy();
    const result = plan(text, "refine", before);
    assert.deepEqual(result.config, before, text);
    assert.equal(result.unchanged, true);
    assert.match(result.reply, /保持不变/);
    assert.match(result.reply, /可以试试/);
    assert.ok(result.reasoning.length > 0);
  }
  // requests that are understood but change nothing explain why
  assert.match(plan("30秒", "refine").reasoning.join(), /已经是 30 秒/);
  assert.match(
    plan("unmute drums", "refine").reasoning.join(),
    /本来就是打开的/,
  );
  assert.match(plan("不要钢琴", "refine").reasoning.join(), /本来就没有/);
  assert.match(plan("前奏长一点", "refine").reasoning.join(), /段/);
  assert.equal(plan("前奏长一点", "refine").unchanged, true);
  assert.match(plan("大调", "refine").reasoning.join(), /已经是 D 大调/);
  assert.match(plan("循环", "refine").reasoning.join(), /已经是循环片段/);
  // thanks are not a failed instruction
  const thanks = plan("谢谢，很好听", "refine");
  assert.equal(thanks.unchanged, true);
  assert.match(thanks.reply, /很高兴你喜欢/);
});

test("old engine-1 works are refined into engine-2 configurations", () => {
  const old = { ...dreamy(), engine: 1 as const };
  const result = plan("鼓轻一点", "refine", old);
  assert.equal(result.config.engine, 2);
  assert.ok(result.config.volumes.drums < old.volumes.drums);
  assert.equal(plan("像一只穿雨衣的河马", "refine", old).unchanged, true);
});

test("hostile or broken requests never throw", () => {
  const broken = [
    { text: "x".repeat(20000), mode: "new" },
    { text: 42, mode: "refine" },
    { text: "爵士", mode: "weird", current: null },
    {
      text: "爵士",
      mode: "new",
      current: { mood: "nope", bpm: "fast", volumes: 3 },
      nextSeed: Number.NaN,
    },
  ];
  for (const request of broken) {
    const result = planWithRules({
      provider: "local",
      history: [],
      nextSeed: 1,
      current: draft(),
      ...request,
    } as unknown as AgentRequest);
    assert.ok(isStyleId(result.config.mood));
    assert.deepEqual(clampConfig(result.config, result.config), result.config);
  }
  assert.equal(plan("钢琴".repeat(2000)).config.prompt.length, 1500);
});

/* ---------- pins: what the user fixed in the UI ---------- */

test("a pinned style replaces style detection; the text still supplies the parameters", () => {
  // the words say café jazz, the style chip says guofeng
  const pinned = plan(
    "雨天咖啡馆里的慵懒爵士，一分钟，不要鼓，速度 90",
    "new",
    draft(),
    { pins: { mood: "guofeng" } },
  );
  const c = pinned.config;
  assert.equal(c.mood, "guofeng");
  assert.equal(c.bpm, 90);
  assert.equal(c.duration, 60);
  assert.equal(c.volumes.drums, 0);
  // what the text leaves open comes from the pinned style, not from the style the words suggest
  assert.equal(c.key, styleInfo("guofeng").key);
  assert.equal(c.instrument, styleInfo("guofeng").instrument);
  assert.equal(c.reverb, styleInfo("guofeng").reverb);
  assert.equal(c.seed, NEXT_SEED);
  assert.equal(pinned.reasoning[0], "按你选的「国风古韵」风格来编");
  assert.ok(
    !pinned.reasoning.some((item) => /风格定为|也很接近|没有.*听出/.test(item)),
    pinned.reasoning.join("｜"),
  );
  assert.match(
    pinned.reply,
    /^好的，做一段「国风古韵」风格的音乐：90 BPM、D 大调、古筝主奏，60 秒/,
  );
  assert.ok(!/没听出/.test(pinned.reply));
  assert.deepEqual(pinned.tags.slice(0, 3), ["国风古韵", "90 BPM", "古筝"]);
  assert.equal(pinned.unchanged, false);
  // a lead, a key or a mood word in the text still shapes the pinned style
  assert.equal(
    plan("钢琴", "new", draft(), { pins: { mood: "guofeng" } }).config
      .instrument,
    "piano",
  );
  assert.equal(
    plan("E minor", "new", draft(), { pins: { mood: "guofeng" } }).config.key,
    "E minor",
  );
  assert.ok(
    plan("安静一点", "new", draft(), { pins: { mood: "rock" } }).config.energy <
      styleInfo("rock").energy,
  );
  // a style defined by its sound still lends its lead to the pinned one — unless the lead is pinned too
  const lent = plan("国风", "new", draft(), { pins: { mood: "dance" } });
  assert.deepEqual(
    [lent.config.mood, lent.config.instrument],
    ["dance", "guzheng"],
  );
  const fixedLead = plan("国风", "new", draft(), {
    pins: { mood: "dance", instrument: "bell" },
  });
  assert.deepEqual(
    [fixedLead.config.mood, fixedLead.config.instrument],
    ["dance", "bell"],
  );
  assert.ok(
    !fixedLead.reasoning.some((item) => item.includes("古筝")),
    fixedLead.reasoning.join("｜"),
  );

  // without a word of text the pinned style's preset is the piece
  const bare = plan(
    "",
    "new",
    { ...draft(), duration: 45, loop: false },
    { pins: { mood: "battle" } },
  );
  assert.deepEqual(
    { ...bare.config, seed: 0, prompt: "" },
    {
      ...draft(),
      ...stylePreset("battle"),
      duration: 45,
      loop: false,
      seed: 0,
      prompt: "",
    },
  );
  assert.deepEqual(bare.reasoning, ["按你选的「热血战斗」风格来编"]);
  // any style can be pinned against any text, and the plan stays valid and deterministic
  for (const style of STYLE_IDS)
    for (const text of [
      "雨天咖啡馆",
      "史诗战斗，古筝，140bpm",
      "像一只穿雨衣的河马",
      "",
    ]) {
      const result = plan(text, "new", draft(), { pins: { mood: style } });
      assert.equal(result.config.mood, style, `${style}: ${text}`);
      assert.deepEqual(
        clampConfig(result.config, result.config),
        result.config,
      );
      assert.deepEqual(
        plan(text, "new", draft(), { pins: { mood: style } }),
        result,
      );
    }
});

test("refining with a pinned style: a new one re-bases the piece, the current one holds it", () => {
  const before = dreamy();
  const swapped = plan("速度 100，鼓轻一点", "refine", before, {
    pins: { mood: "rock" },
  });
  assert.equal(swapped.config.mood, "rock");
  assert.equal(swapped.config.bpm, 100, "the text sets the tempo");
  assert.equal(swapped.config.key, styleInfo("rock").key);
  assert.equal(swapped.config.instrument, styleInfo("rock").instrument);
  assert.equal(swapped.config.energy, styleInfo("rock").energy);
  assert.ok(swapped.config.volumes.drums < before.volumes.drums);
  assert.equal(swapped.config.seed, before.seed);
  assert.equal(swapped.config.duration, before.duration);
  assert.equal(swapped.reasoning[0], "按你选的「摇滚能量」风格来编");
  assert.ok(
    !swapped.reasoning.some((item) => item.startsWith("风格改为")),
    "the pin is named once",
  );
  assert.ok(swapped.reasoning.includes("调性 D 大调 → E 小调"));
  assert.match(swapped.reply, /^好的：风格改为「摇滚能量」/);
  // the old piece's arrangement does not move into the new style
  const hinted = {
    ...before,
    arrangement: { swing: 0.5, layers: { pad: true } },
  };
  assert.equal(
    plan("", "refine", hinted, { pins: { mood: "rock" } }).config.arrangement,
    undefined,
  );

  // pinned to what the piece already is: the words cannot move it to another style
  for (const text of [
    "改成爵士风格，慢一点",
    "摇滚，慢一点",
    "换成赛博朋克风格，慢一点",
    "来点爵士味，慢一点",
  ]) {
    const held = plan(text, "refine", before, { pins: { mood: "dreamy" } });
    assert.deepEqual(changedFields(before, held.config), ["bpm"], text);
    assert.equal(held.config.bpm, before.bpm - 12, text);
  }
  // … and with nothing else to do, nothing changes
  const idle = plan("换个风格", "refine", before, { pins: { mood: "dreamy" } });
  assert.equal(idle.unchanged, true);
  assert.deepEqual(idle.config, before);
  assert.ok(!/想换成什么风格/.test(idle.reply), idle.reply);
  assert.equal(idle.reasoning[0], "按你选的「梦幻空灵」风格来编");
});

test("a pinned duration, loop, lead, key or tempo wins over what the text says", () => {
  const pins = {
    instrument: "guzheng",
    key: "A minor",
    bpm: 90,
    duration: 45,
    loop: false,
  } as const;
  const fresh = plan(
    "两分钟的钢琴曲，速度 140，C大调，无缝循环",
    "new",
    draft(),
    { pins },
  );
  for (const field of ["instrument", "key", "bpm", "duration", "loop"] as const)
    assert.equal(fresh.config[field], pins[field], field);
  assert.equal(
    fresh.reasoning[0],
    "按你的设定：古筝主奏、A 小调、90 BPM、45 秒、完整结尾",
  );
  assert.match(
    fresh.reasoning[1],
    /^风格定为「/,
    "the style is still read from the words",
  );
  assert.ok(
    !fresh.reasoning
      .slice(1)
      .some((item) =>
        /主奏换成|调性|速度 \d|时长 \d|完整版本|改为无缝/.test(item),
      ),
    `the pins are named once: ${fresh.reasoning.join("｜")}`,
  );
  assert.match(fresh.reply, /90 BPM、A 小调、古筝主奏，45 秒，完整结尾/);
  assert.deepEqual(
    plan("两分钟的钢琴曲，速度 140，C大调，无缝循环", "new", draft(), { pins }),
    fresh,
  );
  // each pin on its own
  assert.equal(
    plan("一分钟", "new", draft(), { pins: { duration: 30 } }).config.duration,
    30,
  );
  assert.equal(
    plan("游戏主菜单", "new", draft(), { pins: { loop: false } }).config.loop,
    false,
  );
  assert.equal(
    plan("不要钢琴，用吉他", "new", draft(), { pins: { instrument: "piano" } })
      .config.instrument,
    "piano",
  );
  assert.equal(
    plan("忧伤的小调", "new", draft(), { pins: { key: "G major" } }).config.key,
    "G major",
  );
  assert.equal(
    plan("很慢的冥想", "new", draft(), { pins: { bpm: 150 } }).config.bpm,
    150,
  );

  // refining: pinned values are changes like any other, named once in the reasoning
  const before = dreamy();
  const refined = plan("慢一点", "refine", before, {
    pins: { duration: 60, loop: false },
  });
  assert.deepEqual(changedFields(before, refined.config).sort(), [
    "bpm",
    "duration",
    "loop",
  ]);
  assert.equal(refined.config.seed, before.seed);
  assert.deepEqual(refined.reasoning, [
    "按你的设定：60 秒、完整结尾",
    "速度 74 → 62 BPM",
  ]);
  assert.equal(
    refined.reply,
    "好的：速度 74 → 62 BPM，时长 30 → 60 秒，结构改为完整结尾。旋律动机不变，会按新的设置重新演绎。",
  );
  // a pin alone is a request
  const alone = plan("", "refine", before, { pins: { loop: false } });
  assert.deepEqual(changedFields(before, alone.config), ["loop"]);
  assert.equal(alone.unchanged, false);
  // pins that only repeat the piece do nothing
  const repeated = plan("鼓轻一点", "refine", before, {
    pins: {
      duration: 30,
      loop: true,
      bpm: 74,
      key: "D major",
      instrument: "bell",
    },
  });
  assert.deepEqual(changedFields(before, repeated.config), ["volumes"]);
  assert.equal(
    plan("", "refine", before, { pins: { duration: 30 } }).unchanged,
    true,
  );
  // the text asks for one value, the pin holds another
  const held = plan("速度 120，换成钢琴，两分钟", "refine", before, {
    pins: { bpm: 80, instrument: "flute", duration: 45 },
  }).config;
  assert.deepEqual(
    [held.bpm, held.instrument, held.duration],
    [80, "flute", 45],
  );

  // malformed pins are ignored, out-of-range ones clamped
  const broken = plan("雨天咖啡馆", "new", draft(), {
    pins: {
      mood: "nope",
      instrument: 7,
      key: "H major",
      bpm: "fast",
      duration: 1e9,
      loop: "yes",
    } as unknown as AgentRequest["pins"],
  });
  assert.equal(broken.config.mood, "chill");
  assert.equal(broken.config.bpm, styleInfo("chill").bpm);
  assert.equal(broken.config.duration, 120);
  assert.equal(broken.config.loop, true);
  for (const junk of [null, "jazz", 5, [], () => ({ mood: "rock" })])
    assert.deepEqual(
      plan("雨天咖啡馆", "new", draft(), {
        pins: junk as unknown as AgentRequest["pins"],
      }),
      plan("雨天咖啡馆"),
    );
  // a cloud prompt describes the pinned piece
  const cloud = plan("月下独酌", "new", draft(), {
    provider: "tencent",
    pins: { mood: "guofeng", duration: 60, loop: false },
  });
  assert.match(cloud.cloudPrompt ?? "", /国风古韵/);
  assert.match(cloud.cloudPrompt ?? "", /时长约 60 秒/);
  assert.match(cloud.cloudPrompt ?? "", /自然的结尾/);
});

test("readMentions: which faders and which parameters a request is about", () => {
  const cases: [
    string,
    "new" | "refine",
    TrackName[],
    ("tempo" | "energy" | "complexity" | "reverb")[],
  ][] = [
    ["雨天咖啡馆", "new", [], []],
    ["换成小提琴", "refine", [], []],
    ["不要鼓", "new", ["drums"], []],
    ["140bpm 鼓和贝斯", "new", ["bass", "drums"], ["tempo"]],
    // "抢戏" is a loudness word like "太响": said of a track it also counts as talk about energy
    ["鼓别那么抢戏", "refine", ["drums"], ["energy"]],
    ["旋律小一点，和声厚一些", "refine", ["chords", "melody"], []],
    ["钢琴太响了", "refine", ["melody"], ["energy"]],
    ["只要钢琴独奏", "new", ["bass", "chords", "drums", "melody"], []],
    ["只留鼓", "refine", ["bass", "chords", "drums", "melody"], []],
    ["整体音量小一点", "refine", ["bass", "chords", "drums", "melody"], []],
    ["鼓的音量调到 30%", "refine", ["drums"], []],
    ["睡前冥想", "new", ["drums"], []],
    ["慢一点", "refine", [], ["tempo"]],
    ["速度 96", "refine", [], ["tempo"]],
    ["更温柔一点", "refine", [], ["energy"]],
    ["再欢快一点", "refine", [], ["energy"]],
    ["太单调了", "refine", [], ["complexity"]],
    ["混响大一点", "refine", [], ["reverb"]],
    // mood words move the energy as well
    ["更空灵一些，节奏快一点", "refine", [], ["tempo", "energy", "reverb"]],
    ["", "refine", [], []],
  ];
  for (const [text, mode, tracks, fields] of cases) {
    const read = readMentions(text, mode);
    assert.deepEqual([...read.tracks].sort(), tracks, `${text}: tracks`);
    for (const field of ["tempo", "energy", "complexity", "reverb"] as const)
      assert.equal(read[field], fields.includes(field), `${text}: ${field}`);
  }
});

/* ---------- the reader itself ---------- */

test("normaliser: full-width text, Chinese numerals and hyphenated words", () => {
  assert.equal(normalizeText("１２０ＢＰＭ，Ｃ大调"), "120BPM,C大调");
  assert.equal(normalizeText("两分钟"), "2分钟");
  assert.equal(normalizeText("一分三十秒"), "1分30秒");
  assert.equal(normalizeText("八十年代"), "80年代");
  assert.equal(normalizeText("速度一百二"), "速度120");
  assert.equal(normalizeText("慢一点"), "慢一点");
  assert.equal(normalizeText("十分安静"), "十分安静");
  assert.equal(normalizeText("lo-fi hip-hop"), "lo fi hip hop");
  for (const [text, value] of [
    ["两", 2],
    ["十", 10],
    ["九十", 90],
    ["一百二", 120],
    ["一百零五", 105],
    ["九零", 90],
    ["一百二十", 120],
  ] as const)
    assert.equal(parseChineseNumber(text), value, text);
});

test("durations, decades and tempo are told apart", () => {
  const cases: [string, { duration?: number; bpm?: number }][] = [
    ["30秒", { duration: 30 }],
    ["1分30秒", { duration: 90 }],
    ["一分半", { duration: 90 }],
    ["半分钟", { duration: 30 }],
    ["两分钟", { duration: 120 }],
    ["1.5分钟", { duration: 90 }],
    ["90s", { duration: 90 }],
    ["90 seconds", { duration: 90 }],
    ["2 minutes", { duration: 120 }],
    ["1 min 30 s", { duration: 90 }],
    ["1:30", { duration: 90 }],
    ["80s", {}],
    ["80s synthwave", {}],
    ["'90s hip hop", {}],
    ["90s rock", {}],
    ["80年代", {}],
    ["八十年代", {}],
    ["1980s", {}],
    ["凌晨3:00的街道", {}],
    ["下一秒", {}],
    ["120bpm", { bpm: 120 }],
    ["速度 96", { bpm: 96 }],
    ["节拍 140", { bpm: 140 }],
    ["BPM: 100", { bpm: 100 }],
    ["tempo 88", { bpm: 88 }],
    ["3/4 拍", {}],
  ];
  for (const [text, expect] of cases) {
    const read = analyse(text);
    assert.equal(read.duration, expect.duration, `${text}: duration`);
    assert.equal(read.bpm, expect.bpm, `${text}: bpm`);
  }
  const era = analyse("80s synthwave").tokens.find(
    (token) => token.lex.cat === "era",
  );
  assert.ok(era?.lex.w?.retro, "80s is an era tag");
});

test("keys are only read when written as keys", () => {
  const cases: [string, string | undefined][] = [
    ["C大调", "C major"],
    ["c 大调", "C major"],
    ["升F小调", "F# minor"],
    ["降B大调", "Bb major"],
    ["降E大调", "Eb major"],
    ["升C小调", "C# minor"],
    ["F# minor", "F# minor"],
    ["Bb major", "Bb major"],
    ["A minor", "A minor"],
    ["E minor 忧伤", "E minor"],
    ["e minor", "E minor"],
    ["G sharp minor", "G# minor"],
    ["key of D", "D major"],
    ["key of a minor", "A minor"],
    ["D调", "D major"],
    ["a minor detail of my day", undefined],
    ["a major problem", undefined],
    ["in a minor key", undefined],
    ["江南小调", undefined],
    ["小调", undefined],
  ];
  for (const [text, key] of cases) {
    assert.equal(analyse(text).key, key, text);
    if (key) assert.ok(isKey(key), key);
  }
  // every catalog key can be requested in Chinese
  for (const [name, expected] of [
    ["降D大调", "Db major"],
    ["升F大调", "F# major"],
    ["降A大调", "Ab major"],
    ["降E小调", "Eb minor"],
    ["升G小调", "G# minor"],
    ["降B小调", "Bb minor"],
  ] as const)
    assert.equal(plan(name).config.key, expected, name);
});

test("小调 / 大调 change the key only where they are an instruction (QA probe)", () => {
  // the probe's project: the default piece, C major at 112 BPM
  const piece = (): MusicConfig => ({
    ...draft(),
    prompt: "夏日海边",
    seed: 42,
    duration: 30,
    loop: true,
  });
  const refine = (text: string) => plan(text, "refine", piece());

  // "口哨小调" is a whistled ditty: the tempo and the lead follow the words, the key stays
  const ditty = refine("轻快的口哨小调");
  assert.equal(ditty.config.key, "C major");
  assert.equal(ditty.config.bpm, 120);
  assert.equal(ditty.config.instrument, "flute");
  assert.deepEqual(ditty.reasoning, [
    "速度 112 → 120 BPM",
    "主奏乐器换成长笛",
    "口哨：用长笛音色近似",
  ]);
  assert.ok(!ditty.reasoning.some((line) => line.includes("调性")));
  const fresh = plan("轻快的口哨小调");
  assert.equal(fresh.config.mood, "bright");
  assert.equal(fresh.config.key, "C major");
  assert.equal(fresh.config.instrument, "flute");
  assert.equal(fresh.title, "轻快的口哨小调");

  // the probe's other two refinements are instructions
  assert.deepEqual(refine("来点小调的感觉").reasoning, [
    "调性 C 大调 → C 小调",
  ]);
  assert.deepEqual(refine("改成小调").reasoning, ["调性 C 大调 → C 小调"]);
  // … and its new pieces keep reading as before
  const jiangnan = plan("一首江南小调，悠扬的笛子").config;
  assert.deepEqual(
    [jiangnan.mood, jiangnan.key, jiangnan.instrument],
    ["guofeng", "D major", "dizi"],
  );
  const exact = plan("90 BPM，D 小调，一分钟，完整结尾").config;
  assert.deepEqual(
    [exact.bpm, exact.key, exact.duration, exact.loop],
    [90, "D minor", 60, false],
  );

  // an instruction: after a verb that sets something, as a clause of its own, negated, or as the colour of the piece
  const minor = [
    "小调",
    "小调吧",
    "改成小调",
    "换成小调",
    "换个小调",
    "用小调",
    "转小调",
    "转成小调",
    "变成小调",
    "改为小调",
    "调成小调",
    "调性改成小调",
    "调性：小调",
    "要小调",
    "慢一点，小调",
    "90 BPM，小调",
    "欢快但是小调",
    "来点小调的感觉",
    "带点小调色彩",
    "小调的感觉",
    "不要大调",
    "in a minor key",
    "in minor",
  ];
  for (const text of minor)
    assert.equal(refine(text).config.key, "C minor", text);
  const dark = (): MusicConfig => ({ ...piece(), key: "A minor" });
  for (const text of [
    "大调",
    "改成大调",
    "换成大调",
    "用大调",
    "转大调",
    "变成大调",
    "悲伤但是大调",
    "不要小调",
    "来点大调的感觉",
    "major key",
  ])
    assert.equal(plan(text, "refine", dark()).config.key, "A major", text);

  // a noun: a ditty, a folk tune, or part of another word. The key is not touched.
  const ditties = [
    "轻快的口哨小调",
    "一首欢快的小调",
    "来首小调",
    "来一段民间小调",
    "明亮的小调",
    "吉他小调",
    "山间小调",
    "哼一支小调",
    "口哨小调的感觉",
    "用口哨小调",
    "做个大调整",
    "要大调整一下",
    "小调整一下",
    "可爱的小调皮",
  ];
  for (const text of ditties) {
    const refined = refine(text);
    // "民间小调" is a folk tune: the style may change (and bring its own major key), the mode does not
    if (refined.config.mood === "bright")
      assert.equal(refined.config.key, "C major", text);
    assert.equal(parseKey(refined.config.key).minor, false, text);
    assert.ok(!refined.reasoning.some((line) => /→ .*小调/.test(line)), text);
    assert.equal(parseKey(plan(text).config.key).minor, false, `new: ${text}`);
  }
  assert.equal(refine("来一段民间小调").config.mood, "guofeng");
  // nothing else in these was an instruction either
  for (const text of ["做个大调整", "小调整一下"])
    assert.equal(refine(text).unchanged, true, text);
  assert.equal(plan("可爱的小调皮").config.mood, "cute");
  // a sad ditty is still in a minor key, because it is sad
  assert.equal(parseKey(plan("忧伤的小调").config.key).minor, true);
  // a key with its tonic is always a key
  assert.equal(refine("轻快的口哨，A 小调").config.key, "A minor");
  assert.equal(refine("口哨小调，D小调").config.key, "D minor");
});

test("all 14 instruments can be asked for, with synonyms", () => {
  // prettier-ignore
  const cases: [string, InstrumentId][] = [
    ["钢琴", "piano"], ["电钢", "epiano"], ["罗兹", "epiano"], ["吉他", "guitar"], ["木吉他", "guitar"],
    ["尤克里里", "guitar"], ["合成器", "synth"], ["电子音色", "synth"], ["拨弦", "pluck"], ["钟琴", "bell"],
    ["铃", "bell"], ["钢片琴", "bell"], ["风铃", "bell"], ["八音盒", "musicbox"], ["音乐盒", "musicbox"],
    ["马林巴", "marimba"], ["木琴", "marimba"], ["颤音琴", "vibes"], ["长笛", "flute"], ["弦乐", "strings"],
    ["小提琴", "strings"], ["大提琴", "strings"], ["管弦", "strings"], ["古筝", "guzheng"], ["琵琶", "guzheng"],
    ["笛子", "dizi"], ["竹笛", "dizi"], ["箫", "dizi"], ["8-bit", "chip"], ["方波", "chip"], ["芯片", "chip"],
    ["piano", "piano"], ["rhodes", "epiano"], ["ukulele", "guitar"], ["synth", "synth"], ["music box", "musicbox"],
    ["marimba", "marimba"], ["vibraphone", "vibes"], ["flute", "flute"], ["violin", "strings"], ["guzheng", "guzheng"],
  ];
  for (const [word, instrument] of cases) {
    assert.equal(
      plan(`换成${word}`, "refine", {
        ...draft(),
        instrument: instrument === "piano" ? "bell" : "piano",
      }).config.instrument,
      instrument,
      word,
    );
    assert.equal(plan(word).config.instrument, instrument, `new: ${word}`);
  }
  // "synthwave" is a genre, not the synth lead; "good vibes" is not a vibraphone
  assert.equal(plan("good vibes", "refine").config.instrument, "bell");
});

/* ====================================================================== *
 * The v0.3 review (AGENT-01 … AGENT-14, UX-03, UX-05, LEFT-05): every
 * reviewed prompt whose outcome is unambiguous.
 * ====================================================================== */

/** The piece most of the reviewer's refinements start from: 112 BPM, C major, piano, 30 s, loop. */
const bright = (patch: Partial<MusicConfig> = {}): MusicConfig => ({
  ...draft(),
  ...stylePreset("bright"),
  prompt: "晴天散步",
  seed: 111,
  ...patch,
});

type Move = number | "up" | "down";
type Fader = Move | "off";
/** What a refinement must do; everything not named must stay exactly as it was. */
interface Want {
  bpm?: Move;
  dur?: Move;
  energy?: Move;
  complexity?: Move;
  reverb?: Move;
  key?: string;
  lead?: InstrumentId;
  /** a style change brings its own tempo, key, lead and sliders */
  style?: StyleId;
  loop?: boolean;
  melody?: Fader;
  chords?: Fader;
  bass?: Fader;
  drums?: Fader;
  /** a new melody is asked for */
  seed?: true;
  arr?: (hints: NonNullable<MusicConfig["arrangement"]>) => boolean;
  /** nothing may change */
  same?: true;
  says?: RegExp;
  from?: MusicConfig;
}

const MELODY_LINES = {
  identical: "旋律保持不变。",
  adapted: "旋律动机不变，会按新的设置重新演绎。",
  new: "这是一段新的旋律。",
} as const;

/** Reply and chips say exactly what describeChanges finds between the two configurations. */
function honest(before: MusicConfig, result: AgentPlan): string[] {
  const out: string[] = [];
  const changes = describeChanges(before, result.config);
  if (result.unchanged !== (changes.length === 0))
    out.push("unchanged flag is wrong");
  if (changes.length) {
    const head =
      `好的：${changes.slice(0, 3).join("，")}${changes.length > 3 ? " 等" : ""}。` +
      (result.config.seed === before.seed
        ? MELODY_LINES[melodyContinuity(before, result.config)]
        : "");
    if (!result.reply.startsWith(head))
      out.push(`reply “${result.reply}” does not start with “${head}”`);
  } else if (!/保持不变/.test(result.reply))
    out.push(`no-op reply “${result.reply}”`);
  if (changes.slice(0, 8).some((line) => !result.reasoning.includes(line)))
    out.push(
      `a change is missing from the chips: ${result.reasoning.join("｜")}`,
    );
  const claims = result.reasoning.filter((line) =>
    /→|^(?:关闭|风格改为|主奏乐器换成|改为|加入|去掉|换一组)/.test(line),
  );
  if (claims.some((line) => !changes.includes(line)))
    out.push(
      `a chip claims a change that did not happen: ${claims.join("｜")}`,
    );
  // the interface's own terms, no emoji, no internal marker
  if (
    /[\u{1F300}-\u{1FAFF}]|(?<!情绪)能量 \d|复杂度 \d|主旋律音量|低音音量|\u0001/u.test(
      result.reply + result.reasoning.join(""),
    )
  )
    out.push(`not in the interface's terms: ${result.reply}`);
  return out;
}

function refineProblems(text: string, want: Want): string[] {
  const before = structuredClone(want.from ?? bright());
  const result = plan(text, "refine", structuredClone(before));
  const c = result.config;
  const out: string[] = [];
  const restyled = want.style !== undefined;
  const moved = (
    name: string,
    was: number,
    now: number,
    move: Fader | undefined,
    fader = false,
  ) => {
    if (move === undefined) {
      if (now !== was) out.push(`${name} ${was} → ${now}, nobody asked`);
    } else if (move === "off") {
      if (now !== 0) out.push(`${name} not off (${now})`);
    } else if (
      move === "up"
        ? !(now > was)
        : move === "down"
          ? !(now < was && (!fader || now > 0))
          : Math.abs(now - move) > 1e-9
    )
      out.push(`${name} ${was} → ${now}, wanted ${move}`);
  };
  if (c.mood !== (want.style ?? before.mood)) out.push(`style ${c.mood}`);
  for (const [name, field] of [
    ["bpm", "bpm"],
    ["dur", "duration"],
    ["energy", "energy"],
    ["complexity", "complexity"],
    ["reverb", "reverb"],
  ] as const) {
    if (restyled && name !== "dur" && want[name] === undefined) continue;
    moved(name, before[field], c[field], want[name]);
  }
  if ((!restyled || want.key) && c.key !== (want.key ?? before.key))
    out.push(`key ${c.key}`);
  if (
    (!restyled || want.lead) &&
    c.instrument !== (want.lead ?? before.instrument)
  )
    out.push(`lead ${c.instrument}`);
  if (c.loop !== (want.loop ?? before.loop)) out.push(`loop ${c.loop}`);
  for (const track of ["melody", "chords", "bass", "drums"] as const)
    moved(track, before.volumes[track], c.volumes[track], want[track], true);
  if ((c.seed !== before.seed) !== !!want.seed)
    out.push(
      c.seed !== before.seed ? "the melody was re-rolled" : "no new melody",
    );
  const hints = JSON.stringify(c.arrangement ?? {});
  if (
    want.arr
      ? !want.arr(c.arrangement ?? {})
      : !restyled && hints !== JSON.stringify(before.arrangement ?? {})
  )
    out.push(`arrangement ${hints}`);
  if (!!want.same !== result.unchanged)
    out.push(
      want.same ? "should change nothing" : `nothing changed: ${result.reply}`,
    );
  if (
    want.says &&
    !want.says.test([result.reply, ...result.reasoning].join("\n"))
  )
    out.push(`nothing says ${want.says}: ${result.reply}`);
  out.push(...honest(before, result));
  assert.deepEqual(
    before,
    want.from ?? bright(),
    `${text}: the request was mutated`,
  );
  return out;
}

const mutedDrums = () => bright({ volumes: { ...DEFAULT_VOLUMES, drums: 0 } });
const jazzy = (): MusicConfig => ({ ...bright(), ...stylePreset("jazz") });
const tense = (): MusicConfig => ({ ...bright(), ...stylePreset("tension") });

// prettier-ignore
const REVIEW_REFINE: [string, Want][] = [
  /* AGENT-01: a relative tempo is a change, "到" makes it a target */
  ["快 10 bpm", { bpm: 122 }],
  ["慢 5 bpm", { bpm: 107 }],
  ["加快 20bpm", { bpm: 132 }],
  ["提高 15 BPM", { bpm: 127 }],
  ["降 10bpm", { bpm: 102 }],
  ["faster by 10 bpm", { bpm: 122 }],
  ["slow it down by 8 bpm", { bpm: 104 }],
  ["+10 bpm", { bpm: 122 }],
  ["bpm 减 10", { bpm: 102 }],
  ["bpm 加 8", { bpm: 120 }],
  ["再快10个bpm", { bpm: 122 }],
  ["快十个bpm", { bpm: 122 }],
  ["提速到 130", { bpm: 130 }],
  ["加快到 140", { bpm: 140 }],
  ["放慢到 80", { bpm: 80 }],
  ["快到 150", { bpm: 150 }],
  ["速度降到90", { bpm: 90 }],
  ["调到 100 拍", { bpm: 100 }],
  ["120拍", { bpm: 120 }],
  ["把速度调到每分钟 96 拍", { bpm: 96 }],
  ["降速 20%", { bpm: 90 }],
  ["速度减半", { bpm: 56 }],
  ["速度翻倍", { bpm: 200, says: /速度范围是 50–200 BPM/ }],
  ["把钢琴换成吉他，把鼓去掉，速度降到90，再加一点混响", { lead: "guitar", drums: "off", bpm: 90, reverb: "up" }],
  ["慢一点，换成古筝，不要鼓", { bpm: 100, lead: "guzheng", drums: "off" }],
  ["降到 90", { same: true, says: /速度 90.*时长 90 秒/ }],
  ["快 10 bpm", { from: bright({ bpm: 195 }), bpm: 200, says: /速度范围/ }],
  ["太快了", { bpm: 100 }],
  ["有点快", { bpm: 100 }],
  ["太慢了", { bpm: 124 }],
  ["有点慢了", { bpm: 124 }],
  ["节奏太快", { bpm: 100 }],
  ["太快了，慢一点", { bpm: 100 }],
  ["太慢，快点", { bpm: 124 }],
  ["没那么快", { bpm: 100 }],
  ["不要这么快", { bpm: 100 }],
  ["别这么慢", { bpm: 124 }],
  ["再快一点点", { bpm: 118 }],
  ["稍微慢一丢丢", { bpm: 106 }],
  ["慢很多", { bpm: 91 }],
  ["快得多", { bpm: 133 }],
  ["只要节奏快一点就行", { bpm: 124 }],

  /* AGENT-02: a length, a change of length, or a point in time */
  ["加长 15 秒", { dur: 45 }],
  ["再加 10 秒", { dur: 40 }],
  ["多 20 秒", { dur: 50 }],
  ["缩短 10 秒", { dur: 20 }],
  ["少 5 秒", { dur: 25 }],
  ["延长 30 秒", { dur: 60 }],
  ["加长半分钟", { dur: 60 }],
  ["make it 20 seconds longer", { dur: 50 }],
  ["10 seconds shorter", { dur: 20 }],
  ["extend by 30s", { dur: 60 }],
  ["时长改成 45 秒", { dur: 45 }],
  ["延长到一分钟", { dur: 60 }],
  ["再长一倍", { dur: 60 }],
  ["缩短一半", { dur: 15 }],
  ["改成 2 分钟，不循环", { dur: 120, loop: false }],
  ["加长 100 秒", { dur: 120, says: /时长范围是 15–120 秒/ }],
  ["长一点", { dur: 45 }],
  ["再短一点", { dur: 15 }],
  ["我要发抖音，再短一点", { dur: 15 }],
  ["第 20 秒那里鼓太吵了", { drums: "down", says: /不能按时间点修改，已按整首处理/ }],
  ["0:45 的地方加点弦乐", { arr: (h) => h.layers?.pad === true, says: /时间点/ }],
  ["最后 10 秒渐弱", { loop: false }],
  ["结尾淡出 5 秒", { loop: false }],
  ["前 8 秒只要钢琴", { same: true, says: /不能只修改某个时间点/ }],
  ["副歌在 20 秒的时候进", { same: true, says: /时间点/ }],
  ["开头 15 秒太空了", { same: true, says: /时间点/ }],

  /* AGENT-03: a complaint asks for the opposite */
  ["太短了", { dur: 45 }],
  ["有点短", { dur: 45 }],
  ["时间太短", { dur: 45 }],
  ["好听，但是太短了", { dur: 45 }],
  ["太长了", { dur: 15 }],
  ["有点长", { dur: 15 }],
  ["太长了，缩短一点", { dur: 15 }],
  ["too short", { dur: 45 }],
  ["it's too long", { dur: 15 }],
  ["太短了", { from: bright({ duration: 120 }), same: true, says: /已经是最长的 120 秒/ }],

  /* AGENT-04: what the music is for, and what it sounds too much like, never restyles */
  ["这是给我家猫的视频配的，鼓小一点", { drums: "down" }],
  ["视频是讲咖啡的，所以再慢一点", { bpm: 100 }],
  ["用在健身视频里，再快一点", { bpm: 124 }],
  ["鼓轻一点，这是婚礼上用的", { drums: "down" }],
  ["游戏里用的，要能循环", { same: true, says: /已经是循环片段/ }],
  ["是给小朋友听的，别太吵", { energy: "down" }],
  ["太像恐怖片了", { same: true, says: /青春欢快/ }],
  ["听着像恐怖片，我不想要这种感觉", { same: true }],
  ["有点太像儿歌了", { energy: "down" }],
  ["别像儿歌", { energy: "down" }],
  ["太吵了，像夜店", { energy: "down" }],
  ["客户说太像广告了，改得自然点", { same: true }],
  ["老板说不要像游戏音乐", { same: true }],
  ["别搞得跟恐怖片似的", { same: true }],
  ["不要像恐怖片", { same: true }],
  ["有点像婚礼音乐，不要这样", { energy: "up" }],
  ["太电子了", { same: true, says: /没有找到可以单独去掉的「电子」元素/ }],
  ["不要电子味", { same: true }],
  ["去掉国风元素", { same: true }],
  ["少点爵士味", { complexity: "down", says: /保持「青春欢快」风格，减少「爵士」的味道/ }],
  ["把爵士味去掉", { complexity: "down" }],
  ["太爵士了", { complexity: "down" }],
  ["这首爵士味太重了", { complexity: "down" }],
  ["少点爵士味", { from: jazzy(), complexity: "down", arr: (h) => h.swing === 0, says: /还是「爵士小馆」风格/ }],
  ["太像恐怖片了", { from: tense(), key: "E major", says: /还是「悬疑紧张」风格/ }],
  ["去掉国风元素", { from: bright({ instrument: "guzheng" }), lead: "piano" }],
  ["鼓换成电子鼓", { same: true, says: /鼓组的音色跟随风格/ }],
  // … while an instruction to change the style still does
  ["改成国风", { style: "guofeng" }],
  ["风格换成摇滚", { style: "rock" }],
  ["换一种风格，爵士", { style: "jazz" }],
  ["做成恐怖片的感觉", { style: "tension" }],
  ["让它听起来像深夜咖啡馆", { style: "chill" }],
  ["摇滚", { style: "rock" }],
  ["摇滚，慢一点", { style: "rock", bpm: styleInfo("rock").bpm - 12 }],
  ["换成爵士风格", { style: "jazz" }],
  ["雨天咖啡馆", { style: "chill" }],
  ["换个风格", { same: true, says: /想换成什么风格/ }],
  // … and a flavour borrows a colour
  ["来点国风元素", { lead: "guzheng", says: /保持「青春欢快」的底子/ }],
  ["加一点点电子味", { lead: "synth" }],
  ["更电子一点", { lead: "synth" }],
  ["更爵士一点", { lead: "vibes", arr: (h) => (h.swing ?? 0) > 0 }],
  ["不够国风", { lead: "guzheng" }],
  ["没有摇滚的感觉了，加点吉他", { lead: "guitar" }],

  /* AGENT-05: the inspector's own words, in both directions */
  ["旋律丰富度低一点", { complexity: "down" }],
  ["降低旋律丰富度", { complexity: "down" }],
  ["旋律丰富度调低", { complexity: "down" }],
  ["丰富度太高了", { complexity: "down" }],
  ["丰富度降低", { complexity: "down" }],
  ["减少丰富度", { complexity: "down" }],
  ["层次少一点", { complexity: "down" }],
  ["细节少一些", { complexity: "down" }],
  ["变化少一点", { complexity: "down" }],
  ["不要那么丰富", { complexity: "down" }],
  ["不要这么复杂", { complexity: "down" }],
  ["别那么花哨", { complexity: "down" }],
  ["起伏小一点", { complexity: "down" }],
  ["旋律丰富度高一点", { complexity: "up" }],
  ["太平了，加点起伏", { complexity: "up" }],
  ["情绪能量调低", { energy: "down" }],
  ["降低情绪能量", { energy: "down" }],
  ["情绪能量太高了", { energy: "down" }],
  ["情绪能量低一点", { energy: "down" }],
  ["活力少一点", { energy: "down" }],
  ["力量感弱一点", { energy: "down" }],
  ["不要那么有活力", { energy: "down" }],
  ["别太燃", { energy: "down" }],
  ["没那么激烈", { energy: "down" }],
  ["太刺耳了，柔和一点", { energy: "down" }],
  ["情绪再饱满一些", { energy: "up" }],
  ["不够燃", { energy: "up" }],
  ["还是不够欢快", { energy: "up" }],
  ["太闷了", { energy: "up" }],
  ["空间混响调小", { reverb: "down" }],
  ["减少空间混响", { reverb: "down" }],
  ["空间混响太大了", { reverb: "down" }],
  ["少点空间感", { reverb: "down" }],
  ["空间混响大一些", { reverb: "up" }],
  ["空间感再多一点", { reverb: "up" }],
  ["能量降到 30%", { energy: 0.3 }],
  ["能量 80%", { energy: 0.8 }],
  ["情绪能量调到百分之四十", { energy: 0.4 }],
  ["复杂度调到 0.3", { complexity: 0.3 }],
  ["混响加 20%", { reverb: 0.45 }],
  ["混响 20%", { reverb: 0.2 }],
  ["混响恢复", { from: bright({ reverb: 0.7 }), reverb: 0.25 }],

  /* AGENT-06: negation, double negation, "要 / 有" */
  ["别把鼓去掉", { same: true, says: /鼓组会保留/ }],
  ["不要去掉鼓", { same: true, says: /鼓组会保留/ }],
  ["不要没有鼓", { same: true, says: /鼓组会保留/ }],
  ["别把鼓去掉", { from: mutedDrums(), drums: DEFAULT_VOLUMES.drums }],
  ["鼓不要去掉，只是小一点", { drums: "down" }],
  ["不是不要鼓，是鼓小一点", { drums: "down" }],
  ["不要鼓，要贝斯", { drums: "off" }],
  ["鼓不要太大", { drums: "down" }],
  ["要鼓", { from: mutedDrums(), drums: DEFAULT_VOLUMES.drums }],
  ["有鼓", { from: mutedDrums(), drums: DEFAULT_VOLUMES.drums }],
  ["取消静音", { from: mutedDrums(), drums: DEFAULT_VOLUMES.drums }],
  ["把鼓加回来", { from: mutedDrums(), drums: DEFAULT_VOLUMES.drums }],
  ["全部恢复", { from: bright({ volumes: { melody: 0.8, chords: 0, bass: 0, drums: 0 } }), chords: 0.64, bass: 0.68, drums: 0.56 }],
  ["不要悲伤", { energy: "up" }],
  ["别这么可爱", { energy: "down" }],
  ["用弦乐代替钢琴", { lead: "strings" }],

  /* the mixer: amounts, complaints, lists */
  ["鼓加大 20%", { drums: 0.76 }],
  ["鼓减小 10%", { drums: 0.46 }],
  ["贝斯降低 30%", { bass: 0.38 }],
  ["旋律音量调到 50%", { melody: 0.5 }],
  ["鼓的音量 30%", { drums: 0.3 }],
  ["把鼓调到 80", { drums: 0.8 }],
  ["贝斯拉满", { bass: 1 }],
  ["贝斯小一半", { bass: 0.34 }],
  ["把鼓调成原来的一半", { drums: 0.28 }],
  ["鼓 0%", { drums: "off" }],
  ["鼓 100%", { drums: 1 }],
  ["鼓 150%", { drums: 1, says: /音量最大是 100%/ }],
  ["鼓和贝斯各 40%", { drums: 0.4, bass: 0.4 }],
  ["鼓声太大了", { drums: "down" }],
  ["鼓太轻了，听不见", { drums: "up" }],
  ["贝斯有点闷", { bass: "up" }],
  ["低音太重", { bass: "down" }],
  ["低频太多了", { bass: "down" }],
  ["旋律不够突出", { melody: "up" }],
  ["钢琴声音再大一点", { melody: "up" }],
  ["伴奏小声一点，旋律大声一点", { chords: "down", melody: "up" }],
  ["鼓和贝斯都小一点", { drums: "down", bass: "down" }],
  ["除了鼓其他都小一点", { melody: "down", chords: "down", bass: "down" }],
  ["鼓别那么抢戏", { drums: "down" }],
  ["让钢琴更靠前", { melody: "up" }],
  ["贝斯往后放", { bass: "down" }],
  ["重新调一下鼓的音量，小一点", { drums: "down" }],
  ["音量调到 50%", { same: true, says: /整体音量请用播放器的音量滑块/ }],
  ["整体音量大一点", { same: true, says: /整体音量/ }],
  ["所有声部都大一点", { same: true, says: /整体音量/ }],
  ["人声大一点", { same: true, says: /只制作纯音乐/ }],
  ["钢琴太亮了", { energy: "down" }],
  ["和声太满了", { complexity: "down", says: /和声的疏密跟着「旋律丰富度」走/ }],

  /* the key */
  ["升一个调", { key: "D major" }],
  ["降半音", { key: "B major" }],
  ["升高两个半音", { key: "D major" }],
  ["移到 G 大调", { key: "G major" }],
  ["转成小调", { key: "C minor" }],
  ["换成关系小调", { key: "A minor" }],
  ["调子低一点", { key: "Bb major" }],
  ["音调高一些", { key: "D major" }],
  ["改成大调", { same: true, says: /调性已经是 C 大调/ }],
  ["换个调", { same: true, says: /想换成哪个调/ }],
  ["听起来太悲伤了", { from: bright({ key: "A minor" }), key: "A major", energy: "up" }],

  /* AGENT-12: the melody is re-rolled only when a new one is asked for */
  ["one more thing, louder drums", { drums: "up" }],
  ["try again with less reverb", { reverb: "down" }],
  ["add some variation to the drums", { same: true }],
  ["再做一个慢一点的版本", { bpm: 100 }],
  ["这版不错，再来一个更欢快的", { energy: "up" }],
  ["再来一遍，但是慢一点", { bpm: 100 }],
  ["换一个更悲伤的版本", { key: "C minor", energy: "down" }],
  ["我不喜欢这个旋律", { seed: true }],
  ["旋律不好听，换一个", { seed: true }],
  ["换个旋律，慢一点", { seed: true, bpm: 100 }],
  ["try again", { seed: true }],
  ["one more take", { seed: true }],

  /* the lead and the melody's shape */
  ["换个乐器", { lead: "guitar" }],
  ["去掉钢琴", { lead: "guitar" }],
  ["不要钢琴，用别的", { lead: "guitar" }],
  ["钢琴换成别的乐器", { lead: "guitar" }],
  ["主旋律换成笛子，伴奏用吉他", { lead: "dizi" }],
  ["古筝换成钢琴", { same: true, says: /主奏乐器已经是柔和钢琴/ }],
  ["旋律太高了", { arr: (h) => h.melody?.register === "low" }],
  ["旋律低八度", { arr: (h) => h.melody?.register === "low" }],
  ["把旋律移高一个八度", { arr: (h) => h.melody?.register === "high" }],
  ["旋律密一点", { arr: (h) => (h.melody?.density ?? 0) > 0.5 }],
  ["旋律稀疏一点", { arr: (h) => (h.melody?.density ?? 1) < 0.5 }],
  ["加一个小提琴", { arr: (h) => h.layers?.pad === true }],
  ["重新把鼓加回来", { same: true, says: /鼓组本来就是打开的/ }],

  /* AGENT-11: nothing to do is said as such */
  ["不要鼓", { from: mutedDrums(), same: true, says: /鼓组已经是关闭的/ }],
  ["mute drums", { from: mutedDrums(), same: true, says: /鼓组已经是关闭的/ }],
  ["更有活力", { from: bright({ energy: 1 }), same: true, says: /情绪能量已经是最高的 100%/ }],
  ["安静一点", { from: bright({ energy: 0 }), same: true, says: /情绪能量已经是最低的 0%/ }],
  ["快一点", { from: bright({ bpm: 200 }), same: true, says: /速度已经是最快的 200 BPM/ }],
  ["慢一点", { from: bright({ bpm: 50 }), same: true, says: /速度已经是最慢的 50 BPM/ }],
  ["混响 25%", { same: true, says: /空间混响已经是 25%/ }],
  ["鼓 56%", { same: true, says: /鼓组音量已经是 56%/ }],
  ["恢复默认音量", { same: true, says: /各声部的音量已经是默认值/ }],
  ["不好听", { same: true, says: /抱歉这一版没让你满意/ }],
  ["难听死了", { same: true, says: /抱歉这一版没让你满意/ }],
  ["没有刚才那版好听", { same: true, says: /抱歉这一版没让你满意/ }],
  ["撤销", { same: true, says: /不能撤销上一步/ }],
  ["回到上一版", { same: true, says: /我的作品/ }],
];

test("the review's refinements: enough of them, none twice", () => {
  assert.ok(
    REVIEW_REFINE.length >= 230,
    `refine cases: ${REVIEW_REFINE.length}`,
  );
  const keys = REVIEW_REFINE.map(
    ([text, want]) => `${text}|${JSON.stringify(want.from ?? null)}`,
  );
  assert.equal(new Set(keys).size, keys.length, "duplicate case");
});

test("refinements from the review do what was asked, nothing else, and say exactly that", () => {
  const failures: string[] = [];
  for (const [text, want] of REVIEW_REFINE) {
    const problems = refineProblems(text, want);
    if (problems.length)
      failures.push(`${JSON.stringify(text)}: ${problems.join("; ")}`);
  }
  assert.deepEqual(failures, []);
});

test("every inspector label moves its own slider the way the word says (AGENT-05)", () => {
  const labels = {
    情绪能量: "energy",
    旋律丰富度: "complexity",
    空间混响: "reverb",
    速度: "bpm",
  } as const;
  const ups = [
    "高一点",
    "大一点",
    "调高",
    "再高一些",
    "多一点",
    "提高一点",
    "太低了",
    "不够高",
    "有点低",
  ];
  const downs = [
    "低一点",
    "小一点",
    "调低",
    "再低一些",
    "少一点",
    "降低一点",
    "太高了",
    "有点高",
    "别这么高",
  ];
  for (const [label, field] of Object.entries(labels) as [
    string,
    "energy" | "complexity" | "reverb" | "bpm",
  ][])
    for (const [words, want] of [
      [ups, "up"],
      [downs, "down"],
    ] as const)
      for (const word of words)
        for (const text of [`${label}${word}`, `把${label}${word}`]) {
          const problems = refineProblems(text, { [field]: want });
          assert.deepEqual(problems, [], text);
        }
  // the mixer's four names: louder, quieter, off, back
  const tracks = {
    旋律: "melody",
    和声: "chords",
    贝斯: "bass",
    鼓组: "drums",
  } as const;
  for (const [label, track] of Object.entries(tracks) as [
    string,
    TrackName,
  ][]) {
    for (const word of ["大一点", "再响一些", "太小了", "不够突出", "加大 10%"])
      assert.deepEqual(
        refineProblems(`${label}${word}`, { [track]: "up" }),
        [],
        `${label}${word}`,
      );
    for (const word of [
      "小一点",
      "轻一些",
      "太大了",
      "有点吵",
      "减小 10%",
      "别那么抢戏",
    ])
      assert.deepEqual(
        refineProblems(`${label}${word}`, { [track]: "down" }),
        [],
        `${label}${word}`,
      );
    assert.deepEqual(refineProblems(`不要${label}`, { [track]: "off" }), []);
    assert.deepEqual(refineProblems(`别把${label}去掉`, { same: true }), []);
    const muted = bright({ volumes: { ...DEFAULT_VOLUMES, [track]: 0 } });
    for (const text of [
      `要${label}`,
      `把${label}加回来`,
      `恢复${label}`,
      `别去掉${label}`,
    ])
      assert.deepEqual(
        refineProblems(text, { from: muted, [track]: DEFAULT_VOLUMES[track] }),
        [],
        text,
      );
  }
});

test("what the music is for is heard as context, and a style's own name as that style (AGENT-04)", () => {
  // context: nothing is restyled, and the reply says how to ask for the style
  for (const [text, word, label] of [
    ["适合咖啡馆", "咖啡馆", "慵懒松弛"],
    ["更适合婚礼", "婚礼", "浪漫温馨"],
    ["用于企业宣传片", "企业", "科技商务"],
    ["这是婚礼上用的", "婚礼", "浪漫温馨"],
  ]) {
    const result = plan(text, "refine", bright());
    assert.deepEqual(result.config, bright(), text);
    assert.equal(result.unchanged, true, text);
    assert.equal(
      result.reply,
      `听到了「${word}」，这次没有把它当成换风格的要求；想换可以说「改成${label}风格」。作品保持不变。`,
      text,
    );
    // … and saying exactly that does it
    assert.equal(
      plan(`改成${label}风格`, "refine", bright()).config.mood,
      plan(label, "new").config.mood,
      label,
    );
  }
  const already = plan("适合咖啡馆", "refine", {
    ...bright(),
    ...stylePreset("chill"),
  });
  assert.equal(
    already.reply,
    "这首已经是适合「咖啡馆」的「慵懒松弛」风格。作品保持不变。",
  );
  // with an instruction beside it, the context is simply not acted on
  assert.deepEqual(refineProblems("鼓轻一点，适合学习", { drums: "down" }), []);
  assert.deepEqual(
    refineProblems("for a wedding video, softer drums", { drums: "down" }),
    [],
  );

  // every style can be asked for by the name the interface shows, in a new piece and in a refinement
  for (const style of STYLES) {
    const from = bright(style.id === "bright" ? stylePreset("sad") : {});
    for (const text of [
      `改成${style.label}风格`,
      `换成「${style.label}」`,
      style.label,
      `${style.label}风格`,
      `改成${style.label}`,
    ]) {
      const refined = plan(text, "refine", from);
      assert.equal(refined.config.mood, style.id, `refine: ${text}`);
      assert.equal(refined.config.seed, from.seed, text);
      assert.deepEqual(honest(from, refined), [], text);
      assert.match(refined.reply, /这是一段新的旋律。/, text);
    }
    assert.equal(
      plan(style.label).config.mood,
      style.id,
      `new: ${style.label}`,
    );
    assert.equal(
      plan(`${style.label}风格`).config.mood,
      style.id,
      `new: ${style.label}风格`,
    );
  }
});

/* ---------- new pieces from the review ---------- */

// prettier-ignore
const REVIEW_NEW: [string, Expect][] = [
  /* AGENT-06: what is negated is not what is wanted */
  ["不悲伤的钢琴曲，温暖一些", { notStyle: ["sad"], instrument: "piano", minor: false }],
  ["不是悲伤的那种，是温暖的", { notStyle: ["sad"], minor: false }],
  ["并非悲伤，而是平静", { notStyle: ["sad"], minor: false }],
  ["温暖而不是悲伤", { notStyle: ["sad"], minor: false }],
  ["千万别是那种悲伤的调调", { notStyle: ["sad"] }],
  ["不要悲伤的，要开心的", { style: "bright", minor: false }],
  ["not sad, just calm piano", { notStyle: ["sad"], instrument: "piano" }],
  ["不恐怖的万圣节音乐，可爱一点", { style: "cute" }],
  ["something that isn't scary, for kids", { style: "cute" }],
  ["I don't want jazz, give me something electronic", { style: ["retro", "dance"] }],
  ["no jazz please, rock instead", { style: "rock" }],
  ["我不喜欢电音，来点摇滚", { style: "rock" }],
  ["不要国风，要西方古典", { style: "cinematic" }],
  ["calm, not epic", { notStyle: ["epic"], energy: [0, 0.4] }],
  ["安静而非激烈", { energy: [0, 0.4] }],
  ["不吵的咖啡馆音乐", { style: "chill", energy: [0.2, 0.4] }],
  ["欢快但不幼稚", { style: "bright" }],
  ["讨厌钢琴，换别的", { notInstrument: "piano" }],
  ["除了钢琴都可以", { notInstrument: "piano" }],
  ["钢琴曲，不要钢琴", { notInstrument: "piano" }],
  ["摇滚，不要吉他", { style: "rock", notInstrument: "guitar" }],
  ["爵士但不要颤音琴", { style: "jazz", notInstrument: "vibes" }],
  ["史诗感，但主奏用钢琴，不要弦乐", { style: "epic", instrument: "piano" }],
  ["国风但是用钢琴", { style: "guofeng", instrument: "piano" }],
  ["没有鼓，没有贝斯，只有钢琴和弦乐", { instrument: "piano", drums: "off", bass: "off" }],
  ["瑜伽课放松冥想音乐，2分钟，不要鼓不要贝斯", { style: "ambient", duration: 120, drums: "off", bass: "off" }],
  ["不要人声，纯音乐，适合读书", { style: "focus", check: (_c, p) => assert.ok(!/只制作纯音乐/.test(p.reply + p.reasoning.join()), "nothing was refused") }],

  /* AGENT-08: a hedged second mood colours the piece, it does not choose the style */
  ["欢快，带一点点忧伤", { style: "bright", minor: false, says: /以「青春欢快」为主，「忧伤」只作点缀/ }],
  ["主要是欢快的，略带伤感", { style: "bright", minor: false }],
  ["欢快中带点忧伤", { style: "bright", minor: false }],
  ["我想要快乐的音乐！！！但是又有点点伤感？？", { style: "bright", minor: false }],
  ["紧张刺激又带点搞笑", { style: ["tension", "battle"] }],
  ["悲伤，带一点希望", { style: "sad", minor: true }],
  ["爵士，带点电子味", { style: "jazz" }],

  /* AGENT-09: an ending is an ending; a section word in a description is no edit */
  ["要有结尾的钢琴曲", { loop: false, instrument: "piano" }],
  ["需要一个结尾", { loop: false }],
  ["有明确的结尾", { loop: false }],
  ["结尾要自然", { loop: false }],
  ["要有个完整的结尾，不要循环播放", { loop: false }],
  ["一分钟的片尾音乐，要有结尾", { loop: false, duration: 60 }],
  ["视频配乐，最后要收住", { loop: false }],
  ["不需要循环", { loop: false }],
  ["不用循环", { loop: false }],
  ["循环，不要循环", { loop: false }],
  ["可以循环吗", { loop: true }],
  ["能循环播放的", { loop: true }],
  ["老师您好，我是初中音乐老师，下周公开课讲《茉莉花》，想要一段导入用的国风小曲，笛子主奏，60秒，要有结尾，速度适中，不要电子音色。", { style: "guofeng", instrument: "dizi", duration: 60, loop: false }],
  ["Podcast intro, 12 seconds, warm and confident, no drums", { duration: 15, drums: "off", says: /时长范围/ }],
  ["High-energy EDM drop for a gaming montage, 128 BPM, 30 seconds", { style: "dance", bpm: 128, duration: 30 }],
  ["史诗级预告片音乐，前面安静后面爆发，60秒", { style: "epic", duration: 60, energy: [0.7, 1] }],

  /* AGENT-01 / 02 in a description */
  ["120拍的电子舞曲", { style: "dance", bpm: 120 }],
  ["每分钟90拍的嘻哈", { style: "hiphop", bpm: 90 }],
  ["速度一百二的摇滚", { style: "rock", bpm: 120 }],
  ["bpm=95 lofi", { style: "chill", bpm: 95 }],
  ["BPM: 174 drum and bass", { style: "dance", bpm: 174 }],
  ["高燃踩点，卡点剪辑用，BPM128", { style: "dance", bpm: 128 }],
  ["Boss 战第二阶段，更快更狠，160BPM 以上", { style: "battle", bpm: 160 }],
  ["健身房 HIIT 训练用，180bpm，越炸越好", { style: "dance", bpm: 180 }],
  ["60 bpm 左右的钢琴，时长 1:30", { bpm: 60, duration: 90, instrument: "piano" }],
  ["4/4拍，100bpm，G大调，吉他，60秒，循环", { bpm: 100, key: "G major", instrument: "guitar", duration: 60, loop: true }],
  ["一分钟左右，不超过 70 秒", { duration: 60 }],
  ["两分钟左右，不超过 90 秒", { duration: 90 }],
  ["30 秒到 1 分钟之间的轻音乐", { duration: 30 }],
  ["播客开场 10 秒，沉稳有质感，低音厚一点", { duration: 15, says: /时长范围/ }],
  ["前30秒钢琴独奏，后30秒加入鼓和弦乐", { duration: 30, drums: "on", instrument: "piano", says: /时间点/ }],
  ["开头安静，中间爆发，结尾渐弱，90秒，电影预告", { duration: 90, loop: false, energy: [0.45, 1], says: /不能分段安排强弱/ }],
  ["蓝调吉他，慢，忧郁", { style: "jazz", instrument: "guitar", bpm: [72, 100] }],
  ["忧伤的八音盒，慢", { style: "sad", instrument: "musicbox", bpm: [54, 62] }],
  ["古典钢琴，巴洛克风格，快板", { instrument: "piano", bpm: [92, 104] }],

  /* keys written the way people write them */
  ["bB大调 爵士", { style: "jazz", key: "Bb major" }],
  ["Am 调的吉他", { key: "A minor", instrument: "guitar" }],
  ["C#小调 钢琴", { key: "C# minor", instrument: "piano" }],
  ["D flat major romantic piano", { key: "Db major", style: "romantic" }],
  ["升C大调 明亮", { key: "Db major" }],

  /* what cannot be done is said, the rest is done */
  ["来一首周杰伦风格的中国风", { style: "guofeng", says: /没认出「周杰伦」是哪种风格/ }],
  ["想要一首类似《菊次郎的夏天》的钢琴曲", { instrument: "piano", says: /不能复刻现成的作品《菊次郎的夏天》/ }],
  ["make something like Hans Zimmer's Time", { says: /没认出「Hans Zimmer」/ }],
  ["Taylor Swift style pop song with vocals", { style: "bright", says: /只制作纯音乐/ }],
  ["帮我写一首带歌词的情歌，女声演唱", { style: "romantic", says: /只制作纯音乐，不包含人声和歌词/ }],
  ["给我三个版本", { says: /一次只生成一个版本/ }],
  ["圆舞曲，3/4拍，优雅", { style: "romantic", says: /三拍子/ }],
  ["交响乐，圆号", { style: ["epic", "cinematic"] }],

  /* scenes next to a genre: the genre is the music */
  ["雨天咖啡馆里的爵士小曲，行走贝斯和刷子鼓，松弛一点", { style: "jazz", check: (c) => assert.equal(c.arrangement?.bass, "walking") }],
  ["日式居酒屋，轻松的爵士", { style: "jazz" }],
  ["有氛围感的咖啡店vlog", { style: ["chill", "bright", "acoustic"] }],
  ["国潮电音，鼓点带劲，128bpm，加古筝", { style: ["guofeng", "dance"], bpm: 128, instrument: "guzheng" }],
  ["爵士嘻哈，lofi一点，85bpm，F小调", { style: ["hiphop", "jazz", "chill"], bpm: 85, key: "F minor" }],
  ["摇滚乐队，扎实的鼓组与贝斯", { style: "rock", bpm: styleInfo("rock").bpm, check: (c) => assert.equal(c.arrangement?.drums, undefined, "鼓组与贝斯 is not Drum & Bass") }],
];

test("new pieces from the review map to what was asked", () => {
  assert.ok(REVIEW_NEW.length >= 85, `new cases: ${REVIEW_NEW.length}`);
  const failures: string[] = [];
  for (const [prompt, expect] of REVIEW_NEW) {
    const result = plan(prompt);
    const problems = unmet(result, expect);
    // a description of a new piece edits nothing: no "cannot edit one section" remark
    if (/暂时不能只修改某一个段落/.test(result.reply + result.reasoning.join()))
      problems.push("section-edit note on a new piece");
    if (/→/.test(result.reasoning.join()))
      problems.push(
        `a chip is phrased as an edit: ${result.reasoning.join("｜")}`,
      );
    assert.deepEqual(clampConfig(result.config, result.config), result.config);
    if (problems.length)
      failures.push(`${JSON.stringify(prompt)}: ${problems.join("; ")}`);
  }
  assert.deepEqual(failures, []);
});

test("titles are names, not sentences, wishes or somebody else's name (AGENT-13)", () => {
  const fallbacks: [string, StyleId?][] = [
    ["我是做游戏的，需要一段森林关卡的循环bgm，带点神秘感，不要太吵"],
    ["讨厌钢琴，换别的"],
    ["不是悲伤的那种，是温暖的"],
    ["主要是欢快的，略带伤感", "bright"],
    ["除了钢琴都可以"],
    ["emo 了，来首 emo 的", "sad"],
    ["来一首周杰伦风格的中国风", "guofeng"],
    ["bB大调 爵士", "jazz"],
    ["Am 调的吉他"],
    ["很快但是很安静"],
    ["想要一首类似《菊次郎的夏天》的钢琴曲"],
    ["不悲伤的钢琴曲，温暖一些"],
    ["太吵的不要"],
  ];
  for (const [prompt, style] of fallbacks) {
    const result = plan(prompt);
    if (style) assert.equal(result.config.mood, style, prompt);
    assert.ok(
      styleInfo(result.config.mood).titles.includes(result.title),
      `${prompt}: «${result.title}»`,
    );
  }
  // a clean noun phrase is still used
  for (const [prompt, title] of [
    ["雨天咖啡馆", "雨天咖啡馆"],
    ["奶茶店开业三天活动，要喜庆热闹但不要太土", "奶茶店开业三天活动"],
    ["赛博修仙，古筝加合成器", "赛博修仙"],
    ["婚礼入场，庄重又浪漫，弦乐，D大调，90秒", "婚礼入场"],
    ["欢快的悲伤", "欢快的悲伤"],
  ])
    assert.equal(plan(prompt).title, title, prompt);
});

/* ---------- the app's own words (UX-03, UX-05, LEFT-05) ---------- */

test("a style's own catalogue blurb is that style, exactly as its preset has it (UX-03)", () => {
  for (const style of STYLES) {
    const blurb = `${style.label}：${style.description.replace(/[。.]$/, "")}`;
    const preset = { ...draft(), ...stylePreset(style.id), seed: NEXT_SEED };
    for (const text of [
      blurb,
      style.description,
      `${style.label}：${style.description}`,
    ]) {
      // the way a style card sends it: the style pinned, the blurb as the text
      const pinned = plan(text, "new", draft(), { pins: { mood: style.id } });
      assert.deepEqual(
        { ...pinned.config, prompt: "" },
        { ...preset, prompt: "" },
        `${style.id} pinned: ${text}`,
      );
      assert.deepEqual(
        pinned.reasoning,
        [`按你选的「${style.label}」风格来编`],
        style.id,
      );
      assert.ok(
        pinned.reply.startsWith(
          `好的，做一段「${style.label}」风格的音乐：${style.bpm} BPM、`,
        ),
        pinned.reply,
      );
      assert.ok(pinned.reply.endsWith("30 秒，循环片段。"), pinned.reply);
      assert.ok(
        styleInfo(style.id).titles.includes(pinned.title),
        `${style.id}: «${pinned.title}»`,
      );
      // … and without the chip
      const free = plan(text);
      assert.deepEqual(
        { ...free.config, prompt: "" },
        { ...preset, prompt: "" },
        `${style.id} free: ${text}`,
      );
      assert.equal(free.config.prompt, text);
    }
    // the same words inside a sentence of the user's are read by the lexicon: still this style, and no bogus remarks
    const said = plan(`我想要这样的音乐：${style.description}`);
    assert.equal(said.config.mood, style.id, `${style.id} in a sentence`);
    assert.equal(
      parseKey(said.config.key).minor,
      parseKey(style.key).minor,
      `${style.id}: the mode of the key`,
    );
    assert.equal(
      said.config.instrument,
      style.id === "corporate" ? "piano" : style.instrument,
      `${style.id}: lead`,
    );
    assert.ok(
      Math.abs(said.config.energy - style.energy) <= 0.05,
      `${style.id}: energy ${said.config.energy}`,
    );
    assert.ok(
      !/暂无|段落|时间点|没认出|→/.test(said.reply + said.reasoning.join()),
      `${style.id}: ${said.reasoning.join("｜")}`,
    );
    assert.notEqual(said.config.arrangement?.drums, "breakbeat", style.id);
  }
});

test("a pinned style with no words at all makes that style's piece (UX-03)", () => {
  for (const style of STYLES)
    for (const text of ["", "   ", "\n\t "]) {
      const result = plan(
        text,
        "new",
        { ...draft(), duration: 60, loop: false },
        { pins: { mood: style.id }, provider: "tencent" },
      );
      assert.deepEqual(
        { ...result.config, prompt: "", seed: 0 },
        {
          ...draft(),
          ...stylePreset(style.id),
          duration: 60,
          loop: false,
          prompt: "",
          seed: 0,
        },
        style.id,
      );
      assert.equal(result.config.seed, NEXT_SEED);
      assert.equal(result.unchanged, false);
      assert.equal(
        result.reply,
        `好的，做一段「${style.label}」风格的音乐：${style.bpm} BPM、${parseKey(style.key).name} ${parseKey(style.key).minor ? "小调" : "大调"}、${result.tags[2]}主奏，60 秒，完整结尾。`,
      );
      assert.deepEqual(result.reasoning, [
        `按你选的「${style.label}」风格来编`,
      ]);
      assert.deepEqual(result.tags.slice(0, 2), [
        style.label,
        `${style.bpm} BPM`,
      ]);
      assert.ok(
        styleInfo(style.id).titles.includes(result.title),
        `«${result.title}»`,
      );
      // the cloud prompt describes the pinned style (the draft's stock description is not passed on as the user's words)
      assert.ok(
        result.cloudPrompt?.includes(`风格：${style.label}`),
        result.cloudPrompt,
      );
      assert.ok(result.cloudPrompt?.endsWith("纯音乐，无人声，无歌词"));
      if (style.id !== "bright")
        assert.ok(
          result.cloudPrompt?.startsWith(`风格：${style.label}`),
          result.cloudPrompt,
        );
    }
});

test("every built-in inspiration prompt gets the style it promises, with no bogus remark (UX-05, LEFT-05)", () => {
  const expected: Record<string, StyleId> = {
    "vlog-daily": "bright",
    "vlog-travel": "acoustic",
    "vlog-food": "cute",
    "vlog-product": "corporate",
    "game-pixel": "chiptune",
    "game-battle": "battle",
    "game-explore": "tension",
    "game-village": "guofeng",
    "work-focus": "focus",
    "work-lofi": "chill",
    "work-cafe": "jazz",
    "event-wedding": "romantic",
    "event-festival": "festive",
    "event-sport": "dance",
    "event-trailer": "epic",
    "mood-sleep": "ambient",
    "mood-sad": "sad",
    "mood-dream": "dreamy",
  };
  const prompts = SCENARIO_GROUPS.flatMap((group) => group.prompts);
  assert.deepEqual(
    prompts.map((prompt) => prompt.id).sort(),
    Object.keys(expected).sort(),
  );
  for (const { id, prompt } of prompts) {
    const result = plan(prompt);
    assert.equal(result.config.mood, expected[id], `${id}: ${prompt}`);
    assert.match(result.reasoning[0], /^风格定为「/, id);
    assert.ok(
      !/暂时不能|暂无|没认出|没有.*听出|→/.test(
        result.reply + result.reasoning.join(),
      ),
      `${id}: ${result.reply} ${result.reasoning.join("｜")}`,
    );
  }
  // the café card's own details are heard
  const cafe = plan(
    prompts.find((prompt) => prompt.id === "work-cafe")?.prompt ?? "",
  ).config;
  assert.deepEqual(
    [cafe.arrangement?.bass, cafe.arrangement?.drums],
    ["walking", "swing"],
  );
  // the trailer card asks for 45 seconds with an ending, and its "高潮" is no section edit
  const trailer = plan(
    prompts.find((prompt) => prompt.id === "event-trailer")?.prompt ?? "",
  );
  assert.deepEqual([trailer.config.duration, trailer.config.loop], [45, false]);
  // the guide's "parameters only" example: no style is heard, and every parameter is — said as choices, not as edits
  const help = plan("90 BPM，D 小调，一分钟，完整结尾");
  assert.deepEqual(
    [help.config.bpm, help.config.key, help.config.duration, help.config.loop],
    [90, "D minor", 60, false],
  );
  assert.match(
    help.reasoning[0],
    /^没有从「.*」里听出风格，先按「青春欢快」来做$/,
  );
  assert.deepEqual(help.reasoning.slice(1), [
    "速度 90 BPM",
    "调性 D 小调",
    "时长 60 秒",
    "结构：完整结尾",
  ]);
});

/* ---------- properties ---------- */

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Instructions with their opposites, and the most one step of each may move a value. */
// prettier-ignore
const OPPOSITES: [string, string][] = [
  ["慢一点", "快一点"],
  ["快 10 bpm", "慢 10 bpm"],
  ["更有活力", "安静一点"],
  ["情绪能量高一点", "情绪能量低一点"],
  ["旋律丰富度高一点", "旋律丰富度低一点"],
  ["混响大一点", "混响小一点"],
  ["空间混响加 10%", "空间混响减 10%"],
  ["鼓大一点", "鼓小一点"],
  ["鼓加大 20%", "鼓减小 20%"],
  ["贝斯重一点", "贝斯轻一点"],
  ["旋律大声一点", "旋律小声一点"],
  ["和声大一点", "和声小一点"],
  ["长一点", "短一点"],
  ["加长 15 秒", "缩短 15 秒"],
  ["升一个调", "降一个调"],
  ["升半音", "降半音"],
];
/** Switches: the second instruction names the state the piece ends in. */
// prettier-ignore
const SWITCHES: [string, string, (config: MusicConfig) => boolean][] = [
  ["不要鼓", "加上鼓", (c) => c.volumes.drums === DEFAULT_VOLUMES.drums],
  ["加上鼓", "不要鼓", (c) => c.volumes.drums === 0],
  ["不要贝斯", "把贝斯加回来", (c) => c.volumes.bass === DEFAULT_VOLUMES.bass],
  ["不要旋律", "要旋律", (c) => c.volumes.melody === DEFAULT_VOLUMES.melody],
  ["不循环", "循环", (c) => c.loop],
  ["循环", "不循环", (c) => !c.loop],
  ["转成小调", "转成大调", (c) => !parseKey(c.key).minor],
  ["转成大调", "转成小调", (c) => parseKey(c.key).minor],
  ["不要琶音", "加上琶音", (c) => c.arrangement?.layers?.arp === true],
  ["加点弦乐铺底", "不要铺底", (c) => c.arrangement?.layers?.pad === false],
];
const MELODY_REQUESTS = [
  "换个旋律",
  "换一版",
  "再来一个",
  "new melody",
  "我不喜欢这个旋律",
];
const OTHER_REQUESTS = [
  "换成古筝",
  "换成钢琴",
  "换个乐器",
  "改成爵士风格",
  "改成摇滚风格",
  "来点国风元素",
  "少点爵士味",
  "加点弦乐铺底",
  "不要琶音",
  "摇摆一点",
  "四四拍底鼓",
  "走路贝斯",
  "旋律高八度",
  "太短了",
  "太吵了",
  "太单调了",
  "速度 96",
  "45秒",
  "鼓 30%",
  "降到 F 大调",
  "只要鼓和贝斯",
  "全部恢复",
  "这是给我家猫的视频配的，鼓小一点",
  "太像恐怖片了",
  "别把鼓去掉",
  "谢谢，很好听",
  "嗯嗯",
];

function randomPiece(random: () => number): MusicConfig {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)];
  const grid = () => Math.round(random() * 20) / 20;
  return clampConfig({
    ...draft(),
    ...stylePreset(pick(STYLE_IDS)),
    bpm: 60 + Math.floor(random() * 120),
    duration: pick([15, 30, 45, 60, 90, 120]),
    energy: grid(),
    complexity: grid(),
    reverb: grid(),
    loop: random() < 0.5,
    volumes: {
      melody: pick([0, 0.4, 0.8, 1]),
      chords: pick([0, 0.44, 0.64]),
      bass: pick([0, 0.48, 0.68, 1]),
      drums: pick([0, 0.36, 0.56, 0.9]),
    },
    prompt: "随机作品",
    seed: 1 + Math.floor(random() * 1e6),
  });
}

test("property: over random sequences, reply and chips are describeChanges, and the seed moves only for melody requests", () => {
  const random = rng(20261009);
  const pool = [
    ...OPPOSITES.flat(),
    ...SWITCHES.flatMap(([one, other]) => [one, other]),
    ...MELODY_REQUESTS,
    ...OTHER_REQUESTS,
  ];
  let steps = 0;
  let changed = 0;
  for (let run = 0; run < 150; run++) {
    let piece = randomPiece(random);
    for (let step = 0; step < 6; step++) {
      const text = pool[Math.floor(random() * pool.length)];
      const before = structuredClone(piece);
      // every second request offers the seed the piece already has: a new melody must still be new
      const nextSeed = step % 2 ? before.seed : NEXT_SEED + run * 10 + step;
      const result = plan(text, "refine", piece, { nextSeed });
      assert.deepEqual(piece, before, `${text}: the request was mutated`);
      assert.deepEqual(
        honest(before, result),
        [],
        `run ${run}, step ${step}: ${text} on ${JSON.stringify(before)}`,
      );
      assert.deepEqual(
        clampConfig(result.config, result.config),
        result.config,
        text,
      );
      const reseeded = result.config.seed !== before.seed;
      assert.equal(reseeded, MELODY_REQUESTS.includes(text), `${text}: seed`);
      assert.equal(result.config.prompt, before.prompt);
      assert.deepEqual(
        plan(text, "refine", before, { nextSeed }),
        result,
        `${text}: not deterministic`,
      );
      if (result.unchanged) assert.deepEqual(result.config, before, text);
      else changed++;
      steps++;
      piece = result.config;
    }
  }
  assert.equal(steps, 900);
  assert.ok(
    changed > 500,
    `only ${changed} of ${steps} steps changed anything`,
  );
});

test("property: an instruction followed by its opposite comes back to within one step of where it started", () => {
  const random = rng(7);
  const close = (before: MusicConfig, after: MusicConfig, label: string) => {
    assert.ok(
      Math.abs(after.bpm - before.bpm) <= 12,
      `${label}: bpm ${before.bpm} → ${after.bpm}`,
    );
    assert.ok(
      Math.abs(after.duration - before.duration) <= 30,
      `${label}: duration ${before.duration} → ${after.duration}`,
    );
    assert.ok(
      Math.abs(after.energy - before.energy) <= 0.2 + 1e-9,
      `${label}: energy`,
    );
    assert.ok(
      Math.abs(after.complexity - before.complexity) <= 0.2 + 1e-9,
      `${label}: complexity`,
    );
    assert.ok(
      Math.abs(after.reverb - before.reverb) <= 0.15 + 1e-9,
      `${label}: reverb`,
    );
    for (const track of ["melody", "chords", "bass", "drums"] as const) {
      const was = before.volumes[track];
      const now = after.volumes[track];
      // a part that was off comes back at its default level
      assert.ok(
        Math.abs(now - was) <= 0.2 + 1e-9 ||
          (was === 0 && now === DEFAULT_VOLUMES[track]),
        `${label}: ${track} ${was} → ${now}`,
      );
    }
    const semitones =
      (parseKey(after.key).tonic - parseKey(before.key).tonic + 12) % 12;
    assert.ok(semitones === 0, `${label}: key ${before.key} → ${after.key}`);
    for (const field of [
      "mood",
      "instrument",
      "seed",
      "prompt",
      "engine",
    ] as const)
      assert.equal(after[field], before[field], `${label}: ${field}`);
  };
  for (let run = 0; run < 60; run++) {
    const start = randomPiece(random);
    for (const [one, other] of OPPOSITES)
      for (const [first, second] of [
        [one, other],
        [other, one],
      ]) {
        const there = plan(first, "refine", start).config;
        const back = plan(second, "refine", there).config;
        const label = `${first} → ${second} from ${start.mood} ${start.bpm}`;
        close(start, back, label);
        assert.equal(
          parseKey(back.key).minor,
          parseKey(start.key).minor,
          label,
        );
        assert.equal(back.loop, start.loop, label);
        assert.deepEqual(back.arrangement, start.arrangement, label);
      }
    for (const [first, second, holds] of SWITCHES) {
      const there = plan(first, "refine", start).config;
      const back = plan(second, "refine", there).config;
      assert.ok(
        holds(back),
        `${first} → ${second} from ${JSON.stringify(start.volumes)} ${start.key}`,
      );
      for (const field of [
        "mood",
        "instrument",
        "seed",
        "bpm",
        "duration",
        "energy",
        "complexity",
        "reverb",
      ] as const)
        assert.equal(
          back[field],
          start[field],
          `${first} → ${second}: ${field}`,
        );
    }
  }
  // away from the limits the round trip is exact
  const middle = bright({
    bpm: 120,
    duration: 60,
    energy: 0.5,
    complexity: 0.5,
    reverb: 0.4,
  });
  for (const [one, other] of OPPOSITES)
    for (const [first, second] of [
      [one, other],
      [other, one],
    ]) {
      const back = plan(
        second,
        "refine",
        plan(first, "refine", middle).config,
      ).config;
      assert.deepEqual(back, middle, `${first} → ${second}`);
    }
});
