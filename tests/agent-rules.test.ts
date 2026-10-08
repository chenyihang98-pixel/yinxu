import assert from "node:assert/strict";
import test from "node:test";
import { planWithRules, readMentions } from "../src/agent/rules";
import { analyse, normalizeText, parseChineseNumber } from "../src/agent/lexicon";
import type { AgentPlan, AgentRequest } from "../src/agent/types";
import {
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
  if (expect.notStyle?.includes(c.mood)) out.push(`style must not be ${c.mood}`);
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
  if (expect.drums === "off" && c.volumes.drums !== 0) out.push("drums not muted");
  if (expect.drums === "low" && c.volumes.drums > 0.2) out.push("drums too loud");
  if (expect.drums === "on" && c.volumes.drums <= 0) out.push("drums muted");
  if (expect.bass === "off" && c.volumes.bass !== 0) out.push("bass not muted");
  if (expect.bass === "on" && c.volumes.bass <= 0) out.push("bass muted");
  if (expect.says && !expect.says.test([result.reply, ...result.reasoning].join("\n")))
    out.push(`nothing says ${expect.says}`);
  if (expect.check)
    try {
      expect.check(c, result);
    } catch (error) {
      out.push(error instanceof Error ? error.message : String(error));
    }
  return out;
}

/* The auditor's 71 prompts (.scratch/engine-music/prompts.ts) — 48 of them fell back to "happy piano" in v0.2. */
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
  ["明亮的小调", { minor: true }],
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
    if (c.mood === "bright" && c.bpm === 112 && c.key === "C major" && c.instrument === "piano")
      untouched.push(prompt);
    // whenever the style could not be read, the plan says so instead of pretending
    const explained = /风格定为|没有.*听出|没有收到描述/.test(result.reasoning[0]);
    assert.ok(explained, `${prompt}: ${result.reasoning[0]}`);
  }
  // v0.2: 48 of 71 resolved to bright / 112 / C major / piano, with 10 distinct outcomes.
  // What is left are requests that really are "bright" or that only set a parameter.
  assert.deepEqual(untouched.sort(), [
    "",
    "a minor detail of my day",
    "一分钟",
    "不要电子味",
    "加一点贝斯",
    "无鼓",
    "旅行vlog",
    "without percussion",
    "美食探店",
  ].sort());
  assert.ok(outcomes.size >= 25, `only ${outcomes.size} distinct outcomes`);
  const styles = new Set([...outcomes].map((outcome) => outcome.split("|")[0]));
  assert.ok(styles.size >= 18, `only ${styles.size} of 22 styles reached`);
});

test("every plan is a complete, valid, deterministic engine-2 configuration", () => {
  for (const [prompt] of [...AUDIT_CASES, ...MORE_CASES]) {
    const result = plan(prompt);
    const c = result.config;
    assert.ok(isStyleId(c.mood) && isInstrumentId(c.instrument) && isKey(c.key), prompt);
    assert.deepEqual(clampConfig(c, c), c, `${prompt}: not already clamped`);
    assert.equal(c.engine, 2);
    assert.equal(c.seed, NEXT_SEED, `${prompt}: new pieces use the supplied seed`);
    assert.equal(c.prompt, prompt.trim() || DEFAULT_CONFIG.prompt);
    assert.equal(result.brain, "rules");
    assert.equal(result.unchanged, false);
    assert.equal(result.cloudPrompt, undefined);
    assert.ok(result.title.length > 0 && result.title.length <= 60, prompt);
    assert.ok(result.reply.length > 0 && result.reply.length <= 200, `${prompt}: ${result.reply}`);
    assert.ok(result.reasoning.length > 0 && result.tags.length >= 3, prompt);
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(result.reply + result.reasoning.join("")), "emoji");
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
  const supplied = plan("鼓轻一点", "refine", before.config, { title: "我的曲子" });
  assert.equal(supplied.title, "我的曲子");
  // … as it is stored, also across a change of style; a new piece is a new work
  assert.equal(plan("改成摇滚风格", "refine", before.config, { title: "  我的曲子 " }).title, "我的曲子");
  assert.equal(plan("鼓轻一点", "refine", before.config, { title: "长".repeat(200) }).title.length, 80);
  assert.equal(plan("鼓轻一点", "refine", before.config, { title: "   " }).title, before.title);
  assert.equal(plan("雨天咖啡馆", "new", draft(), { title: "我的曲子" }).title, "雨天咖啡馆");
});

test("cloud providers always get a prompt, the local engine never does", () => {
  for (const provider of ["tencent", "volcengine", "aliyun", "elevenlabs"] as const) {
    const fresh = plan("雨天咖啡馆", "new", draft(), { provider });
    assert.ok(fresh.cloudPrompt?.startsWith("雨天咖啡馆"), fresh.cloudPrompt);
    assert.ok(fresh.cloudPrompt?.endsWith("纯音乐，无人声，无歌词"));
    const refined = plan("不要鼓点", "refine", dreamy(), { provider });
    assert.match(refined.cloudPrompt ?? "", /不要鼓点/);
    assert.match(refined.cloudPrompt ?? "", /不要鼓组/);
  }
  assert.equal(plan("雨天咖啡馆", "refine").cloudPrompt, undefined);
});

/* ---------- refinements ---------- */

const changedFields = (before: MusicConfig, after: MusicConfig) =>
  (Object.keys(after) as (keyof MusicConfig)[]).filter(
    (field) => JSON.stringify(after[field]) !== JSON.stringify(before[field]),
  );

test("refine changes only what was asked and keeps the melody seed", () => {
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
  for (const text of ["换一版", "再来一首", "换个旋律", "再来一个", "another take", "换一版新旋律", "new melody"]) {
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

  const pinned = plan("改成赛博朋克风格，速度 90，用钢琴", "refine", before).config;
  assert.equal(pinned.mood, "retro");
  assert.equal(pinned.bpm, 90);
  assert.equal(pinned.instrument, "piano");

  assert.equal(plan("摇滚", "refine", before).config.mood, "rock");
  assert.equal(plan("把爵士换成摇滚", "refine", before).config.mood, "rock");
  assert.equal(plan("换个风格，史诗一点", "refine", before).config.mood, "epic");
  assert.equal(plan("我想要更像电影配乐", "refine", before).config.mood, "cinematic");
  const vague = plan("换个风格", "refine", before);
  assert.equal(vague.unchanged, true);
  assert.match(vague.reply, /想换成什么风格/);
  assert.equal(plan("换成爵士风格", "refine", before).config.mood, "jazz");
});

test("mood words and flavours adjust the piece without replacing its style", () => {
  const before = dreamy();
  for (const text of ["再欢快一点", "更温柔一点", "安静一点", "更悲伤一点", "来点爵士味", "换成小提琴", "摇摆一点"])
    assert.equal(plan(text, "refine", before).config.mood, "dreamy", text);
  // EM-16: "再欢快一点" used to add 12 BPM through the substring "快一点"
  assert.equal(plan("再欢快一点", "refine", before).config.bpm, before.bpm);
  assert.equal(parseKey(plan("更悲伤一点", "refine", before).config.key).minor, true);
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
        ? [`no ${name}`, `without ${name}`, `remove ${name}`, `mute ${name}`, `${name} off`]
        : [`不要${name}`, `去掉${name}`, `移除${name}`, `关闭${name}`, `静音${name}`, `${name}静音`, `${name}关掉`, `没有${name}`];
      for (const text of mutes)
        assert.equal(plan(text, "refine", draft()).config.volumes[track], 0, text);
      const muted = { ...draft(), volumes: { ...DEFAULT_VOLUMES, [track]: 0 } };
      const restores = latin
        ? [`unmute ${name}`, `enable ${name}`, `add ${name}`, `${name} on`]
        : [`恢复${name}`, `打开${name}`, `开启${name}`, `加回${name}`, `${name}打开`];
      for (const text of restores)
        assert.equal(plan(text, "refine", muted).config.volumes[track], DEFAULT_VOLUMES[track], text);
      const up = latin ? [`more ${name}`, `${name} louder`] : [`${name}大一点`, `${name}强一些`, `突出${name}`, `提高${name}`, `增加${name}`];
      for (const text of up)
        assert.ok(plan(text, "refine", draft()).config.volumes[track] > DEFAULT_VOLUMES[track], text);
      const down = latin ? [`less ${name}`, `${name} quieter`, `${name} softer`] : [`${name}小一点`, `${name}轻一点`, `${name}弱一些`, `降低${name}`, `减少${name}`];
      for (const text of down) {
        const value = plan(text, "refine", draft()).config.volumes[track];
        assert.ok(value < DEFAULT_VOLUMES[track] && value > 0, text);
      }
    }
});

test("gentler instructions never increase energy, even at the minimum", () => {
  for (const energy of [0, 0.01, 0.05, 0.2, 0.7, 1])
    for (const text of ["更温柔一点", "更安静", "轻柔", "calm", "quieter", "不要太吵"]) {
      const result = plan(text, "refine", { ...draft(), energy }).config;
      assert.ok(result.energy <= energy, `${text} at ${energy} became ${result.energy}`);
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
  for (const field of ["seed", "bpm", "duration", "key", "instrument", "mood"] as const)
    assert.equal(restored[field], initial[field]);
});

test("an instruction that is not understood is a true no-op and says so helpfully", () => {
  for (const text of ["像一只穿雨衣的河马", "xyzzy", "嗯嗯", "a minor detail of my day", ""]) {
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
  assert.match(plan("unmute drums", "refine").reasoning.join(), /本来就是打开的/);
  assert.match(plan("不要钢琴", "refine").reasoning.join(), /本来就没有/);
  assert.match(plan("前奏长一点", "refine").reasoning.join(), /段/);
  assert.equal(plan("前奏长一点", "refine").unchanged, true);
  assert.match(plan("大调", "refine").reasoning.join(), /已经是 D 大调/);
  assert.match(plan("循环", "refine").reasoning.join(), /已经是无缝循环/);
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
    { text: "爵士", mode: "new", current: { mood: "nope", bpm: "fast", volumes: 3 }, nextSeed: Number.NaN },
  ];
  for (const request of broken) {
    const result = planWithRules({ provider: "local", history: [], nextSeed: 1, current: draft(), ...request } as unknown as AgentRequest);
    assert.ok(isStyleId(result.config.mood));
    assert.deepEqual(clampConfig(result.config, result.config), result.config);
  }
  assert.equal(plan("钢琴".repeat(2000)).config.prompt.length, 1500);
});

/* ---------- pins: what the user fixed in the UI ---------- */

test("a pinned style replaces style detection; the text still supplies the parameters", () => {
  // the words say café jazz, the style chip says guofeng
  const pinned = plan("雨天咖啡馆里的慵懒爵士，一分钟，不要鼓，速度 90", "new", draft(), { pins: { mood: "guofeng" } });
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
  assert.ok(!pinned.reasoning.some((item) => /风格定为|也很接近|没有.*听出/.test(item)), pinned.reasoning.join("｜"));
  assert.match(pinned.reply, /^好的，做一段「国风古韵」风格的音乐：90 BPM、D 大调、古筝主奏，60 秒/);
  assert.ok(!/没听出/.test(pinned.reply));
  assert.deepEqual(pinned.tags.slice(0, 3), ["国风古韵", "90 BPM", "古筝"]);
  assert.equal(pinned.unchanged, false);
  // a lead, a key or a mood word in the text still shapes the pinned style
  assert.equal(plan("钢琴", "new", draft(), { pins: { mood: "guofeng" } }).config.instrument, "piano");
  assert.equal(plan("E minor", "new", draft(), { pins: { mood: "guofeng" } }).config.key, "E minor");
  assert.ok(plan("安静一点", "new", draft(), { pins: { mood: "rock" } }).config.energy < styleInfo("rock").energy);
  // a style defined by its sound still lends its lead to the pinned one — unless the lead is pinned too
  const lent = plan("国风", "new", draft(), { pins: { mood: "dance" } });
  assert.deepEqual([lent.config.mood, lent.config.instrument], ["dance", "guzheng"]);
  const fixedLead = plan("国风", "new", draft(), { pins: { mood: "dance", instrument: "bell" } });
  assert.deepEqual([fixedLead.config.mood, fixedLead.config.instrument], ["dance", "bell"]);
  assert.ok(!fixedLead.reasoning.some((item) => item.includes("古筝")), fixedLead.reasoning.join("｜"));

  // without a word of text the pinned style's preset is the piece
  const bare = plan("", "new", { ...draft(), duration: 45, loop: false }, { pins: { mood: "battle" } });
  assert.deepEqual(
    { ...bare.config, seed: 0, prompt: "" },
    { ...draft(), ...stylePreset("battle"), duration: 45, loop: false, seed: 0, prompt: "" },
  );
  assert.deepEqual(bare.reasoning, ["按你选的「热血战斗」风格来编"]);
  // any style can be pinned against any text, and the plan stays valid and deterministic
  for (const style of STYLE_IDS)
    for (const text of ["雨天咖啡馆", "史诗战斗，古筝，140bpm", "像一只穿雨衣的河马", ""]) {
      const result = plan(text, "new", draft(), { pins: { mood: style } });
      assert.equal(result.config.mood, style, `${style}: ${text}`);
      assert.deepEqual(clampConfig(result.config, result.config), result.config);
      assert.deepEqual(plan(text, "new", draft(), { pins: { mood: style } }), result);
    }
});

test("refining with a pinned style: a new one re-bases the piece, the current one holds it", () => {
  const before = dreamy();
  const swapped = plan("速度 100，鼓轻一点", "refine", before, { pins: { mood: "rock" } });
  assert.equal(swapped.config.mood, "rock");
  assert.equal(swapped.config.bpm, 100, "the text sets the tempo");
  assert.equal(swapped.config.key, styleInfo("rock").key);
  assert.equal(swapped.config.instrument, styleInfo("rock").instrument);
  assert.equal(swapped.config.energy, styleInfo("rock").energy);
  assert.ok(swapped.config.volumes.drums < before.volumes.drums);
  assert.equal(swapped.config.seed, before.seed);
  assert.equal(swapped.config.duration, before.duration);
  assert.equal(swapped.reasoning[0], "按你选的「摇滚能量」风格来编");
  assert.ok(!swapped.reasoning.some((item) => item.startsWith("风格改为")), "the pin is named once");
  assert.ok(swapped.reasoning.includes("调性 D 大调 → E 小调"));
  assert.match(swapped.reply, /^好的：风格改为「摇滚能量」/);
  // the old piece's arrangement does not move into the new style
  const hinted = { ...before, arrangement: { swing: 0.5, layers: { pad: true } } };
  assert.equal(plan("", "refine", hinted, { pins: { mood: "rock" } }).config.arrangement, undefined);

  // pinned to what the piece already is: the words cannot move it to another style
  for (const text of ["改成爵士风格，慢一点", "摇滚，慢一点", "换成赛博朋克风格，慢一点", "来点爵士味，慢一点"]) {
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
  const pins = { instrument: "guzheng", key: "A minor", bpm: 90, duration: 45, loop: false } as const;
  const fresh = plan("两分钟的钢琴曲，速度 140，C大调，无缝循环", "new", draft(), { pins });
  for (const field of ["instrument", "key", "bpm", "duration", "loop"] as const)
    assert.equal(fresh.config[field], pins[field], field);
  assert.equal(fresh.reasoning[0], "按你的设定：古筝主奏、A 小调、90 BPM、45 秒、带完整结尾");
  assert.match(fresh.reasoning[1], /^风格定为「/, "the style is still read from the words");
  assert.ok(
    !fresh.reasoning.slice(1).some((item) => /主奏换成|调性|速度 \d|时长 \d|完整版本|改为无缝/.test(item)),
    `the pins are named once: ${fresh.reasoning.join("｜")}`,
  );
  assert.match(fresh.reply, /90 BPM、A 小调、古筝主奏，45 秒，带完整结尾/);
  assert.deepEqual(plan("两分钟的钢琴曲，速度 140，C大调，无缝循环", "new", draft(), { pins }), fresh);
  // each pin on its own
  assert.equal(plan("一分钟", "new", draft(), { pins: { duration: 30 } }).config.duration, 30);
  assert.equal(plan("游戏主菜单", "new", draft(), { pins: { loop: false } }).config.loop, false);
  assert.equal(plan("不要钢琴，用吉他", "new", draft(), { pins: { instrument: "piano" } }).config.instrument, "piano");
  assert.equal(plan("忧伤的小调", "new", draft(), { pins: { key: "G major" } }).config.key, "G major");
  assert.equal(plan("很慢的冥想", "new", draft(), { pins: { bpm: 150 } }).config.bpm, 150);

  // refining: pinned values are changes like any other, named once in the reasoning
  const before = dreamy();
  const refined = plan("慢一点", "refine", before, { pins: { duration: 60, loop: false } });
  assert.deepEqual(changedFields(before, refined.config).sort(), ["bpm", "duration", "loop"]);
  assert.equal(refined.config.seed, before.seed);
  assert.deepEqual(refined.reasoning, ["按你的设定：60 秒、带完整结尾", "速度 74 → 62 BPM"]);
  assert.equal(refined.reply, "好的：速度 74 → 62 BPM，时长 30 → 60 秒，改为带结尾的完整版本。旋律素材保持不变。");
  // a pin alone is a request
  const alone = plan("", "refine", before, { pins: { loop: false } });
  assert.deepEqual(changedFields(before, alone.config), ["loop"]);
  assert.equal(alone.unchanged, false);
  // pins that only repeat the piece do nothing
  const repeated = plan("鼓轻一点", "refine", before, { pins: { duration: 30, loop: true, bpm: 74, key: "D major", instrument: "bell" } });
  assert.deepEqual(changedFields(before, repeated.config), ["volumes"]);
  assert.equal(plan("", "refine", before, { pins: { duration: 30 } }).unchanged, true);
  // the text asks for one value, the pin holds another
  const held = plan("速度 120，换成钢琴，两分钟", "refine", before, { pins: { bpm: 80, instrument: "flute", duration: 45 } }).config;
  assert.deepEqual([held.bpm, held.instrument, held.duration], [80, "flute", 45]);

  // malformed pins are ignored, out-of-range ones clamped
  const broken = plan("雨天咖啡馆", "new", draft(), {
    pins: { mood: "nope", instrument: 7, key: "H major", bpm: "fast", duration: 1e9, loop: "yes" } as unknown as AgentRequest["pins"],
  });
  assert.equal(broken.config.mood, "chill");
  assert.equal(broken.config.bpm, styleInfo("chill").bpm);
  assert.equal(broken.config.duration, 120);
  assert.equal(broken.config.loop, true);
  for (const junk of [null, "jazz", 5, [], () => ({ mood: "rock" })])
    assert.deepEqual(
      plan("雨天咖啡馆", "new", draft(), { pins: junk as unknown as AgentRequest["pins"] }),
      plan("雨天咖啡馆"),
    );
  // a cloud prompt describes the pinned piece
  const cloud = plan("月下独酌", "new", draft(), { provider: "tencent", pins: { mood: "guofeng", duration: 60, loop: false } });
  assert.match(cloud.cloudPrompt ?? "", /国风古韵/);
  assert.match(cloud.cloudPrompt ?? "", /时长约 60 秒/);
  assert.match(cloud.cloudPrompt ?? "", /自然的结尾/);
});

test("readMentions: which faders and which parameters a request is about", () => {
  const cases: [string, "new" | "refine", TrackName[], ("tempo" | "energy" | "complexity" | "reverb")[]][] = [
    ["雨天咖啡馆", "new", [], []],
    ["换成小提琴", "refine", [], []],
    ["不要鼓", "new", ["drums"], []],
    ["140bpm 鼓和贝斯", "new", ["bass", "drums"], ["tempo"]],
    ["鼓别那么抢戏", "refine", ["drums"], []],
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
  for (const [text, value] of [["两", 2], ["十", 10], ["九十", 90], ["一百二", 120], ["一百零五", 105], ["九零", 90], ["一百二十", 120]] as const)
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
  const era = analyse("80s synthwave").tokens.find((token) => token.lex.cat === "era");
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
  for (const [name, expected] of [["降D大调", "Db major"], ["升F大调", "F# major"], ["降A大调", "Ab major"], ["降E小调", "Eb minor"], ["升G小调", "G# minor"], ["降B小调", "Bb minor"]] as const)
    assert.equal(plan(name).config.key, expected, name);
});

test("all 14 instruments can be asked for, with synonyms", () => {
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
    assert.equal(plan(`换成${word}`, "refine", { ...draft(), instrument: instrument === "piano" ? "bell" : "piano" }).config.instrument, instrument, word);
    assert.equal(plan(word).config.instrument, instrument, `new: ${word}`);
  }
  // "synthwave" is a genre, not the synth lead; "good vibes" is not a vibraphone
  assert.equal(plan("good vibes", "refine").config.instrument, "bell");
});
