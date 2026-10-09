import test from "node:test";
import assert from "node:assert/strict";
import { SAMPLE_RATE } from "../src/music/score";
import type { VoiceId } from "../src/music/score";
import type { Voice } from "../src/audio/voices/types";
import {
  SUSTAINED_CONTRACT,
  SUSTAINED_VOICES,
} from "../src/audio/voices/group-sustained";
import { BASS_CONTRACT, BASS_VOICES } from "../src/audio/voices/group-bass";
import {
  assertVoiceContract,
  bandEnergiesDb,
  centroidHz,
  centsError,
  checkClicks,
  dcOffset,
  estimatePitch,
  formatReport,
  isFiniteAudio,
  loudestWindowDb,
  measureCost,
  monoSum,
  peak,
  renderNote,
  rmsDb,
  stereoCorrelation,
  tailDb,
} from "../src/audio/voices/testing";
import type { ContractOptions, Rendered } from "../src/audio/voices/testing";
import { createRng, midiToHz, powerSpectrum } from "../src/audio/dsp";
import {
  NES_TRIANGLE_MAX_INC,
  ResponseTable,
  SawBank,
  SvfRange,
  TiltShelf,
  bandpassNoisePower,
  nesTriangle,
  nesTriangleLevel,
  seedPhases,
} from "../src/audio/dsp/extra-sustained";
import {
  Biquad,
  Svf,
  WhiteNoise,
  makePluck,
  pluckLength,
  sawBlep,
} from "../src/audio/dsp";
import { softPluck } from "../src/audio/voices/bass/plucked";

const SUSTAINED: VoiceId[] = [
  "strings",
  "pad",
  "airpad",
  "brass",
  "choir",
  "flute",
  "dizi",
  "synth",
  "chip",
  "chipPulse",
];
const BASSES: VoiceId[] = [
  "subBass",
  "fingerBass",
  "synthBass",
  "uprightBass",
  "chipBass",
  "bass808",
];
const ALL: VoiceId[] = [...SUSTAINED, ...BASSES];
const VOICES = { ...SUSTAINED_VOICES, ...BASS_VOICES } as Record<
  VoiceId,
  Voice
>;
const CONTRACTS = { ...SUSTAINED_CONTRACT, ...BASS_CONTRACT } as Record<
  VoiceId,
  ContractOptions
>;

/* ------------------------------------------------------------- measurement */

const note = (
  id: VoiceId,
  midi: number,
  vel = 0.8,
  duration = 1,
  bend?: number,
  seed = 1,
): Rendered =>
  renderNote(VOICES[id], { midi, vel, duration, bend }, SAMPLE_RATE, seed);

const near = (
  actual: number,
  expected: number,
  tolerance: number,
  what: string,
) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: got ${actual.toFixed(2)}, expected ${expected} ±${tolerance}`,
  );
const above = (actual: number, limit: number, what: string) =>
  assert.ok(
    actual > limit,
    `${what}: got ${actual.toFixed(2)}, want more than ${limit}`,
  );
const below = (actual: number, limit: number, what: string) =>
  assert.ok(
    actual < limit,
    `${what}: got ${actual.toFixed(2)}, want less than ${limit}`,
  );

/**
 * Milliseconds until the 8 ms RMS envelope first reaches `share` of the
 * note's settled level (the median of 0.3 .. 0.9 s).
 */
function riseMs(r: Rendered, share = 0.5): number {
  const sr = r.sampleRate;
  const window = Math.round(0.008 * sr);
  const hop = Math.round(0.001 * sr);
  const envelope: number[] = [];
  for (let start = 0; start + window <= r.frames; start += hop) {
    let power = 0;
    for (let i = start; i < start + window; i++)
      power += r.left[i] * r.left[i] + r.right[i] * r.right[i];
    envelope.push(Math.sqrt(power / (2 * window)));
  }
  const settled = envelope.slice(300, 900).sort((a, b) => a - b);
  const reference = settled[settled.length >> 1];
  for (let i = 0; i < envelope.length; i++)
    if (envelope[i] >= share * reference)
      return ((i * hop + window / 2) / sr) * 1000;
  return NaN;
}

/** Level in dB of harmonics 1..count of `f0`, relative to the fundamental (index 0 = 0 dB). */
function harmonicsDb(
  r: Rendered,
  f0: number,
  from: number,
  seconds: number,
  count: number,
): number[] {
  const start = Math.round(from * r.sampleRate);
  const length = Math.min(r.frames - start, Math.round(seconds * r.sampleRate));
  const spectrum = powerSpectrum(
    monoSum(r),
    r.sampleRate,
    start,
    length,
    65536,
  );
  const levels: number[] = [];
  for (let k = 1; k <= count; k++) {
    const low = Math.max(1, Math.floor(((k - 0.35) * f0) / spectrum.binHz));
    const high = Math.min(
      spectrum.power.length - 1,
      Math.ceil(((k + 0.35) * f0) / spectrum.binHz),
    );
    let power = 0;
    for (let bin = low; bin <= high; bin++) power += spectrum.power[bin];
    levels.push(10 * Math.log10(power + 1e-20));
  }
  return levels.map((level) => level - levels[0]);
}

/** Pitch error in cents against `midi` in consecutive short windows. */
function pitchTrack(
  r: Rendered,
  midi: number,
  from: number,
  to: number,
  window = 0.04,
  hop = 0.01,
): number[] {
  const mono = monoSum(r);
  const track: number[] = [];
  for (let t = from; t + window <= to + 1e-9; t += hop)
    track.push(
      1200 *
        Math.log2(
          estimatePitch(
            mono,
            r.sampleRate,
            midiToHz(midi),
            Math.round(t * r.sampleRate),
            Math.round(window * r.sampleRate),
          ) / midiToHz(midi),
        ),
    );
  return track;
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const deviation = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) * (x - m))));
};
const span = (a: number[]) => Math.max(...a) - Math.min(...a);

/** Oscillations per second of a pitch track sampled every `hop` seconds (zero crossings of its deviation from the mean). */
function wobbleHz(track: number[], hop = 0.01): number {
  const m = mean(track);
  let crossings = 0;
  for (let i = 1; i < track.length; i++)
    if ((track[i - 1] - m) * (track[i] - m) < 0) crossings++;
  return crossings / 2 / ((track.length - 1) * hop);
}

/** Power of L - R relative to L + R in dB: -inf for a mono voice. */
function sideDb(r: Rendered): number {
  let mid = 0;
  let side = 0;
  for (let i = 0; i < r.frames; i++) {
    const m = r.left[i] + r.right[i];
    const s = r.left[i] - r.right[i];
    mid += m * m;
    side += s * s;
  }
  return 10 * Math.log10((side + 1e-30) / (mid + 1e-30));
}

/** Share (dB re total of the same span) of the power between the harmonics 1-2, 2-3 and 3-4: breath, not tone. */
function betweenHarmonicsDb(
  r: Rendered,
  f0: number,
  from: number,
  seconds: number,
): number {
  const bands = bandEnergiesDb(
    r,
    [1.25 * f0, 1.75 * f0, 2.25 * f0, 2.75 * f0, 3.25 * f0, 3.75 * f0],
    from,
    seconds,
  );
  return (
    10 *
    Math.log10(
      Math.pow(10, bands[0] / 10) +
        Math.pow(10, bands[2] / 10) +
        Math.pow(10, bands[4] / 10),
    )
  );
}

/** Frequencies (Hz) of the first cycles of a render, from its upward zero crossings. */
function firstCycles(r: Rendered, count: number): number[] {
  const mono = monoSum(r);
  const crossings: number[] = [];
  for (let i = 1; i < mono.length && crossings.length <= count; i++)
    if (mono[i - 1] <= 0 && mono[i] > 0)
      crossings.push(i - mono[i] / (mono[i] - mono[i - 1]));
  const cycles: number[] = [];
  for (let i = 1; i < crossings.length; i++)
    cycles.push(r.sampleRate / (crossings[i] - crossings[i - 1]));
  return cycles;
}

/* ------------------------------------------------------- the two groups */

test("the sustained and bass groups provide sixteen real voices", () => {
  assert.deepEqual(Object.keys(SUSTAINED_VOICES).sort(), [...SUSTAINED].sort());
  assert.deepEqual(Object.keys(BASS_VOICES).sort(), [...BASSES].sort());
  assert.deepEqual(
    Object.keys(SUSTAINED_CONTRACT).sort(),
    [...SUSTAINED].sort(),
  );
  assert.deepEqual(Object.keys(BASS_CONTRACT).sort(), [...BASSES].sort());
  const engines = new Set<Voice["render"]>();
  for (const id of ALL) {
    const voice = VOICES[id];
    assert.equal(voice.id, id);
    engines.add(voice.render);
  }
  assert.equal(
    engines.size,
    ALL.length,
    "every id has its own render function",
  );
  // ... and no two of them sound alike: same note, different audio
  const renders = ALL.map((id) => note(id, 57, 0.8, 0.5));
  for (let a = 0; a < ALL.length; a++)
    for (let b = a + 1; b < ALL.length; b++) {
      let differs = renders[a].frames !== renders[b].frames;
      for (let i = 2000; i < 6000 && !differs; i++)
        if (Math.abs(renders[a].left[i] - renders[b].left[i]) > 1e-4)
          differs = true;
      assert.ok(differs, `${ALL[a]} and ${ALL[b]} render the same audio`);
    }
});

for (const id of ALL) {
  test(`${id} honours the voice contract over its whole range`, (t) => {
    const options = CONTRACTS[id];
    const report = assertVoiceContract(VOICES[id], options);
    t.diagnostic(formatReport(report));
    for (const level of report.levels)
      near(level.levelDb, -18, 1, `${id} level at midi ${level.midi}`);
    for (const row of report.rows) {
      near(row.levelDb, -18, 2.2, `${id} level at midi ${row.midi}`);
      below(Math.abs(row.cents), 8, `${id} tuning at midi ${row.midi}`);
    }
    for (const velocity of report.velocity)
      near(
        velocity.levelSpanDb,
        11.9,
        1.5,
        `${id} velocity law at midi ${velocity.midi}`,
      );
    below(report.worstPeak, 0.95, `${id} worst peak`);
  });
}

/* ----------------------------------------------------- sustained identity */

test("strings: a section with a bow attack, late vibrato and a body", () => {
  // slower than brass at every dynamic
  for (const vel of [0.3, 0.8, 1]) {
    const bowed = riseMs(note("strings", 60, vel, 2));
    const blown = riseMs(note("brass", 60, vel, 2));
    above(
      bowed,
      blown + 8,
      `strings rise vs brass (${blown.toFixed(0)} ms) at vel ${vel}`,
    );
    const full = riseMs(note("strings", 60, vel, 2), 0.9);
    assert.ok(
      full > 35 && full < 140,
      `bow attack at vel ${vel}: ${full.toFixed(0)} ms`,
    );
  }
  above(
    riseMs(note("strings", 60, 0.3, 2), 0.9),
    riseMs(note("strings", 60, 1, 2), 0.9) + 10,
    "a soft bow speaks later than a hard one",
  );
  // velocity opens the filter
  above(
    centroidHz(note("strings", 60, 1, 1.5), 0.5, 1) /
      centroidHz(note("strings", 60, 0.3, 1.5), 0.5, 1),
    1.3,
    "brightness hard / soft",
  );
  // vibrato fades in: steady while the bow settles, moving later
  const held = note("strings", 69, 0.8, 2.5);
  below(
    deviation(pitchTrack(held, 69, 0.03, 0.15)),
    2,
    "pitch movement in the first 150 ms",
  );
  above(
    deviation(pitchTrack(held, 69, 1, 2.4)),
    3,
    "pitch movement after a second",
  );
  // bright but not fizzy, and a real ensemble: wide, never out of phase
  const bands = bandEnergiesDb(held, [0, 250, 1000, 4000, 8000, 24000], 0.5, 1);
  above(bands[2], -9, "1-4 kHz share");
  below(bands[4], -25, "share above 8 kHz");
  const correlation = stereoCorrelation(held);
  assert.ok(
    correlation > 0.35 && correlation < 0.9,
    `correlation ${correlation}`,
  );
  // the body does not move with the note: two pitches, two harmonic balances
  const low = harmonicsDb(
    note("strings", 48, 0.8, 1.5),
    midiToHz(48),
    0.5,
    1,
    6,
  );
  const high = harmonicsDb(
    note("strings", 72, 0.8, 1.5),
    midiToHz(72),
    0.5,
    1,
    6,
  );
  above(
    Math.max(...low.map((level, k) => Math.abs(level - high[k]))),
    3,
    "difference between the harmonic balance of C3 and C5",
  );
  // NoteEvent.bend is a scoop that lands on the note
  const scooped = note("strings", 69, 0.8, 1, -2);
  below(pitchTrack(scooped, 69, 0.005, 0.045)[0], -60, "scoop start (cents)");
  near(centsError(scooped, 69, 0.3, 0.5), 0, 8, "scoop lands");
  // works as a lead line: a 150 ms note already carries most of its level
  above(
    loudestWindowDb(note("strings", 72, 0.8, 0.15), 0.1),
    -23,
    "150 ms note level",
  );
});

test("brass: stabs with bite, velocity opens the bell, a scoop at the lips", () => {
  const stab = note("brass", 60, 1, 0.12);
  above(loudestWindowDb(stab, 0.1), -18, "a 120 ms stab at vel 1");
  below(riseMs(note("brass", 60, 1, 2)), 15, "rise of a hard note (ms)");
  above(
    riseMs(note("brass", 60, 0.3, 2)),
    riseMs(note("brass", 60, 1, 2)) + 8,
    "a soft note swells",
  );
  // the attack is brighter than what it settles to
  const held = note("brass", 60, 0.9, 1.5);
  above(
    bandEnergiesDb(held, [2500, 24000], 0.02, 0.1)[0] -
      bandEnergiesDb(held, [2500, 24000], 0.6, 0.6)[0],
    1.5,
    "energy above 2.5 kHz, attack minus sustain (dB)",
  );
  // velocity changes the timbre far more than the level law alone would
  above(
    centroidHz(note("brass", 60, 1, 1.5), 0.5, 0.8) /
      centroidHz(note("brass", 60, 0.3, 1.5), 0.5, 0.8),
    1.4,
    "brightness hard / soft",
  );
  // strong mids without harshness
  const loud = bandEnergiesDb(
    note("brass", 60, 1, 1.5),
    [0, 400, 2500, 6000, 24000],
    0.3,
    1,
  );
  above(loud[1], -3, "400 Hz - 2.5 kHz share at vel 1");
  below(loud[3], -35, "share above 6 kHz at vel 1");
  // brass spectrum: harmonics 2..4 within a few dB of the fundamental
  const harmonics = harmonicsDb(
    note("brass", 55, 0.9, 1.5),
    midiToHz(55),
    0.5,
    0.8,
    5,
  );
  above(
    Math.max(harmonics[1], harmonics[2], harmonics[3]),
    -8,
    "strongest of H2..H4 (dB re H1)",
  );
  // every note starts a little flat and is in tune within a tenth of a second
  for (const seed of [1, 2, 3]) {
    const scooped = note("brass", 60, 0.9, 1, undefined, seed);
    below(
      pitchTrack(scooped, 60, 0.004, 0.034, 0.03)[0],
      -5,
      `onset pitch, seed ${seed} (cents)`,
    );
    near(
      centsError(scooped, 60, 0.1, 0.3),
      0,
      6,
      `pitch after the scoop, seed ${seed}`,
    );
  }
  const correlation = stereoCorrelation(held);
  assert.ok(
    correlation > 0.5 && correlation < 0.95,
    `correlation ${correlation}`,
  );
});

test("pad and airpad: slow, wide, and two different colours", () => {
  const warm = note("pad", 60, 0.8, 4);
  const airy = note("airpad", 60, 0.8, 4);
  above(riseMs(warm), 80, "pad rise (ms)");
  above(riseMs(airy), 150, "airpad rise (ms)");
  above(
    riseMs(note("airpad", 60, 0.3, 4)),
    riseMs(note("airpad", 60, 1, 4)) + 40,
    "airpad: softer = slower",
  );
  for (const [name, r] of [
    ["pad", warm],
    ["airpad", airy],
  ] as const) {
    const correlation = stereoCorrelation(r);
    assert.ok(
      correlation > 0.35 && correlation < 0.9,
      `${name} correlation ${correlation}`,
    );
    // mono sum loses little: no phase tricks
    below(sideDb(r), -3, `${name} side / mid (dB)`);
  }
  below(centroidHz(warm, 1, 2), 500, "pad centroid at C4 (Hz)");
  above(
    centroidHz(airy, 1, 2) / centroidHz(warm, 1, 2),
    1.6,
    "airpad / pad brightness",
  );
  // long releases
  above(rmsDb(warm, 4.4, 4.6), -50, "pad level 500 ms after note-off");
  above(rmsDb(airy, 4.4, 4.6), -45, "airpad level 500 ms after note-off");
  // the pad starts from the same phase pattern on every note: level and width do not depend on luck
  const levels: number[] = [];
  for (let seed = 1; seed <= 8; seed++) {
    const r = note("pad", 55, 0.8, 1, undefined, seed);
    levels.push(loudestWindowDb(r));
    above(
      stereoCorrelation(note("pad", 43, 0.8, 0.3, undefined, seed)),
      0.3,
      `short low pad note, seed ${seed}`,
    );
  }
  below(span(levels), 1.5, "pad level spread over 8 seeds (dB)");
  assert.notDeepEqual(
    note("pad", 55, 0.8, 0.3, undefined, 1).left,
    note("pad", 55, 0.8, 0.3, undefined, 2).left,
    "different seeds still give different audio",
  );
  // airpad: air between the partials (the pad has none) ...
  const f0 = midiToHz(84);
  above(
    bandEnergiesDb(note("airpad", 84, 0.6, 3), [3.2 * f0, 3.8 * f0], 1, 2)[0],
    -30,
    "airpad noise between partials",
  );
  below(
    bandEnergiesDb(note("pad", 84, 0.6, 3), [3.2 * f0, 3.8 * f0], 1, 2)[0],
    -60,
    "pad noise between partials",
  );
  // ... glassy upper partials (octaves ring: the 4th stands out over the 5th) ...
  const early = harmonicsDb(airy, midiToHz(60), 1, 1, 8);
  above(early[3] - early[4], 3, "4th partial above the 5th (dB)");
  // ... and the colour keeps moving while the note is held
  const late = harmonicsDb(airy, midiToHz(60), 3, 1, 8);
  above(
    Math.max(
      ...early.slice(1).map((level, k) => Math.abs(level - late[k + 1])),
    ),
    2,
    "largest change of a partial between 1-2 s and 3-4 s (dB)",
  );
});

test("choir: a slow 'aah' with formants near 700, 1100 and 2600 Hz", () => {
  above(riseMs(note("choir", 57, 0.8, 2)), 50, "rise (ms)");
  above(
    riseMs(note("choir", 57, 0.3, 2)),
    riseMs(note("choir", 57, 1, 2)) + 20,
    "softer = slower",
  );
  for (const midi of [45, 52, 57]) {
    const b = bandEnergiesDb(
      note("choir", midi, 0.8, 2.5),
      [0, 250, 450, 900, 1300, 1900, 2300, 3100, 5000, 24000],
      0.6,
      1.5,
    );
    above(
      b[2] - b[1],
      2,
      `midi ${midi}: first formant (450-900 Hz) over 250-450 Hz`,
    );
    above(
      b[3] - b[4],
      4,
      `midi ${midi}: second formant (900-1300 Hz) over 1300-1900 Hz`,
    );
    above(
      b[6] - b[5],
      3,
      `midi ${midi}: third formant (2300-3100 Hz) over 1900-2300 Hz`,
    );
    below(b[8], -30, `midi ${midi}: share above 5 kHz`);
  }
  // sung louder = brighter source
  above(
    bandEnergiesDb(note("choir", 52, 1, 2), [1900, 24000], 0.6, 1)[0] -
      bandEnergiesDb(note("choir", 52, 0.3, 2), [1900, 24000], 0.6, 1)[0],
    3,
    "energy above 1.9 kHz, loud minus soft (dB)",
  );
  // breath between the harmonics, and voices that move
  const held = note("choir", 69, 0.8, 2.5);
  above(
    betweenHarmonicsDb(held, midiToHz(69), 0.8, 1.5),
    -50,
    "aspiration between harmonics",
  );
  above(
    deviation(pitchTrack(held, 69, 1.2, 2.4)),
    1.5,
    "pitch movement after a second",
  );
  const correlation = stereoCorrelation(held);
  assert.ok(
    correlation > 0.45 && correlation < 0.95,
    `correlation ${correlation}`,
  );
  above(
    rmsDb(note("choir", 57, 0.8, 1), 1.08, 1.12),
    -40,
    "release still sounding after 100 ms",
  );
});

test("flute: sine-dominant, weak even harmonics, breath at the attack, late 5 Hz vibrato", () => {
  for (const midi of [67, 74]) {
    const r = note("flute", midi, 0.8, 2.5);
    const h = harmonicsDb(r, midiToHz(midi), 0.6, 1, 6);
    for (let k = 1; k < h.length; k++)
      below(h[k], -12, `midi ${midi}: harmonic ${k + 1} (dB re fundamental)`);
    below(h[1], h[2] + 2, `midi ${midi}: 2nd harmonic vs 3rd`);
    below(h[3], h[2] - 5, `midi ${midi}: 4th harmonic vs 3rd`);
    below(h[3], h[4] + 1, `midi ${midi}: 4th harmonic vs 5th`);
    // vibrato: none while the note speaks, about 5 Hz and gentle once it has settled
    below(
      deviation(pitchTrack(r, midi, 0.04, 0.14)),
      1.5,
      `midi ${midi}: early pitch movement`,
    );
    const late = pitchTrack(r, midi, 1.2, 2.4);
    assert.ok(
      span(late) > 8 && span(late) < 30,
      `midi ${midi}: vibrato width ${span(late)} cents`,
    );
    const rate = wobbleHz(late);
    assert.ok(rate > 4.2 && rate < 6, `midi ${midi}: vibrato rate ${rate} Hz`);
    above(stereoCorrelation(r), 0.95, `midi ${midi}: a point source`);
  }
  // purer the higher it plays
  above(
    harmonicsDb(note("flute", 62, 0.8, 1.5), midiToHz(62), 0.5, 0.8, 3)[2] -
      harmonicsDb(note("flute", 86, 0.8, 1.5), midiToHz(86), 0.5, 0.8, 3)[2],
    6,
    "3rd harmonic, D4 minus D6 (dB)",
  );
  // breath: strongest at the attack, still there while held, different left and right
  const breathy = note("flute", 84, 0.6, 1.5);
  const attack = betweenHarmonicsDb(breathy, midiToHz(84), 0, 0.06);
  const sustain = betweenHarmonicsDb(breathy, midiToHz(84), 0.5, 0.8);
  above(attack - sustain, 6, "breath share, attack minus sustain (dB)");
  above(sustain, -45, "breath share while held");
  above(sideDb(breathy), -45, "the breath is not mono");
  // soft attack, quick enough for a melody
  const rise = riseMs(note("flute", 72, 0.8, 2), 0.9);
  assert.ok(rise > 15 && rise < 80, `attack ${rise} ms`);
  // NoteEvent.bend slides into the note
  const slid = note("flute", 76, 0.8, 1, -2);
  below(
    pitchTrack(slid, 76, 0.005, 0.035, 0.03)[0],
    -80,
    "slide start (cents)",
  );
  near(centsError(slid, 76, 0.3, 0.5), 0, 3, "slide lands");
});

test("dizi: brighter and buzzier than the flute, more breath, quicker ornaments", () => {
  for (const midi of [67, 74, 81]) {
    const reed = note("dizi", midi, 0.8, 2.5);
    const pipe = note("flute", midi, 0.8, 2.5);
    above(
      centroidHz(reed, 0.6, 1) / centroidHz(pipe, 0.6, 1),
      1.8,
      `midi ${midi}: brightness dizi / flute`,
    );
    // the membrane: a band of harmonics around 3.6 kHz the flute does not have
    above(
      bandEnergiesDb(reed, [2500, 5500], 0.6, 1)[0] -
        bandEnergiesDb(pipe, [2500, 5500], 0.6, 1)[0],
      10,
      `midi ${midi}: 2.5-5.5 kHz, dizi minus flute (dB)`,
    );
    below(
      riseMs(reed) + 5,
      riseMs(pipe),
      `midi ${midi}: tongued attack (dizi rise + 5 ms vs flute)`,
    );
    const reedVibrato = pitchTrack(reed, midi, 1.2, 2.4);
    const pipeVibrato = pitchTrack(pipe, midi, 1.2, 2.4);
    above(
      span(reedVibrato),
      span(pipeVibrato) + 4,
      `midi ${midi}: vibrato width`,
    );
    above(
      wobbleHz(reedVibrato),
      wobbleHz(pipeVibrato),
      `midi ${midi}: vibrato rate`,
    );
  }
  // the buzz grows with blowing pressure
  above(
    bandEnergiesDb(note("dizi", 74, 1, 1.5), [2500, 5500], 0.5, 0.8)[0] -
      bandEnergiesDb(note("dizi", 74, 0.3, 1.5), [2500, 5500], 0.5, 0.8)[0],
    6,
    "2.5-5.5 kHz share, hard minus soft (dB)",
  );
  // more breath than the flute
  above(
    betweenHarmonicsDb(note("dizi", 84, 0.6, 1.5), midiToHz(84), 0.5, 0.8),
    betweenHarmonicsDb(note("flute", 84, 0.6, 1.5), midiToHz(84), 0.5, 0.8) + 1,
    "breath share while held, dizi vs flute",
  );
  // vibrato arrives sooner than on the flute
  const reed = note("dizi", 74, 0.8, 1);
  const pipe = note("flute", 74, 0.8, 1);
  above(
    span(pitchTrack(reed, 74, 0.3, 0.5)),
    span(pitchTrack(pipe, 74, 0.3, 0.5)) + 3,
    "vibrato width at 300-500 ms",
  );
  // NoteEvent.bend is a slide, from above or from below
  for (const bend of [-2, 3]) {
    const slid = note("dizi", 76, 0.8, 1, bend);
    const start = pitchTrack(slid, 76, 0.005, 0.035, 0.03)[0];
    above(
      start * Math.sign(bend),
      80,
      `slide of ${bend}: start (cents towards the bend)`,
    );
    near(centsError(slid, 76, 0.3, 0.5), 0, 3, `slide of ${bend} lands`);
  }
});

test("synth: two oscillators, a filter that snaps, vibrato that arrives late", () => {
  const held = note("synth", 69, 0.9, 2);
  below(riseMs(held), 8, "attack (ms)");
  // filter envelope: the attack carries far more top than the sustain
  above(
    bandEnergiesDb(held, [4000, 24000], 0, 0.06)[0] -
      bandEnergiesDb(held, [4000, 24000], 0.6, 0.6)[0],
    6,
    "energy above 4 kHz, attack minus sustain (dB)",
  );
  // saw + pulse: all harmonics present, odd ones stronger than a saw alone would give
  const h = harmonicsDb(note("synth", 57, 0.9, 1.5), midiToHz(57), 0.6, 0.8, 4);
  above(h[1], -16, "2nd harmonic (dB re fundamental)");
  above(h[2], -14, "3rd harmonic (dB re fundamental)");
  // steady pitch at first, vibrato after about half a second
  below(
    Math.max(...pitchTrack(held, 69, 0.01, 0.1).map(Math.abs)),
    4,
    "pitch in the first 100 ms (cents)",
  );
  above(
    span(pitchTrack(held, 69, 1, 1.9)),
    10,
    "pitch movement after a second (cents)",
  );
  // the two oscillators sit a little left and right
  const correlation = stereoCorrelation(held);
  assert.ok(
    correlation > 0.75 && correlation < 0.98,
    `correlation ${correlation}`,
  );
  // cuts through without piercing
  for (const midi of [81, 93]) {
    const loud = note("synth", midi, 1, 1);
    below(
      bandEnergiesDb(loud, [8000, 24000])[0],
      -25,
      `midi ${midi}: share above 8 kHz at vel 1`,
    );
    above(
      bandEnergiesDb(loud, [1000, 6000])[0],
      -8,
      `midi ${midi}: 1-6 kHz share at vel 1`,
    );
  }
  // every note starts with the full sound: the level does not depend on the seed
  const levels: number[] = [];
  for (let seed = 1; seed <= 8; seed++)
    levels.push(
      loudestWindowDb(note("synth", 60, 0.8, 0.25, undefined, seed), 0.2),
    );
  below(span(levels), 1.5, "level spread of short notes over 8 seeds (dB)");
  // NoteEvent.bend glides in
  above(
    pitchTrack(note("synth", 69, 0.8, 1, 3), 69, 0.003, 0.023, 0.02)[0],
    150,
    "glide start (cents)",
  );
  near(
    centsError(note("synth", 69, 0.8, 1, 3), 69, 0.3, 0.5),
    0,
    8,
    "glide lands",
  );
});

test("chip and chipPulse: console pulse channels, the pulse thinner than the square", () => {
  for (const vel of [0.4, 1]) {
    const square = note("chip", 60, vel, 1.5);
    const h = harmonicsDb(square, midiToHz(60), 0.3, 0.6, 8);
    // a 50 % square and nothing else: odd harmonics at 1/k, no even ones
    near(h[2], -9.54, 0.7, `chip vel ${vel}: 3rd harmonic`);
    near(h[4], -13.98, 0.7, `chip vel ${vel}: 5th harmonic`);
    near(h[6], -16.9, 0.8, `chip vel ${vel}: 7th harmonic`);
    below(Math.max(h[1], h[3], h[5]), -45, `chip vel ${vel}: even harmonics`);
    below(riseMs(square), 6, `chip vel ${vel}: attack (ms)`);
    near(stereoCorrelation(square), 1, 1e-9, "chip is mono");
    // vibrato only once a note is long
    below(
      span(pitchTrack(square, 60, 0.05, 0.25)),
      1,
      `chip vel ${vel}: early pitch movement`,
    );
    const late = span(pitchTrack(square, 60, 0.8, 1.4));
    assert.ok(
      late > 6 && late < 25,
      `chip vel ${vel}: vibrato width ${late} cents`,
    );

    const pulse = note("chipPulse", 60, vel, 1.5);
    const p = harmonicsDb(pulse, midiToHz(60), 0.3, 0.6, 8);
    above(p[1], -6, `chipPulse vel ${vel}: 2nd harmonic`);
    // thinner: less of the energy in the fundamental, more above
    const squareBody = bandEnergiesDb(
      square,
      [0, 1.5 * midiToHz(60)],
      0.3,
      0.6,
    )[0];
    const pulseBody = bandEnergiesDb(
      pulse,
      [0, 1.5 * midiToHz(60)],
      0.3,
      0.6,
    )[0];
    below(
      pulseBody,
      squareBody - 1.5,
      `vel ${vel}: fundamental share, pulse vs square`,
    );
    above(
      centroidHz(pulse, 0.3, 0.6) / centroidHz(square, 0.3, 0.6),
      1.15,
      `vel ${vel}: brightness pulse / square`,
    );
    below(riseMs(pulse), 6, `chipPulse vel ${vel}: attack (ms)`);
    near(stereoCorrelation(pulse), 1, 1e-9, "chipPulse is mono");
  }
  // chipPulse: 25 % duty when soft (every 4th harmonic missing), 12.5 % when hard (every 8th)
  const soft = harmonicsDb(
    note("chipPulse", 60, 0.3, 1),
    midiToHz(60),
    0.3,
    0.6,
    8,
  );
  below(soft[3], -30, "25 % duty: 4th harmonic");
  const hard = harmonicsDb(
    note("chipPulse", 60, 1, 1),
    midiToHz(60),
    0.3,
    0.6,
    8,
  );
  above(hard[3], -10, "12.5 % duty: 4th harmonic");
  below(hard[7], -30, "12.5 % duty: 8th harmonic");
  // chip accents: a hard note opens on a narrower duty (even harmonics for two frames), a soft one does not
  above(
    harmonicsDb(note("chip", 60, 1, 0.5), midiToHz(60), 0.003, 0.028, 2)[1],
    -12,
    "opening duty of a hard note: 2nd harmonic",
  );
  below(
    harmonicsDb(note("chip", 60, 0.4, 0.5), midiToHz(60), 0.003, 0.028, 2)[1],
    -30,
    "opening of a soft note: 2nd harmonic",
  );
  // ... and an accent decays to the sustain level within a few frames (chipPulse shows it plainly)
  const accented = note("chipPulse", 60, 1, 1);
  above(
    rmsDb(accented, 0.005, 0.03) - rmsDb(accented, 0.5, 1),
    1,
    "accent above the sustain level (dB)",
  );
  near(
    rmsDb(note("chipPulse", 60, 0.3, 1), 0.005, 0.03) -
      rmsDb(note("chipPulse", 60, 0.3, 1), 0.5, 1),
    0,
    0.3,
    "no accent on a soft note",
  );
  // bends move on the 60 Hz frame grid: the pitch holds still inside a frame
  const bent = note("chip", 72, 0.8, 0.5, -4);
  const cycles = firstCycles(bent, 12);
  near(
    cycles[4],
    cycles[1],
    cycles[1] * 0.002,
    "pitch inside the first frame (Hz)",
  );
  above(cycles[cycles.length - 1], cycles[1] * 1.02, "pitch one frame later");
  near(centsError(bent, 72, 0.2, 0.25), 0, 2, "bend lands");
});

/* ---------------------------------------------------------- bass identity */

test("bass voices: mono, no DC, a strong fundamental and harmonics a small speaker can play", () => {
  for (const id of BASSES)
    for (const midi of [28, 33, 40]) {
      const what = `${id} midi ${midi}`;
      const r = note(id, midi, 0.8, 1.5);
      above(stereoCorrelation(r), 0.999, `${what}: L/R correlation`);
      below(sideDb(r), -80, `${what}: side / mid (dB)`);
      below(dcOffset(r), 2e-3, `${what}: DC`);
      const f0 = midiToHz(midi);
      const h = harmonicsDb(r, f0, 0.02, 0.5, 6);
      below(
        Math.max(...h.slice(1)),
        0,
        `${what}: strongest overtone (dB re fundamental)`,
      );
      const shares = bandEnergiesDb(
        r,
        [0, 1.5 * f0, 3.5 * f0, 24000],
        0.02,
        0.5,
      );
      above(shares[0], -4.5, `${what}: share of the fundamental`);
      above(shares[1], -22, `${what}: share of the 2nd + 3rd harmonic`);
      above(
        bandEnergiesDb(r, [100, 24000], 0.02, 0.5)[0],
        -21,
        `${what}: share above 100 Hz`,
      );
      below(
        bandEnergiesDb(r, [4000, 24000], 0.02, 0.5)[0],
        -30,
        `${what}: share above 4 kHz`,
      );
      below(
        20 * Math.log10(peak(r)) - loudestWindowDb(r),
        12,
        `${what}: crest factor (dB)`,
      );
    }
});

test("fingerBass: a plucked string that sustains, is stopped by the finger and clicks a little", () => {
  const held = note("fingerBass", 33, 0.8, 2);
  const fall = rmsDb(held, 0.05, 0.25) - rmsDb(held, 1.6, 2);
  assert.ok(fall > 3 && fall < 14, `decay over 1.6 s: ${fall} dB`);
  below(riseMs(held), 12, "attack (ms)");
  // upper partials go first
  below(
    centroidHz(held, 1.2, 0.6),
    centroidHz(held, 0.02, 0.2) * 0.95,
    "centroid after 1.2 s vs at the pluck",
  );
  // eighth notes: the finger stops the string
  const short = note("fingerBass", 33, 0.8, 0.2);
  below(
    rmsDb(short, 0.26, 0.28),
    rmsDb(short, 0.05, 0.2) - 30,
    "60 ms after note-off",
  );
  // finger noise: a burst above 1 kHz in the first milliseconds, more of it when plucked hard
  const hard = note("fingerBass", 40, 1, 1);
  above(
    bandEnergiesDb(hard, [1000, 6000], 0, 0.02)[0] -
      bandEnergiesDb(hard, [1000, 6000], 0.4, 0.4)[0],
    6,
    "energy above 1 kHz, first 20 ms minus sustain (dB)",
  );
  above(
    rmsDb(hard, 0, 0.02) + bandEnergiesDb(hard, [1000, 6000], 0, 0.02)[0],
    rmsDb(note("fingerBass", 40, 0.3, 1), 0, 0.02) +
      bandEnergiesDb(note("fingerBass", 40, 0.3, 1), [1000, 6000], 0, 0.02)[0] +
      12,
    "finger noise level, hard vs soft",
  );
  // every pluck lands on a slightly different spot of the string: the tone
  // differs, the level of an eighth-note line does not
  const levels: number[] = [];
  const colours: number[] = [];
  for (let seed = 1; seed <= 8; seed++) {
    const r = note("fingerBass", 40, 0.8, 0.25, undefined, seed);
    levels.push(loudestWindowDb(r, 0.2));
    colours.push(harmonicsDb(r, midiToHz(40), 0.02, 0.2, 3)[2]);
  }
  below(span(levels), 1, "level spread over 8 plucks (dB)");
  above(span(colours), 0.5, "spread of the 3rd harmonic over 8 plucks (dB)");
  // slides
  const slid = note("fingerBass", 45, 0.8, 1, -2);
  below(pitchTrack(slid, 45, 0.005, 0.045)[0], -60, "slide start (cents)");
  near(centsError(slid, 45, 0.3, 0.5), 0, 3, "slide lands");
});

test("uprightBass: woody pizzicato whose overtones die before its fundamental", () => {
  const held = note("uprightBass", 33, 0.8, 2);
  const finger = note("fingerBass", 33, 0.8, 2);
  const fall = rmsDb(held, 0.05, 0.25) - rmsDb(held, 1.6, 2);
  assert.ok(fall > 10 && fall < 30, `decay over 1.6 s: ${fall} dB`);
  above(
    fall,
    rmsDb(finger, 0.05, 0.25) - rmsDb(finger, 1.6, 2) + 5,
    "decays faster than the electric bass",
  );
  // long-ish fundamental: a second later it is still there
  above(rmsDb(held, 0.9, 1.1), -32, "level after one second");
  // fast-decaying upper partials
  const early = harmonicsDb(held, midiToHz(33), 0.02, 0.25, 4);
  const late = harmonicsDb(held, midiToHz(33), 0.8, 0.5, 4);
  above(
    early[1] - late[1],
    1,
    "2nd harmonic re fundamental, early minus late (dB)",
  );
  above(
    early[3] - late[3],
    4,
    "4th harmonic re fundamental, early minus late (dB)",
  );
  below(
    centroidHz(held, 0.4, 0.4),
    centroidHz(held, 0, 0.05) * 0.85,
    "centroid after 400 ms vs at the pluck",
  );
  // darker than the electric bass
  below(
    bandEnergiesDb(held, [300, 24000], 0.02, 0.5)[0],
    bandEnergiesDb(finger, [300, 24000], 0.02, 0.5)[0] - 2,
    "share above 300 Hz, upright vs finger",
  );
  // woody attack: the body knocks in the first 25 ms
  const hard = note("uprightBass", 45, 1, 1);
  above(
    bandEnergiesDb(hard, [350, 1300], 0, 0.025)[0] -
      bandEnergiesDb(hard, [350, 1300], 0.3, 0.3)[0],
    6,
    "350-1300 Hz, first 25 ms minus sustain (dB)",
  );
  // slight pitch settle: a hard pluck starts sharp and is in tune after 300 ms
  const start = pitchTrack(hard, 45, 0.01, 0.06, 0.05)[0];
  assert.ok(start > 3 && start < 30, `pitch at the pluck: +${start} cents`);
  below(pitchTrack(hard, 45, 0.06, 0.11, 0.05)[0], start, "pitch 50 ms later");
  near(centsError(hard, 45, 0.3, 0.5), 0, 1, "settled pitch");
  below(
    pitchTrack(note("uprightBass", 45, 0.3, 1), 45, 0.01, 0.06, 0.05)[0],
    start - 2,
    "a soft pluck is less sharp",
  );
  // stopped by the hand, a little later than an electric bass
  const short = note("uprightBass", 33, 0.8, 0.2);
  below(
    rmsDb(short, 0.35, 0.37),
    rmsDb(short, 0.05, 0.2) - 40,
    "150 ms after note-off",
  );
});

test("synthBass: the same solid attack on every note, a filter that snaps shut", () => {
  // oscillators restart in phase: identical audio whatever the random stream
  const a = note("synthBass", 40, 0.9, 0.5, undefined, 1);
  const b = note("synthBass", 40, 0.9, 0.5, undefined, 9);
  assert.deepEqual(a.left, b.left);
  // snappy filter envelope
  above(
    centroidHz(a, 0, 0.03) / centroidHz(a, 0.25, 0.2),
    1.25,
    "centroid attack / sustain",
  );
  above(
    bandEnergiesDb(a, [1000, 24000], 0, 0.03)[0] -
      bandEnergiesDb(a, [1000, 24000], 0.25, 0.2)[0],
    6,
    "energy above 1 kHz, first 30 ms minus sustain (dB)",
  );
  // saw + square: every harmonic present, odd ones stronger
  const h = harmonicsDb(a, midiToHz(40), 0.15, 0.3, 5);
  above(h[1], -16, "2nd harmonic");
  above(h[2], h[1], "3rd harmonic vs 2nd");
  // velocity opens the filter
  above(
    bandEnergiesDb(note("synthBass", 40, 1, 0.5), [300, 24000], 0.1, 0.3)[0] -
      bandEnergiesDb(
        note("synthBass", 40, 0.3, 0.5),
        [300, 24000],
        0.1,
        0.3,
      )[0],
    3,
    "share above 300 Hz, hard minus soft (dB)",
  );
  // sixteenth notes at 140 bpm (107 ms): full level, gone 30 ms after note-off
  const sixteenth = note("synthBass", 40, 0.8, 0.107);
  above(loudestWindowDb(sixteenth, 0.1), -19.5, "level of a sixteenth note");
  below(rmsDb(sixteenth, 0.137, 0.15), -55, "30 ms after note-off");
  below(riseMs(note("synthBass", 40, 0.8, 1)), 6, "attack (ms)");
});

test("chipBass: the 4-bit triangle of a console", () => {
  const hard = note("chipBass", 45, 1, 1);
  const h = harmonicsDb(hard, midiToHz(45), 0.2, 0.6, 34);
  // a triangle: odd harmonics at 1/k², no even ones
  near(h[2], -19.08, 1.5, "3rd harmonic");
  near(h[4], -27.96, 2, "5th harmonic");
  below(Math.max(h[1], h[3]), -45, "even harmonics");
  // 32 steps per cycle: images of the fundamental at 31x and 33x, nothing at 32x
  above(Math.min(h[30], h[32]), -36, "step harmonics 31 and 33");
  below(h[31], -60, "harmonic 32");
  // soft notes are rounder
  const soft = harmonicsDb(
    note("chipBass", 45, 0.3, 1),
    midiToHz(45),
    0.2,
    0.6,
    34,
  );
  below(soft[30], h[30] - 4, "step harmonic of a soft note");
  // instant attack, flat level, clean stop
  below(riseMs(hard), 6, "attack (ms)");
  near(
    rmsDb(hard, 0.05, 0.25) - rmsDb(hard, 0.75, 0.95),
    0,
    0.3,
    "level is flat",
  );
  below(rmsDb(hard, 1.012, 1.014), -60, "12 ms after note-off");
  // above the range where a step is two samples long it falls back to a smooth triangle
  const high = harmonicsDb(
    note("chipBass", 84, 0.8, 0.5),
    midiToHz(84),
    0.1,
    0.3,
    5,
  );
  near(high[2], -19.08, 1.5, "3rd harmonic of a high note");
});

test("bass808: a pitch drop into a long driven sub", () => {
  const hit = note("bass808", 45, 0.9, 1);
  const cycles = firstCycles(hit, 9);
  // downward sweep inside the first 60 ms
  above(cycles[0], midiToHz(45) * 1.25, "frequency of the first cycle (Hz)");
  for (let i = 1; i < 6; i++)
    assert.ok(
      cycles[i] < cycles[i - 1],
      `cycle ${i + 1} (${cycles[i]} Hz) is lower than the one before`,
    );
  let elapsed = 0;
  let index = 0;
  while (elapsed < 0.06 && index < cycles.length)
    elapsed += 1 / cycles[index++];
  near(
    cycles[index - 1],
    midiToHz(45),
    midiToHz(45) * 0.03,
    "frequency at 60 ms (Hz)",
  );
  near(centsError(hit, 45, 0.1, 0.3), 0, 2, "pitch after the drop");
  // harder = a deeper drop and more drive
  above(
    firstCycles(note("bass808", 45, 1, 0.5), 2)[0],
    firstCycles(note("bass808", 45, 0.3, 0.5), 2)[0] * 1.1,
    "first cycle, hard vs soft",
  );
  above(
    centroidHz(note("bass808", 33, 1, 1), 0.2, 0.6) /
      centroidHz(note("bass808", 33, 0.3, 1), 0.2, 0.6),
    1.05,
    "brightness hard / soft",
  );
  // drive: 2nd and 3rd harmonic for small speakers
  const h = harmonicsDb(note("bass808", 33, 0.8, 1), midiToHz(33), 0.2, 0.6, 3);
  above(h[1], -22, "2nd harmonic");
  above(h[2], -18, "3rd harmonic");
  // sustains while held (sagging only a little) ...
  const held = note("bass808", 33, 0.8, 4);
  near(
    rmsDb(held, 0.1, 0.4) - rmsDb(held, 3.5, 4),
    2,
    2,
    "sag over four seconds (dB)",
  );
  // ... then lets go smoothly: still audible after 60 ms, gone when the tail ends
  const short = note("bass808", 33, 0.8, 0.2);
  above(rmsDb(short, 0.26, 0.28), -45, "60 ms after note-off");
  below(
    rmsDb(short, 0.26, 0.28),
    rmsDb(short, 0.05, 0.2) - 6,
    "60 ms after note-off vs held",
  );
  below(tailDb(short), -60, "end of the tail");
  // NoteEvent.bend is the glide from the previous note
  const glide = note("bass808", 57, 0.8, 1, -5);
  below(
    pitchTrack(glide, 57, 0.03, 0.06, 0.03)[0],
    -60,
    "glide at 30-60 ms (cents)",
  );
  near(centsError(glide, 57, 0.3, 0.5), 0, 2, "glide lands");
});

/* ------------------------------------------------------------- robustness */

test("staccato and ten-second notes, whispers and full velocity stay clean", () => {
  for (const id of ALL) {
    const [low, high] = CONTRACTS[id].range ?? [36, 96];
    for (const midi of [low, Math.round((low + high) / 2), high])
      for (const [vel, duration] of [
        [0.05, 0.04],
        [1, 0.04],
        [0.05, 10],
        [1, 10],
      ] as const) {
        const what = `${id} midi ${midi} vel ${vel} ${duration}s`;
        const r = note(id, midi, vel, duration);
        assert.ok(r.guardIntact, `${what}: wrote beyond frames`);
        assert.ok(isFiniteAudio(r), `${what}: not finite`);
        below(peak(r), 1, `${what}: peak`);
        const clicks = checkClicks(r, CONTRACTS[id].clicks);
        assert.ok(clicks.ok, `${what}: ${clicks.problems.join("; ")}`);
        // (a 40 ms note is a cycle or two of a bass: its mean says nothing;
        // and a 40 ms note of a slow pad is allowed to be next to nothing)
        if (duration > 1) below(dcOffset(r), 0.01, `${what}: DC`);
        if (vel === 1 && duration > 1) above(peak(r), 0.1, `${what}: audible`);
      }
  }
});

test("any buffer length and out-of-range notes are survived", () => {
  const notes = [
    { midi: 60, vel: 0.8, duration: 1 },
    { midi: 60, vel: 0, duration: 0 },
    { midi: 12, vel: 1.5, duration: 0.01 },
    { midi: 127, vel: 1, duration: 0.5, bend: 12 },
    { midi: -5, vel: 0.5, duration: 0.2, bend: -7 },
    { midi: 69.5, vel: 1, duration: 3, bend: 24 },
  ];
  for (const id of ALL)
    for (const sampleRate of [SAMPLE_RATE, 44100, 96000])
      for (const frames of [1, 2, 7, 64, 300, 2000])
        for (const n of notes) {
          const what = `${id} ${frames} frames @${sampleRate} ${JSON.stringify(n)}`;
          const left = new Float32Array(frames + 8);
          const right = new Float32Array(frames + 8);
          VOICES[id].render(left, right, frames, n, {
            sampleRate,
            random: createRng(3),
          });
          let top = 0;
          for (let i = 0; i < frames + 8; i++) {
            assert.ok(
              Number.isFinite(left[i]) && Number.isFinite(right[i]),
              `${what}: not finite`,
            );
            if (i >= frames)
              assert.ok(
                left[i] === 0 && right[i] === 0,
                `${what}: wrote beyond frames`,
              );
            top = Math.max(top, Math.abs(left[i]), Math.abs(right[i]));
          }
          assert.ok(top <= 1, `${what}: peak ${top}`);
          assert.ok(Math.abs(left[0]) <= 0.01, `${what}: starts at ${left[0]}`);
          assert.ok(
            Math.abs(left[frames - 1]) <= 0.003,
            `${what}: ends at ${left[frames - 1]}`,
          );
          const tail = VOICES[id].tail(n);
          assert.ok(
            Number.isFinite(tail) && tail >= 0 && tail <= 8,
            `${id}: tail ${tail}`,
          );
        }
});

test("random notes around every range render clean", () => {
  for (const id of ALL) {
    const random = createRng(id.length * 7919 + 13);
    const [low, high] = CONTRACTS[id].range ?? [36, 96];
    for (let n = 0; n < 60; n++) {
      const midi = low - 12 + random() * (high - low + 24);
      const vel = random() < 0.15 ? 1 : 0.02 + 0.98 * random();
      const duration =
        random() < 0.3 ? 0.02 + 0.1 * random() : 0.05 + 4 * random() * random();
      const bend =
        random() < 0.35
          ? Math.round((random() * 2 - 1) * 7) || undefined
          : undefined;
      const sampleRate = random() < 0.25 ? 44100 : SAMPLE_RATE;
      const seed = 1 + Math.floor(random() * 1e6);
      const what = `${id} midi ${midi.toFixed(2)} vel ${vel.toFixed(2)} ${duration.toFixed(3)}s bend ${bend} @${sampleRate} seed ${seed}`;
      const r = renderNote(
        VOICES[id],
        { midi, vel, duration, bend },
        sampleRate,
        seed,
      );
      assert.ok(r.guardIntact, `${what}: wrote beyond frames`);
      assert.ok(isFiniteAudio(r), `${what}: not finite`);
      assert.ok(peak(r) <= 1, `${what}: peak ${peak(r)}`);
      const inRange = midi >= low && midi <= high;
      const clicks = checkClicks(r, CONTRACTS[id].clicks);
      // inside the range a note must be click-free in every respect; an
      // octave outside it must still start and end at zero
      for (const problem of clicks.problems)
        assert.ok(
          !inRange && !/starts at|ends at/.test(problem),
          `${what}: ${problem}`,
        );
      if (inRange && duration >= 0.25) {
        below(dcOffset(r), 0.01, `${what}: DC`);
        assert.ok(
          stereoCorrelation(r) >= (CONTRACTS[id].minCorrelation ?? 0),
          `${what}: correlation ${stereoCorrelation(r)}`,
        );
      }
    }
  }
});

test("ensembles do not depend on the luck of the seed", () => {
  for (const id of [
    "strings",
    "pad",
    "airpad",
    "brass",
    "choir",
    "synth",
  ] as VoiceId[]) {
    const [low, high] = CONTRACTS[id].range ?? [36, 96];
    let lowest = 1;
    for (let midi = low; midi <= high; midi += 12)
      for (let seed = 11; seed <= 16; seed++) {
        const what = `${id} midi ${midi} seed ${seed}`;
        const short = note(id, midi, 0.8, 0.25, undefined, seed);
        const long = note(id, midi, 0.8, 1, undefined, seed);
        lowest = Math.min(
          lowest,
          stereoCorrelation(short),
          stereoCorrelation(long),
        );
        above(
          stereoCorrelation(short),
          0.3,
          `${what}: correlation of a 250 ms note`,
        );
        above(
          stereoCorrelation(long),
          0.3,
          `${what}: correlation of a 1 s note`,
        );
        near(loudestWindowDb(long), -18, 2.5, `${what}: level`);
        below(Math.abs(centsError(long, midi)), 10, `${what}: tuning`);
        below(
          peak(note(id, midi, 1, 1, undefined, seed)),
          0.95,
          `${what}: peak at vel 1`,
        );
      }
    assert.ok(
      lowest < 0.97,
      `${id} is not mono (lowest correlation ${lowest})`,
    );
  }
});

test("render cost: every voice is at least 60x faster than real time", (t) => {
  const realTime = 1e9 / SAMPLE_RATE;
  for (const id of ALL) {
    const [low, high] = CONTRACTS[id].range ?? [36, 96];
    let worst = 0;
    const parts: string[] = [];
    for (const midi of [low, Math.round((low + high) / 2), high]) {
      const cost = measureCost(VOICES[id], { midi, vel: 0.8, duration: 1 }, 4);
      worst = Math.max(worst, cost);
      parts.push(`${midi}: ${(realTime / cost).toFixed(0)}x`);
    }
    t.diagnostic(`${id.padEnd(11)} ${parts.join("  ")}`);
    below(worst, realTime / 60, `${id}: ns per frame`);
  }
});

/* ------------------------------------------- primitives of extra-sustained */

test("extra-sustained primitives: tables, filters, saw bank, NES triangle, phases", () => {
  const sr = SAMPLE_RATE;
  // ResponseTable reproduces the magnitude of a biquad chain
  const chain = [
    new Biquad().setPeak(700, 4, 12, sr),
    new Biquad().setHighShelf(3000, -6, sr),
    new Biquad().setHighpass(60, 0.7, sr),
  ];
  const table = new ResponseTable(chain, sr);
  for (const hz of [20, 61, 333, 700, 731, 1500, 2999, 8000, 20000]) {
    const exact = chain.reduce(
      (gain, filter) => gain * filter.magnitude(hz, sr),
      1,
    );
    near(
      20 * Math.log10(table.gain(hz) / exact),
      0,
      0.15,
      `table gain at ${hz} Hz (dB)`,
    );
  }
  // SvfRange is the toolbox SVF, range by range
  const reference = new Svf(1200, 2.5, sr);
  const ranged = new SvfRange();
  ranged.set(1200, 2.5, sr);
  const noise = new WhiteNoise(5);
  const a = new Float32Array(512);
  noise.fill(a, 512);
  const b = Float32Array.from(a);
  const c = Float32Array.from(a);
  reference.process(a, 512);
  ranged.low(b, 0, 200);
  ranged.low(b, 200, 512);
  for (let i = 0; i < 512; i++)
    near(b[i], a[i], 1e-6, `SvfRange.low sample ${i}`);
  const band = new SvfRange();
  band.copy(ranged);
  band.band(c, 0, 512);
  const check = new Svf(1200, 2.5, sr);
  const d = new Float32Array(512);
  new WhiteNoise(5).fill(d, 512);
  for (let i = 0; i < 512; i++)
    near(c[i], check.band(d[i]) / 2.5, 1e-6, `SvfRange.band sample ${i}`);
  // TiltShelf: unity at DC, `gain` at the top, magnitude() tells the truth
  const tilt = new TiltShelf();
  tilt.set(500, 3.4, sr);
  near(tilt.magnitude(1, sr), 1, 0.01, "tilt at 1 Hz");
  near(tilt.magnitude(20000, sr), 3.4, 0.05, "tilt at 20 kHz");
  const sine = Float32Array.from({ length: 9600 }, (_, i) =>
    Math.sin((2 * Math.PI * 500 * i) / sr),
  );
  tilt.process(sine, 9600);
  let power = 0;
  for (let i = 4800; i < 9600; i++) power += sine[i] * sine[i];
  near(
    Math.sqrt(power / 2400),
    tilt.magnitude(500, sr),
    0.02,
    "tilt gain measured at its corner",
  );
  // bandpassNoisePower predicts the level of filtered noise
  for (const [hz, q] of [
    [900, 3],
    [3000, 1.3],
    [6500, 0.9],
  ]) {
    const filter = new SvfRange();
    filter.set(hz, q, sr);
    const buffer = new Float32Array(96000);
    new WhiteNoise(9).fill(buffer, 96000);
    filter.band(buffer, 0, 96000);
    let measured = 0;
    for (let i = 4800; i < 96000; i++) measured += buffer[i] * buffer[i];
    near(
      10 * Math.log10(measured / 91200 / (bandpassNoisePower(hz, q, sr) / 3)),
      0,
      0.5,
      `noise power through a band-pass at ${hz} Hz q ${q} (dB)`,
    );
  }
  // SawBank adds the toolbox saw, block by block
  const bank = new SawBank(2);
  bank.phase[0] = 0.1;
  bank.phase[1] = 0.6;
  bank.inc[0] = 0.01;
  bank.inc[1] = 0.013;
  bank.left[0] = 1;
  bank.right[0] = 0.25;
  bank.left[1] = 0.5;
  bank.right[1] = 1;
  const l = new Float32Array(300).fill(0.5);
  const r = new Float32Array(300);
  bank.render(l, r, 0, 100);
  bank.render(l, r, 100, 300);
  let p0 = 0.1;
  let p1 = 0.6;
  for (let i = 0; i < 300; i++) {
    const s0 = sawBlep(p0, 0.01);
    const s1 = sawBlep(p1, 0.013);
    near(l[i], 0.5 + s0 + 0.5 * s1, 1e-5, `SawBank left ${i}`);
    near(r[i], 0.25 * s0 + s1, 1e-5, `SawBank right ${i}`);
    p0 += 0.01;
    if (p0 >= 1) p0 -= 1;
    p1 += 0.013;
    if (p1 >= 1) p1 -= 1;
  }
  // NES triangle: 16 levels, symmetric, a triangle underneath, band-limited steps
  const levels = new Set<number>();
  let sum = 0;
  for (let i = 0; i < 3200; i++) {
    const v = nesTriangleLevel((i + 0.5) / 3200);
    levels.add(Math.round(v * 7.5 + 7.5));
    sum += v;
  }
  assert.equal(levels.size, 16);
  near(sum, 0, 1e-6, "NES triangle mean");
  near(nesTriangleLevel(0.26), 1, 1e-6, "NES triangle top");
  near(nesTriangleLevel(0.76), -1, 1e-6, "NES triangle bottom");
  const inc = NES_TRIANGLE_MAX_INC / 4;
  let phase = 0;
  let largest = 0;
  let previous = nesTriangle(0, inc);
  for (let i = 0; i < 4000; i++) {
    phase += inc;
    if (phase >= 1) phase -= 1;
    const v = nesTriangle(phase, inc);
    assert.ok(Math.abs(v) <= 1.05, `nesTriangle stays in range (${v})`);
    largest = Math.max(largest, Math.abs(v - previous));
    previous = v;
  }
  // a naive staircase jumps a whole step (2/15) in one sample; the band-limited one never does
  below(largest, 0.8 * (2 / 15), "largest sample-to-sample step");
  // softPluck (bass strings) is makePluck without its noise share, written without the convolution
  for (const options of [
    {
      sampleRate: sr,
      period: sr / 41.2,
      position: 0.37,
      bodyHz: 250,
      hardnessHz: 520,
      noise: 0,
    },
    {
      sampleRate: 44100,
      period: 44100 / 196,
      position: 0.34,
      bodyHz: 700,
      hardnessHz: 1800,
      noise: 0,
    },
  ]) {
    const size = pluckLength(options);
    const fast = new Float32Array(size);
    const slow = new Float32Array(size);
    assert.equal(
      softPluck(fast, options),
      makePluck(slow, options, createRng(1)),
    );
    for (let i = 0; i < size; i++)
      near(fast[i], slow[i], 1e-6, `softPluck sample ${i}`);
    assert.equal(fast[0], 0);
  }
  // seedPhases: the pattern, rotated as a whole, slightly jittered, deterministic
  const pattern = [0, 0.25, 0.6];
  const phases = new Float64Array(3);
  const rotation = seedPhases(phases, pattern, createRng(4), 0.03);
  for (let i = 0; i < 3; i++) {
    let delta = phases[i] - rotation - pattern[i];
    delta -= Math.round(delta);
    assert.ok(
      Math.abs(delta) <= 0.015 + 1e-9,
      `phase ${i} is the pattern plus at most half the jitter`,
    );
    assert.ok(phases[i] >= 0 && phases[i] < 1);
  }
  const again = new Float64Array(3);
  seedPhases(again, pattern, createRng(4), 0.03);
  assert.deepEqual(again, phases);
});
