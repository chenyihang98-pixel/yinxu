// Pure decisions of the app core: draft, pins, plans, thread, versions, options, shortcuts.
import assert from "node:assert/strict";
import test from "node:test";
import { planWithRules } from "../src/agent/rules";
import type { AgentPlan, AgentTurn } from "../src/agent/types";
import { STYLES } from "../src/music/catalog";
import { DEFAULT_CONFIG, stylePreset } from "../src/music/defaults";
import { originalFormat, originalFormatLabel } from "../src/providers";
import { normalizeProject } from "../src/storage";
import {
  QUICK_PROMPTS,
  SCENARIO_GROUPS,
  styleInspiration,
} from "../src/state/content";
import { formatBytes, formatTime } from "../src/state/format";
import {
  AUTOPLAY_WINDOW_MS,
  IDLE,
  MAX_THREAD_TURNS,
  MIX_SAVE_DELAY_MS,
  agentTurn,
  buildProject,
  capThread,
  changedFields,
  cleanMessage,
  cleanTitle,
  configFromDraft,
  draftOf,
  durationChanged,
  editDraft,
  errorText,
  isAbort,
  isDue,
  joinText,
  resetDraft,
  scheduleChange,
  scheduleRelease,
  shouldAutoplay,
  toggleMuteVolumes,
  userTurn,
  waitFor,
} from "../src/state/logic";
import {
  activeBrain,
  brainOptions,
  cancelText,
  configProblem,
  engineOptions,
  engineProblem,
  phaseText,
} from "../src/state/options";
import {
  buildAgentRequest,
  enforcePins,
  isUnsure,
  newPieceBase,
  planFromDraft,
  planPreview,
  planVariation,
  suggestionsFor,
} from "../src/state/plan";
import {
  EMPTY_SESSION,
  SESSION_KEY,
  createSessionStore,
  parseSession,
  serializeSession,
} from "../src/state/session";
import { shortcutFor } from "../src/state/shortcuts";
import {
  findVersion,
  queryProjects,
  upsertProject,
  versionLabel,
} from "../src/state/works";
import { localProject } from "./helpers/app-fakes";

const turn = (index: number): AgentTurn => ({
  id: `t${index}`,
  role: index % 2 ? "agent" : "user",
  text: `第 ${index} 句`,
  at: "2026-10-01T08:00:00.000Z",
});

test("draft: only the inspector fields, diffed against the committed work", () => {
  const committed = { ...DEFAULT_CONFIG, seed: 7, prompt: "海边" };
  const draft = draftOf(committed);
  assert.deepEqual(Object.keys(draft).sort(), [
    "bpm",
    "complexity",
    "duration",
    "energy",
    "instrument",
    "key",
    "loop",
    "mood",
    "reverb",
  ]);
  assert.ok(
    !("seed" in draft) && !("volumes" in draft) && !("prompt" in draft),
  );
  assert.deepEqual(changedFields(draft, committed), []);
  assert.deepEqual(changedFields(draft, null), []);
  const edited = editDraft({ draft, touched: [] }, committed, "bpm", 96);
  assert.deepEqual(changedFields(edited.draft, committed), ["bpm"]);
  // Setting the same value again is not a change (computed, not a flag).
  const back = editDraft(edited, committed, "bpm", committed.bpm);
  assert.deepEqual(changedFields(back.draft, committed), []);
  // Float noise from a slider is not a change either.
  const noise = editDraft(
    { draft, touched: [] },
    committed,
    "energy",
    committed.energy + 1e-9,
  );
  assert.deepEqual(changedFields(noise.draft, committed), []);
});

test("draft: values are bounded and unknown enum values are ignored", () => {
  const start = { draft: draftOf(DEFAULT_CONFIG), touched: [] };
  assert.equal(editDraft(start, DEFAULT_CONFIG, "bpm", 999).draft.bpm, 200);
  assert.equal(editDraft(start, DEFAULT_CONFIG, "bpm", 96.6).draft.bpm, 97);
  assert.equal(
    editDraft(start, DEFAULT_CONFIG, "duration", 1).draft.duration,
    15,
  );
  assert.equal(editDraft(start, DEFAULT_CONFIG, "reverb", 2).draft.reverb, 1);
  assert.equal(
    editDraft(start, DEFAULT_CONFIG, "bpm", Number.NaN).draft.bpm,
    DEFAULT_CONFIG.bpm,
  );
  assert.equal(
    editDraft(start, DEFAULT_CONFIG, "mood", "polka" as never).draft.mood,
    DEFAULT_CONFIG.mood,
  );
  assert.equal(
    editDraft(start, DEFAULT_CONFIG, "key", "H major").draft.key,
    DEFAULT_CONFIG.key,
  );
  assert.equal(
    editDraft(start, DEFAULT_CONFIG, "instrument", "kazoo" as never).draft
      .instrument,
    DEFAULT_CONFIG.instrument,
  );
});

test("draft: a style brings its preset, but never over a field edited by hand", () => {
  const committed = { ...DEFAULT_CONFIG };
  let state = {
    draft: draftOf(committed),
    touched: [] as ReturnType<typeof editDraft>["touched"],
  };
  state = editDraft(state, committed, "bpm", 150);
  state = editDraft(state, committed, "mood", "jazz");
  const jazz = stylePreset("jazz");
  assert.equal(state.draft.mood, "jazz");
  assert.equal(
    state.draft.bpm,
    150,
    "hand-set tempo survives the style change",
  );
  assert.equal(state.draft.instrument, jazz.instrument);
  assert.equal(state.draft.key, jazz.key);
  assert.equal(state.draft.duration, committed.duration);
  assert.equal(state.draft.loop, committed.loop);
  // Back to the committed style: untouched fields return to the committed values.
  state = editDraft(state, committed, "mood", committed.mood);
  assert.deepEqual(changedFields(state.draft, committed), ["bpm"]);
  // 还原 one field, then all.
  const one = resetDraft(state, committed, "bpm");
  assert.deepEqual(changedFields(one.draft, committed), []);
  assert.deepEqual(one.touched, ["mood"]);
  const all = resetDraft(editDraft(state, committed, "loop", false), committed);
  assert.deepEqual(all, { draft: draftOf(committed), touched: [] });
});

test("applyDraft configuration keeps seed, volumes and description of the committed work", () => {
  const committed = {
    ...DEFAULT_CONFIG,
    seed: 987654,
    prompt: "committed words",
    volumes: { melody: 0.3, chords: 0.5, bass: 0.6, drums: 0 },
    arrangement: { layers: { pad: true } },
  };
  const draft = { ...draftOf(committed), bpm: 90, reverb: 0.7 };
  const next = configFromDraft(committed, draft);
  assert.equal(next.seed, 987654);
  assert.equal(next.prompt, "committed words");
  assert.deepEqual(next.volumes, committed.volumes);
  assert.equal(next.bpm, 90);
  assert.equal(next.reverb, 0.7);
  assert.deepEqual(next.arrangement, { layers: { pad: true } });
  assert.equal(next.engine, 2);
  // A style change drops style-specific arrangement hints.
  const restyled = configFromDraft(committed, { ...draft, mood: "jazz" });
  assert.equal(restyled.arrangement, undefined);
  assert.equal(restyled.seed, 987654);
  // Extra keys smuggled into a draft object are not applied.
  const smuggled = configFromDraft(committed, {
    ...draft,
    seed: 1,
    volumes: { melody: 1, chords: 1, bass: 1, drums: 1 },
  } as never);
  assert.equal(smuggled.seed, 987654);
  assert.deepEqual(smuggled.volumes, committed.volumes);
});

test("an engine-1 work turns into an engine-2 work when it is applied or varied", () => {
  const legacy = localProject(
    "old",
    {},
    { engine: 1, mood: "chill", instrument: "guitar", key: "A minor", bpm: 84 },
  );
  const applied = planFromDraft(legacy, draftOf(legacy.config), "local");
  assert.equal(applied.plan.config.engine, 2);
  assert.equal(applied.plan.config.seed, legacy.config.seed);
  assert.equal(
    applied.plan.unchanged,
    false,
    "the engine upgrade alone is a change",
  );
  assert.ok(applied.plan.reasoning.includes("改用新版引擎"));
  const varied = planVariation(legacy, 55, "local");
  assert.equal(varied.plan.config.engine, 2);
  assert.equal(varied.plan.config.seed, 55);
  assert.equal(varied.plan.title, legacy.title);
});

test("direct plans: 应用调整 lists the changes, 换一版旋律 only changes the seed", () => {
  const project = localProject("p1");
  const same = planFromDraft(project, draftOf(project.config), "local");
  assert.equal(same.plan.unchanged, true);
  const draft = {
    ...draftOf(project.config),
    bpm: 96,
    instrument: "guzheng" as const,
  };
  const { request, plan } = planFromDraft(project, draft, "tencent");
  assert.match(request, /^应用调整：速度 112 → 96 BPM，主奏乐器换成古筝$/);
  assert.equal(plan.unchanged, false);
  assert.equal(plan.title, project.title);
  assert.deepEqual(plan.tags, ["青春欢快", "96 BPM", "古筝"]);
  assert.ok(plan.cloudPrompt && plan.cloudPrompt.includes("96 BPM"));
  const varied = planVariation(project, project.config.seed, "local");
  assert.notEqual(
    varied.plan.config.seed,
    project.config.seed,
    "a new seed even if the dice repeat",
  );
  assert.deepEqual(
    { ...varied.plan.config, seed: 0 },
    { ...project.config, seed: 0 },
  );
  assert.equal(varied.plan.cloudPrompt, undefined);
});

test("requests: a refinement uses the committed work, a new piece the defaults plus pins", () => {
  const project = localProject("p1", { chat: [turn(0), turn(1)] });
  const refine = buildAgentRequest({
    text: "  慢一点  ",
    project,
    thread: project.chat ?? [],
    pins: { mood: "jazz" },
    provider: "local",
    nextSeed: 9,
  });
  assert.equal(refine.mode, "refine");
  assert.equal(refine.text, "慢一点");
  assert.equal(refine.current, project.config);
  assert.equal(refine.title, project.title);
  assert.equal(refine.history.length, 2);
  assert.equal(refine.pins, undefined, "pins belong to the new-piece composer");

  const fresh = buildAgentRequest({
    text: "来点音乐",
    project: null,
    thread: [turn(0)],
    pins: { mood: "guofeng", duration: 60, loop: false },
    provider: "local",
    nextSeed: 9,
  });
  assert.equal(fresh.mode, "new");
  assert.deepEqual(fresh.history, []);
  assert.deepEqual(fresh.pins, { mood: "guofeng", duration: 60, loop: false });
  assert.equal(fresh.current.mood, "guofeng");
  assert.equal(fresh.current.instrument, stylePreset("guofeng").instrument);
  assert.equal(fresh.current.duration, 60);
  assert.equal(fresh.current.loop, false);
  assert.equal(fresh.current.prompt, "");
  assert.deepEqual(newPieceBase({}).volumes, DEFAULT_CONFIG.volumes);
  assert.notEqual(newPieceBase({}).volumes, DEFAULT_CONFIG.volumes);
});

test("pins reach the plan: the brains honour them and the app checks once more", () => {
  const request = buildAgentRequest({
    text: "国风古筝，一分钟，不循环",
    project: null,
    thread: [],
    pins: { mood: "jazz", duration: 30, loop: true },
    provider: "tencent",
    nextSeed: 5,
  });
  const planned = planWithRules(request);
  assert.equal(planned.config.mood, "jazz");
  assert.equal(planned.config.duration, 30);
  assert.equal(planned.config.loop, true);
  assert.equal(
    enforcePins(planned, request),
    planned,
    "a compliant plan is returned as it is",
  );

  // A brain that ignored the pins is corrected before anything is generated.
  const stray: AgentPlan = {
    ...planned,
    config: {
      ...planned.config,
      ...stylePreset("guofeng"),
      duration: 60,
      loop: false,
    },
    tags: ["国风古韵", "78 BPM", "古筝"],
    cloudPrompt: "国风",
  };
  const fixed = enforcePins(stray, request);
  assert.equal(fixed.config.mood, "jazz");
  assert.equal(fixed.config.bpm, stylePreset("jazz").bpm);
  assert.equal(fixed.config.duration, 30);
  assert.equal(fixed.config.loop, true);
  assert.equal(fixed.config.seed, stray.config.seed);
  assert.equal(fixed.tags[0], "爵士小馆");
  assert.ok(
    fixed.cloudPrompt?.includes("爵士小馆"),
    "the cloud prompt describes what will be made",
  );

  const free = buildAgentRequest({
    text: "国风古筝",
    project: null,
    thread: [],
    pins: {},
    provider: "local",
    nextSeed: 5,
  });
  const untouched = planWithRules(free);
  assert.equal(untouched.config.mood, "guofeng");
  assert.equal(enforcePins(untouched, free), untouched);
});

test("preview line: confident, unsure, pinned, empty", () => {
  assert.equal(planPreview("   ", {}), null);
  const sure = planPreview("国风古筝，不循环", {});
  assert.ok(sure && !sure.unsure);
  assert.match(
    sure.line,
    /^将创作：国风古韵 · 78 BPM · D 大调 · 古筝 · 30 秒 · 完整结尾$/,
  );
  const unsure = planPreview("asdf", {});
  assert.ok(unsure?.unsure);
  // UX-05: what was understood is still listed; only the style is a stand-in
  assert.match(
    unsure.line,
    /^将创作：.* · 循环片段；还没听出风格，暂按「青春欢快」/,
  );
  const pinned = planPreview("asdf", { mood: "jazz", duration: 60 });
  assert.ok(pinned && !pinned.unsure);
  assert.match(pinned.line, /^将创作：爵士小馆 · .* · 60 秒 · 循环片段$/);
  assert.equal(
    isUnsure({
      brain: "llm",
      reasoning: ["没有听出明确的风格词"],
    } as AgentPlan),
    false,
  );
});

test("suggestion chips fit the work and are all understood by the offline brain", () => {
  assert.deepEqual(suggestionsFor(null), []);
  const plain = localProject("p1");
  // UX-07: this piece already has its pad from the first bar to the last, so
  // "加点弦乐铺底" would make an identical version — the chip is not offered.
  assert.deepEqual(suggestionsFor(plain), [
    "慢一点",
    "更有活力",
    "换成古筝",
    "不要鼓",
    "混响大一点",
    "换一版旋律",
  ]);
  const other = localProject(
    "p2",
    {},
    {
      bpm: 56,
      energy: 0.9,
      instrument: "guzheng",
      volumes: { ...DEFAULT_CONFIG.volumes, drums: 0 },
      arrangement: { layers: { pad: true } },
    },
  );
  assert.deepEqual(suggestionsFor(other), [
    "快一点",
    "安静一点",
    "换成钢琴",
    "加上鼓",
    "混响大一点",
    "换一版旋律",
  ]);
  for (const project of [plain, other])
    for (const text of suggestionsFor(project)) {
      const plan = planWithRules({
        text,
        mode: "refine",
        current: project.config,
        provider: "local",
        history: [],
        nextSeed: 1,
        title: project.title,
      });
      assert.equal(plan.unchanged, false, `${text} must change the work`);
    }
});

test("every ready-made prompt is recognised by the offline brain", () => {
  const prompts = SCENARIO_GROUPS.flatMap((group) => group.prompts);
  assert.equal(prompts.length, 18);
  assert.equal(new Set(prompts.map((prompt) => prompt.id)).size, 18);
  assert.equal(QUICK_PROMPTS.length, 6);
  const styles = new Set<string>();
  for (const { prompt, title } of prompts) {
    assert.ok(prompt.length <= 1500);
    const preview = planPreview(prompt, {});
    assert.ok(preview && !preview.unsure, `${title}: ${preview?.line}`);
    styles.add(preview.config.mood);
  }
  assert.ok(styles.size >= 12, `only ${styles.size} styles are reached`);
  for (const style of STYLES) {
    const choice = styleInspiration(style);
    assert.equal(choice.mood, style.id);
    assert.equal(
      planPreview(choice.text, { mood: style.id })?.config.mood,
      style.id,
    );
  }
});

test("thread is capped at 40 turns, newest kept", () => {
  const turns = Array.from({ length: 45 }, (_, index) => turn(index));
  const capped = capThread(turns);
  assert.equal(capped.length, MAX_THREAD_TURNS);
  assert.equal(capped[0].id, "t5");
  assert.equal(capped[39].id, "t44");
  assert.notEqual(capThread(turns.slice(0, 3)), turns);
});

test("turns: sizes are bounded and direct controls carry no brain", () => {
  const plan = {
    reply: "好".repeat(2000),
    reasoning: [
      ...Array.from({ length: 12 }, (_, index) => `理由 ${index}`),
      "  ",
      "长".repeat(300),
    ],
    brain: "llm" as const,
  };
  const produced = agentTurn("a1", "2026-10-01T08:00:00.000Z", plan, {
    revision: 3,
  });
  assert.equal(produced.text.length, 1500);
  assert.equal(produced.reasoning?.length, 8);
  assert.equal(produced.brain, "llm");
  assert.equal(produced.revision, 3);
  const direct = agentTurn("a2", "2026-10-01T08:00:00.000Z", plan, {
    direct: true,
  });
  assert.equal(direct.brain, undefined);
  assert.equal(direct.revision, undefined);
  assert.equal(
    userTurn("u1", "2026-10-01T08:00:00.000Z", "x".repeat(1600)).text.length,
    1500,
  );
});

test("versions: new id, revision + 1, parentId, title rules, and a record storage accepts", () => {
  const plan = planWithRules({
    text: "雨夜咖啡馆，慵懒的钢琴",
    mode: "new",
    current: newPieceBase({}),
    provider: "local",
    history: [],
    nextSeed: 12,
  });
  const chat = [
    userTurn("u1", "2026-10-09T08:00:00.000Z", "雨夜咖啡馆，慵懒的钢琴"),
    agentTurn("a1", "2026-10-09T08:00:01.000Z", plan, { revision: 1 }),
  ];
  const first = buildProject({
    id: "one",
    now: "2026-10-09T08:00:02.000Z",
    plan,
    base: null,
    provider: "local",
    chat,
    audioDuration: 30.5,
  });
  assert.equal(first.revision, 1);
  assert.equal(first.parentId, undefined);
  assert.equal(first.title, plan.title);
  assert.equal(first.audioDuration, 30.5);
  assert.equal(first.favorite, false);
  assert.deepEqual(normalizeProject(first).chat, chat);

  const renamed = { ...first, title: "我的咖啡馆", favorite: true };
  const second = buildProject({
    id: "two",
    now: "2026-10-09T09:00:00.000Z",
    plan: { ...plan, title: "别的名字" },
    base: renamed,
    provider: "local",
    chat: [...chat, ...chat].map((item, index) => ({
      ...item,
      id: `c${index}`,
    })),
    audioDuration: Number.NaN,
  });
  assert.equal(second.revision, 2);
  assert.equal(second.parentId, "one");
  assert.equal(
    second.title,
    "我的咖啡馆",
    "a refinement keeps the work's title — no suffixes",
  );
  assert.equal(second.favorite, false);
  assert.equal(second.audioDuration, undefined);
  assert.equal(second.chat?.length, 4);
  normalizeProject(second);

  const long = buildProject({
    id: "three",
    now: "2026-10-09T09:00:00.000Z",
    plan: { ...plan, title: "   " },
    base: null,
    provider: "local",
    chat: Array.from({ length: 50 }, (_, index) => turn(index)),
  });
  assert.equal(long.title, "未命名作品");
  assert.equal(long.chat?.length, 40);
  assert.equal(durationChanged(undefined, 30), true);
  assert.equal(durationChanged(30, 30.01), false);
  assert.equal(durationChanged(30, 31), true);
  assert.equal(durationChanged(30, Number.NaN), false);
});

test("titles and messages are cleaned, never invented", () => {
  assert.equal(cleanTitle("  夏日\n小事  "), "夏日 小事");
  assert.equal(cleanTitle("   "), null);
  assert.equal(cleanTitle(42), null);
  assert.equal(cleanTitle("a".repeat(100))?.length, 64);
  assert.equal(
    cleanTitle(`${"a".repeat(63)}😀`),
    "a".repeat(63),
    "no half emoji",
  );
  assert.equal(cleanMessage("  慢一点\u0000 "), "慢一点");
  assert.equal(cleanMessage("x".repeat(2000)).length, 1500);
  assert.equal(cleanMessage(undefined), "");
});

test("a Latin service name is set off from the Chinese around it, a Chinese one is not", () => {
  assert.equal(
    joinText("腾讯云 TokenHub", "正在创作"),
    "腾讯云 TokenHub 正在创作",
  );
  assert.equal(
    joinText("火山引擎 AI 音乐", "正在创作"),
    "火山引擎 AI 音乐正在创作",
  );
  assert.equal(
    joinText("已移除", "ElevenLabs Music", "的凭据"),
    "已移除 ElevenLabs Music 的凭据",
  );
  assert.equal(
    joinText("请先在设置中保存", "阿里云百炼 Fun-Music", "的服务凭据。"),
    "请先在设置中保存阿里云百炼 Fun-Music 的服务凭据。",
  );
  assert.equal(
    joinText("", "本地作曲", "", "没有返回音乐"),
    "本地作曲没有返回音乐",
  );
  assert.equal(joinText("A", "B"), "AB", "nothing between two Latin pieces");
  assert.equal(joinText("版本 v", "2"), "版本 v2");
  assert.equal(joinText(), "");
  const job = { kind: "generate", brain: "rules" } as const;
  assert.equal(
    phaseText("cloud", { ...job, provider: "tencent" }),
    "腾讯云 TokenHub 正在创作，通常需要几十秒到几分钟",
  );
  assert.equal(
    phaseText("cloud", { ...job, provider: "volcengine" }),
    "火山引擎 AI 音乐正在创作，通常需要几十秒到几分钟",
  );
  assert.equal(
    phaseText("cloud", { ...job, provider: "elevenlabs" }),
    "ElevenLabs Music 正在创作，通常需要几十秒到几分钟",
  );
  // waiting for a language model says that one on this computer can take a minute or two (its limit is 240 s)
  assert.equal(
    phaseText("planning", { ...job, provider: "local", brain: "llm" }),
    "制作人（大模型）正在理解你的想法，本机模型可能需要一两分钟",
  );
  assert.equal(
    phaseText("planning", { ...job, provider: "local" }),
    "制作人正在理解你的想法",
  );
  const engines = engineOptions(
    { canUseCloud: true, canUseLlm: true },
    {
      providers: {
        tencent: { configured: true, damaged: true },
        volcengine: { configured: false },
        aliyun: { configured: false },
        elevenlabs: { configured: false },
      },
    },
  );
  assert.equal(
    engineProblem("tencent", engines)?.message,
    "腾讯云 TokenHub 的凭据无法读取，请在设置中重新保存。",
  );
  assert.equal(
    engineProblem("elevenlabs", engines)?.message,
    "请先在设置中保存 ElevenLabs Music 的服务凭据。",
  );
  assert.equal(
    engineProblem("volcengine", engines)?.message,
    "请先在设置中保存火山引擎 AI 音乐的服务凭据。",
  );
});

test("errors shown to the user are Chinese and free of IPC prefixes", () => {
  assert.equal(
    errorText(
      new Error(
        "Error invoking remote method 'muse:generate-music': Error: API Key 无效或已过期。",
      ),
      "x",
    ),
    "API Key 无效或已过期。",
  );
  assert.equal(
    errorText(
      new TypeError("Cannot read properties of undefined"),
      "生成失败，请重试。",
    ),
    "生成失败，请重试。",
  );
  assert.equal(errorText({ code: 5 }, "备用"), "备用");
  assert.equal(errorText("「我的作品」已满", "备用"), "「我的作品」已满");
  assert.equal(isAbort(new DOMException("x", "AbortError")), true);
  assert.equal(isAbort(new Error("x")), false);
});

test("mute remembers the fader; unmute returns to it", () => {
  const volumes = { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.33 };
  const muted = toggleMuteVolumes(volumes, {}, "drums", 0.56);
  assert.equal(muted.volumes.drums, 0);
  assert.deepEqual(muted.mutedFrom, { drums: 0.33 });
  const back = toggleMuteVolumes(muted.volumes, muted.mutedFrom, "drums", 0.56);
  assert.equal(back.volumes.drums, 0.33);
  assert.deepEqual(back.mutedFrom, {});
  // A work that was opened muted comes back at the reference level.
  const opened = toggleMuteVolumes({ ...volumes, drums: 0 }, {}, "drums", 0.56);
  assert.equal(opened.volumes.drums, 0.56);
  assert.deepEqual(volumes, {
    melody: 0.8,
    chords: 0.64,
    bass: 0.68,
    drums: 0.33,
  });
});

test("save scheduling: 400 ms after the last change, at once on release", () => {
  assert.equal(waitFor(IDLE, 1000), null);
  assert.equal(isDue(IDLE, 1000), false);
  let schedule = scheduleChange(1000, MIX_SAVE_DELAY_MS);
  assert.equal(waitFor(schedule, 1000), 400);
  assert.equal(isDue(schedule, 1399), false);
  // Another move restarts the wait.
  schedule = scheduleChange(1300, MIX_SAVE_DELAY_MS);
  assert.equal(isDue(schedule, 1400), false);
  assert.equal(isDue(schedule, 1700), true);
  // Pointer up: due immediately; with nothing pending, nothing is written.
  assert.equal(waitFor(scheduleRelease(schedule, 1350), 1350), 0);
  assert.equal(scheduleRelease(IDLE, 1350), IDLE);
  assert.equal(waitFor(schedule, 5000), 0);
});

test("autoplay only within a minute of the gesture that started the job", () => {
  assert.equal(shouldAutoplay(1000, 1000), true);
  assert.equal(shouldAutoplay(1000, 1000 + AUTOPLAY_WINDOW_MS - 1), true);
  assert.equal(shouldAutoplay(1000, 1000 + AUTOPLAY_WINDOW_MS), false);
  assert.equal(shouldAutoplay(null, 1000), false);
  assert.equal(shouldAutoplay(2000, 1000), false);
});

test("engines and producers: web offers local only and says where the rest is", () => {
  const off = {
    providers: {
      tencent: { configured: false },
      volcengine: { configured: false },
      aliyun: { configured: false },
      elevenlabs: { configured: false },
    },
    llm: { configured: false },
  };
  const web = engineOptions({ canUseCloud: false, canUseLlm: false }, off);
  assert.equal(web.length, 5);
  assert.deepEqual(
    web.map((option) => option.available),
    [true, false, false, false, false],
  );
  assert.ok(
    web
      .slice(1)
      .every((option) => option.hint === "桌面版可用" && option.desktopOnly),
  );
  assert.deepEqual(engineProblem("tencent", web), {
    message: "云端生成只在 Windows 桌面版中可用。",
  });
  assert.equal(engineProblem("local", web), null);
  const webBrains = brainOptions({ canUseCloud: false, canUseLlm: false }, off);
  assert.deepEqual(
    webBrains.map((option) => [option.id, option.available, option.hint]),
    [
      ["rules", true, undefined],
      ["llm", false, "桌面版可用"],
    ],
  );
  assert.equal(activeBrain("llm", webBrains), "rules");

  const on = {
    providers: {
      tencent: { configured: true },
      volcengine: { configured: true, damaged: true },
      aliyun: { configured: false },
      elevenlabs: { configured: true },
    },
    llm: { configured: true, model: "claude-opus-5-5" },
  };
  const desktop = engineOptions({ canUseCloud: true, canUseLlm: true }, on);
  assert.deepEqual(
    desktop.map((option) => option.available),
    [true, true, false, false, true],
  );
  assert.equal(engineProblem("tencent", desktop), null);
  assert.equal(engineProblem("volcengine", desktop)?.settingsTab, "music");
  assert.match(engineProblem("volcengine", desktop)?.message ?? "", /重新保存/);
  assert.match(
    engineProblem("aliyun", desktop)?.message ?? "",
    /请先在设置中保存/,
  );
  const brains = brainOptions({ canUseCloud: true, canUseLlm: true }, on);
  assert.equal(brains[1].label, "大模型 claude-opus-5-5");
  assert.equal(activeBrain("llm", brains), "llm");
  assert.equal(activeBrain("rules", brains), "rules");
  assert.equal(
    brainOptions(
      { canUseCloud: true, canUseLlm: true },
      { llm: { configured: true, damaged: true } },
    )[1].available,
    false,
  );
});

test("service limits are checked against the configuration that will be generated", () => {
  assert.equal(
    configProblem("local", { ...DEFAULT_CONFIG, duration: 15 }),
    null,
  );
  assert.equal(
    configProblem("tencent", { ...DEFAULT_CONFIG, duration: 15 }),
    null,
  );
  assert.equal(
    configProblem("volcengine", { ...DEFAULT_CONFIG, duration: 30 }),
    null,
  );
  assert.match(
    configProblem("volcengine", { ...DEFAULT_CONFIG, duration: 15 })?.message ??
      "",
    /30–120 秒.*15 秒/,
  );
});

test("the cancel message follows the running job", () => {
  assert.equal(
    cancelText({ kind: "open", stage: "rendering" }),
    "已取消打开作品",
  );
  assert.equal(
    cancelText({ kind: "open", stage: "decoding" }),
    "已取消打开作品",
  );
  assert.equal(
    cancelText({ kind: "generate", stage: "rendering" }),
    "已取消本地生成",
  );
  assert.match(
    cancelText({ kind: "generate", stage: "cloud" }),
    /可能仍会计费/,
  );
  assert.equal(
    cancelText({ kind: "generate", stage: "planning" }),
    "已取消本次编排",
  );
});

test("library helpers: order, search, filter, lineage", () => {
  const a = localProject("a", {
    title: "晴天漫游",
    updatedAt: "2026-10-01T08:00:00.000Z",
  });
  const b = localProject(
    "b",
    {
      title: "夜航",
      updatedAt: "2026-10-03T08:00:00.000Z",
      favorite: true,
      revision: 2,
      parentId: "a",
      audioDuration: 90,
    },
    { prompt: "深夜 飞行", mood: "ambient" },
  );
  const c = localProject("c", {
    title: "阿尔法",
    updatedAt: "2026-10-02T08:00:00.000Z",
    revision: 3,
    parentId: "b",
    tags: ["lofi"],
  });
  const list = upsertProject(upsertProject([a], b), c);
  assert.deepEqual(
    list.map((item) => item.id),
    ["b", "c", "a"],
  );
  assert.deepEqual(
    upsertProject(list, { ...a, updatedAt: "2026-10-04T08:00:00.000Z" }).map(
      (item) => item.id,
    ),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    queryProjects(list, { search: "深夜" }).map((item) => item.id),
    ["b"],
  );
  assert.deepEqual(
    queryProjects(list, { search: "LOFI" }).map((item) => item.id),
    ["c"],
  );
  assert.deepEqual(
    queryProjects(list, { search: "氛围冥想" }).map((item) => item.id),
    ["b"],
  );
  assert.deepEqual(
    queryProjects(list, { favouritesOnly: true }).map((item) => item.id),
    ["b"],
  );
  assert.deepEqual(
    queryProjects(list, { sort: "duration" }).map((item) => item.id),
    ["b", "c", "a"],
  );
  assert.equal(queryProjects(list, { sort: "title" }).length, 3);
  assert.equal(versionLabel(a, list), "v1");
  assert.equal(versionLabel(b, list), "v2 · 源自《晴天漫游》");
  assert.equal(versionLabel(b, [b]), "v2");
  assert.equal(findVersion(c, list, 1)?.id, "a");
  assert.equal(findVersion(c, list, 3)?.id, "c");
  assert.equal(findVersion(c, [c], 1), undefined);
  assert.equal(findVersion(null, list, 1), undefined);
});

test("session: small, tolerant of anything stored, never throws", () => {
  assert.deepEqual(parseSession(null), EMPTY_SESSION);
  assert.deepEqual(parseSession("{not json"), EMPTY_SESSION);
  assert.deepEqual(parseSession("[1]"), EMPTY_SESSION);
  assert.deepEqual(
    parseSession(
      JSON.stringify({ lastProjectId: 5, composerText: 7, brain: "gpt" }),
    ),
    EMPTY_SESSION,
  );
  const noted = {
    lastProjectId: "abc",
    composerText: "海边",
    brain: "llm" as const,
    pendingRemovals: [
      { id: "gone-1", expiresAt: 1_800_000_000_000 },
      { id: "gone-2", expiresAt: 0 },
    ],
    pendingMixes: [
      { id: "abc", volumes: { drums: 0.54 }, at: 1_800_000_000_000 },
    ],
  };
  assert.deepEqual(parseSession(serializeSession(noted)), noted);
  assert.equal(
    parseSession(JSON.stringify({ composerText: "x".repeat(5000) }))
      .composerText.length,
    1500,
  );
  // A session written by an older build has no list; anything odd in the list is dropped.
  assert.deepEqual(
    parseSession(JSON.stringify({ lastProjectId: "abc" })).pendingRemovals,
    [],
  );
  assert.deepEqual(
    parseSession(JSON.stringify({ pendingRemovals: "all" })).pendingRemovals,
    [],
  );
  // v0.3.0 wrote bare ids: deletions to finish at the next start.
  assert.deepEqual(
    parseSession(
      JSON.stringify({
        pendingRemovals: ["a", 7, "", null, "a", "x".repeat(121), "b"],
      }),
    ).pendingRemovals,
    [
      { id: "a", expiresAt: 0 },
      { id: "b", expiresAt: 0 },
    ],
  );
  assert.deepEqual(
    parseSession(
      JSON.stringify({
        pendingRemovals: [
          { id: "a", expiresAt: "soon" },
          { id: 5 },
          { expiresAt: 3 },
          [],
          { id: "b", expiresAt: 12 },
        ],
      }),
    ).pendingRemovals,
    [
      { id: "a", expiresAt: 0 },
      { id: "b", expiresAt: 12 },
    ],
  );
  // Fader notes: only real tracks and finite levels, clamped; a note without any is dropped.
  assert.deepEqual(
    parseSession(
      JSON.stringify({
        pendingMixes: [
          {
            id: "m",
            volumes: { drums: 7, melody: "loud", hihat: 0.2, bass: 0.25 },
            at: 5,
          },
          { id: "n", volumes: {}, at: 5 },
          { id: "o", volumes: { drums: 0.5 } },
          "junk",
        ],
      }),
    ).pendingMixes,
    [{ id: "m", volumes: { bass: 0.25, drums: 1 }, at: 5 }],
  );
  assert.notEqual(parseSession(null).pendingMixes, EMPTY_SESSION.pendingMixes);
  assert.equal(
    parseSession(
      JSON.stringify({
        pendingRemovals: Array.from({ length: 80 }, (_, i) => `id-${i}`),
      }),
    ).pendingRemovals.length,
    50,
  );
  assert.notEqual(
    parseSession(null).pendingRemovals,
    EMPTY_SESSION.pendingRemovals,
    "every read gets its own list",
  );
  const map = new Map<string, string>();
  const store = createSessionStore(() => ({
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  }));
  store.write({
    lastProjectId: "p",
    composerText: "t",
    brain: "rules",
    pendingRemovals: [],
    pendingMixes: [],
  });
  assert.ok(map.has(SESSION_KEY));
  assert.equal(store.read().lastProjectId, "p");
  const broken = createSessionStore(() => {
    throw new Error("SecurityError");
  });
  assert.deepEqual(broken.read(), EMPTY_SESSION);
  broken.write(EMPTY_SESSION);
  const refusing = createSessionStore(() => ({
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("quota");
    },
  }));
  assert.deepEqual(refusing.read(), EMPTY_SESSION);
  refusing.write(EMPTY_SESSION);
  assert.deepEqual(createSessionStore(() => undefined).read(), EMPTY_SESSION);
});

test("shortcuts: real ones only, never while typing or composing", () => {
  const key = (
    k: string,
    extra: Partial<Parameters<typeof shortcutFor>[0]> = {},
  ) => shortcutFor({ key: k, focus: "other", modalOpen: false, ...extra });
  assert.equal(key(" "), "toggle-play");
  assert.equal(key(" ", { focus: "text" }), null);
  assert.equal(
    key(" ", { focus: "button" }),
    null,
    "Space already clicks the button",
  );
  assert.equal(key(" ", { focus: "range" }), "toggle-play");
  assert.equal(key("ArrowLeft"), "seek-back");
  assert.equal(key("ArrowRight", { focus: "button" }), "seek-forward");
  assert.equal(
    key("ArrowRight", { focus: "range" }),
    null,
    "arrows move the slider",
  );
  assert.equal(key("ArrowLeft", { focus: "text" }), null);
  assert.equal(key("l"), "toggle-loop");
  assert.equal(key("L", { shiftKey: true }), null);
  assert.equal(key("l", { focus: "text" }), null);
  assert.equal(key("Enter", { ctrlKey: true, focus: "text" }), "send");
  assert.equal(key("Enter", { metaKey: true, focus: "text" }), "send");
  assert.equal(key("Enter", { focus: "text" }), null);
  assert.equal(key("n", { ctrlKey: true }), "new-piece");
  assert.equal(key("E", { ctrlKey: true, focus: "text" }), "export");
  assert.equal(key("e"), null);
  assert.equal(
    key("Enter", { ctrlKey: true, composing: true, focus: "text" }),
    null,
  );
  assert.equal(key("Escape", { modalOpen: true, focus: "text" }), "close");
  assert.equal(key("Escape"), null);
  assert.equal(key(" ", { modalOpen: true }), null);
  assert.equal(key("Enter", { ctrlKey: true, modalOpen: true }), null);
});

test("originalFormat never throws for an unknown MIME type", () => {
  assert.equal(originalFormat("audio/mpeg"), "mp3");
  assert.equal(originalFormat("audio/x-wav"), "wav");
  assert.equal(originalFormat("video/mp4"), "m4a");
  assert.equal(originalFormat("AUDIO/FLAC; charset=binary"), "flac");
  assert.equal(originalFormat("application/octet-stream"), null);
  assert.equal(originalFormat(""), null);
  assert.equal(originalFormat(undefined), null);
  assert.equal(originalFormat("__proto__"), null);
  assert.equal(originalFormatLabel("audio/ogg"), "未知格式");
  assert.equal(originalFormatLabel("audio/mp3"), "MP3");
});

test("display helpers", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(72.9), "1:12");
  assert.equal(formatTime(Number.NaN), "0:00");
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
});
