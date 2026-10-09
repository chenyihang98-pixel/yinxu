// Pure logic behind the interface (src/ui/logic) and the small state
// refinements the interface needed. No DOM.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LLM_PRESETS } from "../src/agent/llm-presets";
import { planWithRules } from "../src/agent/rules";
import type { AgentPlan } from "../src/agent/types";
import { STYLES, instrumentLabel, styleLabel } from "../src/music/catalog";
import type { InstrumentId } from "../src/music/catalog";
import { compose, summarize } from "../src/music/compose";
import {
  DEFAULT_CONFIG,
  clampConfig,
  stylePreset,
} from "../src/music/defaults";
import { TRACKS } from "../src/music/score";
import { CLOUD_PROVIDERS, EMPTY_PROVIDER_STATUSES } from "../src/providers";
import {
  DESCRIPTION_EXAMPLES,
  FIELD_LABELS,
  MODEL_NAME_SHAPES,
  PARAMETER_EXAMPLE,
  QUICK_PROMPTS,
  REFINE_EXAMPLES,
  SCENARIO_GROUPS,
  STYLE_CARDS,
  THREAD_EXAMPLES,
  modelNameHint,
  scenarioInspiration,
  styleInspiration,
} from "../src/state/content";
import {
  cardLine,
  draftFit,
  fitNotice,
  formatBpm,
  formatSeconds,
  metaLine,
  structureLabel,
  workTiming,
} from "../src/state/format";
import {
  ENGINE_STARTING,
  engineOptions,
  engineProblem,
} from "../src/state/options";
import {
  applyHint,
  buildAgentRequest,
  enforcePins,
  inaudiblePlan,
  isUnsure,
  planFromDraft,
  planPreview,
  suggestionsFor,
  truthfulTiming,
  withAskedDrums,
  wouldChange,
} from "../src/state/plan";
import { agentTurn, houseQuotes, houseTerms } from "../src/state/logic";
import { initialState, reducer } from "../src/state/reducer";
import {
  audibleKey,
  fittedTiming,
  scoreFacts,
  silentStem,
} from "../src/state/score";
import { DRAFT_FIELDS } from "../src/state/types";
import { versionLabel, versionTag } from "../src/state/works";
import { rovingIndex, trapTarget } from "../src/ui/logic/focus";
import {
  groupByName,
  groupByParts,
  stemInstruments,
} from "../src/ui/logic/instruments";
import {
  NAVIGATION_WINDOW_MS,
  tipFocusAllowed,
  tipPlacement,
} from "../src/ui/logic/tooltip";
import type { MusicConfig, Project } from "../src/types";
import { defer, harness, localProject, settle } from "./helpers/app-fakes";
import type { Harness } from "./helpers/app-fakes";
import {
  chordLabelWidth,
  chordLayout,
  chordPill,
  percentAt,
  resamplePeaks,
  sliderRatio,
  spanIndexAt,
  timeAtX,
  waveBarCount,
} from "../src/ui/logic/timeline";

/* ---------------- time axis ---------------- */

test("spanIndexAt: the last span that has started", () => {
  const spans = [
    { start: 0, end: 4 },
    { start: 4, end: 10 },
    { start: 10, end: 12 },
  ];
  assert.equal(spanIndexAt(spans, 0), 0);
  assert.equal(spanIndexAt(spans, 3.999), 0);
  assert.equal(spanIndexAt(spans, 4), 1);
  assert.equal(spanIndexAt(spans, 9.5), 1);
  assert.equal(spanIndexAt(spans, 10), 2);
  // past the end (the playhead rests on the last frame) stays on the last span
  assert.equal(spanIndexAt(spans, 12), 2);
  assert.equal(spanIndexAt(spans, 99), 2);
});

test("spanIndexAt: nothing before the first span, nothing for no spans or NaN", () => {
  assert.equal(spanIndexAt([], 3), -1);
  assert.equal(spanIndexAt([{ start: 2, end: 4 }], 1), -1);
  assert.equal(spanIndexAt([{ start: 0, end: 4 }], Number.NaN), -1);
});

test("spanIndexAt agrees with a linear scan on a long chord list", () => {
  const spans = Array.from({ length: 77 }, (_, index) => ({
    start: index * 1.5,
    end: (index + 1) * 1.5,
  }));
  for (let time = 0; time < 120; time += 0.37) {
    let expected = -1;
    for (let index = 0; index < spans.length; index++)
      if (spans[index].start <= time) expected = index;
    assert.equal(spanIndexAt(spans, time), expected, `at ${time}`);
  }
});

test("percentAt clamps to the axis", () => {
  assert.equal(percentAt(15, 60), 25);
  assert.equal(percentAt(-3, 60), 0);
  assert.equal(percentAt(90, 60), 100);
  assert.equal(percentAt(10, 0), 0);
  assert.equal(percentAt(Number.NaN, 60), 0);
});

test("timeAtX maps a pointer position to seconds and clamps", () => {
  assert.equal(timeAtX(50, 200, 60), 15);
  assert.equal(timeAtX(-10, 200, 60), 0);
  assert.equal(timeAtX(500, 200, 60), 60);
  assert.equal(timeAtX(50, 0, 60), 0);
});

test("sliderRatio is the filled share of a range", () => {
  assert.equal(sliderRatio(50, 0, 100), 0.5);
  assert.equal(sliderRatio(125, 50, 200), 0.5);
  assert.equal(sliderRatio(999, 0, 100), 1);
  assert.equal(sliderRatio(-1, 0, 100), 0);
  assert.equal(sliderRatio(5, 10, 10), 0);
});

const chord = (start: number, end: number, symbol: string) => ({
  start,
  end,
  symbol,
});

test("chordLayout: every chord is labelled when there is room, the first one included", () => {
  const chords = [
    chord(0, 4, "D"),
    chord(4, 8, "Bm7"),
    chord(8, 12, "Gadd9"),
    chord(12, 16, "A"),
  ];
  const marks = chordLayout(chords, 16, 800);
  assert.deepEqual(
    marks.map((mark) => mark.label),
    [true, true, true, true],
  );
  assert.deepEqual(
    marks.map((mark) => mark.tick),
    [true, true, true, true],
  );
});

test("chordLayout: a repeated chord is a continuation — no label and no tick", () => {
  const chords = [
    chord(0, 2, "C"),
    chord(2, 4, "C"),
    chord(4, 6, "C"),
    chord(6, 8, "G"),
  ];
  const marks = chordLayout(chords, 8, 600);
  assert.deepEqual(marks[1], { label: false, tick: false });
  assert.deepEqual(marks[2], { label: false, tick: false });
  assert.deepEqual(marks[3], { label: true, tick: true });
});

test("chordLayout: labels never overlap and no tick cuts through a label", () => {
  // 76 chords in 320 px: about 4 px each
  const symbols = ["Cmaj7", "Am7", "Dm7", "G7", "Em7", "Fmaj7"];
  const chords = Array.from({ length: 76 }, (_, index) =>
    chord(index, index + 1, symbols[index % symbols.length]),
  );
  for (const width of [288, 500, 838, 1200]) {
    const marks = chordLayout(chords, 76, width);
    let inked = Number.NEGATIVE_INFINITY;
    let labels = 0;
    chords.forEach((item, index) => {
      const left = (item.start / 76) * width;
      if (marks[index].tick)
        assert.ok(left >= inked, `tick inside a label at ${width}`);
      if (!marks[index].label) return;
      labels++;
      assert.ok(left >= inked, `overlapping labels at ${width}`);
      assert.ok(
        left + chordLabelWidth(item.symbol) <= width + 1,
        "label leaves the strip",
      );
      assert.ok(marks[index].tick, "a labelled chord has its tick");
      inked = left + chordLabelWidth(item.symbol);
    });
    assert.ok(labels >= 4, `only ${labels} labels at ${width} px`);
  }
});

test("chordLayout: nothing to draw without a width or a duration", () => {
  const chords = [chord(0, 4, "C")];
  assert.deepEqual(chordLayout(chords, 4, 0), [{ label: false, tick: false }]);
  assert.deepEqual(chordLayout(chords, 0, 300), [
    { label: false, tick: false },
  ]);
  assert.deepEqual(chordLayout([], 4, 300), []);
});

test("chordPill: the highlighted chord hides the labels it would cover, and nothing else", () => {
  const chords = [
    chord(0, 2, "Dadd9"),
    chord(2, 4, "Gadd9"),
    chord(4, 6, "A"),
    chord(6, 8, "Bm"),
    chord(40, 42, "D"),
  ];
  // 400 px for 42 s: the first four chords are about 19 px apart
  const width = 400;
  const marks = chordLayout(chords, 42, width);
  assert.equal(marks[0].label, true);
  const pill = chordPill(chords, marks, 1, 42, width);
  assert.equal(pill.edge, false);
  // "Dadd9" (printed from 0 px, ~45 px wide) runs under the pill at 19 px
  assert.ok(pill.hidden.has(0));
  assert.ok(!pill.hidden.has(1), "the current chord itself stays");
  assert.ok(!pill.hidden.has(4), "a label far away stays");
  // nothing is hidden when no chord is playing
  assert.equal(chordPill(chords, marks, -1, 42, width).hidden.size, 0);
});

test("chordPill: at the right edge the pill hangs to the left", () => {
  const chords = [chord(0, 28, "C"), chord(28, 30, "Gsus4/D")];
  const marks = chordLayout(chords, 30, 300);
  const pill = chordPill(chords, marks, 1, 30, 300);
  assert.equal(pill.edge, true);
  assert.equal(chordPill(chords, marks, 0, 30, 300).edge, false);
});

test("resamplePeaks keeps the loudest input when shrinking", () => {
  const peaks = [0.1, 0.9, 0.2, 0.3, 0.8, 0.1, 0, 0.5];
  assert.deepEqual(resamplePeaks(peaks, 4), [0.9, 0.3, 0.8, 0.5]);
  assert.deepEqual(resamplePeaks(peaks, 8), peaks);
});

test("resamplePeaks interpolates when stretching and keeps both ends", () => {
  const out = resamplePeaks([0, 1], 5);
  assert.deepEqual(out, [0, 0.25, 0.5, 0.75, 1]);
  const long = resamplePeaks([0.2, 0.6, 0.4], 300);
  assert.equal(long.length, 300);
  assert.equal(long[0], 0.2);
  assert.equal(long[299], 0.4);
  assert.ok(long.every((value) => value >= 0.2 - 1e-9 && value <= 0.6 + 1e-9));
});

test("resamplePeaks survives empty, odd and dirty input", () => {
  assert.deepEqual(resamplePeaks([], 4), [0, 0, 0, 0]);
  assert.deepEqual(resamplePeaks([0.5], 0), []);
  assert.deepEqual(resamplePeaks([0.5], 3), [0.5, 0.5, 0.5]);
  assert.deepEqual(resamplePeaks([Number.NaN, 7, -2], 3), [0, 1, 0]);
});

test("waveBarCount: one bar per 4 px, never fewer than 8", () => {
  assert.equal(waveBarCount(800), 200);
  assert.equal(waveBarCount(288), 72);
  assert.equal(waveBarCount(10), 8);
});

/* ---------------- mixer groups ---------------- */

test("groupByName: lead, drums and bass by name, the rest under 和声", () => {
  const groups = groupByName(
    ["古筝", "竹笛", "尼龙吉他", "指弹贝斯", "原声鼓组", "打击乐点缀"],
    "古筝",
  );
  assert.deepEqual(groups, {
    melody: ["古筝"],
    chords: ["竹笛", "尼龙吉他"],
    bass: ["指弹贝斯"],
    drums: ["原声鼓组", "打击乐点缀"],
  });
});

test("groupByParts follows the track of each part and names the lead's instrument wherever it plays", () => {
  const names = ["柔和钢琴", "弦乐", "指弹贝斯", "流行鼓组"];
  const groups = groupByParts(
    [
      { kind: "notes", role: "lead", track: "melody", voice: "piano" },
      { kind: "notes", role: "counter", track: "melody", voice: "strings" },
      // the pianist's left hand is not a second instrument — but it IS the
      // piano playing the chords, and 和声 says so (UX-07)
      { kind: "notes", role: "comp", track: "chords", voice: "piano" },
      { kind: "notes", role: "pad", track: "chords", voice: "strings" },
      { kind: "notes", role: "bass", track: "bass", voice: "fingerBass" },
      { kind: "drums", role: "kit", track: "drums" },
    ],
    names,
    { instrument: "piano" },
  );
  assert.deepEqual(groups, {
    melody: ["柔和钢琴", "弦乐"],
    chords: ["柔和钢琴", "弦乐"],
    bass: ["指弹贝斯"],
    drums: ["流行鼓组"],
  });
});

test("stemInstruments: every style's instruments land in a group, the lead in 旋律", () => {
  for (const style of STYLES) {
    const config = clampConfig({
      ...DEFAULT_CONFIG,
      ...stylePreset(style.id),
      duration: 30,
      seed: 4242,
    });
    const summary = summarize(compose(config));
    const groups = stemInstruments(config, summary);
    const placed = new Set(TRACKS.flatMap((track) => groups[track]));
    for (const name of summary.instruments)
      assert.ok(placed.has(name), `${style.id}: ${name} is in no group`);
    for (const name of placed)
      assert.ok(
        summary.instruments.includes(name),
        `${style.id}: ${name} was invented`,
      );
    assert.equal(
      groups.melody[0],
      instrumentLabel(config.instrument),
      style.id,
    );
    for (const name of groups.drums)
      assert.match(name, /鼓|打击/, `${style.id}: ${name} under 鼓组`);
    for (const name of groups.bass)
      assert.match(name, /贝斯|低音提琴/, `${style.id}: ${name} under 贝斯`);
  }
});

test("stemInstruments: empty for old-engine works and for audio without a summary", () => {
  const config = clampConfig({ ...DEFAULT_CONFIG, duration: 15 });
  const none = { melody: [], chords: [], bass: [], drums: [] };
  assert.deepEqual(stemInstruments(config, undefined), none);
  assert.deepEqual(stemInstruments(config, { instruments: [] }), none);
  assert.deepEqual(
    stemInstruments({ ...config, engine: 1 }, { instruments: ["柔和钢琴"] }),
    none,
  );
});

test("stemInstruments falls back to names when the score does not explain the list", () => {
  const config = clampConfig({ ...DEFAULT_CONFIG, duration: 15 });
  const groups = stemInstruments(config, {
    instruments: [
      instrumentLabel(config.instrument),
      "手风琴",
      "电贝斯",
      "大鼓",
    ],
  });
  assert.deepEqual(groups.melody, [instrumentLabel(config.instrument)]);
  assert.deepEqual(groups.chords, ["手风琴"]);
  assert.deepEqual(groups.bass, ["电贝斯"]);
  assert.deepEqual(groups.drums, ["大鼓"]);
});

/* ---------------- focus ---------------- */

test("trapTarget wraps Tab at both ends of a dialog and leaves the middle alone", () => {
  const items = ["close", "tab", "field", "save"];
  assert.equal(trapTarget(items, "save", false), "close");
  assert.equal(trapTarget(items, "close", true), "save");
  assert.equal(trapTarget(items, "tab", false), null);
  assert.equal(trapTarget(items, "field", true), null);
  // focus on the dialog itself, or lost to the page behind
  assert.equal(trapTarget(items, null, false), "close");
  assert.equal(trapTarget(items, "elsewhere", true), "save");
  assert.equal(trapTarget([], null, false), null);
  assert.equal(trapTarget(["only"], "only", false), "only");
});

test("rovingIndex: arrows wrap, Home and End jump, other keys do nothing", () => {
  assert.equal(rovingIndex("ArrowRight", 0, 3), 1);
  assert.equal(rovingIndex("ArrowRight", 2, 3), 0);
  assert.equal(rovingIndex("ArrowLeft", 0, 3), 2);
  assert.equal(rovingIndex("ArrowDown", 1, 3), 2);
  assert.equal(rovingIndex("ArrowUp", 1, 3), 0);
  assert.equal(rovingIndex("Home", 2, 3), 0);
  assert.equal(rovingIndex("End", 0, 3), 2);
  assert.equal(rovingIndex("Enter", 0, 3), null);
  assert.equal(rovingIndex("ArrowRight", 0, 0), null);
});

/* ---------------- state: which service the settings open on ---------------- */

test("refusing an unconfigured engine names the service for the settings modal", () => {
  const desktop = engineOptions(
    { canUseCloud: true, canUseLlm: true },
    { providers: EMPTY_PROVIDER_STATUSES },
  );
  const refusal = engineProblem("aliyun", desktop);
  assert.equal(refusal?.settingsTab, "music");
  assert.equal(refusal?.provider, "aliyun");
  assert.equal(engineProblem("local", desktop), null);
  // the web build has nowhere to configure it: no tab, no service
  const web = engineOptions(
    { canUseCloud: false, canUseLlm: false },
    { providers: EMPTY_PROVIDER_STATUSES },
  );
  assert.equal(engineProblem("aliyun", web)?.settingsTab, undefined);
  assert.equal(engineProblem("aliyun", web)?.provider, undefined);
});

test("ui.settingsProvider lives for one opening of the settings modal", () => {
  let state = initialState({ desktop: true, version: "test" });
  assert.equal(state.ui.settingsProvider, null);
  state = reducer(state, {
    type: "ui/modal",
    modal: "settings",
    settingsTab: "music",
    settingsProvider: "volcengine",
  });
  assert.equal(state.ui.modal, "settings");
  assert.equal(state.ui.settingsProvider, "volcengine");
  // switching tabs inside the modal keeps the hint
  state = reducer(state, {
    type: "ui/modal",
    modal: "settings",
    settingsTab: "llm",
  });
  assert.equal(state.ui.settingsTab, "llm");
  assert.equal(state.ui.settingsProvider, "volcengine");
  // closing forgets it; the next plain opening has no preference
  state = reducer(state, { type: "ui/modal", modal: null });
  assert.equal(state.ui.settingsProvider, null);
  state = reducer(state, { type: "ui/modal", modal: "settings" });
  assert.equal(state.ui.settingsProvider, null);
  assert.equal(state.ui.settingsTab, "llm");
  // other dialogs never carry it
  state = reducer(state, {
    type: "ui/modal",
    modal: "export",
    settingsProvider: "tencent",
  });
  assert.equal(state.ui.settingsProvider, null);
});

/* ================================================================== */
/* v0.3 review: truthful words and input that is never lost             */
/* ================================================================== */

const studioOf = (h: Harness) => h.core.getState().studio;
const toastsOf = (h: Harness) => h.core.getState().ui.toasts;
const styled = (
  style: (typeof STYLES)[number]["id"],
  config: Partial<MusicConfig> = {},
): MusicConfig =>
  clampConfig({
    ...DEFAULT_CONFIG,
    ...stylePreset(style),
    seed: 11,
    ...config,
  });
const work = (config: MusicConfig, patch: Partial<Project> = {}): Project =>
  localProject("w", patch, config);
const refine = (config: MusicConfig, text: string): AgentPlan =>
  planWithRules({
    text,
    mode: "refine",
    current: config,
    provider: "local",
    history: [],
    nextSeed: 9,
    title: "测试",
  });
const fresh = (text: string, pins = {}) => {
  const request = buildAgentRequest({
    text,
    project: null,
    thread: [],
    pins,
    provider: "local",
    nextSeed: 5,
  });
  return enforcePins(planWithRules(request), request);
};

/* ---------------- UX-04: tempo and length are the audio's ---------------- */

test("UX-04: fittedTiming is the composer's own tempo and length, for every style, length and structure", () => {
  let fittedLoops = 0;
  for (const style of STYLES)
    for (const duration of [15, 30, 60, 90, 120])
      for (const loop of [true, false]) {
        const config = styled(style.id, { duration, loop });
        const score = compose(config);
        const fitted = fittedTiming(config);
        assert.equal(fitted.bpm, score.bpm, `${style.id} ${duration} ${loop}`);
        assert.equal(
          fitted.duration,
          score.duration,
          `${style.id} ${duration} ${loop}`,
        );
        if (!loop) {
          assert.equal(fitted.bpm, config.bpm);
          assert.equal(fitted.duration, config.duration);
        } else if (fitted.adjusted !== "none") fittedLoops++;
      }
  // the finding: this is the common case for loops, not an edge
  assert.ok(fittedLoops > 40, `${fittedLoops} of 110 loops are fitted`);
});

test("UX-04: tempo and length are written as they are, without false precision", () => {
  assert.equal(formatBpm(144), "144");
  assert.equal(formatBpm(143.99999), "144");
  assert.equal(formatBpm(117.3333), "117.3");
  assert.equal(formatSeconds(18), "18");
  assert.equal(formatSeconds(29.3333), "29.3");
  assert.equal(structureLabel(true), "循环片段");
  assert.equal(structureLabel(false), "完整结尾");
});

test("UX-04: header, library card and footnote state what the audio is; the setting is secondary", () => {
  // the reviewer's two cases: a fitted tempo (140 → 144) and a snapped length (15 s → 18 s)
  const pixel = work(styled("chiptune", { duration: 60 }));
  assert.equal(pixel.config.bpm, 140);
  assert.equal(
    metaLine(pixel),
    "像素 8-bit · 144 BPM · C 大调 · 8-bit 方波 · 循环片段",
  );
  assert.equal(
    cardLine({ ...pixel, audioDuration: 60 }),
    "像素 8-bit · 144 BPM · 1:00 · 本地作曲",
  );
  assert.equal(
    fitNotice(pixel),
    "设定 140 BPM；循环片段按整小节对齐，实际是 144 BPM",
  );
  assert.deepEqual(workTiming(pixel), {
    bpm: 144,
    duration: 60,
    askedBpm: 140,
  });

  const chill = work(styled("chill", { duration: 15, energy: 0.12 }));
  assert.equal(
    metaLine(chill),
    "慵懒松弛 · 80 BPM · F 大调 · 电钢琴 · 循环片段",
  );
  assert.equal(
    fitNotice(chill),
    "设定 15 秒；循环片段按整小节对齐，实际是 18 秒",
  );
  // not rendered yet (a fresh import): the card already shows the length it will have
  assert.equal(cardLine(chill), "慵懒松弛 · 80 BPM · 0:18 · 本地作曲");
  assert.deepEqual(workTiming(chill), {
    bpm: 80,
    duration: 18,
    askedDuration: 15,
  });

  // what the loaded audio says wins over the plan (one decimal when it is not whole)
  assert.match(
    metaLine(pixel, { bpm: 117.3333, duration: 61.4 }),
    /· 117\.3 BPM ·/,
  );
  assert.equal(
    fitNotice(pixel, { bpm: 117.3333, duration: 61.4 }),
    "设定 140 BPM、60 秒；循环片段按整小节对齐，实际是 117.3 BPM、61.4 秒",
  );

  // exactly as asked: nothing to add
  const ending = work(styled("chiptune", { duration: 60, loop: false }));
  assert.equal(
    metaLine(ending),
    "像素 8-bit · 140 BPM · C 大调 · 8-bit 方波 · 完整结尾",
  );
  assert.equal(fitNotice(ending), null);
  assert.equal(fitNotice(ending, { bpm: 140, duration: 60 }), null);

  // a cloud work was generated from a description: no tempo is claimed for it
  const cloud = work(styled("guofeng"), {
    provider: "tencent",
    audioDuration: 42.5,
  });
  assert.equal(
    metaLine(cloud),
    "生成要求：国风古韵 · 约 78 BPM · D 大调 · 古筝 · 循环片段",
  );
  assert.equal(cardLine(cloud), "国风古韵 · 0:42 · 腾讯云 TokenHub");
  assert.equal(workTiming(cloud).bpm, null);
  assert.equal(fitNotice(cloud), "设定 30 秒；云端生成的音频实际是 42.5 秒");

  // a v0.2 work is what its settings say, at the length that was rendered
  const legacy = work(
    { ...styled("chiptune", { duration: 60 }), engine: 1 },
    { audioDuration: 60 },
  );
  assert.equal(
    metaLine(legacy),
    "像素 8-bit · 140 BPM · C 大调 · 8-bit 方波 · 循环片段",
  );
  assert.equal(fitNotice(legacy), null);
});

test("UX-04: the inspector says what a loop draft will really get", () => {
  assert.deepEqual(draftFit(styled("chiptune", { duration: 60 })), {
    bpm: "循环片段按整小节对齐：实际 144 BPM",
  });
  assert.deepEqual(draftFit(styled("chill", { duration: 15 })), {
    duration: "循环片段按整小节对齐：实际 18 秒（6 小节）",
  });
  assert.deepEqual(
    draftFit(styled("chiptune", { duration: 60, loop: false })),
    {},
  );
  assert.deepEqual(
    draftFit({ ...styled("chiptune", { duration: 60 }), engine: 1 }),
    {},
  );
});

test("UX-04: the preview promises the fitted tempo and length, with the setting next to it", () => {
  assert.equal(
    planPreview("", { mood: "chiptune", duration: 60 })?.line,
    "将创作：像素 8-bit · 144 BPM（设定 140） · C 大调 · 8-bit 方波 · 60 秒 · 循环片段",
  );
  assert.match(
    planPreview("雨夜咖啡馆，慵懒的钢琴和轻轻的鼓点", { duration: 15 })?.line ??
      "",
    /^将创作：慵懒松弛 · 80 BPM · .* · 18 秒（设定 15 秒） · 循环片段$/,
  );
  // a cloud service only gets the description: there the settings are a target
  assert.match(
    planPreview("", { mood: "chiptune", duration: 60 }, "tencent")?.line ?? "",
    /^目标：像素 8-bit · 140 BPM · .* · 60 秒 · 循环片段（云端按描述生成，结果可能不同）$/,
  );
  // the language model plans for itself: the line is the offline reading, and says so
  assert.match(
    planPreview("国风古筝，悠闲", {}, "local", "llm")?.line ?? "",
    /^离线规则的理解：国风古韵 · .*；发送后由大模型重新理解，方案可能不同$/,
  );
  assert.equal(
    planPreview("asdf", {}, "local", "llm")?.line,
    "发送后由大模型来理解这段描述（离线规则没有听出风格）",
  );
});

test("UX-04: the producer's reply, chips and tags state the fitted tempo and length", () => {
  let restated = 0;
  for (const style of STYLES)
    for (const duration of [15, 30, 60, 90, 120]) {
      const raw = fresh("", { mood: style.id, duration, loop: true });
      const plan = truthfulTiming(raw, "local", null);
      const fitted = fittedTiming(plan.config);
      const bpm = formatBpm(fitted.bpm);
      const seconds = formatSeconds(fitted.duration);
      const where = `${style.id} ${duration}s: ${plan.reply}`;
      const tempos = [...plan.reply.matchAll(/([\d.]+) BPM/g)].map(
        (match) => match[1],
      );
      const lengths = [...plan.reply.matchAll(/([\d.]+) 秒/g)].map(
        (match) => match[1],
      );
      assert.ok(
        tempos.length > 0 && tempos.every((value) => value === bpm),
        where,
      );
      assert.ok(
        lengths.length > 0 && lengths.every((value) => value === seconds),
        where,
      );
      assert.ok(
        plan.tags.includes(`${bpm} BPM`),
        `${where} / ${plan.tags.join()}`,
      );
      const moved =
        bpm !== String(raw.config.bpm) ||
        seconds !== String(raw.config.duration);
      if (!moved) {
        assert.equal(
          plan,
          raw,
          "a plan that comes out as written is not touched",
        );
        continue;
      }
      restated++;
      assert.ok(
        !plan.tags.includes(`${raw.config.bpm} BPM`) ||
          bpm === String(raw.config.bpm),
        where,
      );
      // the user's own setting is quoted as it was set, and one chip explains the fit
      const quoted = raw.reasoning.filter((line) => /设定|按你/.test(line));
      assert.ok(
        quoted.some((line) => line.includes(`${duration} 秒`)),
        raw.reasoning.join(" / "),
      );
      for (const line of quoted)
        assert.ok(plan.reasoning.includes(line), `${line} was rewritten`);
      assert.ok(
        plan.reasoning.some((line) =>
          /^循环片段按整小节对齐：实际 [\d.]+ (BPM|秒)（设定 \d+/.test(line),
        ),
        plan.reasoning.join(" / "),
      );
      assert.ok(plan.reasoning.length <= 8);
      // a cloud service is told the settings; nothing is fitted there
      assert.equal(truthfulTiming(raw, "tencent", null), raw);
    }
  assert.ok(restated > 40, `${restated} of 110 plans needed restating`);
});

test("UX-04: a refinement's arrow runs from the fitted tempo to the fitted tempo", () => {
  // 慵懒松弛 at 30 s plays at 80; "慢一点" sets 68, which the loop fits to 64
  const base = work(styled("chill"));
  const raw = refine(base.config, "慢一点");
  assert.equal(raw.config.bpm, 68);
  assert.match(raw.reply, /速度 80 → 68 BPM/);
  const plan = truthfulTiming(raw, "local", base);
  assert.match(plan.reply, /^好的：速度 80 → 64 BPM。/);
  assert.ok(
    plan.reasoning.includes("循环片段按整小节对齐：实际 64 BPM（设定 68）"),
    plan.reasoning.join(" / "),
  );
  assert.ok(plan.tags.includes("64 BPM") && !plan.tags.includes("68 BPM"));

  // every style: both ends of every arrow are what was and what will be heard
  for (const style of STYLES) {
    const from = work(styled(style.id, { duration: 60 }));
    const before = formatBpm(fittedTiming(from.config).bpm);
    for (const text of ["慢一点", "快一点"]) {
      const answer = truthfulTiming(refine(from.config, text), "local", from);
      const after = formatBpm(fittedTiming(answer.config).bpm);
      const arrows = [answer.reply, ...answer.reasoning].flatMap((line) => [
        ...line.matchAll(/速度 ([\d.]+) → ([\d.]+) BPM/g),
      ]);
      assert.ok(arrows.length > 0, `${style.id} ${text}: ${answer.reply}`);
      for (const [, left, right] of arrows) {
        assert.equal(left, before, `${style.id} ${text}: ${answer.reply}`);
        assert.equal(right, after, `${style.id} ${text}: ${answer.reply}`);
      }
    }
  }

  // 应用调整 goes through the same wording
  const direct = planFromDraft(base, { ...base.config, bpm: 68 }, "local").plan;
  assert.match(truthfulTiming(direct, "local", base).reply, /速度 80 → 64 BPM/);

  // a language model's free wording: the piece's values are restated, other numbers are not
  const model: AgentPlan = {
    ...raw,
    brain: "llm",
    reply:
      "我把速度降到 68 BPM，比原来慢了 12 BPM；前 30 秒只留钢琴，整首 30 秒。",
    reasoning: ["速度放慢 12 BPM", "速度范围是 50–200 BPM，已取 68"],
    tags: ["慵懒松弛", "68 BPM"],
  };
  const said = truthfulTiming(model, "local", base);
  assert.equal(
    said.reply,
    "我把速度降到 64 BPM，比原来慢了 12 BPM；前 30 秒只留钢琴，整首 30 秒。",
  );
  assert.equal(said.reasoning[0], "速度放慢 12 BPM");
  assert.equal(
    said.reasoning[1],
    "速度范围是 50–200 BPM，已取 68",
    "a quoted limit is not the result",
  );
  // nothing was generated: nothing is restated — the setting it quotes gets its other half
  const idle = { ...raw, unchanged: true };
  const answered = truthfulTiming(idle, "local", base);
  assert.equal(answered.reply, idle.reply);
  assert.deepEqual(
    answered.reasoning.slice(0, idle.reasoning.length),
    idle.reasoning,
  );
  assert.deepEqual(answered.reasoning.slice(idle.reasoning.length), [
    "循环片段按整小节对齐：实际 64 BPM（设定 68）",
  ]);
  assert.deepEqual(answered.tags, idle.tags);
});

/* ---------------- UX-05 / LEFT-05: the app's own words keep their promise ---------------- */

/** What each scenario card says besides its style; a new card has to declare its own. */
const CARD_PROMISES: Record<
  string,
  {
    instrument?: InstrumentId;
    duration?: number;
    loop?: boolean;
    drums?: "none";
  }
> = {
  "vlog-daily": { instrument: "piano" },
  "vlog-travel": { instrument: "guitar" },
  "vlog-food": { instrument: "marimba" },
  "vlog-product": { duration: 60, loop: false },
  "game-pixel": { instrument: "chip", loop: true },
  "game-battle": { instrument: "synth" },
  "game-explore": { loop: true },
  "game-village": { instrument: "guzheng", loop: true },
  "work-focus": { instrument: "piano", duration: 120, drums: "none" },
  "work-lofi": { instrument: "epiano", loop: true },
  "work-cafe": {},
  "event-wedding": { instrument: "piano", duration: 90, loop: false },
  "event-festival": {},
  "event-sport": {},
  "event-trailer": { instrument: "strings", duration: 45, loop: false },
  "mood-sleep": { drums: "none" },
  "mood-sad": { instrument: "piano" },
  "mood-dream": { instrument: "bell" },
};

const NOT_UNDERSTOOD = /暂时不能|暂无|没有听出|没听出|没听懂|保持不变/;

test("UX-05 / LEFT-05: every scenario card and quick prompt produces what it says, through the offline producer", () => {
  const cards = SCENARIO_GROUPS.flatMap((group) => group.prompts);
  assert.equal(cards.length, 18);
  assert.equal(new Set(cards.map((card) => card.id)).size, cards.length);
  assert.equal(QUICK_PROMPTS.length, 6);
  for (const quick of QUICK_PROMPTS) assert.ok(cards.includes(quick), quick.id);
  assert.deepEqual(
    Object.keys(CARD_PROMISES).sort(),
    cards.map((card) => card.id).sort(),
  );
  for (const card of cards) {
    const where = `${card.id}「${card.prompt}」`;
    // a description of a NEW piece: nothing that only makes sense as a change
    assert.doesNotMatch(card.prompt, /一点|一些|换成|改成|更/, where);
    assert.equal(scenarioInspiration(card).text, card.prompt);
    const plan = fresh(card.prompt);
    const { config } = plan;
    assert.equal(
      config.mood,
      card.style,
      `${where} → ${styleLabel(config.mood)}`,
    );
    assert.equal(isUnsure(plan), false, where);
    assert.equal(plan.unchanged, false, where);
    assert.doesNotMatch(plan.reply, NOT_UNDERSTOOD, `${where} → ${plan.reply}`);
    for (const line of plan.reasoning) {
      assert.doesNotMatch(line, NOT_UNDERSTOOD, `${where} → ${line}`);
      // a first version has nothing to change "from": chips are choices, not arrows
      assert.doesNotMatch(line, /→/, `${where} → ${line}`);
    }
    const promise = CARD_PROMISES[card.id];
    if (promise.instrument)
      assert.equal(
        config.instrument,
        promise.instrument,
        `${where} → ${instrumentLabel(config.instrument)}`,
      );
    if (promise.duration)
      assert.equal(config.duration, promise.duration, where);
    if (promise.loop !== undefined)
      assert.equal(config.loop, promise.loop, where);
    if (promise.drums === "none") {
      const facts = scoreFacts(config);
      assert.ok(
        config.volumes.drums === 0 || facts?.playing.drums === false,
        `${where}: drums are heard`,
      );
    }
    // and the line under the composer says the same before anything is sent
    const preview = planPreview(card.prompt, {});
    assert.ok(preview && !preview.unsure, where);
    assert.ok(
      preview.line.startsWith(`将创作：${styleLabel(card.style)} · `),
      preview.line,
    );
  }
});

test("UX-03 / UX-05: every style card gives exactly its style, with nothing invented", () => {
  assert.equal(STYLE_CARDS.length, STYLES.length);
  for (const { style } of STYLE_CARDS) {
    const choice = styleInspiration(style);
    assert.deepEqual(choice, { text: "", mood: style.id });
    const plan = fresh(choice.text, { mood: style.id });
    const preset = stylePreset(style.id);
    for (const field of Object.keys(preset) as (keyof typeof preset)[])
      assert.deepEqual(
        plan.config[field],
        preset[field],
        `${style.id}.${field}`,
      );
    assert.equal(plan.unchanged, false);
    for (const line of [plan.reply, ...plan.reasoning])
      assert.doesNotMatch(line, NOT_UNDERSTOOD, `${style.id}: ${line}`);
    assert.ok(
      (planPreview("", { mood: style.id })?.line ?? "").startsWith(
        `将创作：${style.label} · `,
      ),
      style.id,
    );
  }
});

test("UX-05: the examples in the placeholder and the user guide are understood as shown", () => {
  for (const example of [...DESCRIPTION_EXAMPLES, PARAMETER_EXAMPLE]) {
    const plan = fresh(example.text);
    assert.equal(plan.config.mood, example.style, example.text);
    assert.equal(isUnsure(plan), false, example.text);
    for (const line of [plan.reply, ...plan.reasoning])
      assert.doesNotMatch(line, NOT_UNDERSTOOD, `${example.text}: ${line}`);
  }
  // "也可以直接说参数": every parameter of the example arrives
  const { config } = fresh(PARAMETER_EXAMPLE.text);
  assert.deepEqual(
    [config.mood, config.bpm, config.key, config.duration, config.loop],
    ["jazz", 90, "D minor", 60, false],
  );
  // parameters without any style word: the line still lists what was understood
  const bare = planPreview("90 BPM，D 小调，一分钟，完整结尾", {});
  assert.ok(bare?.unsure);
  assert.match(
    bare.line,
    /^将创作：90 BPM · D 小调 · .* · 60 秒 · 完整结尾；还没听出风格，暂按「青春欢快」——可以点下面的风格，或再多描述一点$/,
  );

  // "制作人听得懂什么": each phrase changes a work, and audibly so on a typical one
  const typical = [styled("bright"), styled("chill"), styled("guofeng")];
  const phrases = [
    ...REFINE_EXAMPLES.flatMap((group) => group.phrases),
    ...THREAD_EXAMPLES,
  ];
  assert.ok(phrases.length >= 12);
  for (const phrase of phrases) {
    assert.equal(refine(typical[0], phrase).unchanged, false, phrase);
    if (phrase !== "换一版旋律")
      assert.ok(
        typical.some((config) => wouldChange(config, phrase)),
        `${phrase} is never audible`,
      );
  }
});

/* ---------------- UX-06: the model field of 制作人大模型 ---------------- */

test("UX-06: every service without a model list explains where the name comes from and what it looks like", () => {
  const offered = new Set(LLM_PRESETS.flatMap((preset) => preset.models));
  for (const preset of LLM_PRESETS) {
    if (preset.models.length) {
      // a real list is offered instead of an example
      assert.equal(MODEL_NAME_SHAPES[preset.id], undefined, preset.id);
      continue;
    }
    const hint = modelNameHint(preset);
    assert.match(hint, /控制台|ollama list|文档/, preset.id);
    const shape = MODEL_NAME_SHAPES[preset.id];
    if (preset.id !== "custom")
      assert.ok(shape, `${preset.id} has no example of the format`);
    // an example is never a value: it is not something the form offers or pre-fills
    if (shape) assert.equal(offered.has(shape), false, preset.id);
  }
  assert.match(
    modelNameHint({ id: "deepseek", kind: "openai" }),
    /^在服务商控制台的模型列表里复制模型名称/,
  );
  for (const id of Object.keys(MODEL_NAME_SHAPES))
    assert.ok(
      LLM_PRESETS.some((preset) => preset.id === id),
      `${id} is not a preset`,
    );
});

/* ---------------- UX-07: the mixer and the chips follow what the piece contains ---------------- */

test("UX-07: a group played by the lead's instrument is named; only a silent stem is unused", () => {
  // the reviewer's case: 慵懒松弛 + "深夜学习用的，安静一点", 15 s
  const { config } = fresh("深夜学习用的，安静一点", {
    mood: "chill",
    duration: 15,
  });
  const facts = scoreFacts(config);
  assert.ok(facts);
  assert.equal(facts.playing.chords, true, "the chords stem sounds");
  assert.equal(facts.playing.drums, false, "the drum stem really is empty");
  const groups = stemInstruments(config, summarize(compose(config)));
  assert.deepEqual(groups.melody, ["电钢琴"]);
  assert.deepEqual(
    groups.chords,
    ["电钢琴"],
    "v0.3.0 showed 这首曲子没有用到 next to a sounding stem",
  );
  assert.deepEqual(groups.drums, []);

  assert.equal(silentStem([0, 0, 0]), true);
  assert.equal(silentStem([0, 0.0005]), true);
  assert.equal(silentStem([0, 0.2, 0]), false);
  assert.equal(silentStem(undefined), true);
  assert.equal(silentStem([]), true);
});

test("UX-07: every group that sounds names who plays it, for every style, lead and energy", () => {
  const leads = [...new Set(STYLES.map((style) => style.instrument))];
  for (const style of STYLES)
    for (const instrument of leads)
      for (const energy of [0.12, 0.3, 0.9]) {
        const config = styled(style.id, { instrument, energy, duration: 15 });
        const facts = scoreFacts(config);
        assert.ok(facts);
        const groups = stemInstruments(config, summarize(compose(config)));
        for (const track of TRACKS)
          assert.equal(
            groups[track].length > 0,
            facts.playing[track],
            `${style.id} / ${instrument} / ${energy}: ${track} ${JSON.stringify(groups[track])}`,
          );
      }
});

test("UX-07: a suggestion is only offered when it would be heard", () => {
  /** written out here, independent of state/score.ts: everything a listener gets */
  const heard = (config: MusicConfig) => {
    const {
      parts,
      notes: _notes,
      sections: _sections,
      chords: _chords,
      ...frame
    } = compose(config);
    return JSON.stringify([
      frame,
      TRACKS.map((track) => {
        const sounding = parts.filter(
          (part) =>
            part.track === track &&
            (part.kind === "notes" ? part.notes : part.hits).length > 0,
        );
        return sounding.length && config.volumes[track] > 0
          ? [sounding, config.volumes[track]]
          : null;
      }),
    ]);
  };
  const seen = new Set<string>();
  let offered = 0;
  for (const style of STYLES)
    for (const energy of [0.12, undefined, 0.9])
      for (const duration of [15, 30])
        for (const muted of [false, true]) {
          const base = styled(style.id, {
            duration,
            ...(energy === undefined ? {} : { energy }),
          });
          const config = muted
            ? { ...base, volumes: { ...base.volumes, drums: 0 } }
            : base;
          const chips = suggestionsFor(work(config));
          const where = `${style.id} e=${config.energy} ${duration}s ${muted ? "drums muted" : ""}`;
          assert.equal(chips.at(-1), "换一版旋律", where);
          assert.equal(new Set(chips).size, chips.length, where);
          const drums = scoreFacts(config)?.playing.drums;
          // what exists decides what is offered
          assert.equal(
            chips.includes("不要鼓"),
            !muted && drums === true,
            where,
          );
          assert.equal(
            chips.includes("加上鼓"),
            muted && drums === true,
            where,
          );
          assert.equal(
            chips.includes("加点沙锤"),
            !muted && drums === false,
            where,
          );
          for (const text of chips.slice(0, -1)) {
            offered++;
            seen.add(text);
            const plan = refine(config, text);
            assert.equal(
              plan.unchanged,
              false,
              `${where}: 「${text}」 → ${plan.reply}`,
            );
            assert.notEqual(
              heard(plan.config),
              heard(config),
              `${where}: 「${text}」 changes nothing audible`,
            );
            assert.equal(
              wouldChange(config, text),
              true,
              `${where}: 「${text}」`,
            );
          }
        }
  assert.ok(offered > 1000, `${offered} chips checked`);
  for (const text of [
    "慢一点",
    "更有活力",
    "安静一点",
    "换成古筝",
    "不要鼓",
    "加上鼓",
    "加点沙锤",
    "加点弦乐铺底",
    "混响大一点",
  ])
    assert.ok(seen.has(text), `「${text}」 is never offered`);

  // v0.3.0 offered these, and each made a new version that sounded the same
  const quiet = styled("ambient", { energy: 0.12, duration: 15 });
  assert.equal(wouldChange(quiet, "不要鼓"), false);
  assert.equal(audibleKey(refine(quiet, "不要鼓").config), audibleKey(quiet));
  const padded = styled("romantic", { energy: 0.9 });
  assert.equal(wouldChange(padded, "加点弦乐铺底"), false);
  assert.ok(!suggestionsFor(work(padded)).includes("加点弦乐铺底"));

  // moving a fader does not change the list (nor compose anything again)
  const moved = { ...padded, volumes: { ...padded.volumes, melody: 0.31 } };
  assert.equal(suggestionsFor(work(moved)), suggestionsFor(work(padded)));
  // a cloud mix and a v0.2 work have no score to check: the plain list
  assert.deepEqual(
    suggestionsFor(work(quiet, { provider: "tencent" })).slice(3),
    ["不要鼓", "加点弦乐铺底", "换一版旋律"],
  );
  assert.deepEqual(suggestionsFor(work({ ...quiet, engine: 1 })).slice(3), [
    "不要鼓",
    "加点弦乐铺底",
    "换一版旋律",
  ]);
  assert.deepEqual(suggestionsFor(null), []);
});

/* ---------------- UX-08: tooltips ---------------- */

test("UX-08: a tip follows keyboard focus the user moved, never focus set by code", () => {
  assert.equal(
    tipFocusAllowed({ focusVisible: true, sinceNavigationMs: 3 }),
    true,
    "Tab onto a control",
  );
  assert.equal(
    tipFocusAllowed({
      focusVisible: true,
      sinceNavigationMs: NAVIGATION_WINDOW_MS,
    }),
    true,
  );
  // Enter sent a message; seconds later the finished job focuses the play button
  assert.equal(
    tipFocusAllowed({ focusVisible: true, sinceNavigationMs: 4200 }),
    false,
  );
  assert.equal(
    tipFocusAllowed({ focusVisible: true, sinceNavigationMs: Infinity }),
    false,
    "no key at all",
  );
  // a mouse click focuses without a focus ring
  assert.equal(
    tipFocusAllowed({ focusVisible: false, sinceNavigationMs: 3 }),
    false,
  );
});

test("UX-08: transport tips go under their control, away from the time axis", () => {
  const viewport = { width: 1366, height: 768 };
  const play = { left: 309, top: 289, bottom: 337, width: 48 };
  const bubble = { width: 92, height: 31 };
  // v0.3.0: above the button, on top of the chord strip (y 270–301)
  assert.deepEqual(tipPlacement(play, bubble, viewport), {
    left: 287,
    top: 250,
  });
  assert.deepEqual(tipPlacement(play, bubble, viewport, "bottom"), {
    left: 287,
    top: 345,
  });
  // no room below (the mini transport at the bottom edge): above after all
  const low = { left: 248, top: 720, bottom: 760, width: 40 };
  assert.equal(tipPlacement(low, bubble, viewport, "bottom").top, 720 - 31 - 8);
  // no room above: below
  assert.equal(
    tipPlacement({ left: 20, top: 6, bottom: 34, width: 28 }, bubble, viewport)
      .top,
    42,
  );
  // kept inside the window on both sides
  assert.equal(
    tipPlacement(
      { left: 0, top: 300, bottom: 328, width: 28 },
      bubble,
      viewport,
    ).left,
    4,
  );
  assert.equal(
    tipPlacement(
      { left: 1350, top: 300, bottom: 328, width: 16 },
      bubble,
      viewport,
    ).left,
    1366 - 92 - 4,
  );
});

/* ---------------- UX-09: 循环试听 follows the structure ---------------- */

test("UX-09: a 循环片段 loads looping, a 完整结尾 does not, and a choice is kept per structure", async () => {
  const h = harness();
  await h.core.start();
  const loops: boolean[] = [];
  h.core.attachPlayer({
    ...h.player,
    setLoop: (loop) => void loops.push(loop),
  });
  const { actions } = h.core;
  const make = async (loop: boolean) => {
    actions.newPiece();
    actions.setPin("loop", loop);
    assert.equal(await actions.send("夏日海边的轻快钢琴"), true);
    assert.equal(studioOf(h).project?.config.loop, loop);
    return studioOf(h).project?.id ?? "";
  };
  const firstLoop = await make(true);
  assert.equal(
    loops.at(-1),
    true,
    "v0.3.0 left a piece it called 可无缝循环 stopping at its end",
  );
  assert.equal(loops.length, 1, "told once per load");
  const firstEnding = await make(false);
  assert.equal(
    loops.at(-1),
    false,
    "a composed ending is not wrapped back to bar 1",
  );
  // the user wants this ending looped; that is a choice about 完整结尾 pieces only
  actions.setLoopAudition(true);
  assert.equal(loops.at(-1), true);
  await make(true);
  assert.equal(loops.at(-1), true);
  actions.setLoopAudition(false);
  await make(false);
  assert.equal(loops.at(-1), true, "remembered for 完整结尾");
  await make(true);
  assert.equal(loops.at(-1), false, "remembered for 循环片段");
  // opening from the library follows the same rule
  assert.equal(await actions.openProject(firstEnding), true);
  assert.equal(loops.at(-1), true);
  assert.equal(await actions.openProject(firstLoop), true);
  assert.equal(loops.at(-1), false);
  // a player that cannot loop (a stand-in) is simply not asked
  h.core.attachPlayer(h.player);
  assert.equal(await actions.openProject(firstEnding), true);
});

/* ---------------- UX-02 and lost input ---------------- */

test("UX-02: unapplied inspector edits and unsent words wait with their work", async () => {
  const h = harness();
  await h.core.start();
  const { actions } = h.core;
  assert.equal(await actions.send("夏日海边的轻快钢琴"), true);
  const a = studioOf(h).project;
  assert.ok(a);
  actions.setDraft("bpm", 96);
  actions.setDraft("instrument", "guzheng");
  actions.setComposerText("再慢一点点，结尾留白");
  // leaving for a new piece: v0.3.0 dropped both without a word
  assert.equal(actions.newPiece(), true);
  assert.equal(studioOf(h).project, null);
  assert.equal(studioOf(h).composerText, "");
  assert.equal(await actions.send("国风古筝"), true);
  const b = studioOf(h).project;
  assert.ok(b && b.id !== a.id);
  assert.equal(
    studioOf(h).draft.bpm,
    b.config.bpm,
    "another work starts from its own values",
  );

  assert.equal(await actions.openProject(a.id), true);
  assert.equal(studioOf(h).draft.bpm, 96);
  assert.equal(studioOf(h).draft.instrument, "guzheng");
  assert.deepEqual([...studioOf(h).touched].sort(), ["bpm", "instrument"]);
  assert.equal(
    studioOf(h).project?.config.bpm,
    a.config.bpm,
    "the work itself is as it was",
  );
  assert.equal(studioOf(h).composerText, "再慢一点点，结尾留白");
  assert.match(
    toastsOf(h).at(-1)?.text ?? "",
    /「声音微调」里有 2 项修改没有应用，已经放回来了/,
  );

  // going straight from one work to another keeps them as well
  assert.equal(await actions.openProject(b.id), true);
  assert.equal(studioOf(h).draft.bpm, b.config.bpm);
  actions.setDraft("reverb", 0.9);
  assert.equal(await actions.openProject(a.id), true);
  assert.equal(studioOf(h).draft.bpm, 96);
  assert.equal(await actions.openProject(b.id), true);
  assert.equal(studioOf(h).draft.reverb, 0.9);

  // what was taken back by hand does not come back
  assert.equal(await actions.openProject(a.id), true);
  actions.resetDraft();
  assert.equal(await actions.openProject(b.id), true);
  for (const toast of toastsOf(h)) actions.dismissToast(toast.id);
  assert.equal(await actions.openProject(a.id), true);
  assert.equal(studioOf(h).draft.bpm, a.config.bpm);
  assert.deepEqual(studioOf(h).touched, []);
  assert.deepEqual(
    toastsOf(h),
    [],
    "nothing came back, so nothing is announced",
  );

  // a deleted work that is brought back with 撤销 still has its edits
  actions.setDraft("energy", 0.9);
  assert.equal(actions.removeProject(a.id), "removed");
  assert.equal(studioOf(h).project, null);
  actions.undoRemove(a.id);
  await settle();
  assert.equal(await actions.openProject(a.id), true);
  assert.equal(studioOf(h).draft.energy, 0.9);
  actions.resetDraft();

  // 应用调整 uses the edits up: nothing waits afterwards
  actions.setDraft("bpm", 100);
  assert.equal(await actions.applyDraft(), true);
  const applied = studioOf(h).project;
  assert.equal(applied?.config.bpm, 100);
  assert.equal(await actions.openProject(a.id), true);
  assert.equal(studioOf(h).draft.bpm, a.config.bpm);
  assert.equal(await actions.openProject(applied?.id ?? ""), true);
  assert.equal(studioOf(h).draft.bpm, 100);
  assert.deepEqual(studioOf(h).touched, []);
});

test("lost input: a style card keeps the description; replacing or clearing it can be taken back", async () => {
  const h = harness();
  await h.core.start();
  const { actions } = h.core;
  const rock = STYLES.find((style) => style.id === "rock") ?? STYLES[0];
  actions.setComposerText("海边的日落，想要一点失真");
  actions.setPin("duration", 60);
  // a style card only pins its style: v0.3.0 wiped the text and the chosen length
  actions.chooseInspiration(styleInspiration(rock));
  assert.equal(studioOf(h).composerText, "海边的日落，想要一点失真");
  assert.deepEqual(studioOf(h).pins, { duration: 60, mood: "rock" });
  assert.equal(toastsOf(h).length, 0);

  // a scenario card is a whole description: it replaces the text, with a way back
  const card = QUICK_PROMPTS[0];
  actions.chooseInspiration(scenarioInspiration(card));
  assert.equal(studioOf(h).composerText, card.prompt);
  assert.deepEqual(
    studioOf(h).pins,
    {},
    "the card's own style must not be overridden by an old pin",
  );
  const offer = toastsOf(h).at(-1);
  assert.equal(offer?.action?.label, "撤销");
  offer?.action?.run();
  assert.equal(studioOf(h).composerText, "海边的日落，想要一点失真");
  assert.deepEqual(studioOf(h).pins, { duration: 60, mood: "rock" });

  // 新建创作 in the empty state clears the form — and offers it back
  assert.equal(actions.newPiece(), true);
  assert.equal(studioOf(h).composerText, "");
  const cleared = toastsOf(h).at(-1);
  assert.equal(cleared?.text, "已清空刚才写的描述。");
  cleared?.action?.run();
  assert.equal(studioOf(h).composerText, "海边的日落，想要一点失真");

  // the way back never overwrites something newer
  actions.chooseInspiration(scenarioInspiration(card));
  const stale = toastsOf(h).at(-1);
  actions.setComposerText("我又写了别的");
  stale?.action?.run();
  assert.equal(studioOf(h).composerText, "我又写了别的");
  // picking the same card again, or a card over an empty composer, has nothing to offer back
  actions.setComposerText("");
  actions.chooseInspiration(scenarioInspiration(card));
  assert.ok(!toastsOf(h).some((toast) => toast.key === "composer-replaced"));
});

/* ---------------- CORE-08 / ENG-2: the engine's start is said ---------------- */

test("ENG-2: a render that waits for the engine's worker says so instead of showing 0 %", async () => {
  const h = harness();
  await h.core.start();
  type Options = {
    onProgress?: (fraction: number) => void;
    onPhase?: (phase: "starting" | "rendering") => void;
  };
  // the harness keeps its dependencies to itself; this test needs an engine
  // that reports its phase the way audio/engine.ts does
  const deps = (
    h.core as unknown as { kernel: { deps: { renderMusic: unknown } } }
  ).kernel.deps;
  const render = deps.renderMusic as (
    config: MusicConfig,
    options?: Options,
  ) => Promise<unknown>;
  const first = defer<void>();
  const second = defer<void>();
  const third = defer<void>();
  deps.renderMusic = async (config: MusicConfig, options?: Options) => {
    options?.onPhase?.("starting");
    await first.promise;
    options?.onPhase?.("rendering");
    await second.promise;
    options?.onProgress?.(0.4);
    await third.promise;
    return render(config, {});
  };
  const sending = h.core.actions.send("夏日海边的轻快钢琴");
  await settle();
  let job = studioOf(h).job;
  assert.equal(job?.stage, "rendering");
  assert.equal(job?.phase, ENGINE_STARTING);
  assert.equal(job?.phase, "正在启动作曲引擎");
  assert.equal(
    job?.progress,
    null,
    "no bar stuck at 0 % while nothing is being rendered",
  );
  // the worker is up: back to the bar, from 0
  first.resolve();
  await settle();
  job = studioOf(h).job;
  assert.equal(job?.phase, "正在作曲与合成");
  assert.equal(job?.progress, 0);
  second.resolve();
  await settle();
  assert.equal(studioOf(h).job?.progress, 0.4);
  assert.equal(studioOf(h).job?.phase, "正在作曲与合成");
  third.resolve();
  assert.equal(await sending, true);
  assert.equal(studioOf(h).job, null);

  // an engine that only ever reports progress after "starting": progress means it is up
  const gate = defer<void>();
  deps.renderMusic = async (config: MusicConfig, options?: Options) => {
    options?.onPhase?.("starting");
    await gate.promise;
    options?.onProgress?.(0.25);
    return render(config, {});
  };
  const again = h.core.actions.variation();
  await settle();
  assert.equal(studioOf(h).job?.phase, ENGINE_STARTING);
  // reopening a work says it the same way (session restore right after launch)
  gate.resolve();
  assert.equal(await again, true);

  // the usual case — the worker is warm, the engine says "rendering" at once — never shows it
  const phases: string[] = [];
  const stop = h.core.subscribe(() => {
    const phase = studioOf(h).job?.phase;
    if (phase && phases.at(-1) !== phase) phases.push(phase);
  });
  deps.renderMusic = async (config: MusicConfig, options?: Options) => {
    options?.onPhase?.("rendering");
    options?.onProgress?.(0.5);
    return render(config, {});
  };
  assert.equal(await h.core.actions.variation(), true);
  stop();
  assert.ok(!phases.includes(ENGINE_STARTING), phases.join(" → "));
  assert.ok(phases.includes("正在作曲与合成"), phases.join(" → "));

  // cancelled while it waits: the phase of a job that is gone is not touched
  const never = defer<void>();
  let late: Options | undefined;
  deps.renderMusic = async (config: MusicConfig, options?: Options) => {
    late = options;
    options?.onPhase?.("starting");
    await never.promise;
    return render(config, {});
  };
  const cancelled = h.core.actions.variation();
  await settle();
  assert.equal(studioOf(h).job?.phase, ENGINE_STARTING);
  h.core.actions.cancelJob();
  late?.onPhase?.("rendering");
  late?.onProgress?.(0.9);
  assert.equal(studioOf(h).job?.stage, "cancelling");
  assert.notEqual(studioOf(h).job?.phase, "正在作曲与合成");
  never.resolve();
  assert.equal(await cancelled, false);
  assert.equal(studioOf(h).job, null);
});

/* ---------------- UX-12: the version on a library card ---------------- */

test("UX-12: a version is named by its number and its parent's number, never cut off by a long title", () => {
  const v1 = localProject("a", { title: "像素小游戏的第一关" });
  const v2 = localProject("b", {
    title: "像素小游戏的第一关",
    revision: 2,
    parentId: "a",
  });
  const v3 = localProject("c", {
    title: "第一关（慢板）",
    revision: 3,
    parentId: "b",
  });
  const all = [v3, v2, v1];
  assert.deepEqual(versionTag(v1, all), {
    tag: "v1",
    origin: null,
    full: "v1",
  });
  // versions share their title: the parent's number says it all, and fits any card
  assert.deepEqual(versionTag(v2, all), {
    tag: "v2",
    origin: "源自 v1",
    full: "v2 · 源自《像素小游戏的第一关》v1",
  });
  // a renamed version names its parent by title as well
  assert.equal(versionTag(v3, all).origin, "源自《像素小游戏的第一关》v2");
  // the parent was deleted: no dangling reference
  assert.deepEqual(versionTag(v2, [v3, v2]), {
    tag: "v2",
    origin: null,
    full: "v2",
  });
  // the older label is still what it was (tooltips, exports)
  assert.equal(versionLabel(v2, all), "v2 · 源自《像素小游戏的第一关》");
});

/* ---------------- UX-11: one name per thing ---------------- */

test("UX-11: parameters, structures and services have one name each", () => {
  assert.deepEqual(
    DRAFT_FIELDS.map((field) => FIELD_LABELS[field]),
    [
      "风格",
      "速度",
      "主奏乐器",
      "调性",
      "情绪能量",
      "旋律丰富度",
      "空间混响",
      "时长",
      "结构",
    ],
  );
  // the engine selector and the settings name a service the same way
  const names = [
    "本地作曲 · 免费",
    ...CLOUD_PROVIDERS.map((info) => info.name),
  ];
  const every = (status: { configured: boolean; damaged?: boolean }) =>
    Object.fromEntries(
      CLOUD_PROVIDERS.map((info) => [info.id, status]),
    ) as typeof EMPTY_PROVIDER_STATUSES;
  for (const [platform, providers] of [
    [{ canUseCloud: false, canUseLlm: false }, EMPTY_PROVIDER_STATUSES],
    [{ canUseCloud: true, canUseLlm: true }, EMPTY_PROVIDER_STATUSES],
    [{ canUseCloud: true, canUseLlm: true }, every({ configured: true })],
    [
      { canUseCloud: true, canUseLlm: true },
      every({ configured: true, damaged: true }),
    ],
  ] as const)
    assert.deepEqual(
      engineOptions(platform, { providers }).map((option) => option.label),
      names,
    );
  // what 应用调整 says about a cloud work and a v0.2 work uses the same words as the selector
  const base = work(styled("chill"));
  assert.match(
    applyHint({ ...base, provider: "tencent" }, "local"),
    /改用本地作曲/,
  );
  assert.match(
    applyHint(base, "tencent"),
    /腾讯云 TokenHub 按新的参数重新生成一首并计费/,
  );
});

test("UX-11: no stray names, leftover English or developer words in the interface", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) files.push(path);
    }
  };
  walk(join("src", "ui"));
  walk(join("src", "state"));
  walk(join("src", "services"));
  walk(join("src", "player"));
  files.push(
    "index.html",
    join("src", "storage.ts"),
    join("src", "providers.ts"),
    join("src", "platform.ts"),
    join("src", "audio", "engine-error.ts"),
  );
  const banned: [RegExp, string][] = [
    [/作品库/, "the library is 「我的作品」"],
    [/创作台|工作台/, "the page is 创作"],
    [
      /云端引擎|云端 AI 音乐|本地引擎/,
      "the two ways to make audio are 本地作曲 and 云端生成",
    ],
    [/大模型制作人/, "制作人大模型"],
    [/YOUR IDEAS|YOUR SOUND/, "English tagline"],
    [/旋律种子|音色引擎/, "developer words"],
    [/GenBGM/, "API names in a label"],
    [/请重新启动 App|新版 App|AI 工程|AI 作品/, "v0.2 wording"],
    [/这首曲子没有用到|正在创作台/, "v0.3.0 wording"],
    [/复杂度|主旋律音量/, "旋律丰富度 / 旋律"],
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8")
      // comments are for developers
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
      .replace(/<!--[\s\S]*?-->/g, "")
      // the one table that maps the producer's words onto the interface's
      .replace(/const HOUSE_TERMS[\s\S]*?\n\];/, "");
    for (const [pattern, why] of banned)
      assert.doesNotMatch(text, pattern, `${file}: ${why}`);
    // one kind of quotation mark: 「」
    assert.doesNotMatch(text, /[\u201c\u201d]/, `${file}: curly quotes`);
  }
  // what the producer says is brought to the same marks, whoever wrote it
  assert.equal(
    houseQuotes("可以说\u201c改成爵士风格\u201d或\u201c换成国风\u201d"),
    "可以说「改成爵士风格」或「换成国风」",
  );
  assert.equal(
    houseQuotes("之前的版本都在\u201c我的作品\u201d里"),
    "之前的版本都在「我的作品」里",
  );
  assert.equal(
    houseQuotes("没有引号，「已有的」不变"),
    "没有引号，「已有的」不变",
  );
  // the rules quote that way themselves, in every sentence they can say …
  const asked = refine(styled("bright"), "今天天气怎么样");
  assert.equal(asked.unchanged, true);
  assert.doesNotMatch(
    [asked.reply, ...asked.reasoning].join(""),
    /[\u201c\u201d]/,
  );
  assert.match([asked.reply, ...asked.reasoning].join(""), /「/);
  for (const name of readdirSync(join("src", "agent")))
    assert.doesNotMatch(
      readFileSync(join("src", "agent", name), "utf8"),
      // a quoted phrase; the two marks side by side in a character class are input handling
      /\u201c[^\u201c\u201d]+\u201d/,
      `src/agent/${name}: curly quotes around a phrase`,
    );
  // … and a language model's curly marks are brought to them when its answer is stored
  const turn = agentTurn("t", "2026-10-09T00:00:00.000Z", {
    ...asked,
    reply: "可以说\u201c改成爵士风格\u201d。",
    reasoning: ["没有从\u201c今天\u201d里听出要求"],
  });
  assert.equal(turn.text, "可以说「改成爵士风格」。");
  assert.deepEqual(turn.reasoning, ["没有从「今天」里听出要求"]);
});

/* ---------------- truthfulness: no version without an audible change ---------------- */

test("a change nobody could hear is answered, not saved as a new version", async () => {
  // a 60 s loop at 80 BPM is 20 bars; 81, 82, 83 BPM are fitted back onto the same 20 bars
  const loop = work(styled("chill", { duration: 60 }));
  for (const bpm of [78, 81, 83]) {
    const direct = planFromDraft(loop, { ...loop.config, bpm }, "local").plan;
    assert.equal(direct.unchanged, false);
    assert.equal(
      audibleKey(direct.config),
      audibleKey(loop.config),
      `${bpm} BPM sounds the same`,
    );
    const answer = inaudiblePlan(direct, "local", loop);
    assert.equal(answer.unchanged, true);
    assert.equal(
      answer.reply,
      "这样改完，听起来会和现在这一版完全一样，所以没有生成新版本。",
    );
    assert.deepEqual(answer.reasoning, [
      "循环片段的速度和时长按整小节对齐，对齐后和现在一样",
    ]);
    assert.doesNotMatch(
      answer.reply,
      /→/,
      "v0.3.0 saved a version and said 速度 80 → 81 BPM",
    );
  }
  // a nudge that does move the loop to other bars is a change
  const real = planFromDraft(loop, { ...loop.config, bpm: 96 }, "local").plan;
  assert.equal(inaudiblePlan(real, "local", loop), real);

  // drums taken out of a piece that has none; a pad added where one already plays
  const quiet = work(styled("ambient", { energy: 0.12, duration: 15 }));
  const noDrums = inaudiblePlan(refine(quiet.config, "不要鼓"), "local", quiet);
  assert.equal(noDrums.unchanged, true);
  assert.deepEqual(noDrums.reasoning, ["这一版的编曲里没有鼓组"]);
  const padded = work(styled("romantic", { energy: 0.9 }));
  assert.equal(
    inaudiblePlan(refine(padded.config, "加点弦乐铺底"), "local", padded)
      .unchanged,
    true,
  );
  // what can be heard goes through untouched
  const slower = refine(quiet.config, "慢一点");
  assert.equal(inaudiblePlan(slower, "local", quiet), slower);
  // nothing is known about a cloud mix or a v0.2 work, and a cloud request is always a new piece
  const drumless = refine(quiet.config, "不要鼓");
  assert.equal(inaudiblePlan(drumless, "tencent", quiet), drumless);
  assert.equal(
    inaudiblePlan(drumless, "local", { ...quiet, provider: "tencent" }),
    drumless,
  );
  assert.equal(
    inaudiblePlan(drumless, "local", work({ ...quiet.config, engine: 1 })),
    drumless,
  );
  assert.equal(inaudiblePlan(drumless, "local", null), drumless);

  // through the app: 应用调整 with such a nudge makes no version, keeps the draft and says why
  const h = harness();
  await h.core.start();
  const { actions } = h.core;
  actions.setPin("mood", "chill");
  actions.setPin("duration", 60);
  actions.setPin("loop", true);
  assert.equal(await actions.send(), true);
  const first = studioOf(h).project;
  assert.ok(first);
  assert.equal(first.config.bpm, 80);
  const renders = h.renders.length;
  actions.setDraft("bpm", 82);
  assert.equal(await actions.applyDraft(), false);
  assert.equal(studioOf(h).project?.id, first.id, "still the same work");
  assert.equal(h.renders.length, renders, "nothing was rendered");
  assert.equal(h.storage.records.size, 1, "nothing was stored");
  assert.equal(
    studioOf(h).draft.bpm,
    82,
    "the edit is still there to change further",
  );
  const said = studioOf(h).thread.at(-1);
  assert.equal(
    said?.text,
    "这样改完，听起来会和现在这一版完全一样，所以没有生成新版本。",
  );
  assert.equal(said?.revision, undefined);
  // …and the same request typed to the producer
  actions.resetDraft();
  assert.equal(await actions.send("速度 82"), false);
  assert.equal(h.storage.records.size, 1);
  assert.match(
    studioOf(h).thread.at(-1)?.text ?? "",
    /完全一样，所以没有生成新版本/,
  );
  // a change that is heard still makes its version
  assert.equal(await actions.send("慢一点"), true);
  assert.equal(studioOf(h).project?.revision, 2);
});

test("UX-11: the producer names a work's structure as the rest of the interface does", () => {
  assert.equal(
    houseTerms("好的，做一段音乐：80 BPM，30 秒，可无缝循环。"),
    "好的，做一段音乐：80 BPM，30 秒，循环片段。",
  );
  assert.equal(
    houseTerms("76 BPM，30 秒，带完整结尾。"),
    "76 BPM，30 秒，完整结尾。",
  );
  assert.equal(houseTerms("结构：无缝循环"), "结构：循环片段");
  assert.equal(houseTerms("结构：带完整结尾"), "结构：完整结尾");
  assert.equal(houseTerms("改为无缝循环"), "结构改为循环片段");
  assert.equal(houseTerms("改为带结尾的完整版本"), "结构改为完整结尾");
  assert.equal(
    houseTerms("按你的设定：30 秒、带完整结尾"),
    "按你的设定：30 秒、完整结尾",
  );
  assert.equal(houseTerms("改用新版音色引擎"), "改用新版引擎");
  // already in the interface's words, or about something else: untouched
  for (const text of ["循环片段", "完整结尾", "循环试听", "一段带鼓的音乐"])
    assert.equal(houseTerms(text), text);

  // whatever the rules write about structure reaches the thread in those words
  const STRAY = /无缝循环|带完整结尾|带结尾的完整|音色引擎/;
  const said = (plan: AgentPlan) => {
    const turn = agentTurn("t", "2026-10-09T00:00:00.000Z", plan);
    return [turn.text, ...(turn.reasoning ?? [])];
  };
  const loop = styled("chill");
  const ending = styled("chill", { loop: false });
  const lines = [
    ...said(fresh("", { mood: "chill", duration: 30, loop: true })),
    ...said(fresh("", { mood: "chill", duration: 30, loop: false })),
    ...said(fresh("安静的钢琴，完整结尾")),
    ...said(refine(loop, "改成完整结尾")),
    ...said(refine(ending, "改成循环")),
    ...said(refine(loop, "改成循环")),
  ];
  assert.ok(
    lines.some((line) => /循环片段/.test(line)) &&
      lines.some((line) => /完整结尾/.test(line)),
    lines.join(" / "),
  );
  for (const line of lines) assert.doesNotMatch(line, STRAY, line);

  // 应用调整 writes its own lines from the same change list
  const direct = planFromDraft(work(loop), { ...loop, loop: false }, "local");
  assert.equal(direct.request, "应用调整：结构改为完整结尾");
  assert.match(
    direct.plan.reply,
    /^已按你的调整生成新版本：结构改为完整结尾。/,
  );
  const legacy = planFromDraft(
    work({ ...loop, engine: 1 }),
    { ...loop, bpm: 96 },
    "local",
  );
  assert.ok(
    legacy.plan.reasoning.includes("改用新版引擎"),
    legacy.plan.reasoning.join(" / "),
  );
  for (const line of [
    direct.request,
    direct.plan.reply,
    ...direct.plan.reasoning,
    ...legacy.plan.reasoning,
  ])
    assert.doesNotMatch(line, STRAY, line);
});

/* ---------------- truthfulness: what the settings say and what the score plays ---------------- */

test("加上鼓 on a piece whose arrangement has no kit really adds one", async () => {
  // quiet ambient: the drum fader is up, but the style writes no kit at this energy
  const quiet = styled("ambient", { energy: 0.12, duration: 15 });
  assert.equal(scoreFacts(quiet)?.playing.drums, false);
  assert.ok(quiet.volumes.drums > 0);
  for (const text of [
    "加上鼓",
    "把鼓加回来",
    "加鼓",
    "加点打击乐",
    "鼓大一点",
  ]) {
    const rules = refine(quiet, text);
    // v0.3.0: "鼓组本来就是打开的", or a louder fader on a part that does not exist
    assert.ok(
      rules.unchanged
        ? rules.reasoning.includes("鼓组本来就是打开的")
        : rules.config.volumes.drums > quiet.volumes.drums,
      `${text}: ${rules.reply}`,
    );
    const plan = withAskedDrums(rules, quiet);
    assert.equal(plan.unchanged, false, text);
    assert.equal(plan.config.arrangement?.drums, "light", text);
    assert.equal(
      plan.config.volumes.drums,
      quiet.volumes.drums,
      `${text}: the fader was never the problem`,
    );
    assert.equal(plan.config.seed, quiet.seed);
    assert.equal(
      scoreFacts(plan.config)?.playing.drums,
      true,
      `${text}: a kit plays now`,
    );
    assert.notEqual(audibleKey(plan.config), audibleKey(quiet), text);
    assert.equal(
      plan.reply,
      "好的：这一版的编曲里原本没有鼓组，已经加入一组轻打的鼓。旋律保持不变。",
      text,
    );
    assert.deepEqual(plan.reasoning, ["加入鼓组（轻打）"], text);
    // and it is a version the guard lets through
    assert.equal(inaudiblePlan(plan, "local", work(quiet)), plan, text);
  }
  // asked together with something else: both happen, both are said
  const both = withAskedDrums(refine(quiet, "加鼓，换成古筝"), quiet);
  assert.equal(both.config.instrument, "guzheng");
  assert.equal(both.config.arrangement?.drums, "light");
  assert.match(
    both.reply,
    /^好的：这一版的编曲里原本没有鼓组，已经加入一组轻打的鼓；另外主奏乐器换成.*。/,
  );
  assert.equal(both.reasoning[0], "加入鼓组（轻打）");

  // nothing to do with it: drums that play, drums that were not asked for, drums switched off on purpose
  const lively = styled("bright");
  assert.equal(scoreFacts(lively)?.playing.drums, true);
  for (const text of ["加上鼓", "鼓大一点", "慢一点"]) {
    const rules = refine(lively, text);
    assert.equal(withAskedDrums(rules, lively), rules, text);
  }
  const slower = refine(quiet, "慢一点");
  assert.equal(withAskedDrums(slower, quiet), slower);
  const off = { ...quiet, arrangement: { drums: "none" as const } };
  const back = refine(off, "加上鼓");
  assert.equal(
    withAskedDrums(back, off),
    back,
    "a kit the user took out is the rules' to bring back",
  );
  const legacy = { ...quiet, engine: 1 as const };
  const old = refine(legacy, "加上鼓");
  assert.equal(
    withAskedDrums(old, legacy),
    old,
    "nothing is known about a v0.2 score",
  );

  // the question "would this be heard?" gets the same answer the app acts on
  assert.equal(wouldChange(quiet, "加上鼓"), true);
  assert.equal(wouldChange(lively, "加上鼓"), false);

  // through the app
  const h = harness();
  await h.core.start();
  const { actions } = h.core;
  actions.setPin("mood", "ambient");
  actions.setPin("duration", 15);
  assert.equal(await actions.send("非常安静，几乎听不见"), true);
  const first = studioOf(h).project;
  assert.ok(first);
  if (
    scoreFacts(first.config)?.playing.drums === false &&
    first.config.volumes.drums > 0
  ) {
    assert.equal(
      await actions.send("加上鼓"),
      true,
      "v0.3.0 answered 鼓组本来就是打开的 and made nothing",
    );
    const next = studioOf(h).project;
    assert.equal(next?.revision, 2);
    assert.equal(next?.config.arrangement?.drums, "light");
    assert.match(
      studioOf(h).thread.at(-1)?.text ?? "",
      /原本没有鼓组，已经加入一组轻打的鼓/,
    );
  } else
    assert.fail(`the test piece has drums: ${JSON.stringify(first.config)}`);
});

test("an answer that quotes a loop's tempo setting also says what the loop is fitted to", () => {
  // sad, 30 s loop: the setting is 68 BPM, eight bars fit at 64
  const loop = styled("sad", { duration: 30, loop: true });
  assert.equal(loop.bpm, 68);
  assert.equal(formatBpm(fittedTiming(loop).bpm), "64");
  const asked = refine(loop, "速度 68");
  assert.equal(asked.unchanged, true);
  assert.deepEqual(asked.reasoning, ["速度已经是 68 BPM"]);
  const honest = truthfulTiming(asked, "local", work(loop));
  assert.equal(honest.unchanged, true);
  assert.equal(honest.reply, asked.reply, "the setting is quoted as it is");
  assert.deepEqual(
    honest.reasoning,
    ["速度已经是 68 BPM", "循环片段按整小节对齐：实际 64 BPM（设定 68）"],
    "v0.3.0 said 68 under a header that reads 64",
  );
  assert.equal(
    truthfulTiming(honest, "local", work(loop)),
    honest,
    "said once",
  );
  // an answer that does not mention the tempo gets no note about it
  const chat = refine(loop, "今天天气怎么样");
  assert.equal(chat.unchanged, true);
  assert.equal(truthfulTiming(chat, "local", work(loop)), chat);
  // where setting and audio agree there is nothing to add
  const ending = styled("sad", { duration: 30, loop: false });
  const plain = refine(ending, "速度 68");
  assert.equal(truthfulTiming(plain, "local", work(ending)), plain);
  // a cloud service gets the setting as a target: nothing is fitted
  assert.equal(truthfulTiming(asked, "tencent", work(loop)), asked);
});
