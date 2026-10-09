/**
 * The 22 styles: what makes each one itself (instruments, kit, feel, scale and
 * harmony), plus the generic validity suite over every style × lead × form.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTRUMENT_IDS,
  KEYS,
  STYLE_IDS,
  type InstrumentId,
  type StyleId,
} from "../src/music/catalog";
import { compose } from "../src/music/compose";
import { DEFAULT_CONFIG, stylePreset } from "../src/music/defaults";
import { pickRanked } from "../src/music/harmony";
import { planTiming } from "../src/music/form";
import { seededRandom } from "../src/music/random";
import { makeTimeMap } from "../src/music/rhythm";
import {
  DRUM_KINDS,
  type DrumEvent,
  type DrumKind,
  type DrumPart,
  type NoteEvent,
  type NotePart,
  type PartRole,
  type Score,
} from "../src/music/score";
import { STYLE_DEFS, getStyle } from "../src/music/styles";
import type { Groove } from "../src/music/styles/types";
import { LEAD_TRAITS, lowIntervalClash, parseSteps } from "../src/music/theory";
import { scoreProblems } from "../src/music/validate";
import type { MusicConfig } from "../src/types";

const pc = (midi: number) => ((Math.round(midi) % 12) + 12) % 12;

function config(
  style: StyleId,
  overrides: Partial<MusicConfig> = {},
): MusicConfig {
  return { ...DEFAULT_CONFIG, ...stylePreset(style), ...overrides };
}
const noteParts = (score: Score) =>
  score.parts.filter((part): part is NotePart => part.kind === "notes");
const drumParts = (score: Score) =>
  score.parts.filter((part): part is DrumPart => part.kind === "drums");
const partOf = (score: Score, role: PartRole) =>
  noteParts(score).find((part) => part.role === role);
const notesOf = (score: Score, role: PartRole): NoteEvent[] =>
  partOf(score, role)?.notes ?? [];
const kitOf = (score: Score) =>
  drumParts(score).find((part) => part.role === "kit");
const percOf = (score: Score) =>
  drumParts(score).find((part) => part.role === "perc");
const hitsOf = (score: Score, kind: DrumKind): DrumEvent[] =>
  drumParts(score).flatMap((part) =>
    part.hits.filter((hit) => hit.kind === kind),
  );
const kindsOf = (part: DrumPart | undefined) =>
  new Set((part?.hits ?? []).map((hit) => hit.kind));
const voicesOf = (score: Score) =>
  new Set(noteParts(score).map((part) => part.voice));
const beatOf = (score: Score, t: number) => t / (60 / score.bpm);
/** position inside the bar in sixteenths, for styles that play straight */
const stepOf = (score: Score, t: number) =>
  (((beatOf(score, t) * 4) % 16) + 16) % 16;
const sectionAt = (score: Score, t: number) =>
  score.sections.find(
    (section) => t >= section.start - 1e-6 && t < section.end - 1e-6,
  ) ?? score.sections[score.sections.length - 1];
const sectionsOf = (score: Score, type: string) =>
  score.sections.filter((section) => section.type === type);
const inside = (
  t: number,
  section: { start: number; end: number },
  margin = 0.03,
) => t >= section.start - margin && t < section.end - margin;
const chordAt = (score: Score, t: number) =>
  score.chords.find(
    (chord) => t >= chord.start - 1e-6 && t < chord.end - 1e-6,
  ) ?? score.chords[score.chords.length - 1];
/** degrees of the chord roots above the tonic, e.g. 8 = bVI, 10 = bVII */
const rootDegrees = (score: Score) =>
  new Set(
    score.chords.map((chord) => (chord.root - score.key.tonic + 12) % 12),
  );
const assertValid = (score: Score, cfg: MusicConfig, label: string) => {
  const problems = scoreProblems(score, cfg);
  if (problems.length) assert.fail(`${label}: ${problems.join("; ")}`);
};
/** melodic intervals, with tremolo strokes (one note re-struck) folded into one */
function intervals(score: Score): number[] {
  const lead = notesOf(score, "lead");
  const result: number[] = [];
  for (let i = 1; i < lead.length; i++) {
    const distance = Math.abs(lead[i].midi - lead[i - 1].midi);
    if (distance === 0 && lead[i].t - lead[i - 1].t < 0.17) continue;
    result.push(distance);
  }
  return result;
}
const stepShare = (score: Score) => {
  const list = intervals(score);
  const limit = score.key.scale.length < 7 ? 3 : 2;
  return (
    list.filter((distance) => distance >= 1 && distance <= limit).length /
    Math.max(1, list.length)
  );
};

/* ------------------------------------------------------------------ */
/* registry and data                                                   */
/* ------------------------------------------------------------------ */

test("registry: every catalog style has a definition of its own, and no two are alike", () => {
  assert.deepEqual(Object.keys(STYLE_DEFS).sort(), [...STYLE_IDS].sort());
  const summaries = new Set<string>();
  const signatures = new Set<string>();
  for (const id of STYLE_IDS) {
    const style = getStyle(id);
    assert.equal(style.id, id);
    assert.match(style.summary, /[一-鿿]/, `${id} summary`);
    assert.ok(
      style.summary.length >= 8 && style.summary.length <= 60,
      `${id} summary length`,
    );
    summaries.add(style.summary);
    // a style is not a re-skin: bank, grooves, instrumentation and space are its own
    signatures.add(
      JSON.stringify([
        style.harmony.modes,
        style.drums?.grooves ?? null,
        style.comp?.patterns ?? null,
        style.bass?.voice ?? null,
        style.space,
      ]),
    );
  }
  assert.equal(summaries.size, STYLE_IDS.length);
  assert.equal(signatures.size, STYLE_IDS.length);
  // each of the drum grooves and comp pattern sets is used by one style only
  const grooves = new Set(
    STYLE_IDS.map((id) => JSON.stringify(getStyle(id).drums?.grooves ?? id)),
  );
  assert.equal(grooves.size, STYLE_IDS.length);
  const banks = new Set(
    STYLE_IDS.map((id) => JSON.stringify(getStyle(id).harmony.modes)),
  );
  assert.equal(banks.size, STYLE_IDS.length);
});

test("style data: rhythm cells, bass figures, mode weights and percussion variants are well formed", () => {
  const checkGroove = (groove: Groove, where: string) => {
    for (const [kind, row] of Object.entries(groove)) {
      assert.ok(
        (DRUM_KINDS as readonly string[]).includes(kind),
        `${where}: drum ${kind}`,
      );
      const text = row.replace(/[\s|]/g, "");
      assert.ok(
        text.length === 16 || text.length === 32,
        `${where}: ${kind} row "${row}"`,
      );
      assert.match(text, /^[.goxXr]+$/, `${where}: ${kind} row "${row}"`);
      assert.ok(
        parseSteps(row).hits.length > 0,
        `${where}: ${kind} row is silent`,
      );
    }
  };
  for (const id of STYLE_IDS) {
    const style = getStyle(id);
    // every style has a rhythmic vocabulary of its own
    const cells = style.melody.cells ?? [];
    assert.ok(cells.length >= 2, `${id} needs rhythm cells`);
    for (const cell of cells) {
      assert.match(cell, /^[x._]{8}$/, `${id} cell "${cell}"`);
      assert.ok(cell.includes("x"), `${id} cell "${cell}" is silent`);
    }
    assert.equal(new Set(cells).size, cells.length, `${id} repeats a cell`);
    for (const [tier, rows] of Object.entries(style.bass?.riffs ?? {}))
      for (const row of rows) {
        assert.match(
          row.replace(/[\s|]/g, ""),
          /^[13578a.-]{16}$/,
          `${id} ${tier} bass figure "${row}"`,
        );
        assert.match(row, /[13578a]/, `${id} ${tier} bass figure is silent`);
      }
    for (const tonality of ["major", "minor"] as const)
      for (const mode of style.harmony.modes[tonality]) {
        for (const [lead, weight] of Object.entries(mode.leads ?? {})) {
          assert.ok(
            (INSTRUMENT_IDS as readonly string[]).includes(lead),
            `${id}: mode lead ${lead}`,
          );
          assert.ok(weight >= 0);
        }
        // every lead instrument is left with at least one mode to play in
        for (const lead of INSTRUMENT_IDS)
          assert.ok(
            style.harmony.modes[tonality].some(
              (item) => (item.leads?.[lead] ?? item.weight ?? 1) > 0,
            ),
            `${id} ${tonality}: no mode for ${lead}`,
          );
      }
    for (const [lead, grooves] of Object.entries(style.perc?.byLead ?? {})) {
      assert.ok(
        (INSTRUMENT_IDS as readonly string[]).includes(lead),
        `${id}: perc lead ${lead}`,
      );
      grooves.forEach((groove, i) =>
        checkGroove(groove, `${id} perc for ${lead}[${i}]`),
      );
    }
    if (style.drums?.buildRoll)
      assert.ok(
        (DRUM_KINDS as readonly string[]).includes(style.drums.buildRoll),
        `${id} build roll`,
      );
    assert.ok(
      (style.rubato ?? 0) >= 0 && (style.rubato ?? 0) <= 1,
      `${id} rubato`,
    );
    for (const value of [
      style.melody.staccato,
      style.melody.tremolo,
      style.melody.chromatic,
      style.melody.hook,
    ])
      assert.ok(
        value === undefined || (value >= 0 && value <= 1),
        `${id} melody option ${value}`,
      );
    // the catalog tempo fits the style: chords and space are written for it
    const [slow, fast] = [50, 200];
    assert.ok(stylePreset(id).bpm >= slow && stylePreset(id).bpm <= fast);
  }
});

/* ------------------------------------------------------------------ */
/* generic validity: 22 styles × 14 leads × loop on/off × two lengths   */
/* ------------------------------------------------------------------ */

test("every style × every lead instrument × loop on/off × two lengths gives a valid Score", () => {
  let total = 0;
  for (const style of STYLE_IDS)
    for (const instrument of INSTRUMENT_IDS)
      for (const loop of [true, false])
        for (const duration of [20, 75]) {
          total++;
          const cfg = config(style, {
            instrument,
            loop,
            duration,
            key: KEYS[(total * 7) % KEYS.length],
            seed: 5000 + total * 104729,
          });
          const label = `${style} ${instrument} loop=${loop} ${duration}s ${cfg.key} seed=${cfg.seed}`;
          let score: Score;
          try {
            score = compose(cfg);
          } catch (error) {
            assert.fail(`${label}: compose threw ${(error as Error).stack}`);
          }
          assertValid(score, cfg, label);
          // the lead is the chosen instrument, inside its comfortable range, and it has something to say
          const lead = notesOf(score, "lead");
          const trait = LEAD_TRAITS[instrument];
          assert.ok(
            lead.length >= 4,
            `${label}: only ${lead.length} lead notes`,
          );
          for (const note of lead)
            assert.ok(
              note.midi >= trait.low && note.midi <= trait.high,
              `${label}: lead note ${note.midi} outside ${trait.low}..${trait.high}`,
            );
          if (trait.bend === 0)
            assert.ok(
              lead.every((note) => note.bend === undefined),
              `${label}: ${instrument} cannot slide`,
            );
          // every part belongs to one of the four mixer groups and has events
          for (const part of score.parts)
            assert.ok(
              ["melody", "chords", "bass", "drums"].includes(part.track),
              label,
            );
          if (loop) {
            assert.ok(
              Math.abs(score.duration - (score.bars * 240) / score.bpm) < 1e-6,
              `${label}: not whole bars`,
            );
            assert.equal(score.bars % 2, 0, `${label}: ${score.bars} bars`);
            assert.ok(
              score.sections.every(
                (s) => s.type !== "intro" && s.type !== "outro",
              ),
              label,
            );
          } else {
            assert.equal(score.duration, duration, label);
            assert.equal(score.bpm, cfg.bpm, label);
            const final = score.chords[score.chords.length - 1];
            assert.equal(
              final.root,
              score.key.tonic,
              `${label}: ends on ${final.symbol}`,
            );
            assert.equal(
              pc(lead[lead.length - 1].midi),
              score.key.tonic,
              `${label}: melody ends off the tonic`,
            );
            let latest = 0;
            for (const part of noteParts(score))
              for (const note of part.notes)
                latest = Math.max(latest, note.t + note.d);
            assert.ok(
              duration - latest >= 1.45 && duration - latest <= 3.05,
              `${label}: tail ${duration - latest}s`,
            );
          }
          // deterministic, and safe to post to a worker
          if (total % 9 === 0) {
            assert.deepEqual(
              compose(structuredClone(cfg)),
              score,
              `${label}: not deterministic`,
            );
            assert.deepEqual(structuredClone(score), score, label);
          }
        }
  assert.equal(total, STYLE_IDS.length * INSTRUMENT_IDS.length * 2 * 2);
});

test("extremes: every style at 50 and 200 BPM, 15 s and 120 s, looped and not, with an unusual lead", () => {
  let index = 0;
  for (const style of STYLE_IDS)
    for (const bpm of [50, 200])
      for (const duration of [15, 120])
        for (const loop of [true, false]) {
          index++;
          // the style's own lead and one far from it, different for every case
          const own = stylePreset(style).instrument;
          const others = INSTRUMENT_IDS.filter((id) => id !== own);
          for (const instrument of [
            own,
            others[(index * 5) % others.length],
          ] as InstrumentId[]) {
            const cfg = config(style, {
              bpm,
              duration,
              loop,
              instrument,
              seed: 777 + index * 31,
            });
            const label = `${style} ${instrument} ${bpm}bpm ${duration}s loop=${loop}`;
            const score = compose(cfg);
            assertValid(score, cfg, label);
            const lead = notesOf(score, "lead");
            assert.ok(lead.length >= 3, `${label}: ${lead.length} lead notes`);
            // nothing turns into a buzz: lead notes stay at least a sixteenth at 200 BPM apart,
            // tremolo strokes (one pitch re-struck) aside
            for (let i = 1; i < lead.length; i++)
              if (lead[i].midi !== lead[i - 1].midi)
                assert.ok(
                  lead[i].t - lead[i - 1].t >= 0.055,
                  `${label}: lead notes ${lead[i].t - lead[i - 1].t}s apart`,
                );
            // and no part floods the renderer
            for (const part of score.parts) {
              const events =
                part.kind === "notes" ? part.notes.length : part.hits.length;
              assert.ok(
                events / score.duration <= 40,
                `${label}: ${part.id} has ${events} events`,
              );
            }
            assert.ok(
              score.sections.length >= 1 && score.chords.length >= 1,
              label,
            );
          }
        }
});

/* ------------------------------------------------------------------ */
/* musical manners that hold in every style                            */
/* ------------------------------------------------------------------ */

test("melody manners in every style: in the scale, stepwise, no clashes on strong beats, no wild leaps", () => {
  for (const style of STYLE_IDS) {
    const def = getStyle(style);
    let inScale = 0;
    let notes = 0;
    let steps = 0;
    let wide = 0;
    let moves = 0;
    let clashes = 0;
    let pieces = 0;
    for (let seed = 1; seed <= 6; seed++)
      for (const loop of [true, false]) {
        const score = compose(
          config(style, { loop, duration: 60, seed: seed * 7919 + 13 }),
        );
        const lead = notesOf(score, "lead");
        const beat = 60 / score.bpm;
        pieces++;
        steps += stepShare(score);
        lead.forEach((note, i) => {
          notes++;
          if (score.key.scale.includes(pc(note.midi))) inScale++;
          const before = lead[i - 1];
          if (before) {
            const distance = Math.abs(note.midi - before.midi);
            moves++;
            // a leap wider than an octave inside a phrase (across a breath it starts a new one)
            if (
              distance > 12 &&
              note.t - (before.t + before.d) < beat * 0.9 &&
              sectionAt(score, note.t) === sectionAt(score, before.t)
            )
              wide++;
          }
          // a held or accented note a semitone above a chord tone, unless it leans
          // down a step into a chord tone (an appoggiatura) within a second.
          // Rubato moves notes up to an eighth against the chord timeline, hence the three probes.
          const fits = [0.02, -0.14, 0.16].some((offset) => {
            const chord = chordAt(score, Math.max(0, note.t + offset));
            const pitch = pc(note.midi);
            return (
              chord.pitchClasses.includes(pitch) ||
              !chord.pitchClasses.includes((pitch + 11) % 12)
            );
          });
          const strong =
            Math.abs(
              beatOf(score, note.t) / 2 - Math.round(beatOf(score, note.t) / 2),
            ) < 0.04;
          const after = lead[i + 1];
          const resolves =
            !!after &&
            note.midi - after.midi >= 1 &&
            note.midi - after.midi <= 3 &&
            after.t - (note.t + note.d) < beat * 0.3 &&
            note.d <= Math.min(1.05, beat * 1.6);
          if (!fits && !resolves && (strong || note.d >= beat * 0.95))
            clashes++;
        });
      }
    const sparse = def.melody.density < 0.3;
    assert.ok(
      inScale / notes >= 0.9,
      `${style}: only ${(inScale / notes).toFixed(2)} of the melody is in the scale`,
    );
    const share = steps / pieces;
    assert.ok(
      share >= (sparse ? 0.3 : 0.5) && share <= 0.82,
      `${style}: stepwise share ${share.toFixed(2)}`,
    );
    assert.ok(
      wide / moves <= 0.004,
      `${style}: ${wide} leaps wider than an octave inside phrases`,
    );
    // pentatonic rock and folk lines lean on the fourth over major chords; everything else stays clean
    assert.ok(
      clashes / pieces <= (def.harmony.voicing === "power" ? 1.5 : 0.5),
      `${style}: ${clashes} clashing notes in ${pieces} pieces`,
    );
  }
});

test("accompaniment manners in every style: no mud below C3, the tune above the chords, the bass on the roots", () => {
  for (const style of STYLE_IDS) {
    const def = getStyle(style);
    let mud = 0;
    let under = 0;
    let covered = 0;
    let rootChecks = 0;
    let rootHits = 0;
    for (const [loop, duration, seed] of [
      [true, 30, 11],
      [false, 60, 12],
      [true, 60, 13],
      [false, 45, 14],
    ] as const) {
      const score = compose(config(style, { loop, duration, seed }));
      const beat = 60 / score.bpm;
      // pairs of low notes in the bass and the chordal layers that sound together for a while
      const low: { note: NoteEvent; id: string }[] = [];
      for (const part of noteParts(score)) {
        if (part.role === "lead") continue;
        for (const note of part.notes)
          if (note.midi < 56) low.push({ note, id: part.id });
      }
      low.sort((a, b) => a.note.t - b.note.t);
      const seen = new Set<number>();
      for (let i = 0; i < low.length; i++)
        for (let j = i + 1; j < low.length; j++) {
          const a = low[i].note;
          const b = low[j].note;
          if (b.t >= a.t + a.d - 0.12) break;
          if (low[i].id === "bass" && low[j].id === "bass") continue;
          if (Math.min(a.t + a.d, b.t + b.d) - b.t < 0.12) continue;
          if (
            !lowIntervalClash(
              Math.min(a.midi, b.midi),
              Math.max(a.midi, b.midi),
            )
          )
            continue;
          const slot = Math.round(b.t * 20);
          if (!seen.has(slot)) mud++;
          seen.add(slot);
        }
      // how often the tune dips to or below the top of the chord underneath it
      const comp = notesOf(score, "comp");
      for (const note of notesOf(score, "lead")) {
        const sounding = comp.filter(
          (other) =>
            other.t <= note.t + 0.02 && other.t + other.d > note.t + 0.02,
        );
        if (!sounding.length) continue;
        covered++;
        if (note.midi <= Math.max(...sounding.map((other) => other.midi)))
          under++;
      }
      // the first bass note of every chord is its root (or its written bass note)
      const bass = notesOf(score, "bass");
      for (const chord of score.chords) {
        const first = bass.find(
          (note) =>
            note.t > chord.start - 0.14 + 0.1 &&
            note.t < Math.min(chord.end, chord.start + beat * 2) - 0.03,
        );
        if (!first || chord.end - chord.start < beat * 1.5) continue;
        rootChecks++;
        const bassName = /\/([A-G][#b]?)$/.exec(chord.symbol)?.[1];
        const names = [
          "C",
          "C#",
          "D",
          "Eb",
          "E",
          "F",
          "F#",
          "G",
          "Ab",
          "A",
          "Bb",
          "B",
        ];
        const flats: Record<string, string> = {
          Db: "C#",
          "D#": "Eb",
          Gb: "F#",
          "G#": "Ab",
          "A#": "Bb",
        };
        const wanted = bassName
          ? names.indexOf(flats[bassName] ?? bassName)
          : chord.root;
        if (pc(first.midi) === wanted || pc(first.midi) === chord.root)
          rootHits++;
      }
    }
    assert.ok(mud <= 1, `${style}: ${mud} muddy low intervals`);
    if (covered >= 20)
      assert.ok(
        under / covered < 0.4,
        `${style}: the tune is inside the chords ${(under / covered).toFixed(2)} of the time`,
      );
    const pedal = !!def.bass && Object.values(def.bass.feel).includes("pedal");
    if (rootChecks >= 8 && !pedal)
      assert.ok(
        rootHits / rootChecks >= 0.85,
        `${style}: bass on the root at ${(rootHits / rootChecks).toFixed(2)} of the chord changes`,
      );
  }
});

test("the same seed gives every style a motif rhythm of its own", () => {
  // v0.2 gave every style the same rhythm. Now the motif is drawn from the
  // style's own cells with draws salted by the style: over a spread of seeds
  // nearly every style has a rhythm to itself. (Styles whose vocabularies
  // overlap can still hit on the same two bars now and then — it is chance,
  // so it is counted over many seeds instead of being asserted for three.)
  const seeds = [
    42017,
    7,
    990001,
    ...Array.from({ length: 17 }, (_, i) => 1000 + i * 7919),
  ];
  let distinct = 0;
  let crowded = 0;
  for (const seed of seeds) {
    const rhythms = new Map<string, StyleId[]>();
    for (const style of STYLE_IDS) {
      const score = compose(config(style, { loop: true, duration: 30, seed }));
      const barSeconds = 240 / score.bpm;
      const row = notesOf(score, "lead")
        .filter((note) => note.t < barSeconds * 2 - 0.03)
        .map((note) => Math.round(note.t / (barSeconds / 16)))
        .join(",");
      rhythms.set(row, [...(rhythms.get(row) ?? []), style]);
    }
    distinct += rhythms.size;
    assert.ok(
      rhythms.size >= 17,
      `seed ${seed}: only ${rhythms.size} different motif rhythms in 22 styles`,
    );
    for (const [, styles] of rhythms) {
      assert.ok(
        styles.length <= 3,
        `seed ${seed}: ${styles.join(", ")} share a rhythm`,
      );
      if (styles.length === 3) crowded++;
    }
  }
  assert.ok(
    distinct / seeds.length >= 19.5,
    `${(distinct / seeds.length).toFixed(1)} different rhythms per seed on average`,
  );
  assert.ok(
    crowded <= 2,
    `${crowded} rhythms shared by three styles in ${seeds.length} seeds`,
  );
});

test("sections contrast: the chorus is busier, higher or fuller than the verse in every style", () => {
  // Whether a chorus tops its verse depends on the two motifs a seed draws,
  // so one seed proves little either way (the sparsest style — ambient bells
  // over tied pads, whose chorus hardly lifts — misses it for about a quarter
  // of all seeds, in the motif engine before this one just as now). Twelve
  // seeds per style: the contrast must be there in at least two thirds of
  // them and in all but a few pieces overall; a chorus never loses more than
  // a layer or a quarter of the verse's events, and is as busy as the verse
  // (within a tenth) in most pieces of every style.
  const seeds = Array.from({ length: 12 }, (_, i) => 2024 + i * 37);
  let pieces = 0;
  let flat = 0;
  for (const style of STYLE_IDS) {
    let contrasted = 0;
    let thinner = 0;
    for (const seed of seeds) {
      const score = compose(config(style, { loop: false, duration: 75, seed }));
      const verse = sectionsOf(score, "verse")[0];
      const chorus = sectionsOf(score, "chorus")[0];
      assert.ok(
        verse && chorus,
        `${style}: ${score.sections.map((s) => s.type).join(" ")}`,
      );
      assert.ok(chorus.energy > verse.energy, `${style}: chorus energy`);
      const density = (section: typeof verse) => {
        let events = 0;
        const layers = new Set<string>();
        for (const part of score.parts) {
          const times =
            part.kind === "notes"
              ? part.notes.map((n) => n.t)
              : part.hits.map((h) => h.t);
          const count = times.filter((t) => inside(t, section)).length;
          if (count) layers.add(part.id);
          events += count;
        }
        return { perBar: events / section.bars, layers: layers.size };
      };
      const mean = (section: typeof verse) => {
        const lead = notesOf(score, "lead").filter((note) =>
          inside(note.t, section),
        );
        return (
          lead.reduce((sum, note) => sum + note.midi, 0) /
          Math.max(1, lead.length)
        );
      };
      const a = density(verse);
      const b = density(chorus);
      pieces++;
      if (
        b.perBar > a.perBar * 1.08 ||
        b.layers > a.layers ||
        mean(chorus) > mean(verse) + 1.5
      )
        contrasted++;
      else flat++;
      // a drop may trade a layer for weight (dance mutes its arpeggio), but it never thins out
      assert.ok(
        b.layers >= a.layers - 1 && b.perBar >= a.perBar * 0.75,
        `${style} seed ${seed}: the chorus thins out (verse ${a.perBar.toFixed(1)}/bar in ${a.layers} layers, chorus ${b.perBar.toFixed(1)}/bar in ${b.layers})`,
      );
      if (b.perBar < a.perBar * 0.9) thinner++;
    }
    assert.ok(
      contrasted >= 8,
      `${style}: the chorus tops the verse in only ${contrasted} of ${seeds.length} pieces`,
    );
    assert.ok(
      thinner <= 5,
      `${style}: the chorus is thinner than the verse in ${thinner} of ${seeds.length} pieces`,
    );
  }
  assert.ok(
    flat / pieces <= 0.05,
    `${flat} of ${pieces} pieces have a chorus no busier, higher or fuller than the verse`,
  );
});

test("energy and complexity change the music in every style, step by step", () => {
  const events = (score: Score) =>
    score.parts.reduce(
      (sum, part) =>
        sum + (part.kind === "notes" ? part.notes.length : part.hits.length),
      0,
    );
  for (const style of STYLE_IDS) {
    const energies = [0, 0.25, 0.5, 0.75, 1].map((energy) =>
      compose(config(style, { loop: true, duration: 60, energy, seed: 77 })),
    );
    const counts = energies.map(events);
    assert.ok(
      counts[4] > counts[0] * 1.3,
      `${style}: energy ${counts.join(" → ")}`,
    );
    assert.ok(
      energies[4].parts.length > energies[0].parts.length,
      `${style}: energy adds no layer`,
    );
    // no dead zone: at least three of the four steps change the arrangement
    let changes = 0;
    for (let i = 1; i < 5; i++)
      if (
        counts[i] !== counts[i - 1] ||
        energies[i].parts.length !== energies[i - 1].parts.length
      )
        changes++;
    assert.ok(changes >= 3, `${style}: energy steps ${counts.join(" → ")}`);
    // the tune moves up with the energy
    const mean = (score: Score) =>
      notesOf(score, "lead").reduce((sum, note) => sum + note.midi, 0) /
      notesOf(score, "lead").length;
    assert.ok(
      mean(energies[4]) > mean(energies[0]),
      `${style}: register does not follow the energy`,
    );

    let plain = 0;
    let rich = 0;
    let few = 0;
    let many = 0;
    let changed = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const low = compose(
        config(style, { loop: true, duration: 60, complexity: 0, seed }),
      );
      const mid = compose(
        config(style, { loop: true, duration: 60, complexity: 0.5, seed }),
      );
      const high = compose(
        config(style, { loop: true, duration: 60, complexity: 1, seed }),
      );
      const colour = (score: Score) =>
        score.chords.reduce(
          (sum, chord) => sum + chord.pitchClasses.length,
          0,
        ) / score.chords.length;
      plain += colour(low);
      rich += colour(high);
      few += notesOf(low, "lead").length + low.chords.length;
      many += notesOf(high, "lead").length + high.chords.length;
      if (
        JSON.stringify(low.parts) !== JSON.stringify(mid.parts) &&
        JSON.stringify(mid.parts) !== JSON.stringify(high.parts)
      )
        changed++;
    }
    assert.equal(changed, 6, `${style}: complexity leaves the notes unchanged`);
    // more colour in the chords, or (where chords are bare by design) more going on in the line
    assert.ok(
      rich > plain + 0.4 || many > few * 1.1,
      `${style}: complexity colour ${plain.toFixed(1)} → ${rich.toFixed(1)}, notes ${few} → ${many}`,
    );
  }
});

test("drumless styles stay drumless; quiet styles keep their drums for high energy", () => {
  for (const loop of [true, false])
    for (const duration of [30, 90])
      for (const energy of [0, 0.3, 0.6, 1]) {
        // ambient never has a kit or percussion
        assert.equal(
          drumParts(compose(config("ambient", { loop, duration, energy })))
            .length,
          0,
          "ambient",
        );
      }
  for (const style of ["sad", "romantic"] as StyleId[])
    for (const loop of [true, false])
      for (const duration of [30, 90])
        for (const seed of [1, 2, 3]) {
          // at their own energy, and below it, these two are played without drums
          const preset = stylePreset(style);
          for (const energy of [0, preset.energy * 0.6, preset.energy]) {
            const score = compose(
              config(style, { loop, duration, seed, energy }),
            );
            assert.equal(
              drumParts(score).length,
              0,
              `${style} e=${energy} loop=${loop} ${duration}s`,
            );
          }
        }
  // turned right up they get a gentle kit
  assert.ok(
    kitOf(compose(config("sad", { energy: 1, duration: 60 }))),
    "sad at full energy",
  );
  assert.ok(
    kitOf(compose(config("romantic", { energy: 0.8, duration: 60 }))),
    "romantic at high energy",
  );
  assert.equal(
    kitOf(compose(config("sad", { energy: 1, duration: 60 })))!.kit,
    "soft",
  );
  assert.equal(
    kitOf(compose(config("romantic", { energy: 0.8, duration: 60 })))!.kit,
    "brush",
  );
  // an explicit request overrides either way
  assert.ok(
    kitOf(compose(config("ambient", { arrangement: { drums: "light" } }))),
  );
  assert.equal(
    drumParts(compose(config("battle", { arrangement: { drums: "none" } })))
      .length,
    0,
  );
});

/* ------------------------------------------------------------------ */
/* style identity                                                      */
/* ------------------------------------------------------------------ */

test("bright: a pop band with guitar comping, finger bass and a tight kit", () => {
  const score = compose(config("bright", { loop: false, duration: 60 }));
  assert.equal(partOf(score, "lead")!.voice, "piano");
  assert.equal(partOf(score, "comp")!.voice, "guitar");
  assert.equal(partOf(score, "bass")!.voice, "fingerBass");
  assert.equal(kitOf(score)!.kit, "pop");
  assert.equal(score.swing, 0);
  assert.equal(score.key.scale.length, 7);
  assert.equal(score.master.character, "clean");
  const kinds = kindsOf(kitOf(score));
  for (const kind of ["kick", "snare", "hatClosed", "crash"] as const)
    assert.ok(kinds.has(kind), kind);
  // backbeat: snare on two and four in the chorus
  const chorus = sectionsOf(score, "chorus")[0];
  const snares = hitsOf(score, "snare").filter(
    (hit) => inside(hit.t, chorus) && hit.vel > 0.5,
  );
  assert.ok(snares.length >= chorus.bars);
  assert.ok(
    snares.filter((hit) => [4, 12].includes(Math.round(stepOf(score, hit.t))))
      .length >=
      snares.length * 0.7,
  );
});

test("chill: lo-fi electric piano sevenths over a dusty, swung kit", () => {
  for (const loop of [true, false]) {
    const score = compose(config("chill", { loop, duration: 45 }));
    assert.equal(partOf(score, "lead")!.voice, "epiano");
    assert.equal(partOf(score, "comp")!.voice, "epiano");
    assert.equal(kitOf(score)!.kit, "lofi");
    assert.equal(score.master.character, "lofi");
    assert.ok(score.swing > 0.2 && score.swing < 0.6);
    assert.ok(
      score.chords.every((chord) => chord.pitchClasses.length >= 4),
      "lo-fi chords are sevenths",
    );
    assert.ok(!kindsOf(kitOf(score)).has("crash"));
    assert.ok(score.master.tilt < 0, "dark master");
  }
});

test("cinematic: broken piano chords, strings that arrive later, deep drums", () => {
  const score = compose(
    config("cinematic", { loop: false, duration: 90, energy: 0.7 }),
  );
  assert.equal(partOf(score, "comp")!.voice, "piano");
  assert.ok(voicesOf(score).has("strings"));
  assert.equal(partOf(score, "bass")!.voice, "subBass");
  assert.equal(kitOf(score)!.kit, "cinematic");
  const kinds = kindsOf(kitOf(score));
  assert.ok(kinds.has("taiko") && kinds.has("subBoom"));
  assert.ok(!kinds.has("hatClosed") && !kinds.has("kick"));
  assert.ok(score.space.decay >= 2.4 && score.space.level >= 0.5);
  // the intro is the piano alone
  const intro = score.sections[0];
  assert.equal(intro.type, "intro");
  for (const part of drumParts(score))
    assert.ok(
      !part.hits.some(
        (hit) => hit.kind !== "cymbalSwell" && inside(hit.t, intro),
      ),
    );
});

test("dreamy: glassy pad, a flowing arpeggio and a bell in a big space", () => {
  const score = compose(config("dreamy", { loop: true, duration: 30 }));
  assert.equal(partOf(score, "lead")!.voice, "bell");
  assert.equal(partOf(score, "pad")!.voice, "airpad");
  assert.equal(partOf(score, "arp")!.voice, "pluck");
  assert.ok(
    score.space.decay >= 3 &&
      score.space.level >= 0.7 &&
      score.space.delayFeedback >= 0.4,
  );
  assert.equal(drumParts(score).length, 0, "no drums at its own energy");
  assert.equal(kitOf(compose(config("dreamy", { energy: 0.7 })))!.kit, "soft");
});

test("focus: restrained piano over a quiet pulse", () => {
  const score = compose(config("focus", { loop: true, duration: 60 }));
  assert.equal(partOf(score, "comp")!.voice, "piano");
  assert.ok(notesOf(score, "lead").length / score.bars < 3.2, "sparse melody");
  assert.ok(!kitOf(score), "no kit at its own energy");
  const louder = compose(config("focus", { energy: 0.6, duration: 60 }));
  assert.equal(kitOf(louder)!.kit, "soft");
  assert.ok(!kindsOf(kitOf(louder)).has("crash"));
  assert.ok(Math.max(...notesOf(score, "lead").map((note) => note.vel)) < 0.9);
});

test("retro: synthwave with octave bass, a running arpeggio and a drum machine", () => {
  const score = compose(config("retro", { loop: true, duration: 30 }));
  assert.equal(partOf(score, "lead")!.voice, "synth");
  assert.equal(partOf(score, "bass")!.voice, "synthBass");
  assert.equal(kitOf(score)!.kit, "electro");
  assert.equal(partOf(score, "pad")!.voice, "pad");
  assert.equal(partOf(score, "arp")!.voice, "pluck");
  assert.equal(score.master.character, "wide");
  // octave bass: the same pitch class an octave apart inside a bar
  const bass = notesOf(score, "bass");
  let octaves = 0;
  for (let i = 1; i < bass.length; i++)
    if (Math.abs(bass[i].midi - bass[i - 1].midi) === 12) octaves++;
  assert.ok(octaves >= score.bars, `only ${octaves} octave jumps`);
  assert.ok(
    partOf(score, "pad")!.mix.duck > 0.3,
    "the pad ducks under the kick",
  );
});

test("epic: strings, brass stabs, a pizzicato ostinato, taiko and booms", () => {
  const score = compose(config("epic", { loop: false, duration: 60 }));
  const voices = voicesOf(score);
  for (const voice of ["strings", "brass", "pizzicato", "synthBass"] as const)
    assert.ok(voices.has(voice), voice);
  assert.equal(kitOf(score)!.kit, "cinematic");
  const kinds = kindsOf(kitOf(score));
  for (const kind of ["taiko", "subBoom", "cymbalSwell", "crash"] as const)
    assert.ok(kinds.has(kind), kind);
  assert.ok(score.space.size >= 0.8);
  assert.equal(score.master.character, "punchy");
});

test("chiptune: three tone channels and noise, dry and bit-crushed", () => {
  for (const loop of [true, false])
    for (const energy of [0, 0.5, 1]) {
      const score = compose(config("chiptune", { loop, energy, duration: 45 }));
      for (const voice of voicesOf(score))
        assert.ok(["chip", "chipPulse", "chipBass"].includes(voice), voice);
      for (const part of drumParts(score)) {
        assert.equal(part.kit, "chip");
        for (const hit of part.hits)
          assert.ok(
            hit.kind === "noiseHit" || hit.kind === "noiseTick",
            hit.kind,
          );
      }
      assert.ok(score.space.level < 0.2);
      assert.equal(score.master.character, "bitcrush");
    }
  const score = compose(config("chiptune", { loop: true, duration: 30 }));
  assert.ok(
    notesOf(score, "arp").length / score.bars >= 12,
    "the pulse channel arpeggiates in sixteenths",
  );
});

test("guofeng: pentatonic guzheng with slides and tremolo, a dizi above it, sparse woodblock, drum and gong", () => {
  for (const key of ["D major", "A minor", "F# major", "C minor"])
    for (const loop of [true, false]) {
      const score = compose(
        config("guofeng", { key, loop, duration: 60, energy: 0.55 }),
      );
      const label = `guofeng ${key} loop=${loop}`;
      // five-note scale, and a tune that never leaves it
      assert.equal(score.key.scale.length, 5, label);
      const minor = key.endsWith("minor");
      assert.deepEqual(
        score.key.scale.map((value) => (value - score.key.tonic + 12) % 12),
        minor ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9],
        label,
      );
      const lead = notesOf(score, "lead");
      assert.ok(
        lead.every((note) => score.key.scale.includes(pc(note.midi))),
        `${label}: the tune leaves the pentatonic scale`,
      );
      // slides (bends) and tremolo (one pitch re-struck faster than a sixteenth)
      const slides = lead.filter((note) => note.bend !== undefined).length;
      assert.ok(
        slides >= 3 && slides / lead.length < 0.4,
        `${label}: ${slides} slides`,
      );
      let strokes = 0;
      for (let i = 1; i < lead.length; i++)
        if (
          lead[i].midi === lead[i - 1].midi &&
          lead[i].t - lead[i - 1].t < (60 / score.bpm / 4) * 0.8
        )
          strokes++;
      assert.ok(strokes >= 6, `${label}: ${strokes} tremolo strokes`);
      // the harmony stays diatonic: no secondary dominants, no leading tone in minor
      const parent = (
        minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]
      ).map((value) => (value + score.key.tonic) % 12);
      for (const chord of score.chords)
        assert.ok(
          chord.pitchClasses.every((value) => parent.includes(value)),
          `${label}: chromatic chord ${chord.symbol}`,
        );
      // dizi counter-line floating above the guzheng
      const counter = partOf(score, "counter")!;
      assert.equal(counter.voice, "dizi", label);
      const mean = (notes: NoteEvent[]) =>
        notes.reduce((sum, note) => sum + note.midi, 0) / notes.length;
      assert.ok(
        mean(counter.notes) > mean(lead) + 2,
        `${label}: the dizi sits under the tune`,
      );
      // percussion: woodblock, low drum and gong only, and not much of it
      const kit = kitOf(score)!;
      assert.equal(kit.kit, "acoustic");
      for (const kind of kindsOf(kit))
        assert.ok(
          ["woodblock", "tomLow", "tomHigh", "taiko", "gong"].includes(kind),
          `${label}: ${kind}`,
        );
      assert.ok(kindsOf(kit).has("woodblock"), label);
      assert.ok(
        kit.hits.length / score.bars <= 9,
        `${label}: ${kit.hits.length / score.bars} hits per bar`,
      );
      assert.equal(score.swing, 0);
      assert.ok(score.space.level >= 0.5 && score.space.decay >= 2);
    }
  const score = compose(
    config("guofeng", { loop: false, duration: 60, energy: 0.6 }),
  );
  assert.ok(kindsOf(kitOf(score)).has("gong"), "a gong marks the arrivals");
  assert.equal(partOf(score, "comp")!.voice, "nylon");
  // the guzheng accompanies when another instrument leads; the tune starts in the intro, alone
  assert.equal(
    partOf(compose(config("guofeng", { instrument: "dizi" })), "comp")!.voice,
    "guzheng",
  );
  assert.equal(score.sections[0].type, "intro");
  assert.ok(
    notesOf(score, "lead").some((note) => inside(note.t, score.sections[0])),
    "free intro",
  );
  // lots of space: the tune rests for a good part of the time
  const lead = notesOf(score, "lead");
  const sounding = lead.reduce((sum, note) => sum + note.d, 0);
  assert.ok(lead.length / score.bars < 9);
  assert.ok(sounding / score.duration < 0.95);
});

test("jazz: swung ride, walking upright bass and rootless sevenths", () => {
  const score = compose(
    config("jazz", { loop: true, duration: 30, energy: 0.6 }),
  );
  assert.ok(score.swing > 0.4);
  assert.equal(partOf(score, "bass")!.voice, "uprightBass");
  assert.equal(kitOf(score)!.kit, "brush");
  assert.ok(kindsOf(kitOf(score)).has("ride"));
  assert.ok(
    score.chords.every((chord) => chord.pitchClasses.length >= 4),
    "sevenths or richer",
  );
  assert.ok(
    notesOf(score, "bass").length >= score.bars * 3,
    "the bass walks in quarters",
  );
  assert.deepEqual(score.sections.map((section) => section.label).slice(0, 2), [
    "A 段",
    "B 段",
  ]);
});

test("acoustic: fingerpicked and strummed guitar with shaker", () => {
  const score = compose(config("acoustic", { loop: true, duration: 30 }));
  assert.equal(partOf(score, "lead")!.voice, "guitar");
  assert.equal(partOf(score, "comp")!.voice, "nylon");
  assert.ok(kindsOf(percOf(score)).has("shaker"));
  assert.equal(
    compose(config("acoustic", { energy: 0.8 })).parts.find(
      (part) => part.role === "kit",
    )!.kind,
    "drums",
  );
  assert.equal(
    kitOf(compose(config("acoustic", { energy: 0.8 })))!.kit,
    "acoustic",
  );
  assert.equal(score.master.character, "warm");
});

test("tension: a tonic pulse, string clusters, isolated hits and no bright cadence", () => {
  for (const key of ["E minor", "C minor", "A minor"])
    for (const seed of [1, 2, 3, 4]) {
      const loop = compose(
        config("tension", { key, loop: true, duration: 45, seed }),
      );
      const label = `tension ${key} seed ${seed}`;
      // natural minor or phrygian
      const scale = loop.key.scale.map(
        (value) => (value - loop.key.tonic + 12) % 12,
      );
      assert.ok(
        scale.includes(3) && scale.includes(8) && scale.includes(10),
        `${label}: scale ${scale}`,
      );
      // pedal bass: one pitch class, pulsing
      const bass = partOf(loop, "bass")!;
      assert.equal(bass.voice, "synthBass");
      assert.ok(
        bass.notes.every((note) => pc(note.midi) === loop.key.tonic),
        `${label}: the bass leaves the tonic`,
      );
      assert.ok(
        bass.notes.length >= loop.bars * 2,
        `${label}: no pulse (${bass.notes.length} notes)`,
      );
      // the cluster pad is strings even under a string melody
      assert.equal(partOf(loop, "lead")!.voice, "strings");
      assert.equal(partOf(loop, "pad")!.voice, "strings");
      // dissonance: a chord with a semitone or a tritone inside it
      const tense = loop.chords.filter((chord) =>
        chord.pitchClasses.some((a) =>
          chord.pitchClasses.some((b) =>
            [1, 6, 11].includes((a - b + 12) % 12),
          ),
        ),
      );
      assert.ok(
        tense.length >= loop.chords.length * 0.3,
        `${label}: only ${tense.length}/${loop.chords.length} dissonant chords`,
      );
      // no major dominant resolving brightly: nothing that sounds like V7 → I in a major key
      const song = compose(
        config("tension", { key, loop: false, duration: 45, seed }),
      );
      const final = song.chords[song.chords.length - 1];
      const intervals = final.pitchClasses.map(
        (value) => (value - final.root + 12) % 12,
      );
      assert.ok(
        intervals.includes(3) && !intervals.includes(4),
        `${label}: ends on ${final.symbol}`,
      );
      // the rub is a second over the root — the mode's own: phrygian has given
      // up the natural second, so there it is the lowered one, a semitone over the tonic
      const phrygian = scale.includes(1);
      assert.ok(
        intervals.includes(phrygian ? 1 : 2) &&
          !intervals.includes(phrygian ? 2 : 1),
        `${label}: the last chord has no rub in it, or the wrong one for its mode (${final.symbol})`,
      );
      // a modal v → i is allowed; a major dominant with its leading tone is not
      const before = song.chords[song.chords.length - 2];
      const dominant =
        (before.root - song.key.tonic + 12) % 12 === 7 &&
        before.pitchClasses.includes((song.key.tonic + 11) % 12);
      assert.ok(
        !dominant,
        `${label}: dominant cadence ${before.symbol} → ${final.symbol}`,
      );
    }
  const score = compose(config("tension", { loop: false, duration: 60 }));
  const kit = kitOf(score)!;
  assert.equal(kit.kit, "cinematic");
  assert.ok(
    kindsOf(kit).has("gong") &&
      kindsOf(kit).has("subBoom") &&
      !kindsOf(kit).has("crash"),
  );
  assert.ok(kit.hits.length / score.bars < 9, "sparse hits");
  // the ticking clock
  const perc = percOf(score)!;
  assert.ok(
    [...kindsOf(perc)].every((kind) => kind === "rim" || kind === "woodblock"),
  );
  // a major key is made uneasy too: it never ends on a plain major triad
  for (const seed of [1, 2, 3, 4]) {
    const major = compose(
      config("tension", { key: "C major", loop: false, duration: 45, seed }),
    );
    const final = major.chords[major.chords.length - 1];
    assert.ok(
      !final.pitchClasses.includes((final.root + 4) % 12),
      `major key ends on ${final.symbol}`,
    );
  }
  assert.ok(score.master.tilt < 0);
});

test("cute: staccato mallets over plucked oom-pah, a music box, chromatic grace notes and a woodblock", () => {
  let chromatic = 0;
  let total = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const score = compose(config("cute", { loop: true, duration: 30, seed }));
    assert.equal(partOf(score, "lead")!.voice, "marimba");
    assert.equal(partOf(score, "comp")!.voice, "pizzicato");
    assert.equal(partOf(score, "bass")!.voice, "uprightBass");
    assert.equal(score.swing, 0);
    const kit = kitOf(score)!;
    assert.equal(kit.kit, "pop");
    assert.ok(kindsOf(kit).has("woodblock"), "woodblock in the kit");
    assert.ok(!kindsOf(kit).has("crash"), "no crash");
    // staccato: short notes are cut to about half their slot
    const lead = notesOf(score, "lead");
    const beat = 60 / score.bpm;
    let short = 0;
    let clipped = 0;
    for (let i = 0; i + 1 < lead.length; i++) {
      const slot = lead[i + 1].t - lead[i].t;
      if (slot > beat * 1.05 || slot < 0.05) continue;
      short++;
      if (lead[i].d <= slot * 0.62) clipped++;
    }
    assert.ok(
      short >= 10 && clipped / short >= 0.8,
      `seed ${seed}: ${clipped}/${short} staccato notes`,
    );
    for (const note of lead) {
      total++;
      if (!score.key.scale.includes(pc(note.midi))) chromatic++;
    }
    // oom-pah: the plucked strings alternate a bass note and a chord
    const comp = notesOf(score, "comp");
    assert.ok(
      comp.every((note) => note.d <= beat * 0.6),
      "pizzicato notes are short",
    );
    // the bass hops between root and fifth
    const bass = notesOf(score, "bass");
    const hops = bass.filter(
      (note, i) =>
        i > 0 && [5, 7].includes(Math.abs(note.midi - bass[i - 1].midi)),
    ).length;
    assert.ok(
      hops >= bass.length * 0.3,
      `seed ${seed}: ${hops} root-fifth hops in ${bass.length} bass notes`,
    );
  }
  // playful chromatic neighbours, but only as a spice
  assert.ok(chromatic >= 4, `${chromatic} chromatic notes`);
  assert.ok(chromatic / total < 0.1, `${chromatic}/${total} chromatic notes`);
  const high = compose(
    config("cute", { loop: true, duration: 30, energy: 0.8 }),
  );
  assert.equal(partOf(high, "arp")!.voice, "musicbox");
  assert.ok(Math.min(...notesOf(high, "arp").map((note) => note.midi)) >= 60);
  assert.equal(
    compose(config("cute", { loop: false, duration: 45 }))
      .chords.at(-1)!
      .symbol.replace(/^[A-G][#b]?/, ""),
    "6",
  );
});

test("battle: fast, a sixteenth-note synth bass, bVI–bVII–i, string stabs and an aggressive kit", () => {
  assert.ok(
    stylePreset("battle").bpm >= 140 && stylePreset("battle").bpm <= 188,
  );
  let flatSixSeven = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const score = compose(config("battle", { loop: true, duration: 30, seed }));
    const label = `battle seed ${seed}`;
    assert.equal(score.bpm, 160, label);
    assert.equal(partOf(score, "lead")!.voice, "synth");
    assert.equal(partOf(score, "bass")!.voice, "synthBass");
    assert.equal(partOf(score, "comp")!.voice, "strings");
    assert.equal(kitOf(score)!.kit, "pop");
    assert.equal(score.master.character, "punchy");
    // driving ostinato: twelve or more bass notes in a bar, almost all of them the root
    const barSeconds = 240 / score.bpm;
    const bass = notesOf(score, "bass");
    const perBar = new Map<number, number>();
    for (const note of bass)
      perBar.set(
        Math.floor(note.t / barSeconds + 1e-3),
        (perBar.get(Math.floor(note.t / barSeconds + 1e-3)) ?? 0) + 1,
      );
    const busy = [...perBar.values()].filter((count) => count >= 12).length;
    assert.ok(
      busy >= score.bars * 0.7,
      `${label}: ${busy}/${score.bars} bars of sixteenth-note bass`,
    );
    const onRoot = bass.filter(
      (note) => pc(note.midi) === chordAt(score, note.t + 0.01).root,
    ).length;
    assert.ok(onRoot / bass.length > 0.9, `${label}: ostinato off the root`);
    // fast hats or ride, kick and snare, and stabs on the strings
    const kit = kitOf(score)!;
    const kinds = kindsOf(kit);
    assert.ok(
      kinds.has("kick") && kinds.has("snare") && kinds.has("crash"),
      label,
    );
    const cymbals = kit.hits.filter(
      (hit) => hit.kind === "hatClosed" || hit.kind === "ride",
    ).length;
    const kicks = kit.hits.filter((hit) => hit.kind === "kick").length;
    assert.ok(
      cymbals / score.bars >= 4 && kicks / score.bars >= 2.5,
      `${label}: ${cymbals} cymbals, ${kicks} kicks`,
    );
    assert.ok(
      notesOf(score, "comp").every((note) => note.d < (60 / score.bpm) * 0.6),
      `${label}: stabs are short`,
    );
    const degrees = rootDegrees(score);
    if (degrees.has(8) && degrees.has(10) && degrees.has(0)) flatSixSeven++;
    // tom fill into the loop point
    assert.ok(
      kit.hits.some(
        (hit) =>
          hit.kind.startsWith("tom") ||
          (hit.kind === "snare" && hit.t > score.duration - barSeconds / 2),
      ),
      label,
    );
  }
  assert.ok(flatSixSeven >= 5, `bVI–bVII–i in ${flatSixSeven}/6 seeds`);
  // minor by default, and it stays in tempo range without halving its feel
  assert.ok(compose(config("battle")).key.minor);
});

test("ambient: slow pads, a drone and sparse bells, no beat", () => {
  const score = compose(config("ambient", { loop: false, duration: 60 }));
  assert.ok(voicesOf(score).has("airpad") && voicesOf(score).has("pad"));
  const longest = Math.max(...notesOf(score, "pad").map((note) => note.d));
  assert.ok(longest >= 6, `pads are long (${longest}s)`);
  assert.ok(notesOf(score, "lead").length / score.duration < 0.8);
  assert.ok(score.space.level > 0.7 && score.space.decay >= 4);
  assert.equal(drumParts(score).length, 0);
});

test("corporate: plucked motif, eighth-note ostinato, bright piano chords and a steady four", () => {
  for (const seed of [1, 2, 3, 4]) {
    const score = compose(
      config("corporate", { loop: true, duration: 30, seed }),
    );
    const label = `corporate seed ${seed}`;
    assert.equal(partOf(score, "lead")!.voice, "pluck");
    assert.equal(partOf(score, "comp")!.voice, "piano");
    assert.equal(partOf(score, "arp")!.voice, "guitar");
    assert.equal(partOf(score, "bass")!.voice, "fingerBass");
    assert.equal(kitOf(score)!.kit, "pop");
    assert.equal(score.swing, 0);
    assert.equal(score.master.character, "clean");
    // the I–V–vi–IV family: diatonic chords on I, ii, iii, IV, V, vi (an applied dominant may pass by)
    const chromatic = score.chords.filter(
      (chord) =>
        !chord.pitchClasses.every((value) => score.key.scale.includes(value)),
    );
    assert.ok(
      chromatic.length <= score.chords.length * 0.15,
      `${label}: ${chromatic.map((chord) => chord.symbol)}`,
    );
    for (const chord of score.chords)
      if (!chromatic.includes(chord))
        assert.ok(
          [0, 2, 4, 5, 7, 9].includes((chord.root - score.key.tonic + 12) % 12),
          `${label}: ${chord.symbol}`,
        );
    const degrees = rootDegrees(score);
    assert.ok(
      degrees.has(0) && degrees.has(7) && (degrees.has(9) || degrees.has(5)),
      label,
    );
    // steady: a kick on the first beat of every bar the kit plays, ostinato in even eighths
    const barSeconds = 240 / score.bpm;
    const kicks = hitsOf(score, "kick");
    for (let bar = 0; bar < score.bars; bar++)
      assert.ok(
        kicks.some((hit) => Math.abs(hit.t - bar * barSeconds) < 0.03),
        `${label}: no kick on bar ${bar + 1}`,
      );
    const arp = notesOf(score, "arp");
    assert.ok(
      arp.length >= score.bars * 8,
      `${label}: ostinato has ${arp.length} notes`,
    );
    assert.ok(
      arp.every(
        (note) =>
          Math.abs(stepOf(score, note.t) - Math.round(stepOf(score, note.t))) <
          0.2,
      ),
      label,
    );
  }
  // under any other lead the ostinato is the pluck itself
  assert.equal(
    partOf(compose(config("corporate", { instrument: "piano" })), "arp")!.voice,
    "pluck",
  );
  // layers join one by one: every section of a longer piece has at least as many as the one before, up to the chorus
  const song = compose(config("corporate", { loop: false, duration: 60 }));
  const layers = song.sections.map(
    (section) =>
      song.parts.filter((part) =>
        (part.kind === "notes"
          ? part.notes.map((n) => n.t)
          : part.hits.map((h) => h.t)
        ).some((t) => inside(t, section)),
      ).length,
  );
  const peak = song.sections.findIndex((section) => section.type === "chorus");
  for (let i = 1; i <= peak; i++)
    assert.ok(layers[i] >= layers[i - 1], `layers ${layers.join(" → ")}`);
  assert.ok(layers[peak] >= layers[0] + 2, `layers ${layers.join(" → ")}`);
});

test("sad: a slow piano ballad for two hands with strings, iv and bVI, and breathing time", () => {
  let subdominants = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const score = compose(config("sad", { loop: true, duration: 60, seed }));
    const label = `sad seed ${seed}`;
    assert.ok(score.bpm <= 84, label);
    assert.ok(score.key.minor);
    // one pianist: melody and accompaniment are both piano
    assert.equal(partOf(score, "lead")!.voice, "piano", label);
    assert.equal(partOf(score, "comp")!.voice, "piano", label);
    assert.equal(partOf(score, "pad")!.voice, "strings", label);
    assert.equal(drumParts(score).length, 0, label);
    // sustained strings
    assert.ok(
      Math.max(...notesOf(score, "pad").map((note) => note.d)) >=
        (240 / score.bpm) * 0.9,
      label,
    );
    // the right hand stays above the left
    const mean = (notes: NoteEvent[]) =>
      notes.reduce((sum, note) => sum + note.midi, 0) / notes.length;
    assert.ok(
      mean(notesOf(score, "lead")) > mean(notesOf(score, "comp")) + 9,
      label,
    );
    const degrees = rootDegrees(score);
    if (degrees.has(5) || degrees.has(8)) subdominants++;
    // the minor subdominant is minor, the submediant major
    for (const chord of score.chords) {
      const degree = (chord.root - score.key.tonic + 12) % 12;
      if (degree === 5 && !chord.symbol.includes("/"))
        assert.ok(
          chord.pitchClasses.includes((chord.root + 3) % 12),
          `${label}: ${chord.symbol}`,
        );
      if (degree === 8)
        assert.ok(
          chord.pitchClasses.includes((chord.root + 4) % 12),
          `${label}: ${chord.symbol}`,
        );
    }
  }
  assert.equal(subdominants, 6, "iv or bVI in every piece");
  // rubato: notes drift against the metronome inside a phrase, by tens of milliseconds, never chaotically
  const score = compose(config("sad", { loop: true, duration: 60, seed: 3 }));
  const grid = 60 / score.bpm / 4;
  const offsets = notesOf(score, "comp").map((note) => {
    const steps = note.t / grid;
    return (steps - Math.round(steps)) * grid;
  });
  const worst = Math.max(...offsets.map(Math.abs));
  assert.ok(
    worst > 0.04 && worst < 0.18,
    `rubato moves notes by up to ${worst}s`,
  );
  // …while every part shares the clock: lead notes written on a downbeat arrive with the left hand
  const comp = notesOf(score, "comp");
  let together = 0;
  let checked = 0;
  for (const note of notesOf(score, "lead")) {
    const nearest = Math.min(
      ...comp.map((other) => Math.abs(other.t - note.t)),
    );
    const steps = note.t / grid;
    if (Math.abs(steps / 16 - Math.round(steps / 16)) > 0.02) continue;
    checked++;
    if (nearest < 0.06) together++;
  }
  assert.ok(
    checked >= 4 && together / checked >= 0.9,
    `${together}/${checked} downbeats together`,
  );
});

test("dance: four on the floor, off-beat open hats and bass, claps on two and four, ducked chords, a build into the drop", () => {
  for (const [loop, duration] of [
    [true, 30],
    [false, 45],
    [true, 60],
  ] as const) {
    const score = compose(config("dance", { loop, duration }));
    const label = `dance loop=${loop} ${duration}s`;
    const beat = 60 / score.bpm;
    const barSeconds = beat * 4;
    assert.equal(kitOf(score)!.kit, "electro", label);
    assert.equal(partOf(score, "bass")!.voice, "synthBass", label);
    assert.equal(score.swing, 0);
    assert.equal(score.master.character, "punchy");
    // the form goes build → drop
    const types = score.sections.map((section) => section.type);
    const build = score.sections.find((section) => section.type === "build")!;
    assert.ok(build, `${label}: ${types.join(" ")}`);
    assert.equal(
      types[types.indexOf("build") + 1],
      "chorus",
      `${label}: ${types.join(" ")}`,
    );
    const drop = score.sections[score.sections.indexOf(build) + 1];
    // the drop: kick on every beat, open hat on every off-beat, clap on two and four
    const dropBars =
      Math.round((drop.end - drop.start) / barSeconds) -
      (drop === score.sections.at(-1) ? 1 : 0);
    const at = (kind: DrumKind, t: number) =>
      hitsOf(score, kind).some((hit) => Math.abs(hit.t - t) < 0.02);
    for (let bar = 0; bar < dropBars - 1; bar++)
      for (let b = 0; b < 4; b++) {
        const t = drop.start + bar * barSeconds + b * beat;
        assert.ok(
          at("kick", t),
          `${label}: no kick on beat ${b + 1} of drop bar ${bar + 1}`,
        );
        assert.ok(
          at("hatOpen", t + beat / 2),
          `${label}: no open hat after beat ${b + 1} of drop bar ${bar + 1}`,
        );
        if (b % 2 === 1)
          assert.ok(at("clap", t), `${label}: no clap on beat ${b + 1}`);
        else assert.ok(!at("clap", t), `${label}: clap on beat ${b + 1}`);
      }
    // the bass answers from the off-beats: never on the beat inside the drop
    const bass = notesOf(score, "bass").filter((note) => inside(note.t, drop));
    assert.ok(
      bass.length >= dropBars * 4,
      `${label}: ${bass.length} bass notes in the drop`,
    );
    for (const note of bass) {
      const fraction = beatOf(score, note.t) % 1;
      assert.ok(
        fraction > 0.4 && fraction < 0.85,
        `${label}: bass note on the beat (${fraction.toFixed(2)})`,
      );
    }
    // sidechain: pad and stabs duck hard, the lead does not
    assert.ok(partOf(score, "pad")!.mix.duck >= 0.8, label);
    assert.ok(partOf(score, "comp")!.mix.duck >= 0.5, label);
    assert.equal(partOf(score, "lead")!.mix.duck, 0, label);
    // the build: a snare roll that doubles its speed and grows, the kick dropping out at the end, and a riser
    const roll = hitsOf(score, "snare").filter((hit) => inside(hit.t, build));
    const half = (build.start + build.end) / 2;
    const first = roll.filter((hit) => hit.t < half).length;
    const second = roll.length - first;
    assert.ok(
      second >= first * 2 && second >= 10,
      `${label}: snare roll ${first} then ${second}`,
    );
    assert.ok(
      roll[roll.length - 1].vel > roll[0].vel + 0.2,
      `${label}: the roll does not grow`,
    );
    const lastBar = build.end - barSeconds;
    const tail = roll.filter((hit) => hit.t >= lastBar + barSeconds / 2 - 0.02);
    assert.ok(
      tail.length >= 7,
      `${label}: ${tail.length} strokes in the last two beats`,
    );
    assert.ok(
      !hitsOf(score, "kick").some(
        (hit) =>
          hit.t > lastBar + barSeconds / 2 + 0.02 && hit.t < build.end - 0.02,
      ),
      `${label}: the kick plays through the roll`,
    );
    const swell = hitsOf(score, "cymbalSwell").find(
      (hit) => hit.t > build.start && hit.t < build.end,
    );
    assert.ok(
      swell && Math.abs(build.end - swell.t - 1.8) < 0.02,
      `${label}: no riser into the drop`,
    );
    // impact on the drop
    assert.ok(
      at("crash", drop.start) && at("subBoom", drop.start),
      `${label}: the drop lands without an impact`,
    );
  }
});

test("hiphop: half-time backbeat on three, an 808 locked to the kick, rolling hats, a looped riff and finger snaps", () => {
  assert.ok(
    stylePreset("hiphop").bpm >= 70 && stylePreset("hiphop").bpm <= 100,
  );
  for (const seed of [1, 2, 3, 4]) {
    const score = compose(
      config("hiphop", { loop: true, duration: 45, seed, energy: 0.65 }),
    );
    const label = `hiphop seed ${seed}`;
    const beat = 60 / score.bpm;
    assert.equal(partOf(score, "bass")!.voice, "bass808", label);
    assert.equal(partOf(score, "lead")!.voice, "epiano", label);
    assert.equal(partOf(score, "comp")!.voice, "epiano", label);
    assert.equal(kitOf(score)!.kit, "electro", label);
    assert.ok(Math.abs(score.swing - 0.3) < 1e-9, label);
    // snare and clap on beat three, never on two or four
    // (the last bar of a section carries the fill)
    const fills = score.sections.map((section) => section.end - beat * 4);
    const loud = [...hitsOf(score, "snare"), ...hitsOf(score, "clap")].filter(
      (hit) =>
        hit.vel > 0.45 &&
        !fills.some(
          (start) => hit.t >= start - 0.03 && hit.t < start + beat * 4,
        ),
    );
    assert.ok(
      loud.length >= score.bars - score.sections.length - 1,
      `${label}: ${loud.length} backbeats`,
    );
    for (const hit of loud) {
      const inBar = beatOf(score, hit.t) % 4;
      assert.ok(
        Math.abs(inBar - 2) < 0.12,
        `${label}: backbeat on beat ${(inBar + 1).toFixed(2)}`,
      );
    }
    // laid back: the backbeat lands a little late
    const late = loud.map((hit) => ((beatOf(score, hit.t) % 4) - 2) * beat);
    assert.ok(
      late.reduce((a, b) => a + b, 0) / late.length > 0.006,
      `${label}: the backbeat does not drag`,
    );
    // the 808 follows the kick and slides
    const kicks = hitsOf(score, "kick");
    const bass = notesOf(score, "bass");
    const locked = bass.filter((note) =>
      kicks.some((hit) => Math.abs(hit.t - note.t) < 0.05),
    ).length;
    assert.ok(
      locked / bass.length >= 0.75,
      `${label}: ${locked}/${bass.length} bass notes on a kick`,
    );
    assert.ok(
      bass.some((note) => note.bend !== undefined),
      `${label}: no 808 slide`,
    );
    assert.ok(Math.max(...bass.map((note) => note.midi)) <= 50);
    // hat rolls: strokes closer together than a sixteenth
    const hats = hitsOf(score, "hatClosed");
    let rolls = 0;
    for (let i = 1; i < hats.length; i++)
      if (hats[i].t - hats[i - 1].t < (beat / 4) * 0.7) rolls++;
    assert.ok(rolls >= 3, `${label}: ${rolls} hat rolls`);
    // finger snaps
    assert.ok(
      hitsOf(score, "fingerSnap").length >= 2,
      `${label}: no finger snaps`,
    );
    // a riff that loops: the second two-bar statement repeats the rhythm of the first
    const barSeconds = beat * 4;
    const rhythm = (bar: number) =>
      notesOf(score, "lead")
        .filter(
          (note) =>
            note.t >= bar * barSeconds - 0.04 &&
            note.t < (bar + 1) * barSeconds - 0.04,
        )
        .map((note) =>
          Math.round((note.t - bar * barSeconds) / (barSeconds / 8)),
        )
        .join(",");
    // (a riff that enters off the beat may be led in by a pickup the very first
    // time: what counts is the riff itself, from its own first note on)
    const entry = Number(rhythm(2).split(",")[0]);
    const first = rhythm(0)
      .split(",")
      .filter((step) => Number(step) >= entry)
      .join(",");
    assert.ok(rhythm(2).length > 0, `${label}: no riff in bar 3`);
    assert.equal(first, rhythm(2), `${label}: the riff does not loop`);
    assert.ok(score.chords.every((chord) => chord.pitchClasses.length >= 3));
    assert.ok(
      score.chords.filter((chord) => chord.pitchClasses.length >= 4).length >=
        score.chords.length * 0.6,
      `${label}: seventh chords`,
    );
  }
});

test("rock: overdriven power chords, eighth-note bass, an acoustic kit with crashes and tom fills, a pentatonic lead", () => {
  for (const key of ["E minor", "A major", "D minor"])
    for (const seed of [1, 2, 3]) {
      const score = compose(
        config("rock", { key, loop: true, duration: 30, seed }),
      );
      const label = `rock ${key} seed ${seed}`;
      assert.equal(partOf(score, "lead")!.voice, "guitar", label);
      assert.equal(partOf(score, "bass")!.voice, "fingerBass", label);
      assert.equal(kitOf(score)!.kit, "acoustic", label);
      // power chords: every strum is a root and its fifth (plus octaves), nothing else
      const comp = partOf(score, "comp")!;
      assert.equal(comp.voice, "overdrive", label);
      assert.ok(comp.mix.drive >= 0.4, label);
      const strums = new Map<number, number[]>();
      for (const note of comp.notes)
        strums.set(Math.round(note.t * 25), [
          ...(strums.get(Math.round(note.t * 25)) ?? []),
          note.midi,
        ]);
      for (const notes of strums.values()) {
        const low = Math.min(...notes);
        // root and fifth in either order (the low root may leave the bass register to the bass)
        for (const midi of notes)
          assert.ok(
            [0, 7, 5].includes((midi - low) % 12),
            `${label}: power chord with ${notes}`,
          );
      }
      assert.ok(
        [...strums.values()].filter((notes) => notes.length >= 2).length >=
          strums.size * 0.9,
        label,
      );
      assert.ok(
        Math.min(...comp.notes.map((note) => note.midi)) < 52,
        `${label}: power chords sit low`,
      );
      // pentatonic lead, well above the chords
      assert.equal(score.key.scale.length, 5, label);
      const lead = notesOf(score, "lead");
      assert.ok(
        lead.every((note) => score.key.scale.includes(pc(note.midi))),
        label,
      );
      assert.ok(
        Math.min(...lead.map((note) => note.midi)) >
          Math.max(...comp.notes.map((note) => note.midi)) - 8,
        label,
      );
      // eighth-note bass on the roots
      const bass = notesOf(score, "bass");
      assert.ok(
        bass.length >= score.bars * 7,
        `${label}: ${bass.length} bass notes in ${score.bars} bars`,
      );
      // crash at every section start, tom fill at the loop point
      for (const section of score.sections)
        assert.ok(
          hitsOf(score, "crash").some(
            (hit) => Math.abs(hit.t - section.start) < 0.03,
          ),
          `${label}: no crash at ${section.label}`,
        );
      const barSeconds = 240 / score.bpm;
      const fill = kitOf(score)!.hits.filter(
        (hit) =>
          hit.t > score.duration - barSeconds / 2 - 0.02 &&
          (hit.kind.startsWith("tom") || hit.kind === "snare"),
      );
      assert.ok(fill.length >= 4, `${label}: ${fill.length} fill strokes`);
    }
  const toms = new Set<string>();
  for (const seed of [1, 2, 3, 4, 5, 6])
    for (const hit of kitOf(
      compose(config("rock", { loop: false, duration: 60, seed })),
    )!.hits)
      if (hit.kind.startsWith("tom")) toms.add(hit.kind);
  assert.ok(toms.size >= 2, "tom fills");
});

test("romantic: a piano over its own arpeggios, strings as pad and counter-melody, IV–V–iii–vi and secondary dominants", () => {
  let secondary = 0;
  let royal = 0;
  // (the two shares below are properties of the bank: about half of all pieces
  // carry one of the "royal road" progressions. Twenty-four seeds measure it;
  // the eight this test started with could pass or fail on the draw.)
  const seeds = Array.from({ length: 24 }, (_, i) => i + 1);
  for (const seed of seeds) {
    const score = compose(
      config("romantic", {
        loop: true,
        duration: 60,
        seed,
        complexity: 0.8,
        energy: 0.5,
      }),
    );
    const label = `romantic seed ${seed}`;
    assert.ok(!score.key.minor);
    assert.equal(partOf(score, "lead")!.voice, "piano", label);
    assert.equal(partOf(score, "comp")!.voice, "piano", label);
    assert.equal(partOf(score, "pad")!.voice, "strings", label);
    assert.equal(partOf(score, "counter")!.voice, "strings", label);
    assert.equal(
      drumParts(score).filter((part) => part.role === "kit").length,
      score.sections.some((s) => s.energy >= 0.5) ? 1 : 0,
      label,
    );
    // arpeggiated accompaniment: the left hand plays one or two notes at a time, not block chords
    const comp = notesOf(score, "comp");
    const onsets = new Map<number, number>();
    for (const note of comp)
      onsets.set(
        Math.round(note.t * 20),
        (onsets.get(Math.round(note.t * 20)) ?? 0) + 1,
      );
    const single = [...onsets.values()].filter((count) => count <= 2).length;
    assert.ok(
      single / onsets.size >= 0.8,
      `${label}: ${single}/${onsets.size} arpeggio notes`,
    );
    if (
      score.chords.some((chord) =>
        chord.pitchClasses.some((value) => !score.key.scale.includes(value)),
      )
    )
      secondary++;
    const degrees = score.chords
      .map((chord) => (chord.root - score.key.tonic + 12) % 12)
      .join(",");
    if (
      degrees.includes("5,7,4,9") ||
      degrees.includes("0,7,9") ||
      degrees.includes("5,7,4")
    )
      royal++;
  }
  assert.ok(
    secondary >= 18,
    `chromatic colour (secondary dominants, minor iv) in ${secondary}/${seeds.length} pieces`,
  );
  assert.ok(
    royal >= 9,
    `IV–V–iii–vi or the canon bass in ${royal}/${seeds.length} pieces`,
  );
  // warm and roomy
  const score = compose(config("romantic"));
  assert.equal(score.master.character, "warm");
  assert.ok(score.space.decay >= 2);
});

test("festive: bells over a bouncing bass with sleigh bells and tambourine, pentatonic with gongs and drums for guzheng or dizi", () => {
  for (const seed of [1, 2, 3, 4]) {
    const score = compose(
      config("festive", { loop: true, duration: 30, seed }),
    );
    const label = `festive seed ${seed}`;
    assert.equal(partOf(score, "lead")!.voice, "bell", label);
    assert.ok(!score.key.minor);
    assert.equal(kitOf(score)!.kit, "pop", label);
    // sleigh bells on every eighth
    const bells = hitsOf(score, "sleighBell");
    assert.ok(
      bells.length >= score.bars * 8 - 2,
      `${label}: ${bells.length} sleigh bells in ${score.bars} bars`,
    );
    assert.ok(
      hitsOf(score, "tambourine").length >= 4,
      `${label}: no tambourine`,
    );
    // bouncing bass: root and fifth
    const bass = notesOf(score, "bass");
    const hops = bass.filter(
      (note, i) =>
        i > 0 && [5, 7].includes(Math.abs(note.midi - bass[i - 1].midi)),
    ).length;
    assert.ok(
      hops >= bass.length * 0.3,
      `${label}: ${hops} hops in ${bass.length} bass notes`,
    );
    assert.equal(partOf(score, "bass")!.voice, "fingerBass");
  }
  // bright major by default, with the seven-note scale for most seeds
  const scales = [1, 2, 3, 4, 5, 6, 7, 8].map(
    (seed) => compose(config("festive", { seed })).key.scale.length,
  );
  assert.ok(
    scales.filter((length) => length === 7).length >= 5,
    `scales ${scales}`,
  );
  // new-year flavour: guzheng or dizi lead → pentatonic tune, drum-cymbal-gong instead of sleigh bells
  for (const instrument of ["guzheng", "dizi"] as InstrumentId[])
    for (const key of ["G major", "E minor"])
      for (const seed of [1, 2, 3, 4, 5]) {
        const score = compose(
          config("festive", {
            instrument,
            key,
            seed,
            loop: true,
            duration: 30,
          }),
        );
        const label = `festive ${instrument} ${key} seed ${seed}`;
        assert.equal(score.key.scale.length, 5, label);
        assert.ok(
          notesOf(score, "lead").every((note) =>
            score.key.scale.includes(pc(note.midi)),
          ),
          label,
        );
        assert.equal(hitsOf(score, "sleighBell").length, 0, label);
        const perc = kindsOf(percOf(score));
        assert.ok(
          perc.has("tomLow") && perc.has("hatOpen"),
          `${label}: ${[...perc]}`,
        );
        // and the harmony stays inside the key
        const parent = (
          key.endsWith("minor")
            ? [0, 2, 3, 5, 7, 8, 10, 11]
            : [0, 2, 4, 5, 7, 9, 11]
        ).map((value) => (value + score.key.tonic) % 12);
        for (const chord of score.chords)
          assert.ok(
            chord.pitchClasses.every((value) => parent.includes(value)),
            `${label}: ${chord.symbol}`,
          );
      }
});

/* ------------------------------------------------------------------ */
/* engine features the styles rely on                                  */
/* ------------------------------------------------------------------ */

test("rubato: phrase boundaries stay on the grid, the clock never runs backwards, and loops close", () => {
  for (const [loop, bpm, duration] of [
    [true, 68, 60],
    [true, 76, 30],
    [false, 68, 45],
    [false, 90, 20],
  ] as const) {
    const cfg = config("sad", { loop, bpm, duration });
    const timing = planTiming(cfg, getStyle("sad"));
    const straight = makeTimeMap(timing, 0, 8, 0);
    const free = makeTimeMap(timing, 0, 8, 1);
    const period = (timing.loop && timing.bars % 4 !== 0 ? 2 : 4) * 4;
    let worst = 0;
    let previous = -1;
    const total = timing.bars * 4;
    for (let beat = 0; beat <= total; beat += 0.125) {
      const t = free.seconds(beat);
      assert.ok(t > previous, `time runs backwards at beat ${beat}`);
      previous = t;
      worst = Math.max(worst, Math.abs(t - straight.seconds(beat)));
      if (beat % period === 0 && (loop || beat < timing.finalBar * 4 - 4))
        assert.ok(
          Math.abs(t - straight.seconds(beat)) < 1e-9,
          `phrase boundary at beat ${beat} moved`,
        );
    }
    // up to ±7 % of tempo: a few tenths of a beat at most
    assert.ok(
      worst > 0.03 && worst < 0.2 * timing.beatSeconds * 1.01 + 1e-9,
      `rubato of ${worst}s`,
    );
    if (loop)
      assert.ok(
        Math.abs(free.seconds(total) - timing.duration) < 1e-9,
        "the loop does not close",
      );
    else
      assert.ok(
        Math.abs(
          free.seconds(timing.finalBar * 4) -
            timing.finalBar * timing.barSeconds,
        ) < 1e-9,
        "the final chord is off the grid",
      );
  }
  // styles without rubato are metronomic
  const timing = planTiming(config("dance"), getStyle("dance"));
  assert.equal(
    makeTimeMap(timing, 0, 8).seconds(5.5),
    5.5 * timing.beatSeconds,
  );
});

test("pattern lists are ranked: verses draw from the calm half, lifted sections from the busy half", () => {
  const list = ["a", "b", "c", "d", "e"];
  for (let seed = 0; seed < 40; seed++) {
    assert.ok(
      ["a", "b", "c"].includes(pickRanked(list, false, seededRandom(seed))),
    );
    assert.ok(["d", "e"].includes(pickRanked(list, true, seededRandom(seed))));
  }
  assert.equal(pickRanked(["x"], true, seededRandom(1)), "x");
  assert.equal(pickRanked(["x", "y"], false, seededRandom(1)), "x");
  assert.equal(pickRanked(["x", "y"], true, seededRandom(1)), "y");
  // low-interval limit
  assert.ok(
    lowIntervalClash(45, 48) &&
      lowIntervalClash(43, 47) &&
      lowIntervalClash(50, 52),
  );
  assert.ok(
    !lowIntervalClash(48, 52) &&
      !lowIntervalClash(45, 52) &&
      !lowIntervalClash(52, 54) &&
      !lowIntervalClash(40, 47),
  );
});

test("written bass figures follow the chords: root on every change, fifths inside the chord, hints override them", () => {
  for (const style of [
    "cute",
    "festive",
    "battle",
    "dance",
    "corporate",
    "rock",
  ] as StyleId[])
    for (const seed of [1, 2, 3]) {
      const score = compose(
        config(style, { loop: true, duration: 30, seed, complexity: 0.9 }),
      );
      const bass = notesOf(score, "bass");
      // every bass note belongs to its chord, apart from the last-eighth approach notes
      let foreign = 0;
      for (const note of bass) {
        const chord = chordAt(score, note.t + 0.01);
        const bassName = pc(note.midi);
        if (!chord.pitchClasses.includes(bassName)) foreign++;
      }
      assert.ok(
        foreign / bass.length < 0.12,
        `${style} seed ${seed}: ${foreign}/${bass.length} bass notes outside the chord`,
      );
      // half-bar chords get their own root
      for (const chord of score.chords) {
        const first = bass.find(
          (note) =>
            note.t > chord.start - 0.02 &&
            note.t < chord.start + (60 / score.bpm) * 2 - 0.03,
        );
        if (!first || style === "dance") continue;
        const slash = chord.symbol.includes("/");
        if (!slash)
          assert.equal(
            pc(first.midi),
            chord.root,
            `${style} seed ${seed}: ${chord.symbol} starts on ${first.midi}`,
          );
      }
    }
  // a bass hint replaces the figure
  const walking = compose(
    config("dance", {
      loop: true,
      duration: 30,
      arrangement: { bass: "walking" },
    }),
  );
  const drop = sectionsOf(walking, "chorus")[0];
  assert.ok(
    notesOf(walking, "bass").some(
      (note) => inside(note.t, drop) && beatOf(walking, note.t) % 1 < 0.1,
    ),
    "walking bass plays on the beat",
  );
  assert.ok(
    !partOf(
      compose(config("battle", { arrangement: { bass: "none" } })),
      "bass",
    ),
  );
});

test("unusual leads keep each style recognisable", () => {
  // the accompaniment never borrows the lead's own instrument unless the style insists on it
  for (const style of STYLE_IDS)
    for (const instrument of INSTRUMENT_IDS) {
      const score = compose(
        config(style, { instrument, loop: true, duration: 30, energy: 0.8 }),
      );
      const def = getStyle(style);
      for (const role of ["comp", "pad", "arp", "counter"] as const) {
        const part = partOf(score, role);
        const layer = def[role];
        if (!part || !layer) continue;
        const choices = Array.isArray(layer.voice)
          ? layer.voice
          : [layer.voice];
        assert.ok(
          choices.includes(part.voice),
          `${style}/${instrument}: ${role} plays ${part.voice}`,
        );
        if (choices.length > 1)
          assert.notEqual(
            part.voice,
            instrument,
            `${style}/${instrument}: ${role} doubles the lead`,
          );
      }
      // kit and bass belong to the style, whatever the lead
      if (def.drums && kitOf(score))
        assert.equal(
          kitOf(score)!.kit,
          def.drums.kit,
          `${style}/${instrument}`,
        );
      if (def.bass && partOf(score, "bass"))
        assert.equal(
          partOf(score, "bass")!.voice,
          def.bass.voice,
          `${style}/${instrument}`,
        );
    }
  // high instruments are not pushed out of their range by a style's register lift
  for (const instrument of [
    "musicbox",
    "bell",
    "flute",
    "dizi",
  ] as InstrumentId[]) {
    const lead = notesOf(
      compose(config("rock", { instrument, loop: false, duration: 60 })),
      "lead",
    );
    const mean = lead.reduce((sum, note) => sum + note.midi, 0) / lead.length;
    assert.ok(
      mean < LEAD_TRAITS[instrument].centre + 6,
      `rock/${instrument}: mean pitch ${mean.toFixed(1)}`,
    );
  }
  // a guitar lead in rock sits clearly higher than in a ballad
  const mean = (style: StyleId) => {
    const lead = notesOf(
      compose(
        config(style, {
          instrument: "guitar",
          loop: true,
          duration: 30,
          energy: 0.6,
        }),
      ),
      "lead",
    );
    return lead.reduce((sum, note) => sum + note.midi, 0) / lead.length;
  };
  assert.ok(mean("rock") > mean("sad") + 2);
});
