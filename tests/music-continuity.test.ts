/**
 * A refinement keeps the melody. The tune is a function of the seed, the
 * style and the section family; every other setting only adapts it (see
 * composeLead in src/music/melody.ts). These tests measure that over all 22
 * styles and many seeds, and hold melodyContinuity() — the composer's own
 * account of what a change does to the tune, used for the agent's replies —
 * against the scores it describes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTRUMENT_IDS,
  KEYS,
  STYLE_IDS,
  parseKey,
  type InstrumentId,
  type StyleId,
} from "../src/music/catalog";
import { compose, melodyContinuity } from "../src/music/compose";
import {
  DEFAULT_CONFIG,
  clampConfig,
  stylePreset,
} from "../src/music/defaults";
import { planForm, planTiming } from "../src/music/form";
import { TUNE_ABOVE, TUNE_BELOW, leadCentre } from "../src/music/harmony";
import { SWUNG_FEELS, makeTimeMap } from "../src/music/rhythm";
import type { NoteEvent, NotePart, Score } from "../src/music/score";
import { getStyle } from "../src/music/styles";
import { LEAD_TRAITS, makeKey } from "../src/music/theory";
import type { MusicConfig } from "../src/types";

const pc = (midi: number) => ((Math.round(midi) % 12) + 12) % 12;

function config(
  style: StyleId,
  overrides: Partial<MusicConfig> = {},
): MusicConfig {
  return clampConfig({
    ...DEFAULT_CONFIG,
    ...stylePreset(style),
    ...overrides,
  });
}
const leadOf = (score: Score): NoteEvent[] =>
  (score.parts.find((part) => part.role === "lead") as NotePart | undefined)
    ?.notes ?? [];

/** Seconds → beats: the inverse of the clock the piece was written on (swing and rubato included). */
function beatClock(
  cfg: MusicConfig,
  score: Score,
): (seconds: number) => number {
  const style = getStyle(cfg.mood);
  const timing = planTiming(cfg, style);
  const feel = cfg.arrangement?.drums
    ? SWUNG_FEELS[cfg.arrangement.drums]
    : undefined;
  const time = makeTimeMap(
    timing,
    score.swing,
    feel !== undefined ? 8 : (style.swingGrid ?? 8),
    style.rubato ?? 0,
    planForm(cfg, style, timing).map((section) => ({
      startBar: section.startBar,
      bars: section.playBars,
    })),
  );
  const total = score.bars * 4;
  return (seconds) => {
    let low = -1;
    let high = total + 1;
    for (let i = 0; i < 40; i++) {
      const middle = (low + high) / 2;
      if (time.seconds(middle) < seconds) low = middle;
      else high = middle;
    }
    return (low + high) / 2;
  };
}

interface Placed {
  /** sixteenths from the start of the section */
  step: number;
  /** semitones above the tonic, 0..11 */
  degree: number;
  midi: number;
}
interface Excerpt {
  notes: Placed[];
  bars: number;
  score: Score;
}

/**
 * The lead in the first section of `type`, at most eight bars of it, on the
 * sixteenth grid. A tremolo (one note re-struck) counts as the one note it is.
 */
function excerpt(
  cfg: MusicConfig,
  type: string,
  score = compose(cfg),
): Excerpt {
  const section =
    score.sections.find((item) => item.type === type) ?? score.sections[0];
  const toBeat = beatClock(cfg, score);
  const beat = 60 / score.bpm;
  const bars = Math.min(section.bars, 8);
  const all = leadOf(score);
  const notes = all
    .filter((note, i) => {
      const before = all[i - 1];
      return !(
        before &&
        before.midi === note.midi &&
        note.t - before.t < Math.max(0.17, beat * 0.3) &&
        before.d < beat * 0.3
      );
    })
    .map((note) => ({
      step: Math.round(toBeat(note.t) * 4) - section.startBar * 16,
      degree: pc(note.midi - score.key.tonic),
      midi: note.midi,
    }))
    .filter((note) => note.step >= 0 && note.step < bars * 16);
  return { notes, bars, score };
}

/** The section both pieces are compared on: the first verse where both have one. */
function commonSection(a: Score, b: Score): string {
  const has = (score: Score, type: string) =>
    score.sections.some((section) => section.type === type);
  return (
    ["verse", "chorus", "bridge", "build", "breakdown", "outro", "intro"].find(
      (type) => has(a, type) && has(b, type),
    ) ?? "verse"
  );
}

interface Kept {
  /** share of the notes that keep both their place in the bar and their scale degree */
  notes: number;
  /** share that keep their place, whatever the pitch */
  onsets: number;
  /** share of the sparser version's onsets that the other one has too */
  shared: number;
  type: string;
  a: Excerpt;
  b: Excerpt;
}
function kept(before: MusicConfig, after: MusicConfig): Kept {
  const scoreA = compose(before);
  const scoreB = compose(after);
  const type = commonSection(scoreA, scoreB);
  const a = excerpt(before, type, scoreA);
  const b = excerpt(after, type, scoreB);
  const bars = Math.min(a.bars, b.bars);
  const first = a.notes.filter((note) => note.step < bars * 16);
  const second = b.notes.filter((note) => note.step < bars * 16);
  const at = new Map<number, number[]>();
  for (const note of second)
    at.set(note.step, [...(at.get(note.step) ?? []), note.degree]);
  let notes = 0;
  let onsets = 0;
  for (const note of first) {
    const degrees = at.get(note.step);
    if (!degrees) continue;
    onsets++;
    if (degrees.includes(note.degree)) notes++;
  }
  const most = Math.max(first.length, second.length, 1);
  const least = Math.max(1, Math.min(first.length, second.length));
  return {
    notes: notes / most,
    onsets: onsets / most,
    shared: Math.min(1, onsets / least),
    type,
    a,
    b,
  };
}

const SEEDS = [3000, 3151, 3302, 3453, 3604, 3755];
/** every style × seed × loop on / off, at the style's own settings */
function* bases(seeds: readonly number[] = SEEDS): Generator<MusicConfig> {
  for (const style of STYLE_IDS)
    for (const seed of seeds)
      for (const loop of [true, false])
        yield config(style, { seed, loop, duration: 30 });
}
const label = (cfg: MusicConfig) =>
  `${cfg.mood} seed ${cfg.seed} loop=${cfg.loop}`;

/** The same notes on the same beats (the clock may differ: tempo, swing). */
function assertSameTune(before: MusicConfig, after: MusicConfig, what: string) {
  const a = compose(before);
  const b = compose(after);
  const first = leadOf(a);
  const second = leadOf(b);
  assert.deepEqual(
    second.map((note) => note.midi),
    first.map((note) => note.midi),
    `${what}: the lead's pitches changed`,
  );
  const beatA = beatClock(before, a);
  const beatB = beatClock(after, b);
  for (let i = 0; i < first.length; i++) {
    const x = beatA(first[i].t);
    const y = beatB(second[i].t);
    // (humanisation moves a note by a few milliseconds, which is a different share of a beat at another tempo)
    assert.ok(
      Math.abs(x - y) < 0.09,
      `${what}: note ${i} moved from beat ${x.toFixed(2)} to ${y.toFixed(2)}`,
    );
  }
}

/* ------------------------------------------------------------------ */

test("reverb, faders, drum and bass feel and layer toggles leave every note of the lead where it is", () => {
  const changes: [string, (cfg: MusicConfig) => Partial<MusicConfig>][] = [
    ["reverb", (cfg) => ({ reverb: cfg.reverb > 0.5 ? 0.05 : 0.95 })],
    [
      "faders",
      () => ({ volumes: { melody: 0.3, chords: 1, bass: 0.2, drums: 0.9 } }),
    ],
    ["prompt", () => ({ prompt: "换一句描述，音乐本身不变" })],
    ["drums: halftime", () => ({ arrangement: { drums: "halftime" } })],
    ["drums: fourfloor", () => ({ arrangement: { drums: "fourfloor" } })],
    ["drums: none", () => ({ arrangement: { drums: "none" } })],
    ["bass: walking", () => ({ arrangement: { bass: "walking" } })],
    ["bass: none", () => ({ arrangement: { bass: "none" } })],
    ["pad on", () => ({ arrangement: { layers: { pad: true } } })],
    ["pad off", () => ({ arrangement: { layers: { pad: false } } })],
    [
      "counter and percussion on",
      () => ({ arrangement: { layers: { counter: true, perc: true } } }),
    ],
  ];
  let checked = 0;
  for (const base of bases(SEEDS.slice(0, 4)))
    for (const [name, change] of changes) {
      const next = { ...base, ...change(base) };
      const what = `${label(base)}, ${name}`;
      assert.equal(melodyContinuity(base, next), "identical", what);
      // nothing about the clock changed either: the part is the same to the last digit
      assert.deepEqual(leadOf(compose(next)), leadOf(compose(base)), what);
      checked++;
    }
  assert.equal(checked, STYLE_IDS.length * 4 * 2 * changes.length);
});

test("a swung drum feel or a swing hint re-times the clock, not the tune", () => {
  const changes: [string, Partial<MusicConfig>][] = [
    ["drums: swing", { arrangement: { drums: "swing" } }],
    ["drums: shuffle", { arrangement: { drums: "shuffle" } }],
    ["swing 0.5", { arrangement: { swing: 0.5 } }],
    ["swing 0", { arrangement: { swing: 0 } }],
  ];
  for (const base of bases(SEEDS.slice(0, 3)))
    for (const [name, change] of changes) {
      const next = { ...base, ...change };
      assert.equal(
        melodyContinuity(base, next),
        "identical",
        `${label(base)}, ${name}`,
      );
      assertSameTune(base, next, `${label(base)}, ${name}`);
    }
});

/** Mean and minimum of the notes kept over every style, seed and loop setting. */
function survey(
  change: (cfg: MusicConfig, index: number) => Partial<MusicConfig> | null,
  each?: (result: Kept, before: MusicConfig, after: MusicConfig) => void,
) {
  let count = 0;
  let sum = 0;
  let onsets = 0;
  let least = 1;
  let worst = "";
  let index = 0;
  for (const base of bases()) {
    const delta = change(base, index++);
    if (!delta) continue;
    const next = clampConfig({ ...base, ...delta });
    const result = kept(base, next);
    each?.(result, base, next);
    count++;
    sum += result.notes;
    onsets += result.onsets;
    if (result.notes < least) {
      least = result.notes;
      worst = label(base);
    }
  }
  return { count, mean: sum / count, onsets: onsets / count, least, worst };
}

test("tempo ±10 %: at least 85 % of the first verse stays on average, never less than 60 %", () => {
  for (const factor of [1.1, 0.9]) {
    const result = survey((cfg) => ({ bpm: Math.round(cfg.bpm * factor) }));
    const what = `bpm ×${factor}`;
    assert.ok(
      result.mean >= 0.95,
      `${what}: ${result.mean.toFixed(3)} of the notes kept on average`,
    );
    assert.ok(
      result.least >= 0.6,
      `${what}: only ${result.least.toFixed(2)} kept in ${result.worst}`,
    );
    assert.ok(
      result.onsets >= 0.97,
      `${what}: ${result.onsets.toFixed(3)} of the onsets kept`,
    );
  }
});

test("a tempo change that keeps the form keeps every pitch and every onset in beats", () => {
  // loops whose bar count survives the change: nothing but the clock differs
  let checked = 0;
  for (const base of bases()) {
    if (!base.loop) continue;
    for (const bpm of [
      base.bpm + 3,
      base.bpm - 3,
      Math.round(base.bpm * 1.06),
    ]) {
      const next = { ...base, bpm };
      if (compose(next).bars !== compose(base).bars) continue;
      assert.equal(
        melodyContinuity(base, next),
        "identical",
        `${label(base)} at ${bpm} BPM`,
      );
      assertSameTune(base, next, `${label(base)} at ${bpm} BPM`);
      checked++;
    }
  }
  assert.ok(checked >= 150, `${checked} loops kept their bars`);
});

test("energy ±0.15 leaves the tune alone: only its dynamics follow", () => {
  for (const delta of [0.15, -0.15]) {
    const result = survey(
      (cfg) => ({ energy: Math.min(1, Math.max(0, cfg.energy + delta)) }),
      (kept, before, after) => {
        // inside the dead zone and the same register step: note for note the same tune
        assert.equal(
          melodyContinuity(before, after),
          "identical",
          `${label(before)} energy ${delta}`,
        );
        assert.equal(
          kept.notes,
          1,
          `${label(before)} energy ${delta}: ${kept.notes.toFixed(2)} kept`,
        );
      },
    );
    assert.equal(result.mean, 1);
  }
  // and the dynamics do follow
  const base = config("bright", { loop: false, duration: 30 });
  const louder = leadOf(compose({ ...base, energy: base.energy + 0.15 }));
  const softer = leadOf(compose({ ...base, energy: base.energy - 0.15 }));
  const mean = (notes: NoteEvent[]) =>
    notes.reduce((sum, note) => sum + note.vel, 0) / notes.length;
  assert.ok(
    mean(louder) > mean(softer) + 0.03,
    `velocity ${mean(softer).toFixed(3)} → ${mean(louder).toFixed(3)}`,
  );
});

test("complexity ±0.15 adds or takes a note here and there: 85 % of the first verse stays on average", () => {
  /** the triads under the excerpt, bar by bar: has the control re-harmonised the verse itself? */
  const harmony = (excerpt: Excerpt, type: string) => {
    const section =
      excerpt.score.sections.find((item) => item.type === type) ??
      excerpt.score.sections[0];
    return excerpt.score.chords
      .filter(
        (chord) =>
          chord.bar >= section.startBar &&
          chord.bar < section.startBar + excerpt.bars,
      )
      .map(
        (chord) =>
          `${chord.bar - section.startBar}:${chord.pitchClasses.slice(0, 3).join(".")}`,
      )
      .join(" ");
  };
  for (const delta of [0.15, -0.15]) {
    let reharmonised = 0;
    const result = survey(
      (cfg) => ({
        complexity: Math.min(1, Math.max(0, cfg.complexity + delta)),
      }),
      (kept, before) => {
        const same = harmony(kept.a, kept.type) === harmony(kept.b, kept.type);
        if (!same) reharmonised++;
        // Under the same chords the tune only thins or fills. Where the control
        // has changed a chord of the verse itself, the notes over that bar (and
        // the passing notes that led into it) follow the new chord.
        assert.ok(
          kept.notes >= (same ? 0.6 : 0.5),
          `${label(before)} complexity ${delta}: ${kept.notes.toFixed(2)} kept${same ? "" : " (chords changed)"}`,
        );
        assert.ok(
          kept.shared >= 0.6,
          `${label(before)} complexity ${delta}: onsets ${kept.shared.toFixed(2)}`,
        );
      },
    );
    assert.ok(
      result.mean >= 0.85,
      `complexity ${delta}: ${result.mean.toFixed(3)} of the notes kept on average`,
    );
    assert.ok(
      reharmonised < result.count * 0.3,
      `complexity ${delta}: ${reharmonised} of ${result.count} verses re-harmonised`,
    );
  }
});

test("another key in the same mode is the same tune transposed", () => {
  const keysLike = (cfg: MusicConfig) =>
    KEYS.filter(
      (key) => key.endsWith(cfg.key.split(" ")[1]) && key !== cfg.key,
    );
  let whole = 0;
  let pieces = 0;
  const result = survey(
    (cfg, index) => ({ key: keysLike(cfg)[(index * 5) % 11] }),
    (kept, before, after) => {
      assert.equal(melodyContinuity(before, after), "adapted");
      assert.equal(
        kept.onsets,
        1,
        `${label(before)} → ${after.key}: the rhythm changed`,
      );
      // the whole lead, not just the verse: one interval for every note
      const a = leadOf(kept.a.score);
      const b = leadOf(kept.b.score);
      pieces++;
      if (
        a.length === b.length &&
        a.every((note, i) => b[i].midi - note.midi === b[0].midi - a[0].midi)
      )
        whole++;
    },
  );
  assert.ok(
    result.mean >= 0.97,
    `${result.mean.toFixed(3)} of the scale degrees kept on average`,
  );
  assert.ok(
    result.least >= 0.6,
    `only ${result.least.toFixed(2)} kept in ${result.worst}`,
  );
  // (the rest reach the edge of the instrument's range in the new key and fold a few notes back)
  assert.ok(
    whole / pieces >= 0.85,
    `${whole} of ${pieces} leads are exact transpositions from the first note to the last`,
  );
  // the shorter way round, up or down, wherever the tune's whole compass has
  // room on the instrument there (see leadCentre); never further than a fifth
  for (const style of ["bright", "sad", "retro"] as StyleId[]) {
    const base = config(style, { loop: true, duration: 30 });
    const home = leadOf(compose(base));
    const trait = LEAD_TRAITS[base.instrument];
    const centre = leadCentre({
      config: base,
      style: getStyle(style),
      key: makeKey(base.key, "major"),
    });
    for (const key of keysLike(base)) {
      const moved = leadOf(compose({ ...base, key }));
      const shift = moved[0].midi - home[0].midi;
      assert.ok(
        Math.abs(shift) <= 7,
        `${style} in ${key}: the tune moved by ${shift} semitones`,
      );
      const shorter =
        ((((parseKey(key).tonic - parseKey(base.key).tonic) % 12) + 18) % 12) -
        6;
      const fits =
        centre + shorter - TUNE_BELOW >= trait.low &&
        centre + shorter + TUNE_ABOVE <= trait.high;
      if (fits) assert.equal(shift, shorter, `${style} in ${key}`);
    }
  }
});

test("major to minor keeps the rhythm of the tune and maps it onto the new scale", () => {
  const result = survey(
    (cfg) => ({
      key: cfg.key.endsWith("major")
        ? cfg.key.replace("major", "minor")
        : cfg.key.replace("minor", "major"),
    }),
    (kept, before, after) => {
      assert.equal(melodyContinuity(before, after), "adapted");
      assert.notDeepEqual(
        kept.a.score.key.scale.map((value) =>
          pc(value - kept.a.score.key.tonic),
        ),
        kept.b.score.key.scale.map((value) =>
          pc(value - kept.b.score.key.tonic),
        ),
      );
    },
  );
  // the motif is the same; the chords under it come from the other mode's bank
  assert.ok(
    result.onsets >= 0.95,
    `${result.onsets.toFixed(3)} of the onsets kept`,
  );
});

test("another lead instrument plays the same notes, an octave away at most", () => {
  const others = (cfg: MusicConfig) =>
    INSTRUMENT_IDS.filter((instrument) => instrument !== cfg.instrument);
  let modal = 0;
  let sum = 0;
  let count = 0;
  let least = 1;
  let worst = "";
  let index = 0;
  for (const base of bases()) {
    const instrument: InstrumentId = others(base)[index++ % 13];
    const next = { ...base, instrument };
    const result = kept(base, next);
    const what = `${label(base)} → ${instrument}`;
    assert.equal(melodyContinuity(base, next), "adapted", what);
    assert.ok(
      result.onsets >= 0.9,
      `${what}: onsets ${result.onsets.toFixed(2)}`,
    );
    // a style may keep a scale for certain leads (festive goes pentatonic for guzheng and dizi):
    // then the chords change with it, and only the rhythm is the same
    if (result.a.score.key.scale.join() !== result.b.score.key.scale.join()) {
      modal++;
      continue;
    }
    // a section that is lifted (the chorus) is lifted less for leads that already sing high
    if (result.type !== "verse") continue;
    count++;
    sum += result.notes;
    if (result.notes < least) {
      least = result.notes;
      worst = what;
    }
  }
  assert.ok(
    sum / count >= 0.95,
    `${(sum / count).toFixed(3)} of the first verse kept on average`,
  );
  assert.ok(least >= 0.6, `only ${least.toFixed(2)} kept in ${worst}`);
  assert.ok(modal < 20, `${modal} lead changes changed the scale`);
  // the notes are the same pitch classes; whole octaves apart for instruments of the same kind of range
  const base = config("bright", { loop: true, duration: 30 });
  const piano = leadOf(compose(base));
  for (const instrument of [
    "epiano",
    "synth",
    "pluck",
    "marimba",
    "vibes",
    "strings",
    "guitar",
    "chip",
  ] as InstrumentId[]) {
    const other = leadOf(compose({ ...base, instrument }));
    assert.equal(other.length, piano.length, instrument);
    const shifts = new Set(other.map((note, i) => note.midi - piano[i].midi));
    assert.ok(
      shifts.size === 1 && [...shifts][0] % 12 === 0,
      `${instrument}: shifted by ${[...shifts].join("/")}`,
    );
  }
});

test("another length or form keeps the motif of every section family", () => {
  for (const [name, change] of [
    ["30 → 60 s", () => ({ duration: 60 })],
    ["30 → 90 s", () => ({ duration: 90 })],
    ["loop ↔ piece that ends", (cfg: MusicConfig) => ({ loop: !cfg.loop })],
  ] as [string, (cfg: MusicConfig) => Partial<MusicConfig>][]) {
    const result = survey(change, (kept, before, after) => {
      assert.equal(
        melodyContinuity(before, after),
        "adapted",
        `${label(before)} ${name}`,
      );
    });
    assert.ok(
      result.mean >= 0.9,
      `${name}: ${result.mean.toFixed(3)} of the notes kept on average`,
    );
    assert.ok(
      result.least >= 0.6,
      `${name}: only ${result.least.toFixed(2)} kept in ${result.worst}`,
    );
  }
  // a verse of eight bars cut to four: the four bars are the first half of the
  // eight (but for a note where the longer verse saves its highest pitch for
  // the climax of its second phrase)
  for (const style of [
    "bright",
    "retro",
    "acoustic",
    "corporate",
  ] as StyleId[]) {
    const form = (bars: number) => [
      { type: "verse" as const, bars, energy: 0.5 },
      { type: "chorus" as const, bars: 8, energy: 0.8 },
    ];
    const long = config(style, {
      loop: true,
      duration: 30,
      arrangement: { form: form(8) },
    });
    const short = config(style, {
      loop: true,
      duration: 30,
      arrangement: { form: form(4) },
    });
    const result = kept(long, short);
    assert.ok(result.a.bars >= 6, `${style}: ${result.a.bars} bars`);
    assert.equal(result.b.bars, 4);
    // (a pickup into whatever follows may be added at the very end)
    assert.ok(
      result.shared >= 0.95 && result.onsets >= 0.85,
      `${style}: the rhythm of the four bars changed`,
    );
    assert.ok(
      result.notes >= 0.85,
      `${style}: ${result.notes.toFixed(2)} of the four bars kept`,
    );
  }
});

test("another seed is another tune", () => {
  const result = survey(
    (cfg) => ({ seed: cfg.seed + 1 }),
    (kept, before, after) => {
      assert.equal(melodyContinuity(before, after), "new");
    },
  );
  assert.ok(
    result.mean < 0.3,
    `${result.mean.toFixed(3)} of the notes coincide`,
  );
  // (two sparse tunes can share most of their few notes by chance, but it stays the exception)
  let alike = 0;
  survey(
    (cfg) => ({ seed: cfg.seed + 7919 }),
    (kept) => {
      if (kept.notes > 0.6) alike++;
    },
  );
  assert.ok(
    alike <= 6,
    `${alike} of ${STYLE_IDS.length * SEEDS.length * 2} new seeds gave nearly the same verse`,
  );
});

test("far from the style's own settings the tune thins, fills and climbs — the same tune still", () => {
  let checked = 0;
  for (const base of bases(SEEDS.slice(0, 3))) {
    // complexity all the way down and up: notes go and come, the ones that stay keep their place
    const plain = kept(base, { ...base, complexity: 0 });
    const rich = kept(base, { ...base, complexity: 1 });
    assert.ok(
      plain.shared >= 0.6,
      `${label(base)} complexity 0: ${plain.shared.toFixed(2)} of the sparser onsets shared`,
    );
    assert.ok(
      rich.shared >= 0.6,
      `${label(base)} complexity 1: ${rich.shared.toFixed(2)}`,
    );
    assert.ok(
      rich.b.notes.length >= plain.b.notes.length,
      `${label(base)}: ${plain.b.notes.length} notes at complexity 0, ${rich.b.notes.length} at 1`,
    );
    // energy from one end to the other: the first phrase of the verse stays put,
    // the answers and the chorus climb (see LeadTraits.lift)
    const calm = { ...base, energy: 0 };
    const wild = { ...base, energy: 1 };
    assert.equal(melodyContinuity(calm, wild), "adapted");
    const range = kept(calm, wild);
    assert.ok(
      range.shared >= 0.6,
      `${label(base)} energy 0 → 1: ${range.shared.toFixed(2)} of the onsets shared`,
    );
    const mean = (cfg: MusicConfig) => {
      const lead = leadOf(compose({ ...cfg, duration: 60 }));
      return lead.reduce((sum, note) => sum + note.midi, 0) / lead.length;
    };
    assert.ok(
      mean(wild) > mean(calm),
      `${label(base)}: the tune does not climb with the energy`,
    );
    checked++;
  }
  assert.equal(checked, STYLE_IDS.length * 3 * 2);
});

test("melodyContinuity: identical, adapted and new mean what the scores say", () => {
  // random pairs of settings, several fields at once
  let state = 20261;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(random() * items.length)];
  const tally = { identical: 0, adapted: 0, new: 0 };
  let adaptedOnsets = 0;
  let newNotes = 0;
  for (let i = 0; i < 700; i++) {
    const style = pick(STYLE_IDS);
    const base = config(style, {
      seed: 1 + Math.floor(random() * 1e6),
      loop: random() < 0.5,
      duration: pick([20, 30, 45]),
    });
    const changes: Partial<MusicConfig> = {};
    const fields = 1 + Math.floor(random() * 2);
    for (let k = 0; k < fields; k++) {
      const what = pick([
        "bpm",
        "bpmSmall",
        "energy",
        "energySmall",
        "complexity",
        "key",
        "instrument",
        "reverb",
        "volumes",
        "drums",
        "bass",
        "layers",
        "swing",
        "duration",
        "loop",
        "seed",
        "density",
        "register",
        "motion",
        "progression",
      ]);
      if (what === "bpm")
        changes.bpm = Math.round(base.bpm * (0.8 + 0.4 * random()));
      else if (what === "bpmSmall")
        changes.bpm = base.bpm + pick([-4, -2, 2, 4]);
      else if (what === "energy") changes.energy = random();
      else if (what === "energySmall")
        changes.energy = Math.min(
          1,
          Math.max(0, base.energy + pick([-0.1, 0.1, 0.2, -0.2])),
        );
      else if (what === "complexity") changes.complexity = random();
      else if (what === "key") changes.key = pick(KEYS);
      else if (what === "instrument") changes.instrument = pick(INSTRUMENT_IDS);
      else if (what === "reverb") changes.reverb = random();
      else if (what === "volumes")
        changes.volumes = {
          melody: random(),
          chords: random(),
          bass: random(),
          drums: random(),
        };
      else if (what === "duration") changes.duration = pick([20, 30, 45, 60]);
      else if (what === "loop") changes.loop = !base.loop;
      else if (what === "seed") changes.seed = base.seed + 1;
      else {
        const hints = { ...(changes.arrangement ?? {}) };
        if (what === "drums")
          hints.drums = pick([
            "none",
            "light",
            "straight",
            "halftime",
            "swing",
            "breakbeat",
          ] as const);
        else if (what === "bass")
          hints.bass = pick(["none", "root", "octave", "pedal"] as const);
        else if (what === "layers")
          hints.layers = { pad: random() < 0.5, arp: random() < 0.5 };
        else if (what === "swing") hints.swing = pick([0, 0.3, 0.6]);
        else if (what === "density")
          hints.melody = { ...hints.melody, density: random() };
        else if (what === "register")
          hints.melody = {
            ...hints.melody,
            register: pick(["low", "high"] as const),
          };
        else if (what === "motion")
          hints.melody = {
            ...hints.melody,
            motion: pick(["stepwise", "leaps", "arpeggio"] as const),
          };
        else if (what === "progression")
          hints.progression = pick([
            ["I", "V", "vi", "IV"],
            ["vi", "IV", "I", "V"],
            ["i", "bVI", "bIII", "bVII"],
          ]);
        changes.arrangement = hints;
      }
    }
    const next = clampConfig({ ...base, ...changes });
    const verdict = melodyContinuity(base, next);
    tally[verdict]++;
    const what = `${label(base)} + ${JSON.stringify(changes)}`;
    if (verdict === "identical") assertSameTune(base, next, what);
    else {
      const result = kept(base, next);
      if (verdict === "adapted") adaptedOnsets += result.shared;
      else newNotes += result.notes;
    }
  }
  assert.ok(
    tally.identical >= 100 && tally.adapted >= 250 && tally.new >= 50,
    JSON.stringify(tally),
  );
  // an adapted tune shares most of its rhythm with the one it came from; a new one shares little of anything
  assert.ok(
    adaptedOnsets / tally.adapted >= 0.85,
    `adapted: ${(adaptedOnsets / tally.adapted).toFixed(3)} of the onsets shared`,
  );
  assert.ok(
    newNotes / tally.new <= 0.35,
    `new: ${(newNotes / tally.new).toFixed(3)} of the notes coincide`,
  );
  // the frozen v0.2 engine is another composer altogether
  const old = { ...config("bright"), engine: 1 as const };
  assert.equal(melodyContinuity(old, config("bright")), "new");
  assert.equal(
    melodyContinuity(config("bright"), config("bright")),
    "identical",
  );
  assert.equal(melodyContinuity(config("bright"), config("chill")), "new");
});
