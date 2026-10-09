/**
 * Regression tests for the composer findings of the v0.3 review (MUS-02 … MUS-11):
 * one voice in the bass, no empty sections, no false relations in the tune,
 * endings that keep to the mode, a pentatonic descant, rubato that follows the
 * phrases, risers that crest on the downbeat, one name per pitch in a chord
 * chart, secondary dominants that resolve, and arrangement notes that describe
 * the piece that was written.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { KEYS, STYLE_IDS, parseKey, type StyleId } from "../src/music/catalog";
import { compose } from "../src/music/compose";
import {
  DEFAULT_CONFIG,
  clampConfig,
  stylePreset,
} from "../src/music/defaults";
import { planForm, planTiming } from "../src/music/form";
import { makeTimeMap } from "../src/music/rhythm";
import {
  CYMBAL_SWELL_SECONDS,
  type DrumPart,
  type NoteEvent,
  type NotePart,
  type Score,
} from "../src/music/score";
import { getStyle } from "../src/music/styles";
import { SCALES, makeKey, parseRoman } from "../src/music/theory";
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
const noteParts = (score: Score) =>
  score.parts.filter((part): part is NotePart => part.kind === "notes");
const notesOf = (score: Score, role: string): NoteEvent[] =>
  noteParts(score).find((part) => part.role === role)?.notes ?? [];
const hitsOf = (score: Score, kind: string) =>
  score.parts
    .filter((part): part is DrumPart => part.kind === "drums")
    .flatMap((part) => part.hits.filter((hit) => hit.kind === kind));

/* ---------------- MUS-02: the bass is one voice ---------------- */

test("the bass is one voice: no two of its notes ever sound together", () => {
  const overlaps = (score: Score) => {
    const bass = notesOf(score, "bass");
    let count = 0;
    for (let i = 1; i < bass.length; i++)
      if (bass[i - 1].t + bass[i - 1].d > bass[i].t + 1e-6) count++;
    return count;
  };
  // the hip-hop 808 at its own settings (it used to overlap in 43 % of pieces)
  for (let seed = 1; seed <= 60; seed++)
    for (const loop of [true, false]) {
      const cfg = config("hiphop", { seed: seed * 523, loop, duration: 30 });
      const score = compose(cfg);
      assert.equal(overlaps(score), 0, `hiphop seed ${cfg.seed} loop=${loop}`);
      assert.deepEqual(scoreProblems(score, cfg), []);
    }
  // every style, every bass feel, approach tones as likely as the style allows
  for (const style of STYLE_IDS)
    for (const bass of [
      "root",
      "octave",
      "walking",
      "arpeggio",
      "syncopated",
      "pedal",
      undefined,
    ] as const)
      for (const seed of [11, 4242]) {
        const cfg = config(style, {
          seed,
          complexity: 1,
          energy: 0.8,
          arrangement: bass ? { bass } : undefined,
        });
        assert.equal(
          overlaps(compose(cfg)),
          0,
          `${style} bass=${bass} seed ${seed}`,
        );
      }
  // the approach tone still gets written: the note before it gives way to it
  let approaches = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const score = compose(
      config("hiphop", {
        seed,
        complexity: 1,
        duration: 60,
        arrangement: { bass: "syncopated" },
      }),
    );
    const bass = notesOf(score, "bass");
    const beat = 60 / score.bpm;
    for (let i = 1; i < bass.length; i++)
      if (
        bass[i].midi !== bass[i - 1].midi &&
        Math.abs(bass[i].t - (bass[i - 1].t + bass[i - 1].d)) < beat * 0.1
      )
        approaches++;
  }
  assert.ok(approaches > 40, `${approaches} bass notes cut by the next one`);
  // and the Score check knows the rule
  const broken = compose(config("hiphop"));
  const bass = noteParts(broken).find((part) => part.role === "bass")!;
  bass.notes[0].d = bass.notes[2].t - bass.notes[0].t + 0.5;
  if (bass.notes[1].midi === bass.notes[0].midi) bass.notes[1].midi += 2;
  assert.ok(
    scoreProblems(broken).some((problem) => problem.startsWith("bass plays")),
  );
});

/* ---------------- MUS-03: no section is ever left empty ---------------- */

/** Stretches in which nothing sounds: no note is held and no drum has just been hit. */
function silences(score: Score): [from: number, to: number][] {
  const heard: [number, number][] = [];
  for (const part of score.parts)
    if (part.kind === "notes")
      for (const note of part.notes) heard.push([note.t, note.t + note.d]);
    else for (const hit of part.hits) heard.push([hit.t, hit.t + 0.3]);
  heard.sort((a, b) => a[0] - b[0]);
  const gaps: [number, number][] = [];
  let reach = 0;
  for (const [from, to] of heard) {
    if (from > reach + 1e-6) gaps.push([reach, from]);
    reach = Math.max(reach, to);
  }
  // a loop runs on into its first bar; a piece that ends is over with its last note
  if (score.loop && reach < score.duration)
    gaps.push([reach, score.duration + (heard[0]?.[0] ?? 0)]);
  return gaps;
}

test("no setting leaves a section empty: every style × energy × every switched-off layer × loop", () => {
  // the hints that take sound away, in every combination: pad, arpeggio,
  // counter-line and percussion off, no drums, no bass
  let pieces = 0;
  let rests = 0;
  for (const style of STYLE_IDS)
    for (const loop of [true, false])
      for (const energy of [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1])
        for (let mask = 0; mask < 64; mask++) {
          const layers: NonNullable<ArrangementHints["layers"]> = {};
          if (mask & 1) layers.pad = false;
          if (mask & 2) layers.arp = false;
          if (mask & 4) layers.counter = false;
          if (mask & 8) layers.perc = false;
          const arrangement: ArrangementHints = {};
          if (Object.keys(layers).length) arrangement.layers = layers;
          if (mask & 16) arrangement.drums = "none";
          if (mask & 32) arrangement.bass = "none";
          const cfg = config(style, {
            loop,
            energy,
            duration: 30,
            seed: 4 + mask,
            arrangement,
          });
          const score = compose(cfg);
          const beat = 60 / score.bpm;
          const what = `${style} loop=${loop} energy ${energy} ${JSON.stringify(arrangement)}`;
          pieces++;
          // every section sounds from the first half of its first bar (a comping
          // pattern may enter off the beat; with swing that is just short of beat three)
          for (const section of score.sections) {
            const first = Math.min(
              ...score.parts.flatMap((part) =>
                (part.kind === "notes" ? part.notes : part.hits)
                  .filter(
                    (event) =>
                      event.t >= section.start - 0.05 && event.t < section.end,
                  )
                  .map((event) => event.t),
              ),
            );
            assert.ok(
              first - section.start <= 2 * beat + 0.06,
              `${what}: ${section.label} (from ${section.start.toFixed(1)} s) is silent until ${first.toFixed(1)} s`,
            );
          }
          for (const [from, to] of silences(score)) {
            // never two seconds, never a whole bar
            assert.ok(
              to - from <= 2,
              `${what}: nothing sounds from ${from.toFixed(1)} to ${to.toFixed(1)} s`,
            );
            assert.ok(
              to - from < 4 * beat,
              `${what}: a bar of silence at ${from.toFixed(1)} s`,
            );
            if (to - from > 1.5 * beat + 0.05) rests++;
          }
          // a section always has something that holds the harmony, unless every such layer is switched off
          const harmony = score.parts.some(
            (part) =>
              part.role === "comp" ||
              part.role === "pad" ||
              part.role === "arp",
          );
          const def = getStyle(style);
          if (def.comp || (def.pad && !(mask & 1)) || (def.arp && !(mask & 2)))
            assert.ok(harmony, `${what}: no harmony layer`);
        }
  assert.equal(pieces, STYLE_IDS.length * 2 * 9 * 64);
  // what is left are the rests a sparse comping pattern or a lone tune takes on
  // purpose (two or three beats in an intro), in a few percent of these pieces
  assert.ok(
    rests / pieces < 0.05,
    `${rests} silent windows of more than 1.5 beats in ${pieces} pieces`,
  );
});

test("everything switched off and the sparsest tune asked for: still no hole in the music", () => {
  // the one hint set that used to leave a lone tune resting for a bar and a
  // half at a time (3 s at 140 BPM): compose() returned what scoreProblems() rejects
  const arrangement: ArrangementHints = {
    drums: "none",
    bass: "none",
    layers: { pad: false, arp: false, counter: false, perc: false },
    melody: { density: 0, register: "low" },
  };
  let alone = 0;
  for (const style of STYLE_IDS)
    for (const energy of [0, 0.1, 0.3, 0.6])
      for (const [loop, duration] of [
        [true, 30],
        [false, 60],
        [false, 120],
      ] as [boolean, number][])
        for (const seed of [11, 4057, 90210]) {
          const cfg = config(style, {
            loop,
            duration,
            seed,
            energy,
            arrangement,
          });
          const score = compose(cfg);
          const what = `${style} loop=${loop} ${duration} s energy ${energy} seed ${seed}`;
          assert.deepEqual(scoreProblems(score, cfg), [], what);
          const bar = 240 / score.bpm;
          for (const [from, to] of silences(score))
            assert.ok(
              to - from <= bar,
              `${what}: nothing sounds from ${from.toFixed(1)} to ${to.toFixed(1)} s`,
            );
          if (score.parts.length === 1) alone++;
        }
  // (the tune is alone only where a style has neither chords nor a pad of its own)
  assert.ok(alone >= 36, `${alone} pieces were a tune alone`);
});

test("“quieter, and no pad” on a dreamy piece that ends starts with music, not with 13 s of silence", () => {
  for (const duration of [30, 60, 90, 120])
    for (const energy of [0, 0.05, 0.08, 0.12, 0.15]) {
      const cfg = config("dreamy", {
        loop: false,
        duration,
        energy,
        arrangement: { layers: { pad: false } },
      });
      const score = compose(cfg);
      const first = Math.min(
        ...score.parts.flatMap((part) =>
          part.kind === "notes"
            ? part.notes.map((n) => n.t)
            : part.hits.map((h) => h.t),
        ),
      );
      assert.ok(
        first < 0.5,
        `dreamy ${duration} s at energy ${energy}: the first sound comes at ${first.toFixed(2)} s`,
      );
      assert.ok(
        !score.parts.some((part) => part.role === "pad"),
        "the pad stays off",
      );
      assert.deepEqual(scoreProblems(score, cfg), []);
    }
  // the Score check knows the rule: a hole of a bar and a half is a broken Score
  const holed = compose(config("bright", { loop: false, duration: 30 }));
  const bar = 240 / holed.bpm;
  for (const part of holed.parts)
    if (part.kind === "notes")
      part.notes = part.notes.filter(
        (note) => note.t >= 2 * bar && note.t + note.d > 2 * bar,
      );
    else part.hits = part.hits.filter((hit) => hit.t >= 2 * bar);
  assert.ok(
    scoreProblems(holed).some((problem) =>
      problem.startsWith("nothing sounds"),
    ),
  );
});

/* ---------------- MUS-04: no false relation between the tune and the chord's third ---------------- */

/**
 * Lead notes of 0.4 s or more that sound a minor third over the root while
 * the accompaniment sounds the chord's major third for 0.3 s of them.
 */
function heldFalseRelations(score: Score): number {
  const others = noteParts(score).filter((part) => part.role !== "lead");
  let clashes = 0;
  for (const note of notesOf(score, "lead")) {
    if (note.d < 0.4) continue;
    const middle = note.t + Math.min(note.d / 2, 0.25);
    const chord = score.chords.find(
      (item) => middle >= item.start && middle < item.end,
    );
    if (!chord || chord.pitchClasses.includes(pc(note.midi))) continue;
    const third = pc(chord.root + 4);
    if (pc(note.midi - chord.root) !== 3 || !chord.pitchClasses.includes(third))
      continue;
    const against = others.some((part) =>
      part.notes.some(
        (other) =>
          pc(other.midi) === third &&
          Math.min(other.t + other.d, note.t + note.d) -
            Math.max(other.t, note.t) >=
            0.3,
      ),
    );
    if (against) clashes++;
  }
  return clashes;
}

test("the tune never holds the natural form of a note the chord has raised", () => {
  // G over E7 in A minor: the chord's third is foreign to the key
  for (const style of [
    "sad",
    "romantic",
    "chill",
    "acoustic",
    "epic",
    "cinematic",
    "jazz",
    "bright",
  ] as StyleId[]) {
    let clashes = 0;
    let applied = 0;
    for (let s = 0; s < 60; s++)
      for (const loop of [true, false]) {
        const score = compose(
          config(style, {
            loop,
            seed: 123457 + s * 4051,
            duration: s % 2 ? 60 : 30,
          }),
        );
        for (const chord of score.chords)
          if (
            chord.pitchClasses.some((value) => !score.key.scale.includes(value))
          )
            applied++;
        clashes += heldFalseRelations(score);
      }
    assert.equal(clashes, 0, `${style}: ${clashes} held false relations`);
    if (style === "sad" || style === "jazz" || style === "romantic")
      assert.ok(
        applied > 20,
        `${style}: only ${applied} chromatic chords to test against`,
      );
  }
});

test("nor a minor third that belongs to the scale against a chord's major third, in any style or mode", () => {
  // The same clash where the scale itself owns the note: the leading tone of
  // a harmonic minor over the major chord on the sixth degree (D-sharp over C
  // in E minor), the seventh of a major key over a borrowed bVI (B over
  // A-flat in C major). It is an avoid note like any other: it may pass, not
  // be held. Every style in its own key, in a major and in a minor one.
  let exposed = 0;
  for (const style of STYLE_IDS) {
    const own = config(style).key;
    for (const key of new Set([own, "C major", "E minor"])) {
      let clashes = 0;
      for (let s = 0; s < 20; s++)
        for (const loop of [true, false]) {
          const score = compose(
            config(style, {
              key,
              loop,
              seed: 247000 + s * 1777,
              duration: s % 2 ? 60 : 30,
            }),
          );
          clashes += heldFalseRelations(score);
          // a chord with a major third whose minor third is a note of the scale
          for (const chord of score.chords)
            if (
              chord.pitchClasses.includes(pc(chord.root + 4)) &&
              score.key.scale.includes(pc(chord.root + 3))
            )
              exposed++;
        }
      assert.equal(
        clashes,
        0,
        `${style} in ${key}: ${clashes} held false relations`,
      );
    }
  }
  assert.ok(exposed > 2000, `only ${exposed} chords to test against`);
});

/* ---------------- MUS-05: endings keep to the mode ---------------- */

test("cadences, last chords and turnarounds keep to the mode the piece is in", () => {
  const modal: Record<string, number> = {};
  for (const style of STYLE_IDS)
    for (const key of [
      "C major",
      "D major",
      "E minor",
      "A minor",
      "C minor",
      "B minor",
    ])
      for (let seed = 1; seed <= 16; seed++)
        for (const loop of [true, false]) {
          const cfg = config(style, {
            key,
            seed: seed * 600,
            loop,
            duration: 30,
          });
          const score = compose(cfg);
          const scale = score.key.scale.map((value) =>
            pc(value - score.key.tonic),
          );
          if (scale.length < 7) continue;
          // the degrees of plain major / natural minor that this mode has replaced
          const plain = SCALES[score.key.minor ? "naturalMinor" : "major"];
          const given = plain.filter(
            (interval) =>
              !scale.includes(interval) &&
              !(score.key.minor && interval === 10 && scale.includes(11)),
          );
          if (!given.length) continue;
          const name = `${style} ${score.notes[0].match(/（(.+?)）/)?.[1] ?? ""}`;
          modal[name] = (modal[name] ?? 0) + 1;
          const foreign = given.map((interval) =>
            pc(score.key.tonic + interval),
          );
          const bar = 240 / score.bpm;
          const ending = loop
            ? score.chords.filter((chord) => chord.bar === score.bars - 1)
            : score.chords.slice(-3);
          for (const chord of ending)
            assert.ok(
              !chord.pitchClasses.some((value) => foreign.includes(value)),
              `${style} ${key} seed ${cfg.seed} loop=${loop}: ${chord.symbol} [${chord.roman}] at ${(chord.start / bar + 1).toFixed(0)} denies the mode (${score.notes[0]})`,
            );
        }
  // the survey really met the modes it is about
  const met = Object.keys(modal).join(" | ");
  for (const mode of ["弗里吉亚", "利底亚", "多利亚"])
    assert.ok(met.includes(mode), `${mode} never came up: ${met}`);
  assert.ok(Object.values(modal).reduce((a, b) => a + b, 0) > 150);
  // tension in phrygian: the Neapolitan falls onto a tonic that carries the lowered second
  let phrygian = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const score = compose(
      config("tension", {
        key: "E minor",
        seed: seed * 600,
        loop: false,
        duration: 30,
      }),
    );
    if (!score.key.scale.includes(5)) continue; // F natural: phrygian on E
    phrygian++;
    const final = score.chords[score.chords.length - 1];
    assert.equal(final.symbol, "Em(addb9)", `seed ${seed * 600}`);
    assert.ok(
      !final.pitchClasses.includes(6),
      "no F sharp in the last chord of E phrygian",
    );
    assert.equal(
      score.chords[score.chords.length - 2].roman.replace(/maj7|add9|7/g, ""),
      "bII",
    );
  }
  assert.ok(phrygian >= 10, `${phrygian} phrygian pieces`);
});

/* ---------------- MUS-06: the descant keeps to the five notes ---------------- */

test("beside a five-note tune the counter-line keeps to the same five notes", () => {
  let notes = 0;
  let pieces = 0;
  for (const [style, overrides] of [
    ["guofeng", {}],
    ["guofeng", { key: "A minor" }],
    ["festive", { instrument: "guzheng" }],
    ["rock", { arrangement: { layers: { counter: true } } }],
  ] as [StyleId, Partial<MusicConfig>][])
    for (let seed = 1; seed <= 40; seed++)
      for (const loop of [true, false]) {
        const score = compose(
          config(style, {
            ...overrides,
            seed: seed * 8000 + 613,
            loop,
            duration: seed % 2 ? 60 : 30,
            energy: 0.6,
          }),
        );
        if (score.key.scale.length !== 5) continue;
        const counter = notesOf(score, "counter");
        if (!counter.length) continue;
        pieces++;
        for (const note of counter) {
          notes++;
          assert.ok(
            score.key.scale.includes(pc(note.midi)),
            `${style} seed ${seed * 8000 + 613} loop=${loop}: the counter-line plays ${note.midi} at ${note.t.toFixed(1)} s for ${note.d.toFixed(2)} s`,
          );
        }
      }
  assert.ok(
    pieces >= 150 && notes > 3000,
    `${notes} counter notes in ${pieces} pentatonic pieces`,
  );
});

/* ---------------- MUS-07: rubato follows the phrases ---------------- */

test("rubato lingers at the edges of each phrase and moves on in its middle, wherever the phrase starts", () => {
  let phrases = 0;
  for (const style of ["sad", "guofeng", "romantic"] as StyleId[])
    for (const loop of [true, false])
      for (const duration of [30, 45, 60, 90, 120]) {
        const cfg = config(style, { loop, duration });
        const def = getStyle(style);
        const timing = planTiming(cfg, def);
        const sections = planForm(cfg, def, timing);
        const time = makeTimeMap(
          timing,
          0,
          8,
          def.rubato ?? 0,
          sections.map((section) => ({
            startBar: section.startBar,
            bars: section.playBars,
          })),
        );
        const tempo = (beat: number) =>
          60 / ((time.seconds(beat + 0.05) - time.seconds(beat - 0.05)) / 0.1);
        const what = `${style} loop=${loop} ${duration} s`;
        for (const section of sections)
          for (let first = 0; first < section.playBars; first += 4) {
            const bars = Math.min(4, section.playBars - first);
            const start = (section.startBar + first) * 4;
            // every phrase starts exactly on its bar line
            assert.ok(
              Math.abs(time.seconds(start) - start * timing.beatSeconds) < 1e-9,
              `${what}: bar ${start / 4 + 1} is off the grid`,
            );
            // (a phrase of one bar does not breathe, and the last bars settle onto the final chord)
            if (
              bars < 2 ||
              (!timing.loop && start + bars * 4 > (timing.finalBar - 1) * 4)
            )
              continue;
            phrases++;
            const edge = tempo(start + 0.06);
            const middle = tempo(start + bars * 2);
            assert.ok(
              edge < timing.bpm * 0.98 && middle > timing.bpm * 1.02,
              `${what}: the phrase at bar ${start / 4 + 1} (${section.label}) starts at ${edge.toFixed(1)} BPM and runs at ${middle.toFixed(1)} in its middle (nominal ${timing.bpm.toFixed(1)})`,
            );
          }
        // the clock never runs backwards and a loop closes exactly
        let previous = -1;
        for (let beat = 0; beat <= timing.bars * 4; beat += 0.125) {
          const seconds = time.seconds(beat);
          assert.ok(
            seconds > previous,
            `${what}: time stands still at beat ${beat}`,
          );
          previous = seconds;
        }
        if (timing.loop)
          assert.ok(
            Math.abs(time.seconds(timing.bars * 4) - timing.duration) < 1e-9,
            what,
          );
      }
  assert.ok(phrases > 120, `${phrases} phrases`);
  // the piece itself is written on that clock: sad with a one-bar intro
  // (its phrases start on bars 2, 6, 10 …) lands its phrase starts on the grid
  const cfg = config("sad", { loop: false, duration: 30 });
  const score = compose(cfg);
  const verse = score.sections.find((section) => section.type === "verse")!;
  assert.ok(
    verse.startBar % 4 !== 0,
    "the verse should start off a four-bar boundary",
  );
  const pad = notesOf(score, "pad").concat(notesOf(score, "comp"));
  assert.ok(
    pad.some((note) => Math.abs(note.t - verse.start) < 0.03),
    "the accompaniment enters exactly with the verse",
  );
});

/* ---------------- MUS-08: a riser crests on the downbeat it leads into ---------------- */

test("a cymbal swell reaches its peak on the downbeat of the section it leads into", () => {
  let swells = 0;
  for (const [style, bpm] of [
    ["battle", 160],
    ["battle", 200],
    ["epic", 128],
    ["epic", 160],
    ["dance", 126],
    ["dance", 158],
    ["festive", 150],
    ["retro", 145],
    ["tension", 96],
    ["corporate", 110],
    ["romantic", 76],
    ["cinematic", 84],
  ] as [StyleId, number][])
    for (const loop of [true, false])
      for (const duration of [30, 45, 60, 120])
        for (const seed of [1, 2, 3]) {
          const score = compose(
            config(style, { bpm, loop, duration, seed, energy: 0.85 }),
          );
          const starts = score.sections.map((section) => section.start);
          for (const hit of hitsOf(score, "cymbalSwell")) {
            swells++;
            const peak =
              (hit.t + CYMBAL_SWELL_SECONDS) %
              (score.loop ? score.duration : Infinity);
            const off = Math.min(
              ...starts.map((start) => Math.abs(start - peak)),
              score.loop ? Math.abs(score.duration - peak) : Infinity,
            );
            assert.ok(
              off < 0.06,
              `${style} at ${bpm} BPM loop=${loop} ${duration} s seed ${seed}: a swell from ${hit.t.toFixed(2)} s peaks ${off.toFixed(2)} s away from a downbeat`,
            );
          }
        }
  assert.ok(swells > 300, `${swells} swells`);
  // battle at its own tempo with a one-bar intro: the bar is shorter than the swell, so there is none into the verse
  const battle = compose(config("battle", { loop: false, duration: 45 }));
  if (
    battle.sections[0].type === "intro" &&
    battle.sections[0].end < CYMBAL_SWELL_SECONDS
  )
    assert.ok(
      !hitsOf(battle, "cymbalSwell").some(
        (hit) => hit.t < battle.sections[0].end,
      ),
    );
});

/* ---------------- MUS-09: one name per pitch in a chord chart ---------------- */

test("chords are spelled by letter: one root never has two names in one key", () => {
  const symbol = (roman: string, key: string) =>
    parseRoman(
      roman,
      makeKey(key, parseKey(key).minor ? "naturalMinor" : "major"),
    )!.symbol;
  assert.equal(symbol("bVII", "G# minor"), "F#");
  assert.equal(symbol("VII", "G# minor"), "F#");
  assert.equal(symbol("bVII/II", "G# minor"), "F#/A#");
  assert.equal(symbol("vii°", "D minor"), "C#dim");
  assert.equal(symbol("vii°", "G minor"), "F#dim");
  assert.equal(symbol("bII", "C major"), "Db");
  assert.equal(symbol("#iv°", "C major"), "F#dim");
  assert.equal(symbol("V7/vi", "C major"), "E7");
  assert.equal(symbol("V7/V", "Eb major"), "F7");
  assert.equal(symbol("bVI", "C major"), "Ab");
  assert.equal(symbol("IV", "Db major"), "Gb");
  assert.equal(symbol("V", "F# major"), "C#");
  // names nobody reads on a chart fall back to the plain enharmonic
  assert.equal(symbol("bVI", "Eb minor"), "B");
  assert.equal(symbol("VII", "F# major"), "F");
  // every style in every key: the chart of a piece gives each pitch one name
  const NAME = /^[A-G][#b]?/;
  for (const key of KEYS)
    for (const style of STYLE_IDS)
      for (const seed of [1, 2]) {
        const score = compose(
          config(style, { key, seed, loop: seed === 1, complexity: 0.8 }),
        );
        const names = new Map<number, Set<string>>();
        for (const chord of score.chords) {
          const root = NAME.exec(chord.symbol)![0];
          names.set(chord.root, (names.get(chord.root) ?? new Set()).add(root));
          const bass = /\/([A-G][#b]?)$/.exec(chord.symbol)?.[1];
          if (bass) {
            const pitch = chord.pitchClasses[chord.pitchClasses.length - 1];
            const at =
              chord.pitchClasses.find(
                (value) =>
                  [
                    "C",
                    "C#",
                    "D",
                    "D#",
                    "E",
                    "F",
                    "F#",
                    "G",
                    "G#",
                    "A",
                    "A#",
                    "B",
                  ][value] === bass ||
                  [
                    "C",
                    "Db",
                    "D",
                    "Eb",
                    "E",
                    "F",
                    "Gb",
                    "G",
                    "Ab",
                    "A",
                    "Bb",
                    "B",
                  ][value] === bass,
              ) ?? pitch;
            names.set(at, (names.get(at) ?? new Set()).add(bass));
          }
        }
        for (const [pitch, used] of names)
          assert.ok(
            used.size === 1,
            `${style} in ${key} seed ${seed}: pitch class ${pitch} appears as ${[...used].join(" and ")}`,
          );
      }
});

/* ---------------- MUS-10: a secondary dominant keeps its target ---------------- */

test("a cadence, a turnaround or the end of a section never takes away what a secondary dominant leads to", () => {
  let appliedChords = 0;
  let shared = 0;
  for (const style of [
    "chiptune",
    "cute",
    "festive",
    "acoustic",
    "epic",
    "cinematic",
    "romantic",
    "jazz",
    "bright",
    "battle",
    "chill",
    "sad",
  ] as StyleId[])
    for (let s = 0; s < 50; s++)
      for (const loop of [true, false]) {
        const cfg = config(style, {
          seed: 70000 + s * 613,
          loop,
          duration: [30, 60, 90][s % 3],
        });
        const score = compose(cfg);
        const key = makeKey(
          cfg.key,
          score.key.minor ? "naturalMinor" : "major",
        );
        const chords = score.chords;
        const last = chords.length - 1;
        chords.forEach((chord, i) => {
          const parsed = parseRoman(chord.roman, key);
          if (!parsed?.applied) return;
          appliedChords++;
          const next = i < last ? chords[i + 1] : loop ? chords[0] : undefined;
          if (!next) return;
          const target = pc(chord.root + (parsed.head === "V" ? 5 : 1));
          const resolves = next.root === target;
          const what = `${style} seed ${cfg.seed} loop=${loop} ${cfg.duration} s: bar ${chord.bar + 1} ${chord.symbol} [${chord.roman}] → ${next.symbol} [${next.roman}]`;
          // two chords in a bar: the dominant was added to lead somewhere, or sits in front of a turnaround
          const sharesBar = chords.some(
            (other, j) => j !== i && other.bar === chord.bar,
          );
          if (sharesBar) {
            shared++;
            assert.ok(resolves, what);
          }
          // into the final cadence, the last chord, or round the loop
          const closing = loop ? chord.bar === score.bars - 1 : i >= last - 3;
          if (closing) assert.ok(resolves, what);
        });
      }
  assert.ok(
    appliedChords > 1000 && shared > 300,
    `${appliedChords} secondary dominants, ${shared} of them sharing a bar`,
  );
});

/* ---------------- MUS-11: the notes describe the piece that was written ---------------- */

test("arrangement notes name the sections that exist and mention a turnaround only where one was written", () => {
  for (const style of STYLE_IDS)
    for (const loop of [true, false])
      for (const duration of [15, 20, 30, 45, 60]) {
        const score = compose(config(style, { loop, duration, seed: 12345 }));
        const labels = new Set(score.sections.map((section) => section.label));
        const line = score.notes.find((note) => note.startsWith("和声："));
        if (!line) continue;
        // "和声：<label> I – V …；<label> …": every label is a section of this piece
        for (const part of line.slice(3).replace(/。.*$/, "").split("；"))
          assert.ok(
            [...labels].some((name) => part.startsWith(`${name} `)),
            `${style} loop=${loop} ${duration} s: the notes say “${part}”, the piece has ${[...labels].join("、")}`,
          );
      }
  // dance, 30 s, a piece without a verse: the chords are the chorus's and are called so
  const dance = compose(
    config("dance", { loop: false, seed: 12345, duration: 30 }),
  );
  assert.ok(!dance.sections.some((section) => section.type === "verse"));
  assert.ok(
    dance.notes.some((note) => note.startsWith("和声：副歌 ")),
    dance.notes.join(" / "),
  );
  // a hinted progression gets no turnaround, and the notes do not claim one
  for (const style of STYLE_IDS) {
    const score = compose(
      config(style, {
        seed: 5,
        arrangement: { progression: ["I", "IV", "vi", "IV"] },
      }),
    );
    assert.ok(
      !score.notes.some((note) => note.includes("转回和弦")),
      `${style}: ${score.notes[score.notes.length - 1]}`,
    );
    assert.ok(
      score.notes[score.notes.length - 1].includes("循环"),
      score.notes[score.notes.length - 1],
    );
  }
  // where the engine did rewrite the last bar, it says so — and only then
  let turned = 0;
  let plain = 0;
  for (const style of STYLE_IDS)
    for (let seed = 1; seed <= 6; seed++) {
      const cfg = config(style, { seed, loop: true });
      const score = compose(cfg);
      const says = score.notes.some((note) => note.includes("转回和弦"));
      // a turnaround ends the piece on a chord that pulls to its first chord
      const closing = score.chords[score.chords.length - 1];
      const pull = pc(closing.root - score.chords[0].root);
      if (says) {
        turned++;
        assert.equal(
          closing.bar,
          score.bars - 1,
          `${style} seed ${seed}: “转回和弦” but the last bar has no chord of its own`,
        );
        assert.ok(
          [7, 10, 11, 1, 5, 2].includes(pull),
          `${style} seed ${seed}: “转回和弦” but the last chord is ${closing.symbol} before ${score.chords[0].symbol}`,
        );
      } else plain++;
      // a drum fill is mentioned only when the kit plays in the last bar
      if (score.notes.some((note) => note.includes("过门"))) {
        const kit = score.parts.find(
          (part): part is DrumPart =>
            part.kind === "drums" && part.role === "kit",
        );
        assert.ok(
          kit &&
            kit.hits.some((hit) => hit.t >= score.duration - 240 / score.bpm),
          `${style} seed ${seed}: no drums in the last bar`,
        );
      }
    }
  assert.ok(
    turned > 40 && plain > 5,
    `${turned} loops with a turnaround, ${plain} without`,
  );
});
