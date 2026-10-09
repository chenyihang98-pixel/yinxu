import test from "node:test";
import assert from "node:assert/strict";
import {
  Adsr,
  Allpass1,
  Biquad,
  biquadChain,
  DcBlocker,
  DelayLine,
  ExpDecay,
  FmOperator,
  KarplusString,
  LfsrNoise,
  MIN_FALL,
  MIN_RAMP,
  ModalBank,
  OnePoleHP,
  OnePoleLP,
  Oscillator,
  Oversampler2x,
  PinkNoise,
  SegmentEnvelope,
  Svf,
  TAU,
  WhiteNoise,
  addSaw,
  adsr,
  allpassCoefForDelay,
  allpassPhaseDelay,
  bandPower,
  bendOffset,
  centsBetween,
  clamp,
  createRng,
  cubicSat,
  dbToGain,
  decayingPartialsRms,
  equalPowerPan,
  fadeIn,
  fadeOut,
  fastTanh,
  fft,
  forkRng,
  gainToDb,
  hashSeed,
  hzToMidi,
  lerp,
  makePluck,
  midiToHz,
  pluckLength,
  pluckSpectrum,
  powerSpectrum,
  pulseBlep,
  saturateBlock,
  sawBlep,
  sawNaive,
  scratch,
  sinTurns,
  spectralCentroid,
  svfLowpassGain,
  t60ToCoef,
  tanhDrive,
  triBlamp,
  velocityGain,
} from "../src/audio/dsp";
// amplitude and phase of one spectral line — as two numbers, for a reason: see the file
import { amplitudeAt, measureLine, phaseAt } from "./helpers/spectrum";

const SR = 48000;
const dB = (gain: number) => 20 * Math.log10(Math.max(gain, 1e-12));
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

/** Precise frequency of the partial near `guessHz` from the phase advance between two windows. */
function measureHz(
  signal: ArrayLike<number>,
  guessHz: number,
  sampleRate: number,
  start: number,
  length: number,
  hop: number,
): number {
  const a = phaseAt(signal, guessHz, sampleRate, start, length);
  const b = phaseAt(signal, guessHz, sampleRate, start + hop, length);
  let delta = b - a;
  delta -= TAU * Math.round(delta / TAU);
  return guessHz + (delta * sampleRate) / (TAU * hop);
}

/** Gain of a linear filter at `hz` measured from its impulse response. */
function gainAt(
  next: (x: number) => number,
  hz: number,
  sampleRate = SR,
  length = 32768,
): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < length; i++) {
    const y = next(i === 0 ? 1 : 0);
    const angle = (TAU * hz * i) / sampleRate;
    re += y * Math.cos(angle);
    im -= y * Math.sin(angle);
  }
  return Math.hypot(re, im);
}

/**
 * Power below `maxHz` that is NOT within ±`guard` bins of a harmonic of f0:
 * what aliasing adds. 10 kHz keeps the measurement to the range where folded
 * partials are clearly audible.
 */
function inharmonicPower(
  signal: Float32Array,
  f0: number,
  maxHz = 10000,
): number {
  const spectrum = powerSpectrum(signal, SR);
  const guard = 6;
  let power = 0;
  for (let k = 1; k < spectrum.power.length; k++) {
    const hz = k * spectrum.binHz;
    if (hz > maxHz) break;
    const harmonic = Math.round(hz / f0);
    const distance = Math.abs(hz - harmonic * f0) / spectrum.binHz;
    if (harmonic >= 1 && distance <= guard) continue;
    power += spectrum.power[k];
  }
  return power;
}

test("math helpers: pitch, decibels, pan law", () => {
  near(midiToHz(69), 440, 1e-9, "A4");
  near(midiToHz(57), 220, 1e-9, "A3");
  near(midiToHz(60), 261.6255653, 1e-6, "C4");
  near(hzToMidi(midiToHz(43.37)), 43.37, 1e-9, "round trip");
  near(dbToGain(-6.0206), 0.5, 1e-5, "-6 dB");
  near(gainToDb(dbToGain(-18)), -18, 1e-9, "dB round trip");
  near(centsBetween(midiToHz(70), midiToHz(69)), 100, 1e-9, "semitone");
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(lerp(2, 4, 0.25), 2.5);
  for (const pan of [-1, -0.4, 0, 0.3, 1]) {
    const [l, r] = equalPowerPan(pan);
    near(l * l + r * r, 1, 1e-12, `pan ${pan} power`);
  }
  near(equalPowerPan(0)[0], Math.SQRT1_2, 1e-12, "centre");
  near(equalPowerPan(-1)[1], 0, 1e-12, "hard left");
  near(Math.pow(t60ToCoef(0.5, SR), 0.5 * SR), 0.001, 1e-6, "t60 coefficient");
  near(velocityGain(0.8), 1, 1e-12, "reference velocity");
  near(velocityGain(0.4), Math.pow(0.5, 1.5), 1e-12, "velocity law");
  assert.equal(bendOffset(2, 0), 2);
  assert.equal(bendOffset(2, 0.07), 0);
  assert.ok(bendOffset(-3, 0.035) < -1.4 && bendOffset(-3, 0.035) > -1.6);
  assert.equal(bendOffset(undefined, 0.01), 0);
});

test("seeded random streams are repeatable, uniform and forkable", () => {
  const a = createRng(7);
  const b = createRng(7);
  const c = createRng(8);
  const one = Array.from({ length: 64 }, () => a());
  assert.deepEqual(
    one,
    Array.from({ length: 64 }, () => b()),
  );
  assert.notDeepEqual(
    one,
    Array.from({ length: 64 }, () => c()),
  );
  const rng = createRng(123);
  let sum = 0;
  for (let i = 0; i < 100000; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1);
    sum += v;
  }
  near(sum / 100000, 0.5, 0.01, "mean");
  // a fork consumes exactly one parent value
  const p1 = createRng(99);
  const p2 = createRng(99);
  const child = forkRng(p1);
  p2();
  assert.equal(p1(), p2());
  assert.equal(typeof child(), "number");
  assert.equal(hashSeed(1, 2.5, 3), hashSeed(1, 2.5, 3));
  assert.notEqual(hashSeed(1, 2.5, 3), hashSeed(1, 2.25, 3));
});

test("wavetable sine is accurate for any phase", () => {
  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const turns = (i - 10000) * 0.000731;
    worst = Math.max(worst, Math.abs(sinTurns(turns) - Math.sin(TAU * turns)));
  }
  assert.ok(worst < 1e-6, `worst sine error ${worst}`);
  assert.ok(Number.isFinite(sinTurns(-1e-18)) && Number.isFinite(sinTurns(1)));
  const osc = new Oscillator(1000, SR);
  const buffer = new Float32Array(4800);
  for (let i = 0; i < buffer.length; i++) buffer[i] = osc.sine();
  near(amplitudeAt(buffer, 1000, SR), 1, 1e-3, "sine amplitude");
});

test("PolyBLEP saw / pulse and PolyBLAMP triangle alias far less than naive shapes", () => {
  const n = 32768;
  for (const hz of [1244.5, 2093, 3520]) {
    const inc = hz / SR;
    const naive = new Float32Array(n);
    const blep = new Float32Array(n);
    const naivePulse = new Float32Array(n);
    const pulse = new Float32Array(n);
    const naiveTri = new Float32Array(n);
    const tri = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      naive[i] = sawNaive(phase);
      blep[i] = sawBlep(phase, inc);
      naivePulse[i] = phase < 0.25 ? 1.5 : -0.5;
      pulse[i] = pulseBlep(phase, inc, 0.25);
      const u = (phase + 0.25) % 1;
      naiveTri[i] = 1 - 4 * Math.abs(u - 0.5);
      tri[i] = triBlamp(phase, inc);
      phase += inc;
      if (phase >= 1) phase -= 1;
    }
    const sawGain = dB(
      Math.sqrt(inharmonicPower(naive, hz) / inharmonicPower(blep, hz)),
    );
    const pulseGain = dB(
      Math.sqrt(inharmonicPower(naivePulse, hz) / inharmonicPower(pulse, hz)),
    );
    const triGain = dB(
      Math.sqrt(inharmonicPower(naiveTri, hz) / inharmonicPower(tri, hz)),
    );
    assert.ok(
      sawGain > 28,
      `saw ${hz} Hz: aliasing only ${sawGain.toFixed(1)} dB lower`,
    );
    assert.ok(
      pulseGain > 28,
      `pulse ${hz} Hz: aliasing only ${pulseGain.toFixed(1)} dB lower`,
    );
    if (hz > 2000)
      assert.ok(
        triGain > 10,
        `triangle ${hz} Hz: aliasing only ${triGain.toFixed(1)} dB lower`,
      );
    // even counting everything up to Nyquist the band-limited saw is far cleaner
    const fullBand = dB(
      Math.sqrt(
        inharmonicPower(naive, hz, 24000) / inharmonicPower(blep, hz, 24000),
      ),
    );
    assert.ok(
      fullBand > 12,
      `saw ${hz} Hz full band: ${fullBand.toFixed(1)} dB`,
    );
    // the wanted harmonics keep their textbook amplitudes
    near(
      dB(amplitudeAt(blep, hz, SR)),
      dB(2 / Math.PI),
      0.3,
      "saw fundamental",
    );
    // (PolyBLEP droops a little towards Nyquist)
    near(
      dB(amplitudeAt(blep, 2 * hz, SR)),
      dB(1 / Math.PI),
      1,
      "saw 2nd harmonic",
    );
    near(
      dB(amplitudeAt(tri, hz, SR)),
      dB(8 / (Math.PI * Math.PI)),
      0.3,
      "triangle fundamental",
    );
    near(
      dB(amplitudeAt(pulse, hz, SR)),
      dB((4 / Math.PI) * Math.sin(Math.PI * 0.25)),
      0.3,
      "25 % pulse fundamental",
    );
  }
  // zero-mean for every width, triangle starts at zero, block renderer matches the kernel
  for (const width of [0.125, 0.25, 0.5, 0.8]) {
    const osc = new Oscillator(200, SR); // whole cycles per second
    let sum = 0;
    for (let i = 0; i < SR; i++) sum += osc.pulse(width);
    assert.ok(Math.abs(sum / SR) < 2e-3, `pulse width ${width} DC ${sum / SR}`);
  }
  assert.ok(Math.abs(triBlamp(0, 440 / SR)) < 1e-9);
  const block = new Float32Array(256);
  const end = addSaw(block, 256, 0.1, 0.01, 0.5);
  let phase = 0.1;
  for (let i = 0; i < 256; i++) {
    near(block[i], 0.5 * sawBlep(phase, 0.01), 1e-6, "addSaw sample");
    phase += 0.01;
    if (phase >= 1) phase -= 1;
  }
  near(end, phase, 1e-9, "addSaw end phase");
});

test("noise sources: white is flat, pink falls 3 dB per octave, LFSR has console periods", () => {
  const white = new WhiteNoise(42);
  const again = new WhiteNoise(42);
  const n = 1 << 17;
  const buffer = new Float32Array(n);
  let sum = 0;
  let square = 0;
  for (let i = 0; i < n; i++) {
    const v = white.next();
    assert.ok(v >= -1 && v < 1);
    buffer[i] = v;
    sum += v;
    square += v * v;
    if (i < 64) assert.equal(v, again.next());
  }
  near(sum / n, 0, 0.01, "white mean");
  near(Math.sqrt(square / n), 1 / Math.sqrt(3), 0.01, "white RMS");
  const flat = powerSpectrum(buffer, SR);
  const low = bandPower(flat, 1000, 5000);
  const high = bandPower(flat, 15000, 19000);
  near(dB(Math.sqrt(high / low)), 0, 0.5, "white tilt");
  const filled = new Float32Array(16);
  new WhiteNoise(5).fill(filled, 16, 0.5);
  const reference = new WhiteNoise(5);
  for (let i = 0; i < 16; i++)
    near(filled[i], 0.5 * reference.next(), 1e-7, "fill");

  const pink = new PinkNoise(createRng(3));
  const pinkBuffer = new Float32Array(n);
  let pinkPeak = 0;
  for (let i = 0; i < n; i++) {
    pinkBuffer[i] = pink.next();
    pinkPeak = Math.max(pinkPeak, Math.abs(pinkBuffer[i]));
  }
  assert.ok(pinkPeak < 1 && pinkPeak > 0.5, `pink peak ${pinkPeak}`);
  const spectrum = powerSpectrum(pinkBuffer, SR);
  const octaves = [100, 200, 400, 800, 1600, 3200, 6400, 12800];
  const levels = octaves
    .slice(0, -1)
    .map((hz, i) => dB(Math.sqrt(bandPower(spectrum, hz, octaves[i + 1]))));
  const spread = Math.max(...levels) - Math.min(...levels);
  assert.ok(
    spread < 2.5,
    `pink octave levels spread ${spread.toFixed(2)} dB: ${levels.map((v) => v.toFixed(1))}`,
  );

  for (const [short, period] of [
    [false, 32767],
    [true, 93],
  ] as const) {
    const lfsr = new LfsrNoise(SR, SR, short);
    const values: number[] = [];
    for (let i = 0; i < period * 2; i++) {
      const v = lfsr.next();
      assert.ok(v === 1 || v === -1);
      values.push(v);
    }
    for (let i = 0; i < period; i++)
      assert.equal(values[i], values[i + period]);
  }
});

test("envelopes start and end at zero and never step", () => {
  const frames = SR;
  const env = new Float32Array(frames);
  const cases = [
    { attack: 0, decay: 0.1, sustain: 0.6, release: 0, hold: 0.5 },
    { attack: 0.01, decay: 0.3, sustain: 0.2, release: 0.2, hold: 0.4 },
    {
      attack: 0.3,
      decay: 0.5,
      sustain: 1,
      release: 0.4,
      hold: 0.05,
      attackShape: "cos" as const,
    },
    {
      attack: 0.02,
      decay: 0.2,
      sustain: 0.8,
      release: 3,
      hold: 0.9,
      attackShape: "lin" as const,
    },
    { attack: 0.002, decay: 0.05, sustain: 0, release: 0.05, hold: 0.999 },
  ];
  for (const params of cases) {
    adsr(env, frames, SR, params, params.hold);
    assert.ok(env[0] < 0.03, `first value ${env[0]}`);
    assert.equal(env[frames - 1], 0);
    let step = 0;
    let peak = 0;
    for (let i = 1; i < frames; i++) {
      assert.ok(env[i] >= 0 && env[i] <= 1);
      step = Math.max(step, Math.abs(env[i] - env[i - 1]));
      peak = Math.max(peak, env[i]);
    }
    assert.ok(
      step < 0.03,
      `largest step ${step} for ${JSON.stringify(params)}`,
    );
    assert.ok(peak > 0.05);
  }
  // nominal shape: reaches 1 after the attack, settles on sustain, silent after the release
  adsr(
    env,
    frames,
    SR,
    { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.1 },
    0.5,
  );
  near(env[Math.round(0.01 * SR) + 2], 1, 0.02, "attack peak");
  near(env[Math.round(0.4 * SR)], 0.5, 1e-3, "sustain");
  assert.equal(env[Math.round(0.6 * SR) + 2], 0);
  assert.ok(
    env[Math.round(0.59 * SR)] < 0.002 && env[Math.round(0.55 * SR)] > 0.005,
  );
  // a buffer shorter than the release still ends on zero without a jump
  const short = new Float32Array(600);
  adsr(
    short,
    600,
    SR,
    { attack: 0.001, decay: 1, sustain: 1, release: 2 },
    0.005,
  );
  assert.equal(short[599], 0);
  for (let i = 1; i < 600; i++)
    assert.ok(Math.abs(short[i] - short[i - 1]) < 0.03);

  // streaming use
  const live = new Adsr(SR, {
    attack: 0.005,
    decay: 0.05,
    sustain: 0.7,
    release: 0.02,
  });
  assert.equal(live.next(), 0);
  live.gate();
  for (let i = 0; i < 0.2 * SR; i++) live.next();
  near(live.value, 0.7, 1e-6, "streamed sustain");
  live.release();
  let count = 0;
  while (!live.done && count < SR) {
    live.next();
    count++;
  }
  assert.ok(
    count <= Math.ceil(0.02 * SR) + 1 && count > 0.01 * SR,
    `release took ${count}`,
  );
  // a zero release is raised to MIN_FALL instead of gating
  live.set({ attack: 0, decay: 0, sustain: 1, release: 0 });
  live.gate();
  for (let i = 0; i < 1000; i++) live.next();
  live.release();
  count = 0;
  while (!live.done && count < SR) {
    live.next();
    count++;
  }
  near(count, MIN_FALL * SR, 2, "minimum release length");
  assert.equal(live.value, 0);
  assert.ok(MIN_RAMP >= 0.001 && MIN_RAMP <= 0.002 && MIN_FALL >= MIN_RAMP);

  const decay = new ExpDecay(0.25, SR);
  for (let i = 0; i < 0.25 * SR; i++) decay.next();
  near(decay.value, 0.001, 2e-5, "ExpDecay T60");

  const segments = new SegmentEnvelope(SR, 0, [
    { to: 1, time: 0.01 },
    { to: 0.25, time: 0.1, curve: 4 },
    { to: 0, time: 0.05, curve: -3 },
  ]);
  const shape = new Float32Array(SR / 2);
  segments.render(shape, shape.length);
  near(shape[479], 1, 1e-6, "segment 1 target");
  near(shape[479 + 4800], 0.25, 1e-6, "segment 2 target");
  near(shape[479 + 4800 + 2400], 0, 1e-6, "segment 3 target");
  assert.equal(shape[shape.length - 1], 0);
  // exponential segment is ahead of a straight line early on
  assert.ok(shape[479 + 1200] < 1 - 0.75 * 0.25 - 0.1);

  const ones = new Float32Array(1000).fill(1);
  fadeIn(ones, 1000, 100);
  fadeOut(ones, 1000, 200);
  assert.equal(ones[0], 0);
  assert.ok(Math.abs(ones[999]) < 1e-12);
  assert.equal(ones[500], 1);
  for (let i = 1; i < 1000; i++)
    assert.ok(Math.abs(ones[i] - ones[i - 1]) < 0.02);
});

test("one-pole, biquad and state-variable filters match their ideal responses", () => {
  const lp1 = new OnePoleLP(1000, SR);
  near(dB(gainAt((x) => lp1.next(x), 1000)), -3.01, 0.02, "one-pole LP corner");
  lp1.reset();
  near(dB(gainAt((x) => lp1.next(x), 50)), 0, 0.05, "one-pole LP passband");
  lp1.reset();
  near(
    dB(gainAt((x) => lp1.next(x), 8000)),
    dB(lp1.magnitude(8000, SR)),
    0.01,
    "one-pole LP model",
  );
  assert.ok(
    dB(lp1.magnitude(8000, SR)) < -16 && dB(lp1.magnitude(8000, SR)) > -20,
  );

  const hp1 = new OnePoleHP(500, SR);
  near(dB(gainAt((x) => hp1.next(x), 500)), -3.01, 0.02, "one-pole HP corner");
  hp1.reset();
  near(dB(gainAt((x) => hp1.next(x), 20000)), 0, 0.01, "one-pole HP passband");
  hp1.reset();
  near(
    dB(gainAt((x) => hp1.next(x), 50)),
    dB(hp1.magnitude(50, SR)),
    0.01,
    "one-pole HP model",
  );
  assert.ok(dB(hp1.magnitude(50, SR)) < -19 && dB(hp1.magnitude(50, SR)) > -21);

  const q = Math.SQRT1_2;
  const bq = new Biquad();
  const measure = (hz: number) => {
    bq.reset();
    return dB(gainAt((x) => bq.next(x), hz));
  };
  bq.setLowpass(1000, q, SR);
  near(measure(100), 0, 0.05, "biquad LP passband");
  near(measure(1000), -3.01, 0.05, "biquad LP corner");
  near(measure(4000), -24.4, 0.6, "biquad LP 2 octaves up");
  near(measure(4000), dB(bq.magnitude(4000, SR)), 0.01, "biquad LP model");
  bq.setHighpass(1000, q, SR);
  near(measure(10000), 0, 0.05, "biquad HP passband");
  near(measure(1000), -3.01, 0.05, "biquad HP corner");
  near(measure(250), -24.1, 0.3, "biquad HP 2 octaves down");
  bq.setBandpass(2000, 4, SR);
  near(measure(2000), 0, 0.05, "biquad BP centre");
  assert.ok(measure(500) < -20 && measure(8000) < -20);
  bq.setNotch(3000, 5, SR);
  assert.ok(measure(3000) < -60);
  near(measure(300), 0, 0.1, "notch passband");
  bq.setAllpass(1500, 1, SR);
  for (const hz of [100, 1500, 9000])
    near(measure(hz), 0, 0.01, `allpass ${hz}`);
  bq.setPeak(1000, 2, 6, SR);
  near(measure(1000), 6, 0.05, "peak centre");
  near(measure(100), 0, 0.15, "peak far below");
  near(measure(10000), 0, 0.15, "peak far above");
  bq.setPeak(1000, 2, -9, SR);
  near(measure(1000), -9, 0.05, "cut centre");
  bq.setLowShelf(300, 6, SR);
  near(measure(20), 6, 0.1, "low shelf plateau");
  near(measure(300), 3, 0.1, "low shelf corner");
  near(measure(8000), 0, 0.05, "low shelf far side");
  bq.setHighShelf(4000, -8, SR);
  near(measure(20000), -8, 0.15, "high shelf plateau");
  near(measure(4000), -4, 0.1, "high shelf corner");
  near(measure(100), 0, 0.05, "high shelf far side");

  // block processing equals per-sample processing
  const noise = new WhiteNoise(1);
  const a = new Float32Array(512);
  noise.fill(a, 512);
  const b = Float32Array.from(a);
  const f1 = new Biquad().setPeak(700, 3, 5, SR);
  const f2 = new Biquad().setPeak(700, 3, 5, SR);
  f1.process(a, 512);
  for (let i = 0; i < 512; i++) near(a[i], f2.next(b[i]), 1e-6, "biquad block");

  // TPT SVF: same magnitude as the RBJ prototypes away from Nyquist, and its own model
  const svf = new Svf(1000, q, SR);
  bq.setLowpass(1000, q, SR);
  for (const hz of [100, 1000, 3000]) {
    svf.reset();
    const low = dB(gainAt((x) => svf.low(x), hz));
    near(low, dB(bq.magnitude(hz, SR)), 0.05, `svf LP ${hz}`);
    near(low, dB(svf.magnitude(hz, SR)), 0.01, `svf LP model ${hz}`);
    near(
      low,
      dB(svfLowpassGain(hz, 1000, q, SR)),
      0.01,
      `svf LP gain helper ${hz}`,
    );
  }
  bq.setHighpass(1000, q, SR);
  for (const hz of [200, 1000, 6000]) {
    svf.reset();
    near(
      dB(gainAt((x) => svf.high(x), hz)),
      dB(bq.magnitude(hz, SR)),
      0.05,
      `svf HP ${hz}`,
    );
  }
  svf.set(2000, 5, SR);
  svf.reset();
  near(
    dB(gainAt((x) => svf.band(x), 2000)),
    dB(5),
    0.05,
    "svf BP peak gain is q",
  );
  svf.reset();
  svf.tick(1);
  assert.ok(Number.isFinite(svf.lp + svf.bp + svf.hp));
  near(
    svf.lp + 0.2 * svf.bp + svf.hp,
    1,
    1e-9,
    "svf outputs reconstruct the input",
  );

  // violent audio-rate modulation with high resonance stays bounded
  const wild = new Svf(1000, 12, SR);
  const rng = createRng(11);
  const source = new WhiteNoise(2);
  let worst = 0;
  for (let i = 0; i < 200000; i++) {
    wild.set(40 * Math.pow(450, rng()), 12, SR);
    worst = Math.max(worst, Math.abs(wild.low(source.next())));
  }
  assert.ok(
    Number.isFinite(worst) && worst < 60,
    `modulated SVF peak ${worst}`,
  );

  const dc = new DcBlocker(SR, 20);
  let last = 1;
  for (let i = 0; i < SR; i++) last = dc.next(1);
  assert.ok(Math.abs(last) < 1e-3, `DC after 1 s: ${last}`);
  dc.reset();
  near(dB(gainAt((x) => dc.next(x), 1000)), 0, 0.01, "DC blocker passband");

  // allpass delay helpers agree with a real allpass
  for (const delay of [0.2, 0.5, 0.83, 1.19]) {
    const omega = (TAU * 440) / SR;
    const coef = allpassCoefForDelay(delay, omega);
    near(
      allpassPhaseDelay(coef, omega),
      delay,
      1e-9,
      `allpass coefficient for ${delay}`,
    );
    const ap = new Allpass1(coef);
    const out = new Float32Array(9600);
    for (let i = 0; i < out.length; i++) out[i] = ap.next(Math.sin(omega * i));
    const phase = phaseAt(out, 440, SR, 4800, 4800);
    const reference = phaseAt(
      Float32Array.from({ length: 9600 }, (_, i) => Math.sin(omega * i)),
      440,
      SR,
      4800,
      4800,
    );
    let lag = (reference - phase) / omega;
    lag -= Math.round(lag / (TAU / omega)) * (TAU / omega);
    // (should this ever fail again: the numbers that tell a filter fault from a measuring fault)
    near(
      lag,
      delay,
      1e-3,
      `measured allpass delay ${delay} (coefficient ${coef}, phase ${phase} against ${reference}, out[4800] = ${out[4800]})`,
    );
    near(amplitudeAt(out, 440, SR, 4800, 4800), 1, 1e-4, "allpass gain");
  }
});

test("biquadChain gives the samples of reset() + process() on every filter, bit for bit, for any chain length", () => {
  const sampleRate = 48000;
  const designs = [
    () => new Biquad().setHighpass(45, 0.7, sampleRate),
    () => new Biquad().setPeak(285, 3, 3, sampleRate),
    () => new Biquad().setPeak(470, 3.5, 3.5, sampleRate),
    () => new Biquad().setPeak(1350, 1.2, -2.5, sampleRate),
    () => new Biquad().setPeak(2500, 1.3, 4.5, sampleRate),
    () => new Biquad().setHighShelf(1000, 7, sampleRate, 0.5),
    () => new Biquad().setAllpass(210, 0.8, sampleRate),
    () => new Biquad().setAllpass(640, 1, sampleRate),
    () => new Biquad().setAllpass(1900, 1, sampleRate),
    () => new Biquad().setLowpass(5200, 0.7, sampleRate),
    () => new Biquad().setNotch(3000, 4, sampleRate),
  ];
  const random = createRng(77);
  const frames = 6000;
  const source = Float32Array.from({ length: frames }, (_, i) =>
    i < 4000 ? 0.4 * Math.sin(i * 0.031) + 0.5 * (random() - 0.5) : 0,
  );
  for (let count = 0; count <= designs.length; count++) {
    const filters = designs.slice(0, count).map((design) => design());
    // the filters are in use elsewhere: the chain must neither need nor disturb their state
    for (const filter of filters) filter.next(0.3);
    const expected = Float32Array.from(source);
    for (const design of designs.slice(0, count))
      design().process(expected, frames);
    const chained = Float32Array.from(source);
    biquadChain(filters, chained, frames);
    assert.deepEqual(chained, expected, `${count} sections`);
    // only the first n frames are touched
    const partial = Float32Array.from(source);
    biquadChain(filters, partial, 1000);
    assert.deepEqual(partial.subarray(0, 1000), expected.subarray(0, 1000));
    assert.deepEqual(partial.subarray(1000), source.subarray(1000));
    // and the filters still continue from where they were
    filters.forEach((filter, index) => {
      const twin = designs[index]();
      twin.next(0.3);
      assert.equal(filter.next(0.1), twin.next(0.1));
    });
  }
});

test("delay line taps: integer exact, fractional accurate", () => {
  const line = new DelayLine(1000);
  for (let i = 0; i < 300; i++) line.write(i);
  assert.equal(line.read(1), 299);
  assert.equal(line.read(100), 200);
  near(line.readLinear(10.25), 289.75, 1e-9, "linear tap on a ramp");
  near(line.readCubic(10.25), 289.75, 1e-9, "cubic tap on a ramp");

  const hz = 1000;
  const omega = (TAU * hz) / SR;
  const delays = [37.5, 100.37, 201.9];
  for (const delay of delays) {
    const linear = new DelayLine(512);
    const cubic = new DelayLine(512);
    const allpass = new DelayLine(512);
    let errLinear = 0;
    let errCubic = 0;
    let errAllpass = 0;
    for (let i = 0; i < 8000; i++) {
      const x = Math.sin(omega * i);
      linear.write(x);
      cubic.write(x);
      allpass.write(x);
      // after write(x[i]) a tap of d returns x[i + 1 - d]
      const ideal = Math.sin(omega * (i + 1 - delay));
      const ap = allpass.readAllpass(delay);
      if (i < 4000) continue;
      errLinear = Math.max(
        errLinear,
        Math.abs(linear.readLinear(delay) - ideal),
      );
      errCubic = Math.max(errCubic, Math.abs(cubic.readCubic(delay) - ideal));
      errAllpass = Math.max(errAllpass, Math.abs(ap - ideal));
    }
    assert.ok(errLinear < 3e-3, `linear error ${errLinear} at ${delay}`);
    assert.ok(errCubic < 2e-4, `cubic error ${errCubic} at ${delay}`);
    assert.ok(errAllpass < 2e-3, `allpass error ${errAllpass} at ${delay}`);
  }
  line.clear();
  assert.equal(line.read(5), 0);
});

test("Karplus-Strong string is in tune within a few cents and decays as requested", () => {
  const notes = [40, 45, 52, 57, 64, 69, 76, 81, 88, 96];
  const configs = [
    { coef: 0, sections: 0 },
    { coef: -0.35, sections: 2 },
    { coef: -0.7, sections: 4 },
  ];
  const excitation = new Float32Array(8192);
  for (const sampleRate of [48000, 44100]) {
    for (const config of configs) {
      for (const midi of notes) {
        const hz = midiToHz(midi);
        const string = new KarplusString(sampleRate, 60);
        string.setFrequency(hz);
        string.setDispersion(config.coef, config.sections);
        string.setDecay(4, 0.6, 5000);
        const options = {
          sampleRate,
          period: string.period,
          position: 0.21,
          bodyHz: hz * 2,
          hardnessHz: 5000,
          noise: 0.3,
        };
        const length = makePluck(excitation, options, createRng(midi));
        assert.equal(length, pluckLength(options));
        string.excite(excitation, length);
        const out = new Float32Array(sampleRate);
        for (let i = 0; i < out.length; i++) out[i] = string.next();
        const window = Math.round(sampleRate * 0.3);
        const measured = measureHz(
          out,
          hz,
          sampleRate,
          Math.round(sampleRate * 0.1),
          window,
          2048,
        );
        const cents = centsBetween(measured, hz);
        assert.ok(
          Math.abs(cents) < 1.5,
          `midi ${midi} @${sampleRate} dispersion ${config.coef}x${config.sections}: ${cents.toFixed(2)} cents`,
        );
        let peak = 0;
        for (let i = 0; i < out.length; i++)
          peak = Math.max(peak, Math.abs(out[i]));
        assert.ok(Number.isFinite(peak) && peak > 0 && peak < 4);
      }
    }
  }

  // decay: the fundamental loses 60 dB per requested T60, upper partials sooner
  const string = new KarplusString(SR, 60);
  string.setFrequency(220);
  string.setDecay(2, 0.4, 4000);
  near(string.t60At(220), 2, 0.01, "model T60 of the fundamental");
  near(string.t60At(4000), 0.4, 0.01, "model T60 at the reference");
  const options = {
    sampleRate: SR,
    period: string.period,
    position: 0.2,
    bodyHz: 2000,
    hardnessHz: 9000,
    noise: 0,
  };
  string.excite(excitation, makePluck(excitation, options, createRng(1)));
  const out = new Float32Array(SR);
  for (let i = 0; i < SR; i++) out[i] = string.next();
  const early = amplitudeAt(out, 220, SR, 2400, 9600);
  const late = amplitudeAt(out, 220, SR, 2400 + 24000, 9600);
  near(dB(late / early), -60 * (0.5 / 2), 0.4, "fundamental decay over 0.5 s");
  const earlyHigh = amplitudeAt(out, 3960, SR, 2400, 4800);
  const lateHigh = amplitudeAt(out, 3960, SR, 2400 + 9600, 4800);
  near(
    dB(lateHigh / earlyHigh),
    -60 * (0.2 / string.t60At(3960)),
    1.5,
    "18th partial decay over 0.2 s",
  );
  // damping at note-off shortens the ring without a jump
  string.setDecay(0.1, 0.05, 4000);
  let previous = string.next();
  let jump = 0;
  for (let i = 0; i < 4800; i++) {
    const v = string.next();
    jump = Math.max(jump, Math.abs(v - previous));
    previous = v;
  }
  assert.ok(jump < 0.02, `jump while damping ${jump}`);

  // block rendering is the same loop as next()
  const one = new KarplusString(SR, 60);
  const two = new KarplusString(SR, 60);
  for (const s of [one, two]) {
    s.setFrequency(311.1);
    s.setDispersion(-0.3, 2);
    s.setDecay(3, 0.5);
  }
  const pluckOptions = {
    sampleRate: SR,
    period: one.period,
    position: 0.3,
    bodyHz: 900,
    hardnessHz: 6000,
    noise: 0.5,
  };
  const excitationA = new Float32Array(4096);
  const excitationB = new Float32Array(4096);
  one.excite(excitationA, makePluck(excitationA, pluckOptions, createRng(9)));
  two.excite(excitationB, makePluck(excitationB, pluckOptions, createRng(9)));
  assert.equal(excitationA[0], 0, "a pluck starts at exactly zero");
  const blockOut = new Float32Array(3000);
  one.process(blockOut, 0, 1000);
  one.process(blockOut, 1000, 2000);
  for (let i = 0; i < 3000; i++)
    near(blockOut[i], two.next(), 1e-6, "process() vs next()");
  assert.equal(one.tap(0), blockOut[2999]);
  assert.equal(one.tap(10), blockOut[2989]);

  // the excitation has the spectrum its model promises (pulse only)
  const spectrumOptions = {
    sampleRate: SR,
    period: 218.18,
    position: 0.18,
    bodyHz: 440,
    hardnessHz: 4000,
    noise: 0,
  };
  const length = makePluck(excitation, spectrumOptions, createRng(1));
  for (const hz of [220, 660, 1540, 3080]) {
    const re = { c: 0, s: 0 };
    for (let i = 0; i < length; i++) {
      re.c += excitation[i] * Math.cos((TAU * hz * i) / SR);
      re.s += excitation[i] * Math.sin((TAU * hz * i) / SR);
    }
    near(
      dB(Math.hypot(re.c, re.s)),
      dB(pluckSpectrum(hz, spectrumOptions)),
      0.3,
      `pluck spectrum ${hz}`,
    );
  }
});

test("Karplus-Strong bends by resampling its output and lands back on pitch", () => {
  const hz = 330;
  const make = () => {
    const string = new KarplusString(SR, 60);
    string.setFrequency(hz);
    string.setDecay(5, 1.5, 4000);
    const excitation = new Float32Array(4096);
    const options = {
      sampleRate: SR,
      period: string.period,
      position: 0.2,
      bodyHz: 700,
      hardnessHz: 5000,
      noise: 0.2,
    };
    string.excite(excitation, makePluck(excitation, options, createRng(4)));
    return string;
  };
  // unbent: nextBent(1) is next() delayed by two samples
  const plain = make();
  const viaBent = make();
  const reference = new Float32Array(2000);
  for (let i = 0; i < 2000; i++) reference[i] = plain.next();
  for (let i = 0; i < 2000; i++) {
    const v = viaBent.nextBent(1);
    if (i >= 2) near(v, reference[i - 2], 1e-6, "nextBent(1) latency");
  }
  // a constant bend of +1 / -2 semitones shifts the pitch by that much
  for (const semitones of [1, -2]) {
    const string = make();
    const ratio = Math.pow(2, semitones / 12);
    const out = new Float32Array(SR);
    for (let i = 0; i < SR / 2; i++) out[i] = string.nextBent(ratio);
    const bent = measureHz(out, hz * ratio, SR, 2400, 12000, 2048);
    near(centsBetween(bent, hz), semitones * 100, 2, `bend ${semitones}`);
    for (let i = SR / 2; i < SR; i++) out[i] = string.nextBent(1);
    const settled = measureHz(out, hz, SR, SR / 2 + 4800, 12000, 2048);
    near(centsBetween(settled, hz), 0, 1.5, "after the bend");
    let jump = 0;
    for (let i = SR / 2 - 200; i < SR / 2 + 3000; i++)
      jump = Math.max(jump, Math.abs(out[i] - out[i - 1]));
    let typical = 0;
    for (let i = SR / 2 - 3000; i < SR / 2 - 200; i++)
      typical = Math.max(typical, Math.abs(out[i] - out[i - 1]));
    assert.ok(
      jump < typical * 1.3 + 1e-4,
      `release of the bend jumps ${jump} vs ${typical}`,
    );
  }
});

test("modal bank: exact decaying sinusoids, predictable level, usable as a filter", () => {
  const bank = new ModalBank(8);
  bank.set(0, 523.25, 0.8, 0.5, SR);
  bank.strike();
  const out = new Float32Array(SR);
  bank.render(out, 0, 100);
  bank.render(out, 100, SR - 100);
  const r = Math.exp(-Math.log(1000) / (0.8 * SR));
  let worst = 0;
  for (let i = 0; i < SR; i++) {
    const ideal = 0.5 * Math.pow(r, i) * Math.sin((TAU * 523.25 * i) / SR);
    worst = Math.max(worst, Math.abs(out[i] - ideal));
  }
  assert.ok(worst < 1e-6, `modal mode error ${worst}`);
  assert.ok(Math.abs(out[0]) < 1e-12);

  const ratios = [1, 2.76, 5.4, 8.93, 13.34];
  const amps = [1, 0.6, 0.4, 0.25, 0.15];
  const t60s = [1.5, 1.1, 0.7, 0.4, 0.25];
  for (let i = 0; i < 5; i++)
    bank.set(i, 300 * ratios[i], t60s[i], amps[i] * 0.2, SR);
  bank.strike();
  const left = new Float32Array(SR);
  const right = new Float32Array(SR);
  const gl = [1, 0.5, 1, 0.5, 1];
  const gr = [0.5, 1, 0.5, 1, 0.5];
  bank.renderStereo(left, right, 0, SR, gl, gr);
  const window = Math.round(0.4 * SR);
  let power = 0;
  for (let i = 0; i < window; i++) power += left[i] * left[i];
  const predicted = decayingPartialsRms(
    amps.map((a, i) => a * 0.2 * gl[i]),
    t60s,
    5,
    0.4,
  );
  near(
    dB(Math.sqrt(power / window)),
    dB(predicted),
    0.15,
    "predicted RMS of a struck bank",
  );
  near(
    dB(
      amplitudeAt(right, 300 * 2.76, SR, 0, 2048) /
        amplitudeAt(left, 300 * 2.76, SR, 0, 2048),
    ),
    6.02,
    0.1,
    "per-mode stereo gains",
  );

  // start phases: mode i begins at amp·sin(phase) and keeps its frequency and decay
  const phased = new ModalBank(2);
  phased.set(0, 700, 0.5, 0.4, SR);
  phased.set(1, 1900, 0.3, 0.2, SR);
  phased.strike(1, [Math.PI / 2, -0.7]);
  const phasedOut = new Float32Array(2000);
  phased.render(phasedOut, 0, 2000);
  const r0 = Math.exp(-Math.log(1000) / (0.5 * SR));
  const r1 = Math.exp(-Math.log(1000) / (0.3 * SR));
  for (let i = 0; i < 2000; i += 37)
    near(
      phasedOut[i],
      0.4 * Math.pow(r0, i) * Math.sin((TAU * 700 * i) / SR + Math.PI / 2) +
        0.2 * Math.pow(r1, i) * Math.sin((TAU * 1900 * i) / SR - 0.7),
      1e-6,
      "phased strike",
    );

  // modes that have faded below `silence` are skipped without changing the sound
  const sleepy = new ModalBank(3);
  const awake = new ModalBank(3);
  awake.silence = 0;
  for (const b of [sleepy, awake]) {
    b.set(0, 440, 3, 0.3, SR);
    b.set(1, 2300, 0.08, 0.2, SR);
    b.set(2, 5100, 0.03, 0.1, SR);
    b.strike();
  }
  const withSkip = new Float32Array(SR);
  const withoutSkip = new Float32Array(SR);
  sleepy.render(withSkip, 0, SR);
  awake.render(withoutSkip, 0, SR);
  for (let i = 0; i < SR; i += 13)
    near(withSkip[i], withoutSkip[i], 3e-6, "silent-mode skipping");

  // damping while ringing is continuous
  bank.scaleDecay(0.05);
  const damped = new Float32Array(4800);
  bank.render(damped, 0, 4800);
  let energy = 0;
  for (let i = 4000; i < 4800; i++) energy += damped[i] * damped[i];
  assert.ok(Math.sqrt(energy / 800) < 1e-3);

  const filter = new ModalBank(2);
  filter.set(0, 440, 0.5, 0.7, SR);
  filter.set(1, 1320, 0.3, 0.2, SR);
  let peak = 0;
  const ring = new Float32Array(4800);
  for (let i = 0; i < 4800; i++) {
    ring[i] = filter.next(i === 0 ? 1 : 0);
    peak = Math.max(peak, Math.abs(ring[i]));
  }
  // an impulse rings each mode at its amplitude (seen through the decay at the window centre)
  const centre = Math.exp((-Math.log(1000) * 512) / (0.5 * SR));
  near(
    amplitudeAt(ring, 440, SR, 0, 1024),
    0.7 * centre,
    0.01,
    "driven mode amplitude",
  );
  assert.ok(peak < 1);
});

test("FM operator produces Bessel sidebands", () => {
  const carrier = new FmOperator(1000, SR);
  const modulator = new FmOperator(200, SR);
  const n = 48000;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = carrier.next(0);
  near(amplitudeAt(out, 1000, SR), 1, 1e-3, "unmodulated carrier");
  // index 2.4048 is the first zero of J0: the carrier vanishes, J1 = 0.5191
  carrier.reset();
  for (let i = 0; i < n; i++) out[i] = carrier.next(2.4048 * modulator.next());
  assert.ok(amplitudeAt(out, 1000, SR) < 0.005);
  near(amplitudeAt(out, 1200, SR), 0.5191, 0.005, "first upper sideband");
  near(amplitudeAt(out, 800, SR), 0.5191, 0.005, "first lower sideband");
  near(amplitudeAt(out, 1400, SR), 0.4318, 0.005, "second sideband");
  const fb = new FmOperator(220, SR);
  fb.feedback = 1.2;
  let peak = 0;
  for (let i = 0; i < n; i++)
    peak = Math.max(peak, Math.abs((out[i] = fb.next())));
  assert.ok(peak <= 1.0001);
  assert.ok(amplitudeAt(out, 440, SR) > 0.1, "feedback adds harmonics");
});

test("saturation curves and the 2x oversampler", () => {
  let worst = 0;
  let previous = -2;
  for (let x = -6; x <= 6; x += 0.001) {
    const y = fastTanh(x);
    worst = Math.max(worst, Math.abs(y - Math.tanh(x)));
    assert.ok(y >= previous - 1e-12 && Math.abs(y) <= 1);
    previous = y;
  }
  assert.ok(worst < 0.025, `fastTanh error ${worst}`);
  near(fastTanh(-0.7), -fastTanh(0.7), 1e-15, "odd symmetry");
  near(tanhDrive(1, 3), 1, 1e-12, "full scale stays full scale");
  assert.ok(tanhDrive(0.1, 3) > 0.25);
  assert.equal(cubicSat(2), 1);
  near(cubicSat(0.5), 0.6875, 1e-12, "cubic");

  // identity through the oversampler: flat passband, 12 samples late
  for (const hz of [100, 1000, 10000, 15000]) {
    const os = new Oversampler2x();
    const out = new Float32Array(9600);
    const dry = new Float32Array(9600);
    for (let i = 0; i < 9600; i++) {
      dry[i] = Math.sin((TAU * hz * i) / SR);
      out[i] = os.process(dry[i], (v) => v);
    }
    const [wetAmplitude, wetPhase] = measureLine(out, hz, SR, 4800, 4800);
    const [dryAmplitude, dryPhase] = measureLine(dry, hz, SR, 4800, 4800);
    near(
      dB(wetAmplitude / dryAmplitude),
      0,
      hz > 12000 ? 0.5 : 0.05,
      `oversampler passband ${hz}`,
    );
    let lag = ((dryPhase - wetPhase) * SR) / (TAU * hz);
    const period = SR / hz;
    lag -= Math.round((lag - Oversampler2x.LATENCY) / period) * period;
    near(lag, Oversampler2x.LATENCY, 0.01, `oversampler latency at ${hz}`);
  }

  // heavy drive on a 5 kHz tone: the 9th harmonic (45 kHz) folds to 3 kHz at 1x, is rejected at 2x
  const plain = new Float32Array(32768);
  const oversampled = new Float32Array(32768);
  for (let i = 0; i < plain.length; i++)
    plain[i] = oversampled[i] = 0.9 * Math.sin((TAU * 5000 * i) / SR);
  saturateBlock(plain, plain.length, 8);
  saturateBlock(oversampled, oversampled.length, 8, new Oversampler2x());
  const aliasPlain = amplitudeAt(plain, 3000, SR, 1024, 16384);
  const aliasOver = amplitudeAt(oversampled, 3000, SR, 1024, 16384);
  assert.ok(aliasPlain > 0.02, `expected an alias at 3 kHz, got ${aliasPlain}`);
  assert.ok(
    dB(aliasOver / aliasPlain) < -40,
    `2x reduces the 3 kHz alias by ${dB(aliasOver / aliasPlain).toFixed(1)} dB`,
  );
  near(
    dB(
      amplitudeAt(oversampled, 5000, SR, 1024, 16384) /
        amplitudeAt(plain, 5000, SR, 1024, 16384),
    ),
    0,
    0.1,
    "fundamental unchanged",
  );
});

test("FFT, power spectrum and the scratch pool", () => {
  const n = 1024;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const original = new Float64Array(n);
  const rng = createRng(5);
  for (let i = 0; i < n; i++) original[i] = re[i] = rng() * 2 - 1;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += re[i] * re[i];
  fft(re, im);
  let spectral = 0;
  for (let i = 0; i < n; i++) spectral += re[i] * re[i] + im[i] * im[i];
  near(spectral / n, energy, 1e-8, "Parseval");
  fft(re, im, true);
  for (let i = 0; i < n; i++)
    near(re[i] / n, original[i], 1e-12, "inverse FFT");
  re.fill(0);
  im.fill(0);
  for (let i = 0; i < n; i++) re[i] = Math.cos((TAU * 37 * i) / n);
  fft(re, im);
  near(Math.hypot(re[37], im[37]), n / 2, 1e-8, "bin of a cosine");
  assert.ok(Math.hypot(re[36], im[36]) < 1e-8);
  assert.throws(() => fft(new Float64Array(12), new Float64Array(12)));

  const sine = Float32Array.from({ length: 30000 }, (_, i) =>
    Math.sin((TAU * 1234.5 * i) / SR),
  );
  const spectrum = powerSpectrum(sine, SR);
  let total = 0;
  for (const p of spectrum.power) total += p;
  near(total, 0.5, 0.01, "power of a full-scale sine");
  near(spectralCentroid(spectrum), 1234.5, 2, "centroid of a sine");
  near(bandPower(spectrum, 1000, 1500) / total, 1, 1e-4, "band power");

  const first = scratch(15, 100);
  first.fill(1, 0, 100);
  const second = scratch(15, 80);
  assert.equal(second, first);
  assert.equal(second[10], 0);
  assert.ok(scratch(15, 5000).length >= 5000);
});

test("spectrum helpers: two measurements never share their numbers, also where V8 makes two object literals share theirs (LEFT-07)", async (t) => {
  // what the tests rely on: numbers come back, and a second measurement leaves the first alone
  const a = Float32Array.from(
    { length: 4800 },
    (_, i) => 0.9 * Math.cos((TAU * 440 * i) / SR + 0.2),
  );
  const b = Float32Array.from(
    { length: 4800 },
    (_, i) => 0.4 * Math.cos((TAU * 440 * i) / SR + 1.1),
  );
  const phaseA = phaseAt(a, 440, SR);
  const amplitudeA = amplitudeAt(a, 440, SR);
  const phaseB = phaseAt(b, 440, SR);
  assert.equal(typeof phaseA, "number");
  assert.equal(typeof amplitudeA, "number");
  near(
    phaseA,
    0.2,
    1e-6,
    "phase of the first tone, read after the second was measured",
  );
  near(amplitudeA, 0.9, 1e-6, "amplitude of the first tone");
  near(phaseB, 1.1, 1e-6, "phase of the second tone");
  near(amplitudeAt(b, 440, SR), 0.4, 1e-6, "amplitude of the second tone");

  // the runtime fault itself, without the timing it needs in the wild: tests/fixtures/literal-aliasing.check.ts
  // drives the tiers of V8 by hand over a helper of the old shape ({ amplitude, phase }) and over measureLine
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const script = fileURLToPath(
    new URL("./fixtures/literal-aliasing.check.ts", import.meta.url),
  );
  const run = spawnSync(
    process.execPath,
    ["--allow-natives-syntax", "--expose-gc", "--import", "tsx", script],
    {
      encoding: "utf8",
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    },
  );
  assert.equal(run.status, 0, `the check did not run: ${run.stderr}`);
  const lines = run.stdout.trim().split("\n");
  const report = JSON.parse(lines[lines.length - 1] || "{}") as {
    v8: string;
    literal: { first: number[]; second: number[]; correct: boolean };
    helper: { first: number[]; second: number[]; correct: boolean };
  };
  // whatever the runtime does to object literals, the helper the tests use is right
  assert.ok(
    report.helper.correct,
    `measureLine under on-stack replacement and deoptimisation: ${JSON.stringify(report.helper)}`,
  );
  // and this is how it went wrong (Node 24.18: the first result shows the numbers of the second)
  t.diagnostic(
    report.literal.correct
      ? `V8 ${report.v8} keeps the numbers of two object literals apart`
      : `V8 ${report.v8} shares the number boxes of two object literals after a deoptimisation: ${JSON.stringify(report.literal.first)} twice`,
  );
});
