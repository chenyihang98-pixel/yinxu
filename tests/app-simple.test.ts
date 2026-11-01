// 简单模式: the plain words (plainChanges and friends), the scene table, the
// instrument rotation, the remembered mode, the producer that follows the
// settings, and the core actions the simple interface relies on — with the
// same fakes as the other app tests.
import assert from "node:assert/strict";
import test from "node:test";
import { planWithRules } from "../src/agent/rules";
import {
  INSTRUMENT_IDS,
  STYLE_IDS,
  instrumentLabel,
  styleLabel,
} from "../src/music/catalog";
import type { MelodyContinuity } from "../src/music/compose";
import { DEFAULT_CONFIG } from "../src/music/defaults";
import { exportName } from "../src/services/exporter";
import {
  MODE_KEY,
  createModeStore,
  memoryModeStore,
  parseMode,
} from "../src/state/mode";
import { autoBrain, brainOptions } from "../src/state/options";
import {
  NOTHING_CHANGED,
  changeLine,
  newPieceLine,
  plainChanges,
  plainDuration,
  plainPhase,
  plainSummary,
  plainWords,
} from "../src/state/plain";
import {
  buildAgentRequest,
  enforcePins,
  truthfulTiming,
} from "../src/state/plan";
import { initialState, reducer } from "../src/state/reducer";
import {
  LENGTH_CHOICES,
  MORE_STYLES,
  SCENES,
  STYLE_LEADS,
  downloadRequest,
  nextInstrument,
  scenePins,
  sentencePins,
  tweaksFor,
} from "../src/state/scenes";
import { fittedTiming } from "../src/state/score";
import { groupPieces } from "../src/state/works";
import type { MusicConfig, Project } from "../src/types";
import {
  MP3_BYTES,
  defer,
  harness,
  localProject,
  platformOf,
  settle,
} from "./helpers/app-fakes";
import type { Harness } from "./helpers/app-fakes";

const studio = (h: Harness) => h.core.getState().studio;
const ui = (h: Harness) => h.core.getState().ui;
const toasts = (h: Harness) => ui(h).toasts.map((toast) => toast.text);

/** What simple mode may never show: numbers other than a length, letters, units, jargon. */
function assertPlain(text: string): void {
  assert.doesNotMatch(text, /[A-Za-z%]/, text);
  assert.doesNotMatch(
    text,
    /BPM|调性|大调|小调|分轨|混响|版本|v\d|引擎|种子|段落|和弦|推子|百分/,
    text,
  );
  // digits only as part of a length ("1 分钟", "30 秒", "1 分 30 秒")
  const digits = text.replace(/\d+ (?:分钟|分|秒)/g, "");
  assert.doesNotMatch(digits, /\d/, text);
}

const base: MusicConfig = {
  ...DEFAULT_CONFIG,
  mood: "bright",
  bpm: 112,
  duration: 60,
  loop: false,
  instrument: "piano",
  key: "C major",
  energy: 0.62,
  complexity: 0.5,
  reverb: 0.25,
  seed: 77,
  volumes: { ...DEFAULT_CONFIG.volumes },
  engine: 2,
  prompt: "",
};

/* ---------------- plain words ---------------- */

test("plainDuration says lengths the way people do", () => {
  assert.equal(plainDuration(30), "30 秒");
  assert.equal(plainDuration(15.2), "15 秒");
  assert.equal(plainDuration(60), "1 分钟");
  assert.equal(plainDuration(61.4), "1 分钟", "a loop fitted to whole bars");
  assert.equal(plainDuration(58.6), "1 分钟");
  assert.equal(plainDuration(90), "1 分 30 秒");
  assert.equal(plainDuration(63), "1 分 3 秒");
  assert.equal(plainDuration(120), "2 分钟");
  assert.equal(plainDuration(Number.NaN), "0 秒");
});

test("plainChanges: each kind of change in plain words, melody last", () => {
  const say = (
    patch: Partial<MusicConfig>,
    continuity: MelodyContinuity = "identical",
  ) => plainChanges(base, { ...base, ...patch }, continuity);
  assert.equal(say({ bpm: 120 }), "改好了：节奏快了一点，旋律没变。");
  assert.equal(say({ bpm: 140 }), "改好了：节奏快了很多，旋律没变。");
  assert.equal(say({ bpm: 104 }), "改好了：节奏慢了一点，旋律没变。");
  assert.equal(say({ bpm: 80 }), "改好了：节奏慢了很多，旋律没变。");
  assert.equal(say({ energy: 0.7 }), "改好了：更有活力了，旋律没变。");
  assert.equal(say({ energy: 0.4 }), "改好了：更安静了，旋律没变。");
  assert.equal(
    say({ instrument: "guzheng" }),
    "改好了：主旋律换成了古筝，旋律没变。",
  );
  assert.equal(
    say({ volumes: { ...base.volumes, drums: 0 } }),
    "改好了：去掉了鼓，旋律没变。",
  );
  assert.equal(
    plainChanges(
      { ...base, volumes: { ...base.volumes, drums: 0 } },
      base,
      "identical",
    ),
    "改好了：加回了鼓，旋律没变。",
  );
  assert.equal(
    say({ volumes: { ...base.volumes, drums: 0.3 } }),
    "改好了：鼓声小了一点，旋律没变。",
  );
  assert.equal(
    say({ volumes: { ...base.volumes, melody: 0.95 } }),
    "改好了：主旋律声音大了一点，旋律没变。",
  );
  assert.equal(
    plainChanges(base, { ...base, duration: 90 }, "adapted", { seconds: 90 }),
    "改好了：变长了，现在 1 分 30 秒，旋律大体没变。",
  );
  assert.equal(
    plainChanges(base, { ...base, duration: 30 }, "adapted", { seconds: 30.4 }),
    "改好了：变短了，现在 30 秒，旋律大体没变。",
  );
  assert.equal(
    say({ loop: true }, "adapted"),
    "改好了：现在可以无缝循环播放，旋律大体没变。",
  );
  assert.equal(
    plainChanges({ ...base, loop: true }, base, "adapted"),
    "改好了：现在有完整的结尾，旋律大体没变。",
  );
  assert.equal(say({ key: "D major" }), "改好了：音调换了一下，旋律没变。");
  assert.equal(say({ complexity: 0.8 }), "改好了：旋律更丰富了，旋律没变。");
  assert.equal(say({ reverb: 0.6 }), "改好了：更空旷了，旋律没变。");
  assert.equal(say({ reverb: 0.1 }), "改好了：更贴近了，旋律没变。");
  // a style brings its own tempo, lead and colour: one change, not five
  assert.equal(
    say({ mood: "chill", bpm: 80, instrument: "epiano", energy: 0.3 }, "new"),
    "改好了：换成了慵懒放松的感觉，换了一段新旋律。",
  );
  // another take of the same settings
  assert.equal(say({ seed: 78 }, "new"), "改好了：换了一段新旋律。");
  assert.equal(say({ seed: 78 }, "rhythm"), "改好了：换了一段新旋律。");
  assert.equal(say({}), NOTHING_CHANGED);
  // a nudge nobody hears is not a change
  assert.equal(say({ energy: 0.63 }), NOTHING_CHANGED);
});

test("plainChanges: at most four items, then 等; never a number but a length", () => {
  const many = plainChanges(
    base,
    {
      ...base,
      bpm: 150,
      energy: 0.9,
      instrument: "guitar",
      volumes: { ...base.volumes, drums: 0 },
      duration: 90,
      loop: true,
      key: "A minor",
    },
    "rhythm",
    { seconds: 90 },
  );
  assert.equal(
    many,
    "改好了：节奏快了很多、更有活力了、主旋律换成了木吉他、去掉了鼓等，换了一段新旋律。",
  );
  for (const patch of [
    { bpm: 200 },
    { duration: 120 },
    { duration: 15, loop: true },
    { volumes: { ...base.volumes, bass: 0 } },
    { mood: "chiptune" as const },
    { arrangement: { drums: "swing" as const } },
  ])
    assertPlain(plainChanges(base, { ...base, ...patch }, "adapted"));
});

test("plainChanges: drums written into the piece count, not only the fader", () => {
  // ambient has no drums of its own: 加点鼓 adds a light kit to the arrangement
  const calm: MusicConfig = { ...base, mood: "ambient", instrument: "bell" };
  const withDrums: MusicConfig = { ...calm, arrangement: { drums: "light" } };
  assert.equal(
    plainChanges(calm, withDrums, "identical"),
    "改好了：加上了鼓，旋律没变。",
  );
  assert.equal(
    plainChanges(
      withDrums,
      { ...withDrums, arrangement: { drums: "none" } },
      "identical",
    ),
    "改好了：去掉了鼓，旋律没变。",
  );
});

test("changeLine and newPieceLine: what the simple result page says", () => {
  const first = localProject("a", {}, { ...base });
  const faster = localProject(
    "b",
    { parentId: "a", revision: 2 },
    { ...base, bpm: 124 },
  );
  const line = changeLine(first, faster);
  assert.match(line, /^改好了：节奏快了一点，旋律(?:没变|大体没变)。$/);
  const cloud: Project = {
    ...faster,
    provider: "tencent",
    audioBlob: new Blob([MP3_BYTES], { type: "audio/mpeg" }),
  };
  assert.equal(
    changeLine(first, cloud),
    "改好了：节奏快了一点，换了一段新旋律。",
    "an AI service always writes a new tune",
  );
  assert.equal(
    newPieceLine(localProject("c", {}, { ...base, loop: true }), 60.2),
    "做好了：轻快明亮 · 1 分钟 · 可以循环播放",
  );
  assert.equal(
    plainSummary(localProject("d", {}, { ...base, mood: "guofeng" }), 30),
    "国风古韵 · 30 秒 · 有完整结尾",
  );
  assert.equal(
    plainSummary({ ...cloud, audioDuration: 59.9 }),
    "轻快明亮 · 1 分钟 · AI 服务生成",
  );
  for (const mood of STYLE_IDS)
    assertPlain(plainSummary(localProject("e", {}, { ...base, mood }), 45));
});

test("plainPhase and plainWords keep the app's messages plain", () => {
  const job = { kind: "generate" as const, brain: "rules" as const };
  assert.equal(plainPhase({ ...job, stage: "rendering" }), "正在作曲");
  assert.equal(
    plainPhase({ ...job, kind: "open", stage: "rendering" }),
    "正在打开",
  );
  assert.equal(
    plainPhase({ ...job, stage: "planning", brain: "llm" }),
    "正在想怎么写，可能要等一会儿",
  );
  for (const stage of [
    "planning",
    "asking",
    "rendering",
    "cloud",
    "downloading",
    "saving",
    "decoding",
    "cancelling",
  ] as const)
    assert.doesNotMatch(
      plainPhase({ ...job, stage }),
      /BPM|引擎|合成|制作人|解码/,
    );
  assert.equal(
    plainWords("创作完成，已保存到「我的作品」"),
    "做好了，已保存到「我的音乐」",
  );
  assert.equal(plainWords("已导出到选定位置"), "已保存");
  assert.equal(
    plainWords("可以在「导出」里保存原始音频"),
    "可以在「下载音乐」里保存原始音频",
  );
  assert.equal(plainWords("已取消本地生成"), "已取消本地生成");
});

/* ---------------- scenes ---------------- */

test("every scene starts the style, length and structure it promises (offline rules + pins)", () => {
  assert.equal(SCENES.length, 12);
  assert.equal(MORE_STYLES.length, 10);
  // every style of the catalog is offered exactly once
  assert.deepEqual(
    [...SCENES, ...MORE_STYLES].map((scene) => scene.mood).sort(),
    [...STYLE_IDS].sort(),
  );
  for (const style of MORE_STYLES) {
    assert.equal(style.title, styleLabel(style.mood));
    assert.equal(style.duration, 60);
    assert.equal(
      style.loop,
      style.mood === "tension" || style.mood === "battle",
    );
  }
  for (const scene of [...SCENES, ...MORE_STYLES])
    for (const length of [null, 30]) {
      const pins = scenePins(scene, length);
      const request = buildAgentRequest({
        text: "",
        project: null,
        thread: [],
        pins,
        provider: "local",
        nextSeed: 7,
      });
      const plan = truthfulTiming(
        enforcePins(planWithRules(request), request),
        "local",
        null,
      );
      const { config } = plan;
      const want = length ?? scene.duration;
      assert.equal(config.mood, scene.mood, scene.id);
      assert.equal(config.loop, scene.loop, scene.id);
      assert.equal(config.duration, want, scene.id);
      assert.equal(plan.unchanged, false, scene.id);
      // what is heard: a loop is fitted to whole bars, never far off
      assert.ok(
        Math.abs(fittedTiming(config).duration - want) <= 6,
        `${scene.id}: ${fittedTiming(config).duration} s for ${want} s`,
      );
      assert.doesNotMatch(plan.title, /[A-Za-z]/, `${scene.id}: ${plan.title}`);
    }
  assert.deepEqual(
    LENGTH_CHOICES.map((choice) => choice.value),
    [null, 30, 60, 120],
  );
});

test("换个乐器: a fixed turn through the leads that suit the style, understood by the rules", () => {
  for (const mood of STYLE_IDS) {
    const leads = STYLE_LEADS[mood];
    assert.ok(leads.length >= 3, mood);
    for (const lead of leads) assert.ok(INSTRUMENT_IDS.includes(lead), lead);
    // a full turn visits every lead and comes back
    let current = leads[0];
    const seen: string[] = [];
    for (let i = 0; i < leads.length; i++) {
      seen.push(current);
      const next = nextInstrument(mood, current);
      assert.notEqual(next, current);
      current = next;
    }
    assert.equal(current, leads[0]);
    assert.deepEqual(seen, [...leads]);
    // a lead that is not on the list: the first one
    const stranger = INSTRUMENT_IDS.find((id) => !leads.includes(id));
    if (stranger) assert.equal(nextInstrument(mood, stranger), leads[0]);
  }
  // the phrase the button sends is understood, and changes the lead to that one
  for (const mood of STYLE_IDS) {
    const request = buildAgentRequest({
      text: "",
      project: null,
      thread: [],
      pins: { mood, duration: 30, loop: false },
      provider: "local",
      nextSeed: 3,
    });
    const config = enforcePins(planWithRules(request), request).config;
    const project = localProject("p", {}, config);
    const tweak = tweaksFor(config, true).find(
      (item) => item.id === "instrument",
    );
    assert.ok(tweak);
    const expected = nextInstrument(mood, config.instrument);
    assert.equal(tweak.phrase, `换成${instrumentLabel(expected)}`);
    const plan = planWithRules(
      buildAgentRequest({
        text: tweak.phrase,
        project,
        thread: [],
        pins: {},
        provider: "local",
        nextSeed: 9,
      }),
    );
    assert.equal(plan.unchanged, false, `${mood}: ${tweak.phrase}`);
    assert.equal(plan.config.instrument, expected, `${mood}: ${tweak.phrase}`);
  }
});

test("the tweak buttons: fixed sentences the rules understand, following the piece", () => {
  const labels = (config: MusicConfig, drums: boolean) =>
    tweaksFor(config, drums).map((tweak) => tweak.label);
  assert.deepEqual(labels(base, true), [
    "更欢快",
    "更安静",
    "快一点",
    "慢一点",
    "长一点",
    "短一点",
    "换个乐器",
    "去掉鼓",
    "做成循环",
  ]);
  assert.deepEqual(labels({ ...base, loop: true }, false).slice(7), [
    "加点鼓",
    "加个结尾",
  ]);
  const project = localProject("p", {}, { ...base });
  for (const tweak of tweaksFor(base, true)) {
    const plan = planWithRules(
      buildAgentRequest({
        text: tweak.phrase,
        project,
        thread: [],
        pins: {},
        provider: "local",
        nextSeed: 9,
      }),
    );
    assert.equal(plan.unchanged, false, tweak.phrase);
  }
  assert.deepEqual(downloadRequest({ provider: "local" }), {
    kind: "mix",
    plainName: true,
  });
  assert.deepEqual(downloadRequest({ provider: "tencent" }), {
    kind: "original",
    plainName: true,
  });
  const v3 = localProject("x", { revision: 3, title: "晴天" });
  assert.equal(exportName(v3, { kind: "mix" }), "晴天 v3");
  assert.equal(exportName(v3, { kind: "mix", plainName: true }), "晴天");
  assert.equal(exportName(v3, { kind: "original", plainName: true }), "晴天");
});

test("做一首: the length picked, else the one the sentence names, else one minute", () => {
  assert.deepEqual(sentencePins("下雨天的咖啡馆，安静一点，要钢琴", null), {
    duration: 60,
  });
  assert.deepEqual(sentencePins("海边日落", undefined), { duration: 60 });
  assert.deepEqual(sentencePins("两分钟的睡前音乐", null), {});
  assert.deepEqual(sentencePins("游戏背景音乐 30 秒", null), {});
  assert.deepEqual(sentencePins("做一段一分钟的片头", null), {});
  assert.deepEqual(sentencePins("两分钟的睡前音乐", 30), { duration: 30 });
  assert.deepEqual(sentencePins("海边日落", 120), { duration: 120 });
  // what the producer then makes of the sentence: its own length is kept
  for (const [text, seconds] of [
    ["两分钟的睡前音乐", 120],
    ["游戏背景音乐 30 秒", 30],
    ["下雨天的咖啡馆", 60],
  ] as const) {
    const request = buildAgentRequest({
      text,
      project: null,
      thread: [],
      pins: sentencePins(text, null),
      provider: "local",
      nextSeed: 5,
    });
    assert.equal(
      enforcePins(planWithRules(request), request).config.duration,
      seconds,
      text,
    );
  }
});

/* ---------------- the remembered mode ---------------- */

test("the mode preference: 简单模式 unless 专业模式 was chosen; storage may refuse", () => {
  assert.equal(parseMode("pro"), "pro");
  for (const value of ["simple", null, undefined, "PRO", 1, "", "expert"])
    assert.equal(parseMode(value), "simple");
  const map = new Map<string, string>();
  const store = createModeStore(() => ({
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  }));
  assert.equal(store.read(), "simple");
  store.write("pro");
  assert.equal(map.get(MODE_KEY), "pro");
  assert.equal(store.read(), "pro");
  const refusing = createModeStore(() => {
    throw new DOMException("denied", "SecurityError");
  });
  assert.equal(refusing.read(), "simple");
  assert.doesNotThrow(() => refusing.write("pro"));
  const broken = createModeStore(() => ({
    getItem: () => {
      throw new Error("quota");
    },
    setItem: () => {
      throw new Error("quota");
    },
  }));
  assert.equal(broken.read(), "simple");
  assert.doesNotThrow(() => broken.write("pro"));
  assert.equal(createModeStore(() => undefined).read(), "simple");
  const memory = memoryModeStore();
  assert.equal(memory.read(), "simple");
  // the reducer: default simple, ui/mode switches, nothing else moves
  const start = initialState({ desktop: false, version: "t" });
  assert.equal(start.ui.mode, "simple");
  const pro = reducer(start, { type: "ui/mode", mode: "pro" });
  assert.equal(pro.ui.mode, "pro");
  assert.equal(pro.studio, start.studio);
  assert.equal(reducer(pro, { type: "ui/mode", mode: "pro" }), pro);
});

test("autoBrain: the user's own model when it is set up and usable, the rules otherwise", () => {
  const desktop = platformOf("desktop");
  const web = platformOf("web");
  const ready = { configured: true, kind: "anthropic" as const, model: "m" };
  assert.equal(autoBrain(brainOptions(desktop, { llm: ready })), "llm");
  assert.equal(
    autoBrain(brainOptions(desktop, { llm: { configured: false } })),
    "rules",
  );
  assert.equal(
    autoBrain(brainOptions(desktop, { llm: { ...ready, damaged: true } })),
    "rules",
  );
  assert.equal(autoBrain(brainOptions(web, { llm: ready })), "rules");
});

/* ---------------- the core in 简单模式 ---------------- */

test("setMode: remembered, nothing is lost, 简单模式 starts free and local", async () => {
  const h = harness({ mode: "simple" });
  await h.core.start();
  assert.equal(ui(h).mode, "simple");
  h.core.actions.openModal("settings");
  assert.equal(ui(h).settingsTab, "general", "简单模式 opens settings on 常规");
  h.core.actions.closeModal();
  assert.equal(await h.core.actions.startPiece(scenePins(SCENES[1])), true);
  const piece = studio(h).project;
  assert.ok(piece);
  h.core.actions.setMode("pro");
  assert.equal(ui(h).mode, "pro");
  assert.equal(h.modeStore.value, "pro");
  assert.equal(studio(h).project, piece, "the loaded piece stays");
  assert.match(toasts(h).at(-1) ?? "", /可在设置里换回简单模式/);
  h.core.actions.navigate("inspiration");
  h.core.actions.setMode("simple");
  assert.equal(h.modeStore.value, "simple");
  assert.equal(ui(h).page, "studio", "简单模式 has no 灵感 page");
  assert.equal(studio(h).project, piece);
  h.core.actions.setMode("simple");
  assert.equal(
    toasts(h).filter((text) => text.startsWith("已切换到简单模式")).length,
    1,
    "setting the mode it is in says nothing",
  );
  // 专业模式 keeps its own default tab
  const pro = harness();
  await pro.core.start();
  pro.core.actions.openModal("settings");
  assert.equal(ui(pro).settingsTab, "music");
});

test("startPiece: exactly the scene's pins, used up on success, put back when nothing was made", async () => {
  const h = harness({ mode: "simple" });
  await h.core.start();
  // a pin left over (e.g. from 专业模式) never rides along
  h.core.actions.setPin("mood", "jazz");
  h.core.actions.setPin("duration", 30);
  h.core.actions.setComposerText("这句话不该被发出去");
  const cafe = SCENES.find((scene) => scene.id === "cafe");
  assert.ok(cafe);
  assert.equal(await h.core.actions.startPiece(scenePins(cafe, 30)), true);
  const { project, pins, composerText } = studio(h);
  assert.ok(project);
  assert.equal(project.config.mood, "chill");
  assert.equal(project.config.loop, true);
  assert.equal(project.config.duration, 30);
  assert.deepEqual(pins, {}, "used up");
  assert.equal(
    composerText,
    "这句话不该被发出去",
    "the typed words were not sent",
  );
  assert.equal(h.renders.length, 1);
  // refused while a piece is loaded
  assert.equal(await h.core.actions.startPiece(scenePins(cafe)), false);
  assert.equal(h.renders.length, 1);

  // a failure: the pins come back, the failure is said, the next job clears it
  assert.equal(h.core.actions.newPiece(), true);
  h.core.actions.setPin("duration", 60);
  h.renderError.current = new Error("合成失败");
  assert.equal(
    await h.core.actions.startPiece(scenePins(SCENES[0], 60)),
    false,
  );
  assert.deepEqual(studio(h).pins, { duration: 60 });
  assert.ok(studio(h).failure, "the failure is kept for 再试一次");
  assert.match(toasts(h).at(-1) ?? "", /^生成失败/);
  h.renderError.current = null;
  const again = h.core.actions.startPiece(scenePins(SCENES[0], 60));
  assert.equal(studio(h).failure, null, "cleared as the next job starts");
  assert.equal(await again, true);

  // with the composer's words (做一首): a length pin and the text, nothing else
  assert.equal(h.core.actions.newPiece(), true);
  h.core.actions.setPin("mood", "epic");
  h.core.actions.setComposerText("下雨天的咖啡馆，安静一点，要钢琴");
  assert.equal(
    await h.core.actions.startPiece({ duration: 120 }, { withText: true }),
    true,
  );
  const made = studio(h).project;
  assert.ok(made);
  assert.equal(made.config.duration, 120);
  assert.notEqual(
    made.config.mood,
    "epic",
    "the old style pin did not ride along",
  );
  assert.equal(made.config.prompt, "下雨天的咖啡馆，安静一点，要钢琴");
  assert.equal(studio(h).composerText, "");
});

test("a cancelled start is not a failure; a failed one gives the typed words back", async () => {
  const h = harness({ mode: "simple" });
  await h.core.start();
  const gate = defer<void>();
  h.gate.current = gate;
  const running = h.core.actions.startPiece(scenePins(SCENES[2]));
  await settle();
  assert.ok(studio(h).job);
  h.core.actions.cancelJob();
  gate.resolve();
  assert.equal(await running, false);
  assert.equal(studio(h).failure, null);
  assert.deepEqual(studio(h).pins, {}, "the pins from before (none)");
  h.gate.current = null;
  h.renderError.current = new Error("boom");
  h.core.actions.setComposerText("海边日落");
  assert.equal(await h.core.actions.startPiece({}, { withText: true }), false);
  assert.equal(studio(h).composerText, "海边日落");
  assert.ok(studio(h).failure);
});

test("简单模式 messages: plain toasts, an unchanged tweak says so, a failed model is quiet", async () => {
  const h = harness({ mode: "simple" });
  await h.core.start();
  assert.equal(await h.core.actions.startPiece(scenePins(SCENES[3])), true);
  assert.equal(toasts(h).at(-1), "做好了，已保存到「我的音乐」");
  // 加个结尾 on a piece that already ends: nothing to make, a plain answer
  const ending = tweaksFor(studio(h).project!.config, true).find(
    (tweak) => tweak.id === "structure",
  );
  assert.equal(ending?.phrase, "做成循环");
  assert.equal(await h.core.actions.send("加个结尾"), false);
  assert.equal(toasts(h).at(-1), NOTHING_CHANGED);
  assert.equal(studio(h).failure, null, "nothing to change is not a failure");
  // a real tweak
  const before = studio(h).project!;
  assert.equal(await h.core.actions.send("快一点"), true);
  const after = studio(h).project!;
  assert.equal(after.parentId, before.id);
  assert.match(changeLine(before, after), /^改好了：节奏快了/);
  // 专业模式 keeps its own words
  const pro = harness();
  await pro.core.start();
  assert.equal(await pro.core.actions.send("夏日海边"), true);
  assert.match(toasts(pro).at(-1) ?? "", /^创作完成，已保存到「我的作品」/);
});

test("简单模式 on the desktop: the producer follows the settings; a failed model says 已用内置方式完成", async () => {
  const h = harness({ kind: "desktop", mode: "simple" });
  assert.ok(h.bridge);
  h.bridge.settings = {
    ...h.bridge.settings,
    llm: { configured: true, kind: "openai", preset: "deepseek", model: "m" },
  };
  await h.core.start();
  assert.equal(studio(h).brain, "llm", "set up and usable: the model plans");
  assert.equal(h.session.value.brain, "llm");
  // a scene has no words to read: the rules plan it at once
  assert.equal(await h.core.actions.startPiece(scenePins(SCENES[0])), true);
  assert.ok(!h.bridge.calls.includes("agentPlan"));
  // a tweak is read by the model; it fails, the rules answer, and the user
  // hears only that it worked
  assert.equal(await h.core.actions.send("快一点"), true);
  assert.ok(h.bridge.calls.includes("agentPlan"));
  assert.ok(
    toasts(h).includes("已用内置方式完成。"),
    JSON.stringify(toasts(h)),
  );
  assert.ok(!toasts(h).some((text) => text.includes("离线规则")));
  assert.equal(await h.core.actions.removeLlm().then((r) => r.ok), true);
  assert.equal(studio(h).brain, "rules");
  assert.equal(
    (
      await h.core.actions.saveLlm({
        kind: "openai",
        preset: "deepseek",
        apiKey: "sk-test-key-long-enough",
        model: "m",
        baseUrl: "https://api.example.test/v1",
      })
    ).ok,
    true,
  );
  assert.equal(studio(h).brain, "llm");

  // 专业模式: the user's own choice of producer stands
  const pro = harness({ kind: "desktop", session: { brain: "rules" } });
  assert.ok(pro.bridge);
  pro.bridge.settings = {
    ...pro.bridge.settings,
    llm: { configured: true, kind: "openai", preset: "deepseek", model: "m" },
  };
  await pro.core.start();
  assert.equal(studio(pro).brain, "rules");
  // …until the user switches to 简单模式, where nothing would show it
  pro.core.actions.setMode("simple");
  assert.equal(studio(pro).brain, "llm");
});

test("简单模式 starts a new piece with the free local engine; the AI switch is the user's", async () => {
  const h = harness({ kind: "desktop" });
  await h.core.start();
  h.core.actions.setProvider("tencent");
  assert.equal(studio(h).provider, "tencent");
  h.core.actions.setMode("simple");
  assert.equal(
    studio(h).provider,
    "local",
    "entering 简单模式: free and offline",
  );
  // the switch on the scene page is setProvider; a scene is then a paid request, asked first
  h.core.actions.setProvider("tencent");
  const running = h.core.actions.startPiece(scenePins(SCENES[0], 30));
  await settle();
  const dialog = ui(h).dialog;
  assert.equal(dialog?.kind, "paid");
  h.core.actions.answerDialog(dialog!.id, "cancel");
  assert.equal(await running, false);
  assert.equal(
    h.bridge!.calls.filter((call) => call.startsWith("generateMusic")).length,
    0,
    "nothing was sent without a yes",
  );
  assert.deepEqual(studio(h).pins, {}, "put back");
});

test("我的音乐: one card per piece, its newest version first; deleting a piece takes every version, one 撤销 brings it back", async () => {
  const a1 = localProject("a1", {
    updatedAt: "2026-10-01T08:00:00.000Z",
    createdAt: "2026-10-01T08:00:00.000Z",
  });
  const a2 = localProject("a2", {
    parentId: "a1",
    revision: 2,
    updatedAt: "2026-10-01T09:00:00.000Z",
    createdAt: "2026-10-01T09:00:00.000Z",
  });
  const b1 = localProject("b1", {
    title: "雨夜",
    updatedAt: "2026-10-01T08:30:00.000Z",
    createdAt: "2026-10-01T08:30:00.000Z",
  });
  // a3 continues a2's conversation but its parent was deleted: still the same piece
  const turn = {
    id: "t-1",
    role: "user" as const,
    text: "慢一点",
    at: "2026-10-01T10:00:00.000Z",
  };
  const a3 = localProject("a3", {
    parentId: "gone",
    revision: 3,
    chat: [turn],
    updatedAt: "2026-10-01T07:00:00.000Z",
    createdAt: "2026-10-01T10:00:00.000Z",
  });
  const a2chat = { ...a2, chat: [turn] };
  const pieces = groupPieces([a2chat, b1, a1, a3]);
  assert.deepEqual(
    pieces.map((piece) => [
      piece.latest.id,
      piece.versions.map((item) => item.id),
    ]),
    [
      ["a3", ["a3", "a2", "a1"]],
      ["b1", ["b1"]],
    ],
  );
  assert.deepEqual(groupPieces([]), []);

  const h = harness({ mode: "simple", records: [a1, a2] });
  await h.core.start();
  const [piece] = groupPieces(h.core.getState().library.projects);
  assert.equal(piece.versions.length, 2);
  for (const item of piece.versions)
    assert.equal(h.core.actions.removeProject(item.id, true), "removed");
  assert.equal(h.core.getState().library.projects.length, 0);
  const undo = ui(h).toasts.find((toast) => toast.action);
  assert.equal(undo?.text, `已删除《${a1.title}》`, "one piece, one name");
  assert.equal(undo?.action?.label, "撤销");
  undo?.action?.run();
  await settle();
  assert.equal(h.core.getState().library.projects.length, 2);
});
