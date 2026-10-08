// Mix review of the groove and electronic styles — chill, jazz, hiphop, retro,
// dance, chiptune, battle, rock — locked in as measurements. Nobody can listen
// to the engine while it is being built, so the balance each style was tuned to
// is written down here as windows around what scripts/audio-audit.ts measures
// at the app's default faders. The windows are wide enough for another seed or
// a small change of taste (about ±1.5 LU around the tuned value) and narrow
// enough to catch a part that has gone missing or taken over the mix.
//
//   npx tsx scripts/audio-audit.ts --style <id> --both --seed 20261 --solo-parts
//
// prints the numbers behind a failure, part by part.
//
// Conventions: stem levels are LUFS at the default faders; "under the mix" is
// the mix's loudness minus the stem's. The spectral slope is the audit's:
// least squares over the octave bands 63 Hz–8 kHz, dB per octave, pink noise 0
// (a mix that falls 4.5 dB per octave on an FFT analyser reads -1.5 here).
//
// Engine finalisation moved two sets of windows without changing a style's
// balance: the crest windows came down 1.5–3 dB and the limiter may now work
// up to a fifth of the time, because the master gained a density stage (a
// drum-bus peak compressor and, per character, a lower limiter ceiling).
import test from "node:test";
import assert from "node:assert/strict";
import { auditConfig } from "../scripts/audio-audit";
import type { Audit } from "../scripts/audio-audit";
import { LoudnessMeter, energyToLufs } from "../src/audio/loudness";
import type { InstrumentId, StyleId } from "../src/music/catalog";
import { compose } from "../src/music/compose";
import { DEFAULT_CONFIG, stylePreset } from "../src/music/defaults";
import type { NotePart, Score } from "../src/music/score";
import { getStyle } from "../src/music/styles";
import type { MusicConfig } from "../src/types";

const SEED = 20261;
const LOOP_SECONDS = 24;

type Window = [low: number, high: number];

interface Target {
  /** seconds of the piece that ends: the shortest that holds a verse and a chorus */
  song: number;
  /** a lead the style was not written around */
  other: InstrumentId;
  /** melody stem over chords stem, LU */
  melodyOverChords: Window;
  bassUnderMix: Window;
  drumsUnderMix: Window;
  slope: Window;
  /** sample peak over RMS of the mix, dB */
  crest: Window;
  /** L/R correlation of the mix */
  correlation: Window;
  /** chorus over verse in the piece that ends, LU */
  contrast: Window;
  /** reverb return against the dry melody track, dB (null: too dry for the renderer to run a reverb) */
  melodyReverb: Window | null;
}

const TARGETS: Record<string, Target> = {
  // lo-fi: dark, soft kit, Rhodes on top of its own chords
  chill: {
    song: 40,
    other: "dizi",
    melodyOverChords: [1.8, 5.8],
    bassUnderMix: [5.2, 9.8],
    drumsUnderMix: [4.3, 8.2],
    slope: [-4.4, -2],
    crest: [10, 16.5],
    correlation: [0.85, 0.99],
    contrast: [0.3, 3.5],
    melodyReverb: [-22, -14],
  },
  // a trio in a small room: the vibraphone leads, the bass walks close behind, brushes and ride are a layer
  jazz: {
    song: 30,
    other: "guitar",
    melodyOverChords: [1.7, 6],
    bassUnderMix: [4, 8],
    drumsUnderMix: [7, 11.5],
    slope: [-3.2, -1.2],
    crest: [10, 17],
    correlation: [0.84, 0.98],
    contrast: [0.3, 3],
    melodyReverb: [-17, -9],
  },
  // drums and 808 in front, everything dry
  hiphop: {
    song: 30,
    other: "flute",
    melodyOverChords: [1.2, 5.6],
    bassUnderMix: [4.2, 9],
    drumsUnderMix: [2.8, 6.8],
    slope: [-4.4, -2.2],
    crest: [9, 16],
    correlation: [0.88, 0.99],
    contrast: [0.3, 3],
    melodyReverb: [-26, -17],
  },
  // synthwave: wide and wet, drum machine up front
  retro: {
    song: 30,
    other: "guzheng",
    melodyOverChords: [1.5, 6],
    bassUnderMix: [4.8, 8.8],
    drumsUnderMix: [3, 7],
    slope: [-3.1, -1.1],
    crest: [9.5, 16],
    correlation: [0.74, 0.94],
    contrast: [0.3, 3],
    melodyReverb: [-15, -8],
  },
  // house: the kick carries the low end, the off-beat bass answers it
  dance: {
    song: 40,
    other: "guzheng",
    melodyOverChords: [1.8, 5.8],
    bassUnderMix: [5.2, 9.3],
    drumsUnderMix: [2.9, 6.4],
    slope: [-2.8, -0.9],
    crest: [8.5, 15],
    correlation: [0.82, 0.96],
    contrast: [0.4, 3.5],
    melodyReverb: [-18, -10],
  },
  // three tone channels and noise: bright, dry, all but mono; the arpeggio that
  // carries the harmony is the chords stem (it is the only harmony the style has)
  chiptune: {
    song: 30,
    other: "piano",
    melodyOverChords: [3.5, 7.5],
    bassUnderMix: [4.2, 8.6],
    drumsUnderMix: [4.6, 8.6],
    slope: [-1.8, 0.2],
    crest: [9.5, 16.3],
    correlation: [0.93, 1],
    contrast: [0.3, 3],
    melodyReverb: null,
  },
  // dense and driving: seven parts, the kit and the sixteenth-note bass push
  battle: {
    song: 30,
    other: "strings",
    melodyOverChords: [0.5, 5.6],
    bassUnderMix: [4.8, 9.2],
    drumsUnderMix: [2.8, 6.5],
    slope: [-2.9, -0.9],
    crest: [9, 15.5],
    correlation: [0.78, 0.95],
    contrast: [0.3, 3],
    melodyReverb: [-22, -13],
  },
  // a wall of guitars under a lead, the kit as loud as the mix allows
  rock: {
    song: 30,
    other: "flute",
    melodyOverChords: [1.3, 6.2],
    bassUnderMix: [5.2, 9.4],
    drumsUnderMix: [3.3, 7],
    slope: [-2.8, -0.6],
    crest: [9.5, 16.5],
    correlation: [0.85, 0.985],
    contrast: [0.3, 3.5],
    melodyReverb: [-23, -14],
  },
};
const STYLES = Object.keys(TARGETS) as StyleId[];

const config = (style: StyleId, overrides: Partial<MusicConfig> = {}): MusicConfig => ({
  ...DEFAULT_CONFIG,
  ...stylePreset(style),
  seed: SEED,
  ...overrides,
});

interface Measured {
  audit: Audit;
  /** loudness of the last bar minus the first (at least two seconds each), LU */
  ends: number;
}

/** K-weighted loudness of a stretch of the mix, without gating. */
function stretchLoudness(left: Float32Array, right: Float32Array, from: number, to: number, sampleRate: number): number {
  const meter = new LoudnessMeter(sampleRate);
  meter.push(left.subarray(from, to), right.subarray(from, to), to - from);
  const hops = meter.hopEnergies;
  let sum = 0;
  for (let i = 0; i < hops.length; i++) sum += hops[i];
  return hops.length ? energyToLufs(sum / hops.length) : -Infinity;
}

async function measure(input: MusicConfig): Promise<Measured> {
  let ends = NaN;
  const audit = await auditConfig(input, {
    onAudio: ({ mix, sampleRate, score }) => {
      const frames = mix[0].length;
      // whole bars: a shorter window would only measure how a held chord decays inside its bar
      const barSeconds = 240 / score.bpm;
      const span = Math.round(barSeconds * Math.ceil(2 / barSeconds) * sampleRate);
      ends =
        stretchLoudness(mix[0], mix[1], frames - span, frames, sampleRate) -
        stretchLoudness(mix[0], mix[1], 0, span, sampleRate);
    },
  });
  return { audit, ends };
}

const inside = (value: number, [low, high]: Window) => value >= low && value <= high;

/** Everything a render of the style must satisfy, whatever its length, lead or mode. */
function checkMix(label: string, { audit, ends }: Measured, target: Target): string[] {
  const problems: string[] = [];
  const expect = (what: string, value: number, window: Window) => {
    if (!inside(value, window)) problems.push(`${label}: ${what} ${value.toFixed(2)} outside ${window[0]} … ${window[1]}`);
  };
  const { mix, stems } = audit;
  for (const flag of audit.flags) problems.push(`${label}: ${flag}`);
  expect("loudness", mix.lufs, [mix.targetLufs - 0.3, mix.targetLufs + 0.3]);
  expect("master shortfall", audit.render.master.shortfallLu, [0, 0]);
  expect("share of samples past the soft clipper's knee", mix.kneeShare, [0, 0.002]);
  // (a denser master lowers the limiter's ceiling until it works up to a fifth of the time: DENSE_BUSY_RATIO in master.ts)
  expect("limiter activity", audit.render.master.limiter.activeRatio, [0, 0.22]);
  expect("correlation below 150 Hz", mix.correlationLow, [0.95, 1]);
  expect("correlation", mix.correlation, target.correlation);
  expect("spectral slope", mix.spectrum.slopeDbPerOctave, target.slope);
  expect("crest factor", mix.crestDb, target.crest);
  for (const track of ["melody", "bass", "drums"] as const)
    if (stems[track].empty) problems.push(`${label}: nothing on the ${track} track`);
  if (!stems.chords.empty) expect("melody over chords", stems.melody.lufs - stems.chords.lufs, target.melodyOverChords);
  expect("bass under the mix", mix.lufs - stems.bass.lufs, target.bassUnderMix);
  expect("drums under the mix", mix.lufs - stems.drums.lufs, target.drumsUnderMix);
  // no stem is louder than the tune
  for (const track of ["chords", "bass", "drums"] as const)
    if (!stems[track].empty && stems[track].lufs > stems.melody.lufs + 0.5)
      problems.push(`${label}: the ${track} stem (${stems[track].lufs}) is louder than the melody (${stems.melody.lufs})`);
  if (target.melodyReverb) expect("melody reverb", stems.melody.reverbDb, target.melodyReverb);
  else if (stems.melody.reverbDb > -30) problems.push(`${label}: melody reverb at ${stems.melody.reverbDb} dB in a dry style`);
  if (audit.score.loop) {
    // a loop repeats without a jump: clean seam, and its last bar is about as loud as its first
    if (!audit.seam) problems.push(`${label}: no seam measurement`);
    else expect("seam step over the usual step", audit.seam.jumpRatio, [0, 3]);
    expect("last bar against first bar", ends, [-3, 3]);
  } else {
    if (!audit.edges) problems.push(`${label}: no edge measurement`);
    else expect("level of the last 50 ms (dBFS)", audit.edges.endDb, [-Infinity, -60]);
  }
  return problems;
}

for (const style of STYLES)
  test(`mix: ${style} — loop, piece with an ending, and an unusual lead`, async (t) => {
    const target = TARGETS[style];
    const problems: string[] = [];
    const loop = await measure(config(style, { loop: true, duration: LOOP_SECONDS }));
    const song = await measure(config(style, { loop: false, duration: target.song }));
    const other = await measure(config(style, { loop: true, duration: LOOP_SECONDS, instrument: target.other }));
    for (const [name, measured] of [["loop", loop], ["song", song], [target.other, other]] as const) {
      const { mix, stems } = measured.audit;
      t.diagnostic(
        `${name}: ${mix.lufs.toFixed(2)} LUFS, stems ${(["melody", "chords", "bass", "drums"] as const)
          .map((track) => (stems[track].empty ? "–" : stems[track].lufs.toFixed(1)))
          .join(" / ")}, slope ${mix.spectrum.slopeDbPerOctave}, crest ${mix.crestDb}, corr ${mix.correlation}`,
      );
      problems.push(...checkMix(`${style} ${name}`, measured, target));
    }

    // form: the chorus is the loudest section, the piece comes down again before it ends
    const sections = song.audit.sections;
    const verses = sections.filter((section) => section.type === "verse");
    const choruses = sections.filter((section) => section.type === "chorus");
    assert.ok(verses.length && choruses.length, `${style}: ${target.song} s hold no verse and chorus (${sections.map((s) => s.type).join(" ")})`);
    const chorus = Math.max(...choruses.map((section) => section.lufs));
    const contrast = chorus - Math.min(...verses.map((section) => section.lufs));
    if (!inside(contrast, target.contrast)) problems.push(`${style}: chorus ${contrast.toFixed(2)} LU over the verse, wanted ${target.contrast[0]} … ${target.contrast[1]}`);
    const last = sections[sections.length - 1];
    if (last.type !== "chorus" && !(last.lufs < chorus - 0.5)) problems.push(`${style}: the ${last.type} (${last.lufs}) does not come down from the chorus (${chorus})`);

    // another lead is levelled against the one it replaces and does not change the style's tone
    const shift = other.audit.stems.melody.lufs - loop.audit.stems.melody.lufs;
    if (Math.abs(shift) > 1.6) problems.push(`${style}: a ${target.other} lead moves the melody stem by ${shift.toFixed(2)} LU`);
    const brighter = other.audit.mix.spectrum.slopeDbPerOctave - loop.audit.mix.spectrum.slopeDbPerOctave;
    if (Math.abs(brighter) > 1.3) problems.push(`${style}: a ${target.other} lead tilts the mix by ${brighter.toFixed(2)} dB per octave`);

    assert.deepEqual(problems, [], problems.join("\n"));
  });

/* ---- what the measurements above rest on, checked on the scores (no rendering) ---- */

const leadOf = (score: Score) => score.parts.find((part): part is NotePart => part.kind === "notes" && part.role === "lead")!;
const partOf = (score: Score, id: string) => score.parts.find((part) => part.id === id);

test("mix: every style keeps a bass and a kit down to the bottom of the energy slider", () => {
  for (const style of STYLES)
    for (const loop of [true, false]) {
      const score = compose(config(style, { loop, duration: 30, energy: 0.15 }));
      assert.ok(partOf(score, "bass"), `${style} loop=${loop}: no bass at energy 0.15`);
      assert.ok(partOf(score, "kit"), `${style} loop=${loop}: no kit at energy 0.15`);
    }
});

test("mix: percussion layers are mixed to be heard, not at shaker-under-a-kick level", () => {
  // a shaker peaks 12 dB under a kick before any gain; at the role's default gain of 0.4 it sat 30–50 LU under the mix
  for (const style of ["chill", "hiphop", "retro", "dance", "rock"] as StyleId[]) {
    const score = compose(config(style, { loop: true, duration: 30, energy: 0.95 }));
    const perc = partOf(score, "perc");
    assert.ok(perc, `${style}: no percussion at energy 0.95`);
    assert.ok(perc.mix.gain >= 0.7, `${style}: percussion gain ${perc.mix.gain}`);
    assert.ok(perc.kind === "drums" && perc.hits.some((hit) => hit.vel >= 0.55), `${style}: percussion is played too softly to be heard`);
  }
});

test("mix: bright leads are rounded off in the dark styles, struck leads are held in check in the dense ones", () => {
  const bright: InstrumentId[] = ["dizi", "guzheng", "strings", "bell"];
  for (const style of ["chill", "jazz", "hiphop"] as StyleId[]) {
    const usual = leadOf(compose(config(style))).mix;
    for (const instrument of bright) {
      const mix = leadOf(compose(config(style, { instrument }))).mix;
      assert.ok(mix.highCut > 0 && mix.highCut <= 4000, `${style}/${instrument}: high cut ${mix.highCut}`);
      assert.ok(usual.highCut === 0 || mix.highCut < usual.highCut, `${style}/${instrument}: no darker than the usual lead`);
    }
  }
  for (const style of ["retro", "dance", "battle", "chiptune", "hiphop"] as StyleId[])
    for (const instrument of ["piano", "pluck", "guzheng", "marimba"] as InstrumentId[]) {
      const mix = leadOf(compose(config(style, { instrument }))).mix;
      assert.ok(mix.drive >= 0.12, `${style}/${instrument}: an unsaturated ${instrument} lead peaks far over the kit`);
    }
  // every one of the eight adapts at least the two brightest leads
  for (const style of STYLES) {
    const table = getStyle(style).lead ?? {};
    assert.ok(table.dizi && table.guzheng, `${style}: no lead settings for dizi and guzheng`);
  }
});

test("mix: style-specific decisions of the review", () => {
  // dance — a clipped kick, and a bass that stays out of the kick's octave and is there from the first bar
  const dance = compose(config("dance", { loop: true, duration: 30 }));
  assert.ok(partOf(dance, "kit")!.mix.drive >= 0.1, "dance: kick peaks are not rounded off");
  const danceBass = partOf(dance, "bass") as NotePart;
  assert.ok(Math.min(...danceBass.notes.map((note) => note.midi)) >= 31, "dance: bass roots under 49 Hz sit inside the kick");
  assert.ok(danceBass.notes.some((note) => note.t < dance.sections[1].start), "dance: no bass before the build");
  // rock — one guitar part spread like a double-tracked take, and verses that leave room for the chorus
  const rock = compose(config("rock", { loop: true, duration: 30 }));
  const guitars = partOf(rock, "comp")!.mix;
  assert.ok(guitars.chorus >= 0.3 && guitars.width >= 1.3 && Math.abs(guitars.pan) <= 0.05, "rock: rhythm guitar is not spread across the field");
  const [verse, chorus] = [rock.sections.find((s) => s.type === "verse")!, rock.sections.find((s) => s.type === "chorus")!];
  assert.ok(verse.energy < 0.7 && chorus.energy >= 0.9, `rock: verse ${verse.energy} and chorus ${chorus.energy} share a tier`);
  assert.equal(partOf(rock, "kit")!.mix.gain, 1.5, "rock: the kit is the reference the other parts are set against");
  // jazz — the kit is quiet by nature (brushes, ride): it needs all the gain there is
  assert.ok(partOf(compose(config("jazz")), "kit")!.mix.gain >= 1.4, "jazz: brushes and ride are lost under the trio");
  // hiphop — the 808 gives way to the kick it is locked to
  assert.ok(partOf(compose(config("hiphop")), "bass")!.mix.duck >= 0.3, "hiphop: the 808 does not duck under the kick");
  // battle — string stabs are there from the bottom of the energy slider, so the chords track is never empty
  assert.ok(partOf(compose(config("battle", { energy: 0.15 })), "comp"), "battle: no chords at energy 0.15");
  // chiptune — the noise channel keeps a backbeat at every energy
  const quiet = compose(config("chiptune", { energy: 0.15, loop: true, duration: 30 }));
  const kit = partOf(quiet, "kit");
  assert.ok(kit && kit.kind === "drums" && kit.hits.some((hit) => hit.kind === "noiseHit"), "chiptune: no noise snare at energy 0.15");
  // the limiter ceiling stays where the engine put it: a lower one flattened the chorus against the verse
  for (const style of STYLES) assert.equal(getStyle(style).master.ceilingDb, -1, `${style}: ceiling`);
});
