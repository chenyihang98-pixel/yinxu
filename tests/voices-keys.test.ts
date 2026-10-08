/**
 * Keys and plucked voice groups: the Voice contract for all thirteen voices,
 * and for each one the measurable traits that make it the instrument it is
 * named after (nobody can listen during development, so identity is asserted
 * on spectra, envelopes and pitch).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SAMPLE_RATE } from "../src/music/score";
import type { VoiceId } from "../src/music/score";
import type { Voice, VoiceNote } from "../src/audio/voices/types";
import { KEYS_CONTRACT, KEYS_VOICES } from "../src/audio/voices/group-keys";
import {
  PLUCKED_CONTRACT,
  PLUCKED_VOICES,
} from "../src/audio/voices/group-plucked";
import {
  assertVoiceContract,
  bandEnergiesDb,
  centroidHz,
  centsError,
  checkClicks,
  estimatePitch,
  formatReport,
  isFiniteAudio,
  loudestWindowDb,
  measureCost,
  monoSum,
  peak,
  renderNote,
  rmsDb,
  spectrumOf,
  stereoCorrelation,
  tailIsSilent,
} from "../src/audio/voices/testing";
import type { ContractOptions, Rendered } from "../src/audio/voices/testing";
import {
  LEVEL_WINDOW,
  ModalBank,
  REFERENCE_RMS,
  createRng,
  isAliasVoice,
  midiToHz,
  velocityGain,
} from "../src/audio/dsp";
import {
  LevelTable,
  PEAK_CEILING,
  expMean,
  mixNote,
  struckPower,
  velocityCeiling,
} from "../src/audio/dsp/extra-keys";

const KEYS: VoiceId[] = [
  "piano",
  "epiano",
  "bell",
  "musicbox",
  "marimba",
  "vibes",
  "organ",
];
const PLUCKED: VoiceId[] = [
  "guitar",
  "nylon",
  "guzheng",
  "pluck",
  "pizzicato",
  "overdrive",
];
const ALL: VoiceId[] = [...KEYS, ...PLUCKED];
const BANK = { ...KEYS_VOICES, ...PLUCKED_VOICES } as Record<VoiceId, Voice>;
const CONTRACT = { ...KEYS_CONTRACT, ...PLUCKED_CONTRACT } as Partial<
  Record<VoiceId, ContractOptions>
>;

/* ---------------------------------------------------------------- helpers */

const play = (
  id: VoiceId,
  midi: number,
  vel = 0.8,
  duration = 1,
  bend?: number,
  seed = 1,
): Rendered => renderNote(BANK[id], { midi, vel, duration, bend }, SAMPLE_RATE, seed);

const near = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: got ${actual}, expected ${expected} ±${tolerance}`,
  );
const atLeast = (actual: number, limit: number, what: string) =>
  assert.ok(actual >= limit, `${what}: got ${actual}, want at least ${limit}`);
const atMost = (actual: number, limit: number, what: string) =>
  assert.ok(actual <= limit, `${what}: got ${actual}, want at most ${limit}`);

/** peak / loudest-400 ms RMS in dB */
const crestDb = (r: Rendered) => 20 * Math.log10(peak(r)) - loudestWindowDb(r);

/**
 * Level in dB, relative to the fundamental, of the strongest spectral line
 * within ±tolerance (as a ratio) of `ratio` × f0, over [from, from + seconds).
 */
function partialDb(
  r: Rendered,
  f0: number,
  ratio: number,
  from: number,
  seconds: number,
  tolerance = 0.03,
): number {
  const spectrum = spectrumOf(r, from, seconds);
  const strongest = (low: number, high: number) => {
    let best = 0;
    const last = Math.min(
      spectrum.power.length - 1,
      Math.ceil(high / spectrum.binHz),
    );
    for (let k = Math.max(1, Math.floor(low / spectrum.binHz)); k <= last; k++)
      if (spectrum.power[k] > best) best = spectrum.power[k];
    return best;
  };
  const line = strongest(
    ratio * f0 * (1 - tolerance),
    ratio * f0 * (1 + tolerance),
  );
  const fundamental = strongest(f0 * 0.97, f0 * 1.03);
  return 10 * Math.log10((line + 1e-30) / (fundamental + 1e-30));
}

/** Share (dB re the total) of the energy between two frequencies. */
const bandDb = (r: Rendered, low: number, high: number, from: number, seconds: number) =>
  bandEnergiesDb(r, [low, high], from, seconds)[0];

/** Level of the left channel minus the right one, in dB. */
const balanceDb = (r: Rendered, from: number, to: number) =>
  rmsDb({ ...r, right: r.left }, from, to) - rmsDb({ ...r, left: r.right }, from, to);

/**
 * Strongest 2..10 Hz modulation of the level of `signal` between two times
 * (or the modulation at exactly `at` Hz): its rate in Hz and its depth in dB
 * peak-to-peak. The steady decay of the note (a straight line in dB) is
 * removed first.
 */
function tremolo(
  signal: Float32Array,
  from: number,
  to: number,
  at?: number,
): { hz: number; depthDb: number } {
  const hop = Math.round(0.005 * SAMPLE_RATE);
  const size = hop * 4;
  const levels: number[] = [];
  for (
    let i = Math.round(from * SAMPLE_RATE);
    i + size <= Math.min(signal.length, to * SAMPLE_RATE);
    i += hop
  ) {
    let sum = 0;
    for (let j = i; j < i + size; j++) sum += signal[j] * signal[j];
    levels.push(10 * Math.log10(sum / size + 1e-20));
  }
  const n = levels.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += levels[i];
    sxx += i * i;
    sxy += i * levels[i];
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const offset = (sy - slope * sx) / n;
  let best = { hz: at ?? 0, depthDb: 0 };
  for (let hz = at ?? 2; hz <= (at ?? 10); hz += 0.02) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      // Hann-weighted, so a curved decay does not leak into the result
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      const v = (levels[i] - offset - slope * i) * window;
      const phase = 2 * Math.PI * hz * i * 0.005;
      re += v * Math.cos(phase);
      im += v * Math.sin(phase);
    }
    // a sine of amplitude A through a Hann window sums to A·n/4
    const depthDb = (8 * Math.sqrt(re * re + im * im)) / n;
    if (depthDb > best.depthDb) best = { hz, depthDb };
  }
  return best;
}

/** Pitch in cents (re `midi`) of the first `seconds` after the first two milliseconds. */
function earlyCents(r: Rendered, midi: number, expectedMidi = midi, seconds = 0.03): number {
  const hz = estimatePitch(
    monoSum(r),
    SAMPLE_RATE,
    midiToHz(expectedMidi),
    96,
    Math.round(seconds * SAMPLE_RATE),
  );
  return 1200 * Math.log2(hz / midiToHz(midi));
}

/* ------------------------------------------------------- the bank itself */

test("both groups deliver thirteen real voices, each with its contract", () => {
  assert.deepEqual(Object.keys(KEYS_VOICES).sort(), [...KEYS].sort());
  assert.deepEqual(Object.keys(PLUCKED_VOICES).sort(), [...PLUCKED].sort());
  for (const id of ALL) {
    const voice = BANK[id];
    assert.equal(voice.id, id);
    assert.ok(!isAliasVoice(voice), `${id} is still an alias`);
    assert.ok(CONTRACT[id], `${id} has no contract options`);
  }
  // no two ids share one implementation
  assert.equal(new Set(ALL.map((id) => BANK[id].render)).size, ALL.length);
});

/**
 * How close to -18 dBFS the level-convention pitches (A3, D#4, A4) must
 * read. Marimba and pizzicato ring for less than the level window at A4, so
 * they are peak-limited there (see velocityCeiling) and get the full ±2 dB.
 */
const LEVEL_TOLERANCE: Partial<Record<VoiceId, number>> = {
  marimba: 1.5,
  pizzicato: 1.8,
};
/**
 * Tuning tolerance in cents over the whole range. The music box is detuned
 * on purpose (each tine up to 4.5 cents); the two saws of the pluck beat,
 * which the short-window pitch estimate reads as a few cents either way.
 */
const CENTS_TOLERANCE: Partial<Record<VoiceId, number>> = {
  musicbox: 5.5,
  pluck: 8,
};

for (const id of ALL) {
  test(`${id} honours the voice contract over its whole range`, (t) => {
    const report = assertVoiceContract(BANK[id], CONTRACT[id]);
    t.diagnostic(formatReport(report));
    for (const level of report.levels)
      near(level.levelDb, -18, LEVEL_TOLERANCE[id] ?? 1, `${id} level at midi ${level.midi}`);
    for (const row of report.rows)
      atMost(Math.abs(row.cents), CENTS_TOLERANCE[id] ?? 5, `${id} midi ${row.midi} cents`);
    atMost(report.worstPeak, 0.98, `${id} worst peak`);
    for (const v of report.velocity)
      near(v.levelSpanDb, 11.9, 2.2, `${id} midi ${v.midi}: vel 1 over vel 0.4`);
  });
}

/* --------------------------------------------------------- shared helpers */

test("struckPower predicts the level of a struck mode bank, beating doublets included", () => {
  const hz = [440, 440.7, 1212.6, 2377.8, 3930];
  const amp = [1, 0.3, 0.5, 0.25, 0.1];
  const t60 = [4, 4, 1.2, 0.5, 0.09];
  const gl = [1, 0.6, 1.2, 0.8, 1].map((g) => g);
  const gr = [1, 1.3, 0.7, 1.1, 1].map((g) => g);
  for (const window of [LEVEL_WINDOW, 0.1, 1]) {
    const bank = new ModalBank(hz.length);
    for (let k = 0; k < hz.length; k++) bank.set(k, hz[k], t60[k], amp[k], SAMPLE_RATE);
    bank.strike();
    const frames = Math.round(window * SAMPLE_RATE);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    bank.renderStereo(left, right, 0, frames, gl, gr);
    let sum = 0;
    for (let i = 0; i < frames; i++) sum += left[i] * left[i] + right[i] * right[i];
    const measured = sum / (2 * frames);
    const predicted = struckPower(hz.length, hz, amp, t60, gl, gr, window);
    near(10 * Math.log10(predicted / measured), 0, 0.15, `window ${window} s`);
  }
  // window 0 = power at the strike: partials in phase add as amplitudes
  near(struckPower(2, [100, 100], [1, 1], [1, 1], [1, 1], [1, 1], 0), 2, 1e-9, "unison");
  near(struckPower(2, [100, 900], [1, 1], [1, 1], [1, 1], [1, 1], 0), 1, 1e-9, "apart");
  near(expMean(0, 1), 1, 1e-12, "expMean(0)");
  near(expMean(2, 1), (1 - Math.exp(-2)) / 2, 1e-12, "expMean");
});

test("LevelTable measures lazily, interpolates in dB and never depends on the caller", () => {
  let probes = 0;
  // a "voice" whose unit-gain level is known: a sine of amplitude 2^(midi/12) · (0.5 + vel)
  const table = new LevelTable({
    low: 0,
    high: 24,
    step: 12,
    velocities: [0, 1],
    probe(left, right, frames, midi, vel, sampleRate, random) {
      probes++;
      assert.equal(typeof random(), "number");
      const amplitude = Math.pow(2, midi / 12) * (0.5 + vel);
      for (let i = 0; i < frames; i++) {
        left[i] += amplitude * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
        right[i] += amplitude * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
      }
    },
  });
  assert.equal(probes, 0, "nothing is rendered before the first lookup");
  near(table.rms(12, 1, 48000), (2 * 1.5) / Math.SQRT2, 1e-3, "grid point");
  assert.equal(probes, 1);
  // halfway between two columns the level is the geometric mean (linear in dB)
  near(table.rms(6, 1, 48000), (Math.SQRT2 * 1.5) / Math.SQRT2, 1e-3, "between columns");
  near(table.rms(12, 0.5, 48000), (2 * Math.sqrt(0.5 * 1.5)) / Math.SQRT2, 1e-3, "between rows");
  // outside the grid the nearest column / row is used
  near(table.rms(40, 2, 48000), (4 * 1.5) / Math.SQRT2, 1e-3, "above the grid");
  near(table.rms(-9, -1, 48000), 0.5 / Math.SQRT2, 1e-3, "below the grid");
  const before = probes;
  const again = table.rms(6, 1, 48000);
  assert.equal(probes, before, "cached");
  assert.equal(again, table.rms(6, 1, 48000), "repeatable to the last bit");
  table.rms(12, 1, 44100);
  assert.equal(probes, before + 1, "one table per sample rate");
});

test("mixNote ramps in, fades to zero, adds, and caps the peak by the velocity law", () => {
  const frames = 4800;
  const make = (value: number) => new Float32Array(frames).fill(value);
  const left = make(0.25);
  const right = make(0.25);
  mixNote(left, right, make(1), make(-0.5), frames, 0.1, 48, 96, 1);
  assert.equal(left[0], 0.25);
  near(left[24], 0.25 + 0.05, 1e-6, "half-way up the ramp");
  near(left[2000], 0.35, 1e-6, "adds gain × signal");
  near(right[2000], 0.2, 1e-6, "adds gain × signal (right)");
  assert.equal(left[frames - 1], 0.25);
  assert.ok(left[frames - 40] < 0.35 && left[frames - 40] > 0.25);
  // the ceiling turns the whole note down, it does not clip
  const out = make(0);
  mixNote(out, make(0), make(2), make(1), frames, 1, 0, 1, 0.5);
  near(out[100], 0.5, 1e-6, "limited to the ceiling");
  near(velocityCeiling(1), PEAK_CEILING, 1e-12, "ceiling at full velocity");
  near(velocityCeiling(0.5) / velocityCeiling(1), velocityGain(0.5) / velocityGain(1), 1e-12, "same law as the level");
  assert.ok(velocityCeiling(0.8) > REFERENCE_RMS * 3, "room for a crest factor of 14 dB");
  // one-frame buffers must still end on zero
  const tiny = new Float32Array(1);
  mixNote(tiny, new Float32Array(1), new Float32Array([1]), new Float32Array([1]), 1, 1, 10, 10, 1);
  assert.equal(tiny[0], 0);
});

/* ------------------------------------------------------------------ keys */

test("epiano: a hard key barks and tings, a soft one stays mellow; rings, damps, pans", () => {
  for (const midi of [52, 64, 76]) {
    const f0 = midiToHz(midi);
    const hard = play("epiano", midi, 1, 3);
    const soft = play("epiano", midi, 0.3, 3);
    // bark: the attack of a hard note is much brighter than its sustain
    atLeast(
      centroidHz(hard, 0, 0.08) / centroidHz(hard, 0.6, 0.3),
      1.25,
      `midi ${midi}: bark`,
    );
    atMost(centroidHz(soft, 0, 0.08) / centroidHz(soft, 0.6, 0.3), 1.1, `midi ${midi}: no bark when soft`);
    // 1:1 FM: the octave is strong at the attack but never buries the note
    const octave = partialDb(hard, f0, 2, 0, 0.1);
    assert.ok(octave > -12 && octave < 3, `midi ${midi}: octave at the attack ${octave} dB`);
    atMost(partialDb(soft, f0, 2, 1, 0.3), -14, `midi ${midi}: soft sustain is nearly pure`);
    // tine: the 13th / 15th partial tings at the attack and is gone later
    const ting = Math.max(partialDb(hard, f0, 13, 0, 0.06), partialDb(hard, f0, 15, 0, 0.06));
    assert.ok(ting > -25 && ting < -6, `midi ${midi}: tine ${ting} dB`);
    atMost(Math.max(partialDb(hard, f0, 13, 1.5, 0.2), partialDb(hard, f0, 15, 1.5, 0.2)), -60, `midi ${midi}: tine after 1.5 s`);
    atLeast(ting - Math.max(partialDb(soft, f0, 13, 0, 0.06), partialDb(soft, f0, 15, 0, 0.06)), 3, `midi ${midi}: tine grows with velocity`);
    // it rings while held (seconds, not forever) and the damper stops it
    const fall = rmsDb(hard, 0.1, 0.2) - rmsDb(hard, 2.1, 2.2);
    assert.ok(fall > 6 && fall < 36, `midi ${midi}: falls ${fall} dB in 2 s`);
    const short = play("epiano", midi, 0.8, 0.5);
    atLeast(rmsDb(short, 0.4, 0.5) - rmsDb(short, 0.62, 0.67), 35, `midi ${midi}: damper`);
    // auto-pan: each channel swells at 4.6 Hz, the mono sum does not
    const pan = tremolo(hard.left, 0.2, 2.6);
    near(pan.hz, 4.6, 0.3, `midi ${midi}: pan rate`);
    assert.ok(pan.depthDb > 1 && pan.depthDb < 3, `midi ${midi}: pan depth ${pan.depthDb}`);
    const other = tremolo(hard.right, 0.2, 2.6);
    near(other.hz, 4.6, 0.3, `midi ${midi}: pan rate (right)`);
    atMost(tremolo(monoSum(hard), 0.2, 2.6, 4.6).depthDb, 0.4, `midi ${midi}: mono tremolo`);
    atLeast(stereoCorrelation(hard), 0.9, `midi ${midi}: correlation`);
  }
  // the top notes have no tine (15 × the note would alias) and stay clean
  const top = play("epiano", 100, 1, 1);
  atMost(bandDb(top, 12000, 24000, 0, 0.3), -50, "energy above 12 kHz at E7");
  // key scaling: the bass growls more than the treble
  atLeast(
    partialDb(play("epiano", 40, 0.9, 1), midiToHz(40), 2, 0, 0.2) -
      partialDb(play("epiano", 88, 0.9, 1), midiToHz(88), 2, 0, 0.2),
    3,
    "bass has more second harmonic than treble",
  );
});

test("bell: inharmonic bar partials that keep shimmering, brighter than a piano, never harsh", () => {
  for (const midi of [72, 84, 96]) {
    const f0 = midiToHz(midi);
    const bell = play("bell", midi, 0.8, 4);
    const piano = play("piano", midi, 0.8, 4);
    // the free-bar partial at 2.756 × f0 is there, and nothing sits on the 3rd harmonic
    const bar = partialDb(bell, f0, 2.756, 0, 0.3, 0.02);
    assert.ok(bar > -12 && bar < 0, `midi ${midi}: 2.756 partial ${bar} dB`);
    atMost(partialDb(bell, f0, 3, 0, 0.3, 0.012), -40, `midi ${midi}: no 3rd harmonic`);
    atMost(partialDb(piano, f0, 2.756, 0, 0.3, 0.02), -40, `midi ${midi}: a piano has nothing at 2.756`);
    // brighter than the piano on the same key
    atLeast(centroidHz(bell) / centroidHz(piano), midi === 72 ? 1.02 : 1.15, `midi ${midi}: centroid vs piano`);
    // long shimmer: the note is still there after a second, and so is its colour
    const fall = rmsDb(bell, 0, 0.1) - rmsDb(bell, 1, 1.1);
    assert.ok(
      fall > 6 && fall < (midi === 96 ? 48 : 32),
      `midi ${midi}: falls ${fall} dB in the first second`,
    );
    atLeast(partialDb(bell, f0, 2.756, 1, 0.3, 0.02), midi === 96 ? -32 : -16, `midi ${midi}: 2.756 partial after 1 s`);
    // quick attack
    atLeast(rmsDb(bell, 0, 0.004), rmsDb(bell, 0.004, 0.02) - 9, `midi ${midi}: attack`);
    // never harsh: little above 9 kHz even when hit hard
    atMost(bandDb(play("bell", midi, 1, 1), 9000, 24000, 0, 0.3), -22, `midi ${midi}: energy above 9 kHz`);
    atLeast(stereoCorrelation(bell), 0.9, `midi ${midi}: correlation`);
  }
  // the doublets drift apart: the stereo balance wanders while the note rings
  const held = play("bell", 72, 0.8, 4);
  const balance = [0.2, 1, 2, 3].map((t) => balanceDb(held, t, t + 0.1));
  atLeast(Math.max(...balance) - Math.min(...balance), 0.8, "balance wanders");
  atMost(Math.max(...balance.map(Math.abs)), 4, "but stays near the centre");
  // a short note is not cut off: the felt damper lets it bloom
  const short = play("bell", 72, 0.8, 0.3);
  atMost(rmsDb(short, 0.25, 0.3) - rmsDb(short, 0.5, 0.55), 16, "rings on after note-off");
  assert.ok(tailIsSilent(short));
  // the top is shorter than the middle
  assert.ok(BANK.bell.tail({ midi: 96, vel: 0.8, duration: 1 }) < BANK.bell.tail({ midi: 60, vel: 0.8, duration: 1 }));
});

test("musicbox: a thin, pure tine with a metallic tink, slightly out of tune, ringing 1-3 s", () => {
  for (const midi of [72, 84]) {
    const f0 = midiToHz(midi);
    const box = play("musicbox", midi, 0.8, 4);
    const piano = play("piano", midi, 0.8, 4);
    const tuned = f0 * Math.pow(2, centsError(box, midi) / 1200);
    // the clamped-bar overtone at 6.267 × f0: clear at the pluck, gone half a second later
    const tink = partialDb(box, tuned, 6.267, 0, 0.08, 0.02);
    assert.ok(tink > (midi === 72 ? -14 : -24) && tink < -3, `midi ${midi}: tink ${tink} dB`);
    atMost(partialDb(box, tuned, 6.267, 0.6, 0.2, 0.02), tink - 18, `midi ${midi}: tink dies`);
    // a piano has nothing like it up there
    atLeast(tink - partialDb(piano, f0, 6.267, 0, 0.08, 0.02), 12, `midi ${midi}: tink vs piano`);
    // after that almost nothing but the fundamental is left
    atLeast(bandDb(box, 0.7 * f0, 1.4 * f0, 0.4, 0.4), -0.5, `midi ${midi}: purity`);
    // 1-3 s ring: 18..60 dB down after one second, and it starts at once
    const fall = rmsDb(box, 0, 0.1) - rmsDb(box, 1, 1.1);
    assert.ok(fall > 18 && fall < 60, `midi ${midi}: falls ${fall} dB in a second`);
    atLeast(rmsDb(box, 0, 0.003), rmsDb(box, 0.003, 0.02) - 8, `midi ${midi}: instant attack`);
    atLeast(stereoCorrelation(box), 0.95, `midi ${midi}: a small box is nearly mono`);
  }
  // thin: a low key has far less bass than the same key of the piano
  const low = play("musicbox", 48, 0.8, 1);
  atLeast(
    partialDb(low, midiToHz(48) * Math.pow(2, centsError(low, 48) / 1200), 2, 0.1, 0.3) -
      partialDb(play("musicbox", 84, 0.8, 1), midiToHz(84) * Math.pow(2, centsError(play("musicbox", 84), 84) / 1200), 2, 0.1, 0.3),
    3,
    "the box favours the overtones of low keys",
  );
  // every tine is a little off, always by the same amount, never by much
  const cents = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84].map((midi) =>
    centsError(play("musicbox", midi), midi),
  );
  atMost(Math.max(...cents.map(Math.abs)), 5, "worst tine");
  atLeast(Math.max(...cents) - Math.min(...cents), 4, "the tines differ");
  near(centsError(play("musicbox", 67, 0.8, 1, undefined, 9), 67), cents[4], 0.05, "a key keeps its tuning");
  // nobody damps a tine: it rings on after note-off
  const short = play("musicbox", 72, 0.8, 0.2);
  atMost(rmsDb(short, 0.15, 0.2) - rmsDb(short, 0.4, 0.45), 12, "rings on after note-off");
});

test("marimba and vibes: the same bar tuning, wood dies in a moment, metal sings with a motor", () => {
  for (const midi of [48, 60, 72]) {
    const f0 = midiToHz(midi);
    const marimba = play("marimba", midi, 0.8, 3);
    const vibes = play("vibes", midi, 0.8, 3);
    // both bars are tuned two octaves up (3.93 / 3.98 × f0) and have NO octave or twelfth
    const knock = partialDb(marimba, f0, 3.93, 0, 0.06, 0.04);
    assert.ok(knock > -18 && knock < -4, `midi ${midi}: marimba 4th-harmonic mode ${knock} dB`);
    const edge = partialDb(vibes, f0, 3.98, 0, 0.06, 0.04);
    assert.ok(edge > -20 && edge < -6, `midi ${midi}: vibes 4th-harmonic mode ${edge} dB`);
    for (const ratio of [2, 3]) {
      atMost(partialDb(marimba, f0, ratio, 0.05, 0.2, 0.02), -40, `midi ${midi}: marimba has no ${ratio}x`);
      atMost(partialDb(vibes, f0, ratio, 0.05, 0.2, 0.02), -40, `midi ${midi}: vibes has no ${ratio}x`);
    }
    // wood loses the upper mode within a quarter of a second, metal keeps it
    atMost(partialDb(marimba, f0, 3.93, 0.25, 0.1, 0.04), knock - 20, `midi ${midi}: marimba upper mode dies`);
    atLeast(partialDb(vibes, f0, 3.98, 0.5, 0.2, 0.04), edge - 14, `midi ${midi}: vibes upper mode rings`);
    // the marimba decays much faster than the vibraphone
    const woodFall = rmsDb(marimba, 0, 0.1) - rmsDb(marimba, 0.5, 0.6);
    const metalFall = rmsDb(vibes, 0, 0.1) - rmsDb(vibes, 0.5, 0.6);
    atLeast(woodFall - metalFall, 8, `midi ${midi}: marimba falls faster`);
    atMost(metalFall, 9, `midi ${midi}: vibes barely fall in half a second`);
    atLeast(rmsDb(vibes, 2, 2.1), rmsDb(vibes, 0, 0.1) - 32, `midi ${midi}: vibes still ring after 2 s`);
    // motor tremolo: 5.3 Hz, a few dB, on both channels; a marimba has none
    for (const channel of [vibes.left, vibes.right]) {
      const motor = tremolo(channel, 0.2, 2.6);
      near(motor.hz, 5.3, 0.25, `midi ${midi}: motor rate`);
      assert.ok(motor.depthDb > 3 && motor.depthDb < 7, `midi ${midi}: motor depth ${motor.depthDb} dB`);
    }
    if (midi < 72)
      atMost(tremolo(marimba.left, 0.05, 0.75).depthDb, 1, `midi ${midi}: marimba is steady`);
    // the damper bar stops a vibraphone; a marimba bar just rings out
    const stopped = play("vibes", midi, 0.8, 1);
    atLeast(rmsDb(stopped, 0.9, 1) - rmsDb(stopped, 1.25, 1.3), 30, `midi ${midi}: vibes damper`);
    const free = play("marimba", midi, 0.8, 0.2);
    const natural = play("marimba", midi, 0.8, 0.6);
    atMost(rmsDb(natural, 0.3, 0.35) - rmsDb(free, 0.3, 0.35), 6, `midi ${midi}: marimba is not damped`);
    // harder mallet strokes are brighter where a bar can show it: in the attack
    atLeast(
      centroidHz(play("marimba", midi, 1), 0, 0.06) / centroidHz(play("marimba", midi, 0.4), 0, 0.06),
      1.08,
      `midi ${midi}: marimba attack brightness`,
    );
    atLeast(stereoCorrelation(marimba), 0.9, `midi ${midi}: marimba correlation`);
    atLeast(stereoCorrelation(vibes), 0.9, `midi ${midi}: vibes correlation`);
  }
  // a soft mallet: the first millisecond is a ramp, and there is a thump under the note
  const hit = play("marimba", 72, 1, 0.5);
  atMost(rmsDb(hit, 0, 0.0005), rmsDb(hit, 0.002, 0.006) - 12, "marimba onset is rounded");
  atLeast(bandDb(hit, 60, 0.6 * midiToHz(72), 0, 0.03), -40, "mallet thump below the note");
  atMost(bandDb(hit, 60, 0.6 * midiToHz(72), 0.2, 0.2), -55, "the thump is only in the attack");
  // the top of the marimba is a quarter of a second long
  const top = play("marimba", 96, 0.8, 1);
  atLeast(rmsDb(top, 0, 0.05) - rmsDb(top, 0.3, 0.35), 40, "top bar is short");
});

test("organ: drawbar footages that hold, a quick click-free envelope, a slow rotary", () => {
  for (const midi of [48, 60, 72, 84]) {
    const f0 = midiToHz(midi);
    const organ = play("organ", midi, 0.8, 3);
    // footages: 16', 4', 2 2/3' and 2' around the 8'
    for (const [ratio, low, high] of [
      [0.5, -16, -6],
      [2, -12, -2],
      [3, -18, -7],
      [4, -22, -9],
    ]) {
      const level = partialDb(organ, f0, ratio, 0.5, 1, 0.02);
      assert.ok(level > low && level < high, `midi ${midi}: footage ${ratio}x at ${level} dB`);
    }
    // it does not decay
    near(rmsDb(organ, 2.5, 3), rmsDb(organ, 0.5, 1), 1.5, `midi ${midi}: sustain`);
    // fast attack and release without a click
    atLeast(rmsDb(organ, 0.01, 0.02), rmsDb(organ, 0.5, 1) - 3, `midi ${midi}: full level after 10 ms`);
    atMost(rmsDb(organ, 0, 0.0005), rmsDb(organ, 0.5, 1) - 25, `midi ${midi}: starts from nothing`);
    atMost(rmsDb(organ, 3.03, 3.045), rmsDb(organ, 2.5, 3) - 15, `midi ${midi}: released within 45 ms`);
    assert.ok(checkClicks(organ).ok, checkClicks(organ).problems.join("; "));
    // rotary speaker: the stereo balance swings slowly, yet stays mono-compatible
    const balance = [0.3, 0.6, 0.9, 1.2, 1.5].map((t) => balanceDb(organ, t, t + 0.1));
    const swing = Math.max(...balance) - Math.min(...balance);
    assert.ok(swing > 0.6 && swing < 6, `midi ${midi}: balance swings ${swing} dB`);
    atLeast(stereoCorrelation(organ), 0.5, `midi ${midi}: correlation`);
    const mono = monoSum(organ);
    let monoPower = 0;
    let stereoPower = 0;
    for (let i = 0; i < organ.frames; i++) {
      monoPower += mono[i] * mono[i];
      stereoPower += 0.5 * (organ.left[i] * organ.left[i] + organ.right[i] * organ.right[i]);
    }
    atLeast(10 * Math.log10(monoPower / stereoPower), -1.5, `midi ${midi}: mono sum`);
    // percussion: the 4' pings on a hard note and settles
    const hard = play("organ", midi, 1, 1);
    atLeast(partialDb(hard, f0, 2, 0, 0.08, 0.02) - partialDb(hard, f0, 2, 0.6, 0.4, 0.02), 2, `midi ${midi}: percussion`);
  }
  // tonewheel foldback: nothing above the highest wheel, however high the key
  atMost(bandDb(play("organ", 96, 1, 1), 6000, 24000, 0.2, 0.5), -60, "nothing above 6 kHz");
  // velocity is the swell pedal AND the upper drawbars
  const soft = play("organ", 60, 0.3, 1);
  const loud = play("organ", 60, 1, 1);
  atLeast(partialDb(loud, midiToHz(60), 4, 0.5, 0.4, 0.02) - partialDb(soft, midiToHz(60), 4, 0.5, 0.4, 0.02), 4, "2' drawbar opens with velocity");
});

/* --------------------------------------------------------------- plucked */

test("nylon: rounder and shorter-lived than the steel-string guitar", () => {
  for (const midi of [45, 52, 64, 76]) {
    const steel = play("guitar", midi, 0.8, 3);
    const nylon = play("nylon", midi, 0.8, 3);
    atMost(centroidHz(nylon, 0.1, 0.3) / centroidHz(steel, 0.1, 0.3), 0.8, `midi ${midi}: body brightness`);
    atMost(centroidHz(nylon, 0, 0.05) / centroidHz(steel, 0, 0.05), 0.8, `midi ${midi}: attack brightness`);
    // it is a plucked string all the same: it decays, darkens, and is damped at note-off
    atLeast(rmsDb(nylon, 0, 0.1) - rmsDb(nylon, 0.9, 1), 6, `midi ${midi}: decays`);
    atMost(centroidHz(nylon, 1.5, 0.5), centroidHz(nylon, 0, 0.3) * 0.85, `midi ${midi}: darkens`);
    atLeast(rmsDb(steel, 2.5, 3) - rmsDb(nylon, 2.5, 3), 4, `midi ${midi}: nylon dies sooner`);
    const short = play("nylon", midi, 0.8, 0.4);
    atLeast(rmsDb(short, 0.3, 0.4) - rmsDb(short, 0.55, 0.6), 20, `midi ${midi}: damped`);
    const correlation = stereoCorrelation(nylon);
    assert.ok(correlation > 0.7 && correlation < 0.995, `midi ${midi}: correlation ${correlation}`);
    atMost(crestDb(play("nylon", midi)), 15, `midi ${midi}: crest`);
  }
  // the fingertip is softer than a pick: the first millisecond is quieter
  atLeast(
    rmsDb(play("guitar", 57), 0, 0.001) - rmsDb(play("nylon", 57), 0, 0.001),
    2,
    "softer onset",
  );
  const bent = play("nylon", 57, 0.8, 1, 2);
  atLeast(earlyCents(bent, 57, 58.7, 0.02), 110, "bend starts sharp");
  near(centsError(bent, 57, 0.3, 0.5), 0, 3, "bend lands on pitch");
});

test("guzheng: bright metallic pluck, long ring, pitch settle, and a real slide into the note", () => {
  for (const midi of [45, 52, 64, 76]) {
    const steel = play("guitar", midi, 0.8, 3);
    const zheng = play("guzheng", midi, 0.8, 3);
    // plucked near the bridge with picks: clearly brighter than a guitar
    atLeast(centroidHz(zheng, 0, 0.05) / centroidHz(steel, 0, 0.05), 1.25, `midi ${midi}: attack brightness`);
    atLeast(centroidHz(zheng, 0.1, 0.3) / centroidHz(steel, 0.1, 0.3), 1.25, `midi ${midi}: body brightness`);
    // strong attack, then a ring at least as long as the guitar's
    atLeast(rmsDb(zheng, 0, 0.002), rmsDb(zheng, 0.002, 0.05) - 8, `midi ${midi}: strong attack`);
    atLeast(rmsDb(zheng, 2.5, 3), rmsDb(steel, 2.5, 3), `midi ${midi}: long ring`);
    atMost(crestDb(play("guzheng", midi)), 15.5, `midi ${midi}: crest`);
    const correlation = stereoCorrelation(zheng);
    assert.ok(correlation > 0.7 && correlation < 0.995, `midi ${midi}: correlation ${correlation}`);
  }
  // nobody damps the string: it rings on after note-off, and fades to silence
  const short = play("guzheng", 64, 0.8, 0.3);
  atMost(rmsDb(short, 0.25, 0.3) - rmsDb(short, 0.5, 0.55), 18, "rings on after note-off");
  assert.ok(tailIsSilent(short));
  // NoteEvent.bend: starts off the note and glides onto it within 70 ms
  for (const bend of [2, -2, 3, -1]) {
    const bent = play("guzheng", 64, 0.8, 1, bend);
    const start = earlyCents(bent, 64, 64 + bend * 0.85, 0.02);
    atLeast(Math.sign(bend) * start, Math.abs(bend) * 75, `bend ${bend}: starts ${start} cents off`);
    atMost(Math.sign(bend) * start, Math.abs(bend) * 105, `bend ${bend}: not further than asked`);
    near(centsError(bent, 64, 0.09, 0.3), 0, 3, `bend ${bend}: on pitch after 90 ms`);
    near(centsError(bent, 64, 0.3, 0.5), 0, 2, `bend ${bend}: lands on pitch`);
  }
  // natural pitch settle: a hard pluck starts a few cents sharp, a soft one barely
  const hard = earlyCents(play("guzheng", 64, 1), 64);
  const soft = earlyCents(play("guzheng", 64, 0.3), 64);
  assert.ok(hard > 3 && hard < 14, `hard pluck starts ${hard} cents sharp`);
  assert.ok(soft > -1 && soft < 3 && soft < hard - 2, `soft pluck starts ${soft} cents sharp`);
  near(centsError(play("guzheng", 64, 1), 64, 0.3, 0.5), 0, 1, "and settles on the note");
  // a guitar has no such settle
  near(earlyCents(play("guitar", 64, 1), 64), 0, 1.5, "guitar starts on pitch");
});

test("pluck: a snapping filter, a tight envelope, identical level every time", () => {
  for (const midi of [57, 69, 81]) {
    const f0 = midiToHz(midi);
    const note = play("pluck", midi, 0.8, 3);
    // the filter is open at the attack and closed a third of a second later
    atLeast(bandDb(note, 8 * f0, 24000, 0, 0.04) - bandDb(note, 8 * f0, 24000, 0.3, 0.2), 15, `midi ${midi}: filter snap`);
    atLeast(bandDb(note, 8 * f0, 24000, 0, 0.04), -20, `midi ${midi}: bright attack`);
    // saw + square: every harmonic is there at the attack
    for (const harmonic of [2, 3, 4, 5])
      atLeast(partialDb(note, f0, harmonic, 0, 0.1, 0.04), -24, `midi ${midi}: harmonic ${harmonic}`);
    // tight: most of the level is gone in half a second, a quiet sustain remains
    const fall = rmsDb(note, 0, 0.1) - rmsDb(note, 0.5, 0.6);
    assert.ok(fall > 7 && fall < 20, `midi ${midi}: falls ${fall} dB`);
    near(rmsDb(note, 2.4, 2.9), rmsDb(note, 1.2, 1.7), 4, `midi ${midi}: sustain holds`);
    // and it stops at once
    const short = play("pluck", midi, 0.8, 0.2);
    atLeast(rmsDb(short, 0.15, 0.2) - rmsDb(short, 0.24, 0.26), 30, `midi ${midi}: stops in 50 ms`);
    atMost(BANK.pluck.tail({ midi, vel: 0.8, duration: 0.2 }), 0.1, "short tail");
    // two saws left and right of a centred square: wide, mono-safe
    const correlation = stereoCorrelation(note);
    assert.ok(correlation > 0.6 && correlation < 0.97, `midi ${midi}: correlation ${correlation}`);
    // harder = the filter opens further
    atLeast(
      bandDb(play("pluck", midi, 1), 8 * f0, 24000, 0, 0.04) - bandDb(play("pluck", midi, 0.3), 8 * f0, 24000, 0, 0.04),
      1,
      `midi ${midi}: velocity opens the filter`,
    );
  }
  // ostinato-proof: the level of repeated notes does not wander, but they are not copies
  const levels = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => loudestWindowDb(play("pluck", 57, 0.8, 1, undefined, seed)));
  atMost(Math.max(...levels) - Math.min(...levels), 0.5, "level spread over seeds");
  const a = play("pluck", 57, 0.8, 0.3, undefined, 1);
  const b = play("pluck", 57, 0.8, 0.3, undefined, 2);
  let differs = false;
  for (let i = 2000; i < 2400; i++) if (a.left[i] !== b.left[i]) differs = true;
  assert.ok(differs, "two notes are not carbon copies");
  // the measured level table holds between its grid columns too
  for (const midi of [50.5, 61.3, 73.7, 85.2])
    near(loudestWindowDb(play("pluck", midi)), -18, 1, `level at midi ${midi}`);
  const bent = play("pluck", 60, 0.8, 1, -2);
  atMost(earlyCents(bent, 60, 58.3, 0.02), -110, "bend starts flat");
});

test("pizzicato: short, dark and woody, with the knock of the body", () => {
  for (const midi of [48, 60, 72, 84]) {
    const pizz = play("pizzicato", midi, 0.8, 1);
    const steel = play("guitar", midi, 0.8, 1);
    // short: far quicker than a guitar string
    const fall = rmsDb(pizz, 0, 0.1) - rmsDb(pizz, 0.5, 0.6);
    atLeast(fall, 15, `midi ${midi}: falls ${fall} dB in half a second`);
    atLeast(fall - (rmsDb(steel, 0, 0.1) - rmsDb(steel, 0.5, 0.6)), 8, `midi ${midi}: shorter than guitar`);
    // dark: the flesh of the finger, not a pick
    atMost(centroidHz(pizz, 0.1, 0.3) / centroidHz(steel, 0.1, 0.3), 0.75, `midi ${midi}: darker than guitar`);
    // but it is a pluck: it starts at once and is loudest at the start
    atLeast(rmsDb(pizz, 0, 0.02), rmsDb(pizz, 0.1, 0.12), `midi ${midi}: loudest at the pluck`);
    atLeast(stereoCorrelation(pizz), 0.8, `midi ${midi}: correlation`);
  }
  // the body knocks at its own frequencies whatever the note (here far below it)
  for (const midi of [72, 84, 93]) {
    const pizz = play("pizzicato", midi, 0.8, 1);
    atLeast(bandDb(pizz, 240, 330, 0, 0.06), -32, `midi ${midi}: body knock near 282 Hz`);
    atMost(bandDb(pizz, 240, 330, 0.3, 0.2), bandDb(pizz, 240, 330, 0, 0.06) - 15, `midi ${midi}: the knock is over quickly`);
    atMost(bandDb(play("guitar", midi), 240, 330, 0, 0.06), -50, `midi ${midi}: a guitar note has nothing there`);
  }
  // low strings ring longer than high ones
  const cello = play("pizzicato", 43, 0.8, 2);
  const violin = play("pizzicato", 79, 0.8, 2);
  atLeast(
    rmsDb(violin, 0, 0.1) - rmsDb(violin, 0.5, 0.6) - (rmsDb(cello, 0, 0.1) - rmsDb(cello, 0.5, 0.6)),
    10,
    "cello pizzicato outlasts violin pizzicato",
  );
  // staccato or held makes little difference: the string is not damped hard
  const staccato = play("pizzicato", 60, 0.8, 0.05);
  const held = play("pizzicato", 60, 0.8, 1);
  atMost(rmsDb(held, 0.15, 0.2) - rmsDb(staccato, 0.15, 0.2), 14, "a staccato pizzicato still rings");
});

test("overdrive: far more harmonics than a guitar, sustained, tight, band-limited by the cabinet", () => {
  for (const midi of [40, 47, 52, 59, 64, 76]) {
    const f0 = midiToHz(midi);
    const driven = play("overdrive", midi, 0.8, 8);
    const clean = play("guitar", midi, 0.8, 8);
    // harmonic energy (above 3.5 × f0) 1.5 s into the note, in absolute terms
    const harmonics = (r: Rendered) => rmsDb(r, 1.5, 2) + bandDb(r, 3.5 * f0, 24000, 1.5, 0.5);
    atLeast(harmonics(driven) - harmonics(clean), midi < 52 ? 10 : 18, `midi ${midi}: harmonic energy vs guitar`);
    // sustains while held: the clipper holds the level while the string fades
    atMost(rmsDb(driven, 0.2, 0.7) - rmsDb(driven, 2, 2.5), 3, `midi ${midi}: level after 2 s`);
    atMost(rmsDb(driven, 0.2, 0.7) - rmsDb(driven, 4, 4.5), 6, `midi ${midi}: level after 4 s`);
    atLeast(rmsDb(clean, 0.2, 0.7) - rmsDb(clean, 2, 2.5), 12, `midi ${midi}: a guitar would be gone`);
    // compressed: low crest factor
    atMost(crestDb(play("overdrive", midi)), 9.5, `midi ${midi}: crest`);
    // tight low end and a cabinet roll-off
    atMost(bandDb(driven, 0, 70, 0.2, 1), -40, `midi ${midi}: energy below 70 Hz`);
    atMost(bandDb(driven, 7000, 24000, 0.2, 1), -34, `midi ${midi}: energy above 7 kHz`);
    atLeast(bandDb(driven, 1000, 5000, 0.2, 1), -14, `midi ${midi}: mids and presence`);
    // the note itself is still the strongest thing around: the pitch is not lost
    atLeast(partialDb(driven, f0, 1, 0.3, 0.5), -0.01, `midi ${midi}: fundamental present`);
    atMost(
      Math.max(...[2, 3, 4, 5].map((k) => partialDb(driven, f0, k, 0.3, 0.5))),
      midi < 59 ? 12 : 4,
      `midi ${midi}: no harmonic buries the fundamental`,
    );
    // the palm stops it
    const stopped = play("overdrive", midi, 0.8, 0.5);
    atLeast(rmsDb(stopped, 0.4, 0.5) - rmsDb(stopped, 0.555, 0.57), 50, `midi ${midi}: stops in 55 ms`);
    atLeast(stereoCorrelation(driven), 0.9, `midi ${midi}: one amplifier, nearly mono`);
  }
  // harder picking drives the amp further: more harmonics, not just more level
  for (const midi of [47, 59, 64]) {
    const share = (vel: number) => bandDb(play("overdrive", midi, vel), 3.5 * midiToHz(midi), 24000, 0.3, 0.5);
    atLeast(share(1) - share(0.3), 1.5, `midi ${midi}: velocity drives harder`);
  }
  // a soft note is cleaner: its crest factor is higher than a saturated one's
  atLeast(crestDb(play("overdrive", 52, 0.15)) - crestDb(play("overdrive", 52, 1)), 0.5, "soft notes are less squashed");
  // bends happen before the amp, and land
  const bent = play("overdrive", 52, 0.8, 1, 2);
  atLeast(earlyCents(bent, 52, 53.7, 0.02), 110, "bend starts sharp");
  near(centsError(bent, 52, 0.3, 0.5), 0, 3, "bend lands on pitch");
  // clipping is oversampled: almost nothing above the cabinet's range comes back as aliasing
  atMost(bandDb(play("overdrive", 88, 1), 9000, 24000, 0.2, 0.5), -40, "top note stays band-limited");
  // the measured level table holds between its grid columns and across picks
  for (const midi of [41.5, 50.3, 62.7, 77.2])
    near(loudestWindowDb(play("overdrive", midi)), -18, 1.2, `level at midi ${midi}`);
});

test("the level-table voices keep their level between grid points and at any velocity", () => {
  for (const id of ["epiano", "pluck", "overdrive"] as VoiceId[])
    for (const midi of [45.4, 58.6, 70.9, 82.3])
      for (const vel of [0.15, 0.45, 0.7, 0.92]) {
        const expected = -18 + 20 * Math.log10(velocityGain(vel));
        near(loudestWindowDb(play(id, midi, vel)), expected, 1.3, `${id} midi ${midi} vel ${vel}`);
      }
});

/* ------------------------------------------------------------ all voices */

test("every voice survives any buffer length, extreme notes, 40 ms staccato and 10 s holds", () => {
  const notes: VoiceNote[] = [
    { midi: 60, vel: 0.8, duration: 1 },
    { midi: 60, vel: 0, duration: 0 },
    { midi: 12, vel: 1.5, duration: 0.01 },
    { midi: 127, vel: 1, duration: 0.5, bend: 12 },
    { midi: -5, vel: 0.5, duration: 0.2, bend: -7 },
    { midi: 71.5, vel: 0.05, duration: 0.04 },
  ];
  for (const id of ALL) {
    for (const frames of [1, 2, 7, 64, 300, 2000])
      for (const note of notes) {
        const what = `${id} ${frames} frames ${JSON.stringify(note)}`;
        const left = new Float32Array(frames + 8);
        const right = new Float32Array(frames + 8);
        BANK[id].render(left, right, frames, note, { sampleRate: SAMPLE_RATE, random: createRng(3) });
        let top = 0;
        for (let i = 0; i < frames + 8; i++) {
          assert.ok(Number.isFinite(left[i]) && Number.isFinite(right[i]), `${what}: not finite`);
          if (i >= frames) assert.ok(left[i] === 0 && right[i] === 0, `${what}: wrote beyond frames`);
          top = Math.max(top, Math.abs(left[i]), Math.abs(right[i]));
        }
        assert.ok(top <= 1, `${what}: peak ${top}`);
        assert.ok(Math.abs(left[0]) <= 0.01, `${what}: starts at ${left[0]}`);
        assert.ok(Math.abs(left[frames - 1]) <= 0.003, `${what}: ends at ${left[frames - 1]}`);
        const tail = BANK[id].tail(note);
        assert.ok(Number.isFinite(tail) && tail >= 0 && tail <= 8, `${what}: tail ${tail}`);
      }
    const [low, high] = CONTRACT[id]?.range ?? [36, 96];
    for (const midi of [low - 12, low, Math.round((low + high) / 2), high, high + 12])
      for (const note of [
        { midi, vel: 0.05, duration: 0.04 },
        { midi, vel: 1, duration: 0.04 },
        { midi, vel: 1, duration: 10 },
        { midi, vel: 0.5, duration: 0.6, bend: -3 },
      ])
        for (const sampleRate of [SAMPLE_RATE, 44100]) {
          const what = `${id} midi ${midi} vel ${note.vel} ${note.duration} s @${sampleRate}`;
          const r = renderNote(BANK[id], note, sampleRate, 5);
          assert.ok(r.guardIntact, `${what}: wrote beyond frames`);
          assert.ok(isFiniteAudio(r), `${what}: not finite`);
          assert.ok(peak(r) <= 1, `${what}: peak ${peak(r)}`);
          // an octave outside the range a voice may be rough, but never click at its ends
          const clicks = checkClicks(r, { startJump: 2, maxJump: 2, releaseJumpRatio: 0 });
          assert.ok(clicks.ok, `${what}: ${clicks.problems.join("; ")}`);
          assert.ok(note.vel < 0.5 || peak(r) > 0.01, `${what}: silent`);
          if (note.duration === 10) {
            assert.ok(tailIsSilent(r), `${what}: tail is not silent`);
            // no runaway resonance: a 10 s hold is never louder at its end than at its start
            assert.ok(rmsDb(r, 9, 10) <= rmsDb(r, 0, 1) + 1.5, `${what}: grows while held`);
          }
        }
  }
});

test("every voice is deterministic for a seed and softer notes are quieter all the way down", () => {
  for (const id of ALL) {
    const note = { midi: 62, vel: 0.7, duration: 0.3 };
    const a = renderNote(BANK[id], note, SAMPLE_RATE, 11);
    const b = renderNote(BANK[id], note, SAMPLE_RATE, 11);
    assert.deepEqual(a.left, b.left, `${id}: left differs`);
    assert.deepEqual(a.right, b.right, `${id}: right differs`);
    let previous = -Infinity;
    for (const vel of [0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1]) {
      const level = loudestWindowDb(play(id, 62, vel));
      assert.ok(level > previous + 1, `${id}: vel ${vel} reads ${level} after ${previous}`);
      previous = level;
    }
    // vel 0.05 is still a note (about 36 dB under vel 0.8), not silence
    const whisper = loudestWindowDb(play(id, 62, 0.05));
    assert.ok(whisper > -62 && whisper < -46, `${id}: vel 0.05 reads ${whisper} dBFS`);
  }
});

test("render cost: every voice is at least 60 times faster than real time", (t) => {
  const realTime = 1e9 / SAMPLE_RATE;
  for (const id of ALL) {
    const [low, high] = CONTRACT[id]?.range ?? [36, 96];
    let worst = 0;
    const parts: string[] = [];
    for (const midi of [low, Math.round((low + high) / 2), high]) {
      const cost = measureCost(BANK[id], { midi, vel: 0.8, duration: 1 }, 5);
      worst = Math.max(worst, cost);
      parts.push(`midi ${midi}: ${cost.toFixed(1)} ns/frame (${(realTime / cost).toFixed(0)}x)`);
    }
    t.diagnostic(`${id} — ${parts.join(", ")}`);
    assert.ok(worst < realTime / 60, `${id}: ${worst.toFixed(0)} ns per frame`);
  }
});
