/**
 * What the settings may not do to the music, measured on composed scores:
 *
 * - a tune that is thinned (low complexity, a sparse-melody hint, a tempo too
 *   fast for sixteenths) or filled keeps its voice leading: no avoid note is
 *   left holding against the chord, no tritone leap opens where the notes
 *   between two others were taken away;
 * - compose() always returns a Score its own validator accepts, whatever valid
 *   settings and hints it is given — including a tune left entirely on its own.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BASS_FEELS,
  DRUM_FEELS,
  INSTRUMENT_IDS,
  KEYS,
  SECTION_TYPES,
  STYLE_IDS,
  type StyleId,
} from "../src/music/catalog";
import { compose } from "../src/music/compose";
import {
  DEFAULT_CONFIG,
  clampConfig,
  stylePreset,
} from "../src/music/defaults";
import { planForm, planTiming } from "../src/music/form";
import { SWUNG_FEELS, makeTimeMap } from "../src/music/rhythm";
import type { NoteEvent, NotePart, Score } from "../src/music/score";
import { getStyle } from "../src/music/styles";
import { scoreProblems } from "../src/music/validate";
import type { ArrangementHints, MusicConfig } from "../src/types";

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

/** The lead on the beat grid the piece was written on (swing and rubato undone, humanisation rounded away). */
function leadInBeats(
  cfg: MusicConfig,
  score: Score,
): { beat: number; beats: number; midi: number }[] {
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
  const GRID = 8;
  const steps = (score.bars * 4 + 2) * GRID;
  const at = new Float64Array(steps + 2);
  for (let i = 0; i <= steps + 1; i++) at[i] = time.seconds((i - GRID) / GRID);
  const toBeat = (seconds: number) => {
    let low = 0;
    let high = steps + 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (at[middle] <= seconds) low = middle;
      else high = middle;
    }
    const span = at[high] - at[low];
    return (low - GRID + (span > 0 ? (seconds - at[low]) / span : 0)) / GRID;
  };
  return leadOf(score).map((note) => {
    const beat = Math.round(toBeat(note.t) * GRID) / GRID;
    return { beat, beats: toBeat(note.t + note.d) - beat, midi: note.midi };
  });
}

interface Faults {
  notes: number;
  bars: number;
  /** two notes in a row (less than a beat of rest between them) an augmented fourth apart */
  tritones: number;
  /**
   * notes held a beat or 0.6 s that grate against the chord they sound over —
   * a semitone above one of its notes, or the minor third over its major one —
   * and do not move on by step
   */
  avoid: number;
  /** notes held a beat on beat one or three that are neither in the chord nor its ninth, and do not move on by step */
  foreign: number;
  examples: string[];
}

function faultsOf(cfg: MusicConfig, into: Faults): void {
  const score = compose(cfg);
  const lead = leadInBeats(cfg, score);
  const beatSeconds = 60 / score.bpm;
  into.bars += score.bars;
  // (Score.chords are on the plain clock: beats × seconds per beat)
  const chordAt = (beat: number) => {
    const t = beat * beatSeconds + 1e-6;
    return (
      score.chords.find((chord) => t >= chord.start && t < chord.end) ??
      score.chords[score.chords.length - 1]
    );
  };
  lead.forEach((note, i) => {
    into.notes++;
    const before = lead[i - 1];
    const next = lead[i + 1];
    if (
      before &&
      note.beat - (before.beat + before.beats) < 1 &&
      Math.abs(note.midi - before.midi) === 6
    ) {
      into.tritones++;
      if (into.examples.length < 6)
        into.examples.push(
          `${cfg.mood} seed ${cfg.seed} loop=${cfg.loop}: tritone into bar ${Math.floor(note.beat / 4) + 1}`,
        );
    }
    const held = note.beats >= 0.95 || note.beats * beatSeconds >= 0.6;
    if (!held) return;
    // a note pushed ahead of the beat belongs to the chord it is held over
    const chord = chordAt(note.beat + Math.min(note.beats * 0.6, 1));
    const pitch = pc(note.midi);
    if (chord.pitchClasses.includes(pitch)) return;
    const resolves =
      !!next &&
      Math.abs(next.midi - note.midi) <= 2 &&
      next.beat - (note.beat + note.beats) < 0.5;
    if (resolves) return;
    const grates =
      chord.pitchClasses.includes(pc(pitch - 1)) ||
      (pitch === pc(chord.root + 3) &&
        chord.pitchClasses.includes(pc(chord.root + 4)));
    if (grates) {
      into.avoid++;
      if (into.examples.length < 6)
        into.examples.push(
          `${cfg.mood} seed ${cfg.seed} loop=${cfg.loop}: bar ${Math.floor(note.beat / 4) + 1}, ${note.beats.toFixed(2)} beats against ${chord.symbol}`,
        );
    }
    const ninth = pitch === pc(chord.root + 2);
    if (note.beat % 2 === 0 && note.beats >= 0.95 && !ninth) into.foreign++;
  });
}

function survey(overrides: (style: StyleId) => Partial<MusicConfig>): Faults {
  const faults: Faults = {
    notes: 0,
    bars: 0,
    tritones: 0,
    avoid: 0,
    foreign: 0,
    examples: [],
  };
  for (const style of STYLE_IDS)
    for (let s = 0; s < 6; s++)
      for (const loop of [true, false])
        faultsOf(
          config(style, {
            loop,
            duration: loop ? 30 : 60,
            seed: 5150 + s * 3331,
            ...overrides(style),
          }),
          faults,
        );
  return faults;
}

test("a thinned or filled tune keeps its voice leading: no avoid note left holding, no tritone across a gap", () => {
  const written = survey(() => ({}));
  // the tune as written is clean to begin with
  assert.ok(written.notes > 15000, `${written.notes} notes`);
  assert.ok(
    written.tritones <= written.notes * 0.0003,
    `as written: ${written.tritones} tritone leaps in ${written.notes} notes (${written.examples.join("; ")})`,
  );
  assert.ok(
    written.avoid <= 2,
    `as written: ${written.avoid} held avoid notes (${written.examples.join("; ")})`,
  );
  const settings: [string, (style: StyleId) => Partial<MusicConfig>][] = [
    ["complexity 0", () => ({ complexity: 0 })],
    ["complexity 0.2", () => ({ complexity: 0.2 })],
    ["complexity 1", () => ({ complexity: 1 })],
    ["a sparse tune", () => ({ arrangement: { melody: { density: 0.25 } } })],
    ["the sparsest tune", () => ({ arrangement: { melody: { density: 0 } } })],
    ["the busiest tune", () => ({ arrangement: { melody: { density: 1 } } })],
    ["180 BPM", () => ({ bpm: 180 })],
    ["200 BPM", () => ({ bpm: 200 })],
    ["energy 0.05", () => ({ energy: 0.05 })],
    ["energy 1", () => ({ energy: 1 })],
  ];
  for (const [name, overrides] of settings) {
    const now = survey(overrides);
    const where = now.examples.join("; ");
    assert.ok(now.notes > 3000, `${name}: ${now.notes} notes`);
    // (these used to be 4 to 5 per thousand notes at complexity 0 and at 180 BPM)
    assert.ok(
      now.tritones <= Math.max(2, now.notes * 0.0005),
      `${name}: ${now.tritones} tritone leaps in ${now.notes} notes (${where})`,
    );
    // (34 of 528 pieces at complexity 0 had one)
    assert.ok(
      now.avoid <= 2,
      `${name}: ${now.avoid} avoid notes left holding (${where})`,
    );
    // and what is held on a strong beat is of the chord no less often than
    // in the tune as written (per bar of music: a fast piece has more bars)
    assert.ok(
      now.foreign / now.bars <= (written.foreign / written.bars) * 1.15 + 0.002,
      `${name}: ${now.foreign} held strong-beat notes foreign to the chord in ${now.bars} bars, ${written.foreign} in ${written.bars} as written`,
    );
  }
  // a slow tempo adds passing notes; those it adds do not grate either
  const slow = survey(() => ({ bpm: 64 }));
  assert.ok(
    slow.tritones <= Math.max(2, slow.notes * 0.0005) && slow.avoid <= 6,
    `64 BPM: ${slow.tritones} tritones, ${slow.avoid} avoid notes (${slow.examples.join("; ")})`,
  );
});

test("thinning takes the ornaments first: what stays are notes of the tune as written, in their own places", () => {
  // every note of the thinned verse was there before, on the same step; and of
  // the notes on the beats more survive than of those between them
  let kept = 0;
  let total = 0;
  let onBeat = [0, 0];
  let offBeat = [0, 0];
  for (const style of STYLE_IDS)
    for (const seed of [11, 4057, 90210]) {
      const base = config(style, { seed, loop: true, duration: 30 });
      const thin = { ...base, complexity: Math.max(0, base.complexity - 0.3) };
      const a = compose(base);
      const b = compose(thin);
      // (complexity also re-colours chords; compare where the plain triads agree)
      const triads = (score: Score) =>
        score.chords
          .map((chord) => chord.pitchClasses.slice(0, 3).join("."))
          .join(" ");
      if (a.bars !== b.bars || triads(a) !== triads(b)) continue;
      const written = leadInBeats(base, a);
      const thinned = leadInBeats(thin, b);
      const at = new Map<number, number[]>();
      for (const note of written)
        at.set(note.beat, [...(at.get(note.beat) ?? []), note.midi]);
      const stays = new Set<number>();
      for (const note of thinned) {
        total++;
        if (at.get(note.beat)?.includes(note.midi)) {
          kept++;
          stays.add(note.beat);
        }
      }
      for (const note of written) {
        const tally = note.beat % 1 === 0 ? onBeat : offBeat;
        tally[1]++;
        if (stays.has(note.beat)) tally[0]++;
      }
    }
  assert.ok(total > 2000, `${total} notes compared`);
  assert.ok(
    kept / total >= 0.9,
    `${(kept / total).toFixed(3)} of the thinned tune's notes are notes of the tune as written`,
  );
  assert.ok(
    onBeat[0] / onBeat[1] > offBeat[0] / offBeat[1] + 0.1,
    `${(onBeat[0] / onBeat[1]).toFixed(2)} of the notes on the beat stay, ${(offBeat[0] / offBeat[1]).toFixed(2)} of those off it`,
  );
});

/* ---------------- compose() and its validator agree ---------------- */

function lcg(seed: number) {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(random() * items.length)];
  return { random, pick };
}

const PROGRESSIONS = [
  ["I", "V", "vi", "IV"],
  ["vi", "IV", "I", "V"],
  ["i", "bVI", "bIII", "bVII"],
  ["ii7", "V7", "Imaj7", "vi7"],
  ["I", "bVII", "IV", "I"],
  ["i", "iv", "V7", "i"],
  ["I", "I", "IV", "V", "vi", "IV", "ii", "V7"],
];

/** Any valid settings: every control anywhere in its range, any mixture of hints. */
function anyConfig(
  { random, pick }: ReturnType<typeof lcg>,
  style: StyleId = pick(STYLE_IDS),
): MusicConfig {
  const overrides: Partial<MusicConfig> = {
    seed: Math.floor(random() * 2 ** 32),
    loop: random() < 0.5,
    duration: 15 + Math.floor(random() * 106),
  };
  if (random() < 0.6) overrides.bpm = 50 + Math.floor(random() * 151);
  if (random() < 0.6)
    overrides.energy = random() < 0.25 ? pick([0, 1]) : random();
  if (random() < 0.6)
    overrides.complexity = random() < 0.25 ? pick([0, 1]) : random();
  if (random() < 0.5) overrides.key = pick(KEYS);
  if (random() < 0.5) overrides.instrument = pick(INSTRUMENT_IDS);
  if (random() < 0.3) overrides.reverb = random();
  if (random() < 0.75) {
    const hints: ArrangementHints = {};
    if (random() < 0.3) hints.progression = pick(PROGRESSIONS);
    if (random() < 0.25)
      hints.form = Array.from({ length: 1 + Math.floor(random() * 6) }, () => ({
        type: pick(SECTION_TYPES),
        bars: pick([1, 2, 4, 4, 8, 8, 12, 16]),
        energy: random() < 0.3 ? 0 : random(),
      }));
    if (random() < 0.4)
      hints.drums = pick(DRUM_FEELS.filter((feel) => feel !== "auto"));
    if (random() < 0.4)
      hints.bass = pick(BASS_FEELS.filter((feel) => feel !== "auto"));
    if (random() < 0.3) hints.swing = pick([0, 0.2, 0.5, 0.66]);
    if (random() < 0.5) {
      hints.layers = {};
      for (const layer of ["pad", "arp", "counter", "perc"] as const)
        if (random() < 0.6) hints.layers[layer] = random() < 0.4;
    }
    if (random() < 0.5) {
      hints.melody = {};
      if (random() < 0.6)
        hints.melody.density = random() < 0.4 ? pick([0, 0, 1]) : random();
      if (random() < 0.5)
        hints.melody.register = pick(["low", "mid", "high"] as const);
      if (random() < 0.4)
        hints.melody.motion = pick(["stepwise", "leaps", "arpeggio"] as const);
    }
    overrides.arrangement = hints;
  }
  return config(style, overrides);
}

const describe = (cfg: MusicConfig) =>
  JSON.stringify({ ...cfg, prompt: undefined, volumes: undefined });

test("compose() always returns a Score its own validator accepts: 2500 random valid settings with hints", () => {
  const dice = lcg(770011);
  const perStyle = new Map<string, number>();
  for (let i = 0; i < 2500; i++) {
    const cfg = anyConfig(dice);
    perStyle.set(cfg.mood, (perStyle.get(cfg.mood) ?? 0) + 1);
    const score = compose(cfg);
    assert.deepEqual(scoreProblems(score, cfg), [], describe(cfg));
    // pure: the same settings, the same piece
    if (i % 50 === 0) assert.deepEqual(compose(cfg), score, describe(cfg));
  }
  assert.equal(perStyle.size, STYLE_IDS.length);
});

test("a tune left on its own carries the piece: no long rest, a note in every bar, whatever density is asked for", () => {
  // every harmony layer, the bass and the drums switched off. Only a style
  // that has neither chords nor a pad of its own (the 8-bit style, whose
  // arpeggio is its harmony) is left with the tune alone; it used to rest for
  // a bar and a half at a time there (3 s at 140 BPM), a Score that
  // scoreProblems() rejects.
  const off: ArrangementHints = {
    drums: "none",
    bass: "none",
    layers: { pad: false, arp: false, counter: false, perc: false },
  };
  const dice = lcg(4242);
  let alone = 0;
  for (let i = 0; i < 700; i++) {
    const base = anyConfig(dice, i % 2 ? "chiptune" : dice.pick(STYLE_IDS));
    const melody: NonNullable<ArrangementHints["melody"]> = {
      ...base.arrangement?.melody,
    };
    if (dice.random() < 0.8)
      melody.density = dice.random() < 0.6 ? 0 : dice.random() * 0.4;
    const cfg = config(base.mood, {
      ...base,
      energy: dice.random() < 0.4 ? 0 : base.energy,
      arrangement: {
        ...off,
        melody,
        ...(base.arrangement?.form ? { form: base.arrangement.form } : {}),
        ...(base.arrangement?.swing !== undefined
          ? { swing: base.arrangement.swing }
          : {}),
      },
    });
    const score = compose(cfg);
    assert.deepEqual(scoreProblems(score, cfg), [], describe(cfg));
    const solo = score.parts.every((part) => part.role === "lead");
    if (!solo) continue;
    alone++;
    // the listener is told, and the tune is there in every bar of the music
    assert.ok(
      score.notes.some((line) => line.includes("主旋律独自演奏")),
      describe(cfg),
    );
    const lead = leadInBeats(cfg, score);
    const lastBar = score.loop
      ? score.bars
      : Math.floor(lead[lead.length - 1].beat / 4);
    const bars = new Set(lead.map((note) => Math.floor(note.beat / 4)));
    for (let bar = 0; bar < lastBar; bar++)
      assert.ok(bars.has(bar), `bar ${bar + 1} is empty: ${describe(cfg)}`);
    // and no rest is longer than a breath: two beats at the very most
    for (let k = 1; k < lead.length; k++) {
      const rest = lead[k].beat - (lead[k - 1].beat + lead[k - 1].beats);
      assert.ok(
        rest <= 2.01,
        `${rest.toFixed(2)} beats of rest before beat ${lead[k].beat}: ${describe(cfg)}`,
      );
    }
  }
  assert.ok(alone >= 200, `${alone} pieces were a tune alone`);

  // with anything under it the tune thins as it is asked to
  const sparse = config("chiptune", {
    seed: 7,
    arrangement: { melody: { density: 0 } },
  });
  const full = config("chiptune", { seed: 7 });
  assert.ok(
    leadOf(compose(sparse)).length < leadOf(compose(full)).length * 0.5,
    "a density hint no longer thins an accompanied tune",
  );
  assert.ok(
    !compose(sparse).notes.some((line) => line.includes("主旋律独自演奏")),
  );
});
