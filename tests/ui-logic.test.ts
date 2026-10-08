// Pure logic behind the interface (src/ui/logic) and the small state
// refinements the interface needed. No DOM.
import assert from "node:assert/strict";
import { test } from "node:test";
import { STYLES, instrumentLabel } from "../src/music/catalog";
import { compose, summarize } from "../src/music/compose";
import { DEFAULT_CONFIG, clampConfig, stylePreset } from "../src/music/defaults";
import { TRACKS } from "../src/music/score";
import { EMPTY_PROVIDER_STATUSES } from "../src/providers";
import { QUICK_PROMPTS, SCENARIO_GROUPS } from "../src/state/content";
import { engineOptions, engineProblem } from "../src/state/options";
import { initialState, reducer } from "../src/state/reducer";
import { rovingIndex, trapTarget } from "../src/ui/logic/focus";
import {
  groupByName,
  groupByParts,
  stemInstruments,
} from "../src/ui/logic/instruments";
import { promptMood } from "../src/ui/logic/promptMood";
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
      if (marks[index].tick) assert.ok(left >= inked, `tick inside a label at ${width}`);
      if (!marks[index].label) return;
      labels++;
      assert.ok(left >= inked, `overlapping labels at ${width}`);
      assert.ok(left + chordLabelWidth(item.symbol) <= width + 1, "label leaves the strip");
      assert.ok(marks[index].tick, "a labelled chord has its tick");
      inked = left + chordLabelWidth(item.symbol);
    });
    assert.ok(labels >= 4, `only ${labels} labels at ${width} px`);
  }
});

test("chordLayout: nothing to draw without a width or a duration", () => {
  const chords = [chord(0, 4, "C")];
  assert.deepEqual(chordLayout(chords, 4, 0), [{ label: false, tick: false }]);
  assert.deepEqual(chordLayout(chords, 0, 300), [{ label: false, tick: false }]);
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

test("groupByParts follows the track of each part and skips the lead's own instrument", () => {
  const names = ["柔和钢琴", "弦乐", "指弹贝斯", "流行鼓组"];
  const groups = groupByParts(
    [
      { kind: "notes", role: "lead", track: "melody", voice: "piano" },
      { kind: "notes", role: "counter", track: "melody", voice: "strings" },
      // the pianist's left hand is not a second instrument
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
    chords: ["弦乐"],
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
      assert.ok(summary.instruments.includes(name), `${style.id}: ${name} was invented`);
    assert.equal(groups.melody[0], instrumentLabel(config.instrument), style.id);
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
    instruments: [instrumentLabel(config.instrument), "手风琴", "电贝斯", "大鼓"],
  });
  assert.deepEqual(groups.melody, [instrumentLabel(config.instrument)]);
  assert.deepEqual(groups.chords, ["手风琴"]);
  assert.deepEqual(groups.bass, ["电贝斯"]);
  assert.deepEqual(groups.drums, ["大鼓"]);
});

/* ---------------- prompt cards ---------------- */

test("promptMood: every ready-made prompt gets the colours of a real style", () => {
  const ids = new Set<string>(STYLES.map((style) => style.id));
  const prompts = [
    ...QUICK_PROMPTS,
    ...SCENARIO_GROUPS.flatMap((group) => group.prompts),
  ];
  for (const item of prompts) assert.ok(ids.has(promptMood(item.prompt)), item.id);
  assert.equal(promptMood("国风游戏里的江南小镇，古筝和竹笛，悠闲，适合循环"), "guofeng");
  assert.equal(promptMood("8-bit 像素风的冒险游戏主题曲"), "chiptune");
  // asked twice: the same answer (cached)
  assert.equal(promptMood("8-bit 像素风的冒险游戏主题曲"), "chiptune");
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
  state = reducer(state, { type: "ui/modal", modal: "settings", settingsTab: "llm" });
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
