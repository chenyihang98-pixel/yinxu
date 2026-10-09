import test from "node:test";
import assert from "node:assert/strict";
import {
  DRUM_KINDS,
  DRUM_KITS,
  SAMPLE_RATE,
  VOICE_IDS,
} from "../src/music/score";
import type { VoiceId } from "../src/music/score";
import type { Voice } from "../src/audio/voices/types";
import {
  DUPLICATE_VOICES,
  MISSING_VOICES,
  VOICES,
  VOICE_CONTRACTS,
  assembleVoiceBank,
  bankProblem,
  completeBank,
} from "../src/audio/voices";
import { KEYS_VOICES } from "../src/audio/voices/group-keys";
import { BASS_VOICES } from "../src/audio/voices/group-bass";
import { DRUMS } from "../src/audio/drums";
import {
  assertVoiceContract,
  bandEnergiesDb,
  centroidHz,
  centsError,
  checkClicks,
  checkVoiceContract,
  dcOffset,
  estimatePitch,
  formatReport,
  isFiniteAudio,
  loudestWindowDb,
  measureCost,
  monoSum,
  noteFrames,
  peak,
  renderDrum,
  renderNote,
  rmsDb,
  stereoCorrelation,
  tailDb,
  tailIsSilent,
} from "../src/audio/voices/testing";
import {
  Adsr,
  REFERENCE_RMS,
  TAU,
  bendOffset,
  createRng,
  midiToHz,
  noteOffFrame,
  scratch,
  velocityGain,
} from "../src/audio/dsp";

const EXEMPLARS: VoiceId[] = ["piano", "guitar", "pad", "subBass"];
const near = (
  actual: number,
  expected: number,
  tolerance: number,
  what: string,
) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: got ${actual}, expected ${expected} ±${tolerance}`,
  );

/**
 * A tiny reference voice that honours the contract (sine + velocity-dependent
 * 2nd/3rd harmonic), with switches for every way of breaking it.
 */
function referenceVoice(
  flaw: Partial<{
    gainDb: number;
    cents: number;
    gate: boolean;
    mathRandom: boolean;
    overwrite: boolean;
    plainVelocity: boolean;
    overrun: boolean;
    dc: number;
    endLevel: number;
    antiphase: boolean;
    ignoreSampleRate: boolean;
    nan: boolean;
  }> = {},
): Voice {
  return {
    id: "synth",
    tail: () => 0.08,
    render(left, right, frames, note, ctx) {
      const sr = flaw.ignoreSampleRate ? 48000 : ctx.sampleRate;
      const env = scratch(14, frames);
      new Adsr(sr, {
        attack: 0.004,
        decay: 0.1,
        sustain: 1,
        release: 0.07,
      }).render(env, frames, noteOffFrame(note, frames, sr));
      const bright = flaw.plainVelocity ? 0.2 : 0.5 * note.vel;
      const rms = Math.sqrt(
        0.5 * (1 + bright * bright + 0.25 * bright * bright),
      );
      const gain =
        ((REFERENCE_RMS * velocityGain(note.vel)) / rms) *
        Math.pow(10, (flaw.gainDb ?? 0) / 20);
      const hz = midiToHz(note.midi + (flaw.cents ?? 0) / 100);
      const jitter = flaw.mathRandom ? Math.random() * 0.1 : 0;
      let phase = 0;
      const count = flaw.overrun ? frames + 8 : frames;
      for (let i = 0; i < count; i++) {
        const bend = Math.pow(2, bendOffset(note.bend, i / sr) / 12);
        const e = flaw.gate
          ? i < noteOffFrame(note, frames, sr)
            ? 1
            : 0
          : env[i];
        let v =
          (Math.cos(TAU * phase - (flaw.gate ? 0 : Math.PI / 2)) +
            bright * Math.sin(2 * TAU * phase) +
            0.5 * bright * Math.sin(3 * TAU * phase)) *
          gain *
          e;
        v += (flaw.dc ?? 0) * e + (flaw.endLevel ?? 0) + jitter;
        if (flaw.nan && i === 100) v = NaN;
        if (flaw.overwrite) {
          left[i] = v;
          right[i] = v;
        } else {
          left[i] += v;
          right[i] += flaw.antiphase ? -v : v;
        }
        phase += (hz * bend) / sr;
      }
    },
  };
}

test("measurement harness reads level, pitch, spectrum and clicks correctly", () => {
  const voice = referenceVoice();
  const r = renderNote(voice, { midi: 69, vel: 0.8, duration: 1 });
  assert.equal(r.frames, Math.ceil(1.08 * SAMPLE_RATE));
  assert.equal(
    r.frames,
    noteFrames(voice, { midi: 69, vel: 0.8, duration: 1 }),
  );
  assert.equal(r.holdFrames, SAMPLE_RATE);
  assert.ok(r.guardIntact && isFiniteAudio(r));
  near(loudestWindowDb(r), -18, 0.05, "loudest 400 ms of a calibrated voice");
  near(rmsDb(r, 0.2, 0.9), -18, 0.05, "RMS of the sustain");
  near(centsError(r, 69), 0, 0.2, "pitch of a steady tone");
  assert.ok(peak(r) > 0.15 && peak(r) < 0.3);
  assert.ok(dcOffset(r) < 1e-3);
  near(stereoCorrelation(r), 1, 1e-9, "mono voice correlation");
  assert.ok(tailIsSilent(r) && tailDb(r) < -60);
  assert.ok(checkClicks(r).ok, checkClicks(r).problems.join("; "));
  // spectrum: fundamental 440, harmonics at -8 and -14 dB
  const centroid = centroidHz(r);
  assert.ok(centroid > 440 && centroid < 700, `centroid ${centroid}`);
  const bands = bandEnergiesDb(r, [0, 600, 1000, 24000]);
  near(bands[0], -0.8, 0.3, "fundamental band");
  near(bands[1], -8.8, 0.5, "second-harmonic band");
  assert.ok(Math.abs(bands[1] - bandEnergiesDb(r, [600, 1000])[0]) < 1e-9);

  // the pitch estimator across the keyboard, on pure and on rich signals
  for (const midi of [21, 33, 45.5, 57, 69, 81, 93, 108]) {
    for (const cents of [0, 7, -12]) {
      const hz = midiToHz(midi + cents / 100);
      const signal = Float32Array.from({ length: 30000 }, (_, i) => {
        const p = (hz * i) / SAMPLE_RATE;
        return (
          Math.sin(TAU * p) +
          0.5 * Math.sin(2 * TAU * p + 1) +
          0.3 * Math.sin(3 * TAU * p + 2)
        );
      });
      const estimate = estimatePitch(signal, SAMPLE_RATE, midiToHz(midi));
      near(
        1200 * Math.log2(estimate / hz),
        0,
        0.3,
        `estimate at midi ${midi} ${cents} cents`,
      );
    }
  }
  // missing fundamental: harmonics 2..4 still give the right pitch
  const hollow = Float32Array.from({ length: 30000 }, (_, i) => {
    const p = (220 * i) / SAMPLE_RATE;
    return (
      Math.sin(2 * TAU * p) + Math.sin(3 * TAU * p) + Math.sin(4 * TAU * p)
    );
  });
  near(
    estimatePitch(hollow, SAMPLE_RATE, 220),
    220,
    0.1,
    "missing fundamental",
  );
  assert.ok(monoSum(r).length === r.frames);

  // level is the average channel power: one silent channel reads 3 dB lower
  const half = { ...r, right: new Float32Array(r.frames) };
  near(loudestWindowDb(half), -21.01, 0.05, "one channel only");
});

test("the contract check passes a correct voice and names every kind of violation", () => {
  const good = checkVoiceContract(referenceVoice(), {
    range: [45, 81],
    step: 12,
  });
  assert.deepEqual(good.failures, []);
  near(good.levels[0].levelDb, -18, 0.1, "reported level");
  near(good.velocity[0].levelSpanDb, 11.9, 0.3, "reported velocity span");
  assert.ok(good.velocity[0].brightnessRatio > 1.05);
  assert.ok(good.rows.length === 4 && good.renders > 40 && good.nsPerFrame > 0);
  assert.match(formatReport(good), /synth: ok/);

  const expectFailure = (
    flaw: Parameters<typeof referenceVoice>[0],
    pattern: RegExp,
  ) => {
    const report = checkVoiceContract(referenceVoice(flaw), {
      range: [45, 81],
      step: 12,
    });
    assert.ok(
      report.failures.some((failure) => pattern.test(failure)),
      `expected a failure matching ${pattern}, got:\n${report.failures.slice(0, 6).join("\n") || "(none)"}`,
    );
  };
  expectFailure({ gainDb: 4 }, /level convention/);
  expectFailure({ gainDb: -4 }, /level convention/);
  expectFailure({ gainDb: 16 }, /exceeds 1\.0/);
  expectFailure({ cents: 18 }, /cents off/);
  expectFailure({ gate: true }, /starts at/);
  expectFailure({ gate: true }, /note-off step/);
  expectFailure({ mathRandom: true }, /Math\.random/);
  expectFailure({ overwrite: true }, /overwrites instead of adding/);
  expectFailure({ plainVelocity: true }, /as bright as/);
  expectFailure({ overrun: true }, /wrote beyond frames/);
  expectFailure({ dc: 0.05 }, /DC offset/);
  expectFailure({ endLevel: 0.02 }, /ends at/);
  expectFailure({ antiphase: true }, /correlation/);
  expectFailure({ ignoreSampleRate: true }, /at 44100 Hz/);
  expectFailure({ nan: true }, /NaN or Infinity/);
  assert.throws(
    () =>
      assertVoiceContract(referenceVoice({ cents: 30 }), {
        range: [57, 69],
        step: 12,
      }),
    /breaks the contract/,
  );
  // Math.random is restored afterwards
  assert.equal(typeof Math.random(), "number");
  // an intentionally inharmonic voice may skip tuning
  const detuned = checkVoiceContract(referenceVoice({ cents: 40 }), {
    range: [57, 69],
    step: 12,
    inharmonic: true,
  });
  assert.deepEqual(detuned.failures, []);
});

for (const id of EXEMPLARS) {
  test(`${id} honours the voice contract over its whole range`, (t) => {
    const options = VOICE_CONTRACTS[id];
    assert.ok(options, `${id} needs an entry in VOICE_CONTRACTS`);
    const report = assertVoiceContract(VOICES[id], options);
    t.diagnostic(formatReport(report));
    for (const level of report.levels)
      near(level.levelDb, -18, 1, `${id} level at midi ${level.midi}`);
    for (const row of report.rows)
      assert.ok(
        Math.abs(row.cents) < 5,
        `${id} midi ${row.midi}: ${row.cents} cents`,
      );
    assert.ok(report.worstPeak <= 1);
  });
}

test("piano: decays like a struck string, damps on release, gentle stereo", () => {
  const voice = VOICES.piano;
  const held = renderNote(voice, { midi: 57, vel: 0.8, duration: 3 });
  const early = rmsDb(held, 0, 0.1);
  const later = rmsDb(held, 0.9, 1);
  const late = rmsDb(held, 2.4, 2.5);
  assert.ok(
    early - later > 3 && early - later < 14,
    `first second falls ${early - later} dB`,
  );
  assert.ok(
    later - late > 2 && later - late < 20,
    `it keeps decaying: ${later - late} dB`,
  );
  // upper partials die first: the tone gets darker while it rings
  assert.ok(centroidHz(held, 1.5, 0.5) < centroidHz(held, 0, 0.3) * 0.85);
  // the damper: 150 ms after note-off the note is at least 25 dB down
  const short = renderNote(voice, { midi: 57, vel: 0.8, duration: 0.5 });
  assert.ok(rmsDb(short, 0.4, 0.5) - rmsDb(short, 0.65, 0.7) > 25);
  // no dampers at the very top: the note rings on after the key is released
  const top = renderNote(voice, { midi: 96, vel: 0.8, duration: 0.2 });
  assert.ok(rmsDb(top, 0.15, 0.2) - rmsDb(top, 0.35, 0.4) < 15);
  // stretched partials: the 2nd partial is sharper than 2 x the fundamental
  const high = renderNote(voice, { midi: 84, vel: 0.9, duration: 1 });
  const second = estimatePitch(
    monoSum(high),
    SAMPLE_RATE,
    2 * midiToHz(84),
    2400,
    16000,
  );
  assert.ok(
    second / (2 * midiToHz(84)) > 1.0005,
    `2nd partial ratio ${second / midiToHz(84)}`,
  );
  for (const midi of [36, 48, 60, 72]) {
    const r = renderNote(voice, { midi, vel: 0.8, duration: 1 });
    const correlation = stereoCorrelation(r);
    assert.ok(
      correlation > 0.8 && correlation < 0.995,
      `midi ${midi} correlation ${correlation}`,
    );
  }
  // a harder hit is brighter, not just louder
  const soft = renderNote(voice, { midi: 60, vel: 0.3, duration: 1 });
  const hard = renderNote(voice, { midi: 60, vel: 1, duration: 1 });
  assert.ok(centroidHz(hard) > centroidHz(soft) * 1.3);
  // bass notes keep a sane crest factor (phase dispersal)
  const bass = renderNote(voice, { midi: 28, vel: 1, duration: 1 });
  assert.ok(20 * Math.log10(peak(bass)) - loudestWindowDb(bass) < 14);
});

test("guitar: plucked decay, damped release, real bends, mild stereo", () => {
  const voice = VOICES.guitar;
  const held = renderNote(voice, { midi: 52, vel: 0.8, duration: 3 });
  assert.ok(rmsDb(held, 0, 0.1) - rmsDb(held, 0.9, 1) > 5);
  assert.ok(rmsDb(held, 2.8, 2.9) > -60, "a low string still rings after 3 s");
  assert.ok(centroidHz(held, 1.5, 0.5) < centroidHz(held, 0, 0.3) * 0.8);
  const short = renderNote(voice, { midi: 52, vel: 0.8, duration: 0.4 });
  assert.ok(
    rmsDb(short, 0.3, 0.4) - rmsDb(short, 0.55, 0.6) > 20,
    "the finger damps the string",
  );
  // a bend of +2 starts two semitones sharp and lands on the note
  const bent = renderNote(voice, { midi: 57, vel: 0.8, duration: 1, bend: 2 });
  const start = estimatePitch(
    monoSum(bent),
    SAMPLE_RATE,
    midiToHz(58.6),
    96,
    1100,
  );
  assert.ok(
    1200 * Math.log2(start / midiToHz(57)) > 110,
    `bend starts ${1200 * Math.log2(start / midiToHz(57))} cents sharp`,
  );
  near(centsError(bent, 57, 0.3, 0.5), 0, 3, "bend lands on pitch");
  for (const midi of [40, 52, 64, 76]) {
    const r = renderNote(voice, { midi, vel: 0.8, duration: 1 });
    const correlation = stereoCorrelation(r);
    assert.ok(
      correlation > 0.7 && correlation < 0.99,
      `midi ${midi} correlation ${correlation}`,
    );
    assert.ok(
      20 * Math.log10(peak(r)) - loudestWindowDb(r) < 15.5,
      `midi ${midi} crest`,
    );
  }
  // note-to-note variation exists but stays small
  const levels = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) =>
    loudestWindowDb(
      renderNote(voice, { midi: 57, vel: 0.8, duration: 1 }, SAMPLE_RATE, seed),
    ),
  );
  const spread = Math.max(...levels) - Math.min(...levels);
  assert.ok(
    spread > 0.05 && spread < 2.5,
    `level spread over seeds ${spread} dB`,
  );
});

test("pad: slow swell, steady sustain, wide but mono-safe", () => {
  const voice = VOICES.pad;
  const r = renderNote(voice, { midi: 60, vel: 0.8, duration: 3 });
  assert.ok(rmsDb(r, 0.6, 1.4) - rmsDb(r, 0, 0.05) > 15, "the attack is slow");
  near(rmsDb(r, 1.5, 3) - rmsDb(r, 0.5, 1.5), 0, 3, "sustain level");
  assert.ok(rmsDb(r, 3.3, 3.4) > -45, "the release is long");
  const correlation = stereoCorrelation(r);
  assert.ok(
    correlation > 0.4 && correlation < 0.93,
    `correlation ${correlation}`,
  );
  // mono sum loses little: no phase tricks
  const mono = monoSum(r);
  let monoPower = 0;
  let stereoPower = 0;
  for (let i = 0; i < r.frames; i++) {
    monoPower += mono[i] * mono[i];
    stereoPower += 0.5 * (r.left[i] * r.left[i] + r.right[i] * r.right[i]);
  }
  assert.ok(10 * Math.log10(monoPower / stereoPower) > -1.5);
  // warm: most energy below 2 kHz, but not a sine either
  const bands = bandEnergiesDb(r, [0, 500, 2000, 24000], 0.6, 1);
  assert.ok(bands[2] < -12 && bands[1] > -20, `bands ${bands}`);
  // velocity opens the filter and shortens the attack
  const soft = renderNote(voice, { midi: 60, vel: 0.3, duration: 2 });
  const hard = renderNote(voice, { midi: 60, vel: 1, duration: 2 });
  assert.ok(centroidHz(hard, 0.8, 1) > centroidHz(soft, 0.8, 1) * 1.15);
  assert.ok(
    rmsDb(hard, 0.1, 0.2) - rmsDb(hard, 1, 2) >
      rmsDb(soft, 0.1, 0.2) - rmsDb(soft, 1, 2),
  );
  // different seeds give different phases, the same seed the same sound
  const other = renderNote(
    voice,
    { midi: 60, vel: 0.8, duration: 3 },
    SAMPLE_RATE,
    2,
  );
  let differs = false;
  for (let i = 30000; i < 30100; i++)
    if (other.left[i] !== r.left[i]) differs = true;
  assert.ok(differs);
});

test("subBass: mono, steady, soft attack, harmonics a small speaker can play", () => {
  const voice = VOICES.subBass;
  for (const midi of [28, 33, 40]) {
    const r = renderNote(voice, { midi, vel: 0.8, duration: 1 });
    near(stereoCorrelation(r), 1, 1e-9, "mono");
    near(rmsDb(r, 0.2, 0.9), -18, 0.3, `sustain level at midi ${midi}`);
    assert.ok(dcOffset(r) < 2e-3);
    // nothing in the first 2 ms: the attack is a ramp, not a thump
    assert.ok(rmsDb(r, 0, 0.002) < -40);
    const above = bandEnergiesDb(r, [120, 24000])[0];
    assert.ok(
      above > -20 && above < -6,
      `midi ${midi}: energy above 120 Hz ${above} dB`,
    );
    assert.ok(20 * Math.log10(peak(r)) - loudestWindowDb(r) < 5);
  }
  // harder = more harmonics
  const soft = renderNote(voice, { midi: 33, vel: 0.3, duration: 1 });
  const hard = renderNote(voice, { midi: 33, vel: 1, duration: 1 });
  assert.ok(
    bandEnergiesDb(hard, [120, 24000])[0] >
      bandEnergiesDb(soft, [120, 24000])[0] + 3,
  );
  // bend glides in from below and settles
  const bent = renderNote(voice, { midi: 40, vel: 0.8, duration: 1, bend: -3 });
  near(centsError(bent, 40, 0.3, 0.5), 0, 2, "bend lands on pitch");
});

test("the voice bank is complete and every id renders clean audio", (t) => {
  assert.deepEqual([...MISSING_VOICES], []);
  assert.deepEqual([...DUPLICATE_VOICES], []);
  assert.deepEqual(Object.keys(VOICES).sort(), [...VOICE_IDS].sort());
  assert.equal(bankProblem(assembleVoiceBank([VOICES])), "");
  // every id is its own instrument: no voice stands in for another
  assert.equal(
    new Set(VOICE_IDS.map((id) => VOICES[id].render)).size,
    VOICE_IDS.length,
    "every id has its own render function",
  );
  for (const id of VOICE_IDS) {
    const voice = VOICES[id];
    assert.equal(voice.id, id);
    for (const midi of [45, 60, 72])
      for (const note of [
        { midi, vel: 0.9, duration: 0.05 },
        { midi, vel: 0.5, duration: 0.6 },
        { midi, vel: 1, duration: 1.5, bend: -2 },
      ]) {
        const what = `${id} midi ${midi} ${note.duration}s`;
        const r = renderNote(voice, note);
        assert.ok(r.guardIntact, `${what}: wrote beyond frames`);
        assert.ok(isFiniteAudio(r), `${what}: not finite`);
        assert.ok(peak(r) <= 1, `${what}: peak ${peak(r)}`);
        assert.ok(note.duration < 0.1 || peak(r) > 0.01, `${what}: silent`);
        const clicks = checkClicks(r, { startJump: 0.35 });
        assert.ok(clicks.ok, `${what}: ${clicks.problems.join("; ")}`);
        const again = renderNote(voice, note);
        assert.deepEqual(again.left, r.left, `${what}: not deterministic`);
      }
  }
});

test("voices and drums survive any buffer length and out-of-range notes", () => {
  const ctx = () => ({ sampleRate: SAMPLE_RATE, random: createRng(3) });
  const check = (
    what: string,
    left: Float32Array,
    right: Float32Array,
    frames: number,
  ) => {
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
  };
  const notes = [
    { midi: 60, vel: 0.8, duration: 1 },
    { midi: 60, vel: 0, duration: 0 },
    { midi: 12, vel: 1.5, duration: 0.01 },
    { midi: 127, vel: 1, duration: 0.5, bend: 12 },
    { midi: -5, vel: 0.5, duration: 0.2, bend: -7 },
  ];
  for (const id of VOICE_IDS)
    for (const frames of [1, 2, 7, 64, 300, 2000])
      for (const note of notes) {
        const left = new Float32Array(frames + 8);
        const right = new Float32Array(frames + 8);
        VOICES[id].render(left, right, frames, note, ctx());
        check(
          `${id} ${frames} frames ${JSON.stringify(note)}`,
          left,
          right,
          frames,
        );
        const tail = VOICES[id].tail(note);
        assert.ok(
          Number.isFinite(tail) && tail >= 0 && tail <= 8,
          `${id}: tail ${tail}`,
        );
      }
  for (const kit of DRUM_KITS)
    for (const kind of DRUM_KINDS)
      for (const frames of [1, 2, 9, 100, 5000])
        for (const vel of [0, 0.5, 2]) {
          const left = new Float32Array(frames + 8);
          const right = new Float32Array(frames + 8);
          DRUMS.render(left, right, frames, kind, kit, vel, ctx());
          check(
            `${kit}/${kind} ${frames} frames vel ${vel}`,
            left,
            right,
            frames,
          );
        }
});

test("an incomplete bank is reported, and its holes throw when used", () => {
  const partial = assembleVoiceBank([KEYS_VOICES]);
  assert.ok(
    partial.missing.includes("guitar") && partial.missing.includes("subBass"),
  );
  assert.ok(!partial.missing.includes("piano"));
  assert.match(bankProblem(partial), /missing: \[.*guitar.*\]/);
  const bank = completeBank(partial);
  assert.equal(bank.piano, KEYS_VOICES.piano);
  assert.throws(
    () => bank.guitar.tail({ midi: 60, vel: 1, duration: 1 }),
    /not implemented/,
  );
  assert.throws(
    () =>
      bank.pad.render(
        new Float32Array(8),
        new Float32Array(8),
        8,
        { midi: 60, vel: 1, duration: 0 },
        {
          sampleRate: SAMPLE_RATE,
          random: () => 0.5,
        },
      ),
    /"pad" is not implemented/,
  );
  const doubled = assembleVoiceBank([
    KEYS_VOICES,
    BASS_VOICES,
    { piano: BASS_VOICES.subBass },
  ]);
  assert.deepEqual(doubled.duplicates, ["piano"]);
  assert.ok(
    doubled.missing.includes("piano"),
    "a voice filed under the wrong id counts as missing",
  );
  assert.equal(bankProblem(assembleVoiceBank([VOICES])), "");
});

test("drums through the voice harness: every kind of every kit is finite, bounded and click-free", () => {
  for (const kit of DRUM_KITS)
    for (const kind of DRUM_KINDS) {
      const length = DRUMS.length(kind, kit);
      assert.ok(
        Number.isFinite(length) && length > 0.01 && length < 4,
        `${kit}/${kind} length ${length}`,
      );
      for (const vel of [0.3, 1])
        for (const sampleRate of [SAMPLE_RATE, 44100]) {
          const what = `${kit}/${kind} vel ${vel} @${sampleRate}`;
          const r = renderDrum(DRUMS, kind, kit, vel, sampleRate);
          assert.equal(r.frames, Math.ceil(length * sampleRate));
          assert.ok(r.guardIntact, `${what}: wrote beyond frames`);
          assert.ok(isFiniteAudio(r), `${what}: not finite`);
          const p = peak(r);
          assert.ok(p <= 1 && p > 0.02, `${what}: peak ${p}`);
          // noise hits step by nature: only "starts at zero, ends at zero, stays in range" applies
          const clicks = checkClicks(r, {
            startJump: 2,
            maxJump: 2,
            releaseJumpRatio: 0,
          });
          assert.ok(clicks.ok, `${what}: ${clicks.problems.join("; ")}`);
          assert.ok(dcOffset(r) < 0.02, `${what}: DC ${dcOffset(r)}`);
        }
      const a = renderDrum(DRUMS, kind, kit, 0.8);
      const b = renderDrum(DRUMS, kind, kit, 0.8);
      assert.deepEqual(a.left, b.left, `${kit}/${kind}: not deterministic`);
      const added = renderDrum(DRUMS, kind, kit, 0.8, SAMPLE_RATE, 1, 0.25);
      for (let i = 0; i < a.frames; i += 97)
        near(
          added.left[i] - 0.25,
          a.left[i],
          1e-5,
          `${kit}/${kind}: adds into the buffer`,
        );
      // louder when hit harder
      assert.ok(
        peak(renderDrum(DRUMS, kind, kit, 1)) >
          peak(renderDrum(DRUMS, kind, kit, 0.4)) * 1.5,
      );
    }
  // kick, snare and hat sit where they belong (the kits themselves are covered by tests/drums.test.ts)
  const kick = renderDrum(DRUMS, "kick", "pop", 1);
  const snare = renderDrum(DRUMS, "snare", "pop", 1);
  const hat = renderDrum(DRUMS, "hatClosed", "pop", 1);
  assert.ok(centroidHz(kick, 0, 0.3) < 400);
  assert.ok(
    centroidHz(snare, 0, 0.2) > 800 && centroidHz(snare, 0, 0.2) < 6000,
  );
  assert.ok(centroidHz(hat, 0, 0.05) > 6000);
});

test("render cost: every exemplar is far faster than real time", (t) => {
  const realTime = 1e9 / SAMPLE_RATE;
  for (const id of EXEMPLARS) {
    const [low, high] = VOICE_CONTRACTS[id]?.range ?? [36, 96];
    let worst = 0;
    const parts: string[] = [];
    for (const midi of [low, Math.round((low + high) / 2), high]) {
      const cost = measureCost(VOICES[id], { midi, vel: 0.8, duration: 1 }, 5);
      worst = Math.max(worst, cost);
      parts.push(
        `midi ${midi}: ${cost.toFixed(1)} ns/frame (${(realTime / cost).toFixed(0)}x)`,
      );
    }
    t.diagnostic(`${id} — ${parts.join(", ")}`);
    // generous bound (30x real time) so a loaded machine cannot make this flaky
    assert.ok(worst < realTime / 30, `${id}: ${worst.toFixed(0)} ns per frame`);
  }
});
