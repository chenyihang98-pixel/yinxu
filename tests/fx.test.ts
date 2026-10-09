import test from "node:test";
import assert from "node:assert/strict";
import {
  Chorus,
  DRIVE_PIVOT,
  DUCK_DEPTH,
  Drive,
  PingPongDelay,
  Reverb,
  applyDuck,
  chorusGains,
  cutFilter,
  dampingRatio,
  driveCurve,
  duckCurve,
  duckGainAt,
  duckRelease,
  fillDuckGains,
  forLoopTail,
  highPass,
  loopSyncedRate,
  lowPass,
  panGains,
  runInsert,
  runSend,
  saturate,
  setPan,
  setWidth,
  stereoMatrix,
} from "../src/audio/fx";
import type { ReverbSettings } from "../src/audio/fx";
import {
  LoudnessMeter,
  integratedLoudness,
  kWeightingCoefs,
  kWeightingGain,
  momentaryLoudness,
  samplePeak,
  shortTermLoudness,
} from "../src/audio/loudness";
import {
  Biquad,
  Oversampler2x,
  createRng,
  powerSpectrum,
} from "../src/audio/dsp";

const SR = 48000;

/* ---------- measuring helpers ---------- */

function energy(data: Float32Array, from = 0, to = data.length): number {
  let sum = 0;
  for (let i = Math.max(0, from); i < Math.min(to, data.length); i++)
    sum += data[i] * data[i];
  return sum;
}
const rms = (data: Float32Array, from = 0, to = data.length) =>
  Math.sqrt(energy(data, from, to) / Math.max(1, to - from));
const db = (ratio: number) => 20 * Math.log10(Math.max(ratio, 1e-12));

function correlation(
  a: Float32Array,
  b: Float32Array,
  from = 0,
  to = a.length,
) {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = from; i < to; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return ab / Math.sqrt(aa * bb + 1e-30);
}

function noise(frames: number, seed: number, gain = 0.3): Float32Array {
  const random = createRng(seed);
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i++) data[i] = (random() * 2 - 1) * gain;
  return data;
}

function sine(
  frames: number,
  hz: number,
  gain = 1,
  sampleRate = SR,
): Float32Array {
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i++)
    data[i] = gain * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return data;
}

/** Fourth-order band-pass around `hz` (two biquads), for octave-band decay measurements. */
function band(data: Float32Array, hz: number): Float32Array {
  const out = Float32Array.from(data);
  new Biquad().setBandpass(hz, 1.4, SR).process(out, out.length);
  new Biquad().setBandpass(hz, 1.4, SR).process(out, out.length);
  return out;
}

/** RT60 from the Schroeder integral, fitted between -5 and -35 dB. */
function rt60(impulse: Float32Array): number {
  const n = impulse.length;
  const decay = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    acc += impulse[i] * impulse[i];
    decay[i] = acc;
  }
  let from = -1;
  let to = -1;
  for (let i = 0; i < n; i++) {
    const level = 10 * Math.log10(decay[i] / decay[0] + 1e-30);
    if (from < 0 && level <= -5) from = i;
    if (level <= -35) {
      to = i;
      break;
    }
  }
  assert.ok(from >= 0 && to > from, "impulse response too short to measure");
  return ((to - from) / SR) * 2;
}

/**
 * Normalised echo density (Abel & Huang): share of samples beyond one
 * standard deviation in a window, relative to Gaussian noise. About 1 for a
 * dense, noise-like tail and near 0 for a few isolated echoes.
 */
function echoDensity(
  data: Float32Array,
  centre: number,
  window = 0.02,
): number {
  const half = Math.round((window * SR) / 2);
  const from = Math.max(0, Math.round(centre * SR) - half);
  const to = Math.min(data.length, Math.round(centre * SR) + half);
  const deviation = rms(data, from, to);
  let beyond = 0;
  for (let i = from; i < to; i++) if (Math.abs(data[i]) > deviation) beyond++;
  return beyond / (to - from) / 0.3173;
}

function impulseResponse(
  settings: ReverbSettings,
  seconds: number,
  options: ConstructorParameters<typeof Reverb>[2] = { lowCutHz: 0 },
  channels: "both" | "left" = "both",
) {
  const frames = Math.round(seconds * SR);
  const inLeft = new Float32Array(frames);
  const inRight = new Float32Array(frames);
  inLeft[0] = 1;
  if (channels === "both") inRight[0] = 1;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const reverb = new Reverb(SR, settings, options);
  reverb.process(inLeft, inRight, left, right, frames);
  return { left, right, reverb, frames };
}

const ROOMS: ReverbSettings[] = [
  { size: 0.15, decay: 0.45, damping: 0.3, preDelay: 0.005 },
  { size: 0.32, decay: 1.1, damping: 0.72, preDelay: 0.01 },
  { size: 0.55, decay: 2, damping: 0.45, preDelay: 0.02 },
  { size: 0.9, decay: 3.2, damping: 0.4, preDelay: 0.03 },
  { size: 1, decay: 6, damping: 0.3, preDelay: 0.04 },
];

/* ---------- loudness ---------- */

test("loudness: BS.1770 K-weighting and reference tones", () => {
  // the coefficients printed in the recommendation for 48 kHz
  const { shelf, highpass } = kWeightingCoefs(48000);
  assert.ok(Math.abs(shelf.b0 - 1.53512485958697) < 1e-9);
  assert.ok(Math.abs(shelf.b1 + 2.69169618940638) < 1e-9);
  assert.ok(Math.abs(shelf.b2 - 1.19839281085285) < 1e-9);
  assert.ok(Math.abs(shelf.a1 + 1.69065929318241) < 1e-9);
  assert.ok(Math.abs(shelf.a2 - 0.73248077421585) < 1e-9);
  assert.ok(Math.abs(highpass.a1 + 1.99004745483398) < 1e-9);
  assert.ok(Math.abs(highpass.a2 - 0.99007225036621) < 1e-9);
  assert.ok(Math.abs(db(kWeightingGain(997, 48000)) - 0.691) < 0.01);

  for (const sampleRate of [44100, 48000]) {
    const frames = sampleRate * 10;
    const tone = sine(frames, 997, 1, sampleRate);
    const silence = new Float32Array(frames);
    // BS.1770: a full-scale 997 Hz sine in ONE channel reads -3.01 LKFS …
    const single = integratedLoudness(tone, silence, sampleRate);
    assert.ok(Math.abs(single + 3.01) < 0.1, `one channel: ${single}`);
    assert.ok(
      Math.abs(integratedLoudness(tone, null, sampleRate) + 3.01) < 0.1,
      "mono signal",
    );
    // … and the same sine in both channels of a stereo file 3.01 LU more (EBU Tech 3341)
    const both = integratedLoudness(tone, tone, sampleRate);
    assert.ok(Math.abs(both) < 0.1, `both channels: ${both}`);
    const ebu = Float32Array.from(tone, (v) => v * Math.pow(10, -23 / 20));
    assert.ok(
      Math.abs(integratedLoudness(ebu, ebu, sampleRate) + 23) < 0.1,
      "EBU 3341 case 1: -23 dBFS stereo sine reads -23.0 LUFS",
    );
    // -6 dB in level is -6 LU
    const half = Float32Array.from(tone, (v) => v * 0.5);
    const quieter = integratedLoudness(half, half, sampleRate);
    assert.ok(
      Math.abs(both - quieter - 6.02) < 0.05,
      `6 dB step: ${both - quieter}`,
    );
  }
});

test("loudness: gating, momentary, short-term and peak", () => {
  // 10 s at -20 dBFS then 10 s at -60 dBFS: the quiet half is gated out
  const frames = SR * 20;
  const data = sine(frames, 997, 0.1);
  for (let i = frames / 2; i < frames; i++) data[i] *= 0.01;
  const meter = new LoudnessMeter(SR);
  // fed in uneven pieces: the result must not depend on the block size
  for (let from = 0; from < frames;) {
    const count = Math.min(frames - from, 1 + ((from * 7919) % 5000));
    meter.push(data, data, count, from);
    from += count;
  }
  assert.ok(
    Math.abs(meter.integrated + 20) < 0.15,
    `gated: ${meter.integrated}`,
  );
  assert.ok(
    Math.abs(meter.integrated - integratedLoudness(data, data, SR)) < 1e-9,
  );
  // without the gate the average would sit 3 LU lower
  assert.ok(Math.abs(meter.momentaryMax + 20) < 0.05);
  assert.ok(Math.abs(meter.shortTermMax + 20) < 0.05);
  const momentary = momentaryLoudness(data, data, SR);
  const shortTerm = shortTermLoudness(data, data, SR);
  assert.equal(momentary.length, 200 - 3);
  assert.equal(shortTerm.length, 200 - 29);
  assert.ok(Math.abs(momentary[momentary.length - 1] + 60) < 0.1);
  assert.ok(Math.abs(meter.peak - 0.1) < 1e-4);
  assert.ok(Math.abs(meter.peakDb + 20) < 0.01);
  assert.ok(
    Math.abs(samplePeak(data, Float32Array.of(-0.7, 0.2)) - 0.7) < 1e-6,
  );
  // silence and anything shorter than one block have no loudness
  assert.equal(integratedLoudness(new Float32Array(SR), null, SR), -Infinity);
  assert.equal(integratedLoudness(sine(SR * 0.3, 997), null, SR), -Infinity);
});

/* ---------- filters ---------- */

test("cut filters: -3 dB at the corner, 12 dB per octave, unity in the pass band", () => {
  for (const hz of [80, 150, 1000]) {
    const filter = cutFilter(SR, hz, 0);
    assert.ok(filter);
    assert.ok(Math.abs(db(filter.magnitude(hz, SR)) + 3.01) < 0.05);
    assert.ok(Math.abs(db(filter.magnitude(hz / 4, SR)) + 24) < 0.6);
    assert.ok(Math.abs(db(filter.magnitude(hz * 8, SR))) < 0.05);
  }
  for (const hz of [2500, 6500, 9000]) {
    const filter = cutFilter(SR, 0, hz);
    assert.ok(filter);
    assert.ok(Math.abs(db(filter.magnitude(hz, SR)) + 3.01) < 0.05);
    assert.ok(Math.abs(db(filter.magnitude(hz / 8, SR))) < 0.05);
    assert.ok(db(filter.magnitude(Math.min(hz * 2, 20000), SR)) < -11);
  }
  assert.equal(cutFilter(SR, 0, 0), null, "nothing to do → no filter");
  assert.equal(cutFilter(SR, 0, 30000), null, "a corner above the band is off");

  // measured on audio: a 150 Hz high-pass on tones an octave apart
  const frames = SR;
  const measure = (hz: number) => {
    const left = sine(frames, hz, 0.5);
    const right = sine(frames, hz, 0.5);
    highPass(left, right, frames, 150, SR);
    return db(rms(left, frames / 2) / (0.5 * Math.SQRT1_2));
  };
  assert.ok(Math.abs(measure(150) + 3.01) < 0.1);
  assert.ok(Math.abs(measure(75) + 12.3) < 0.4);
  assert.ok(Math.abs(measure(1200)) < 0.05);
  const left = sine(frames, 13000, 0.5);
  const right = sine(frames, 13000, 0.5);
  lowPass(left, right, frames, 6500, SR);
  assert.ok(db(rms(right, frames / 2) / (0.5 * Math.SQRT1_2)) < -11);

  // both channels are filtered alike and independently
  const a = noise(4000, 1);
  const b = noise(4000, 2);
  const a2 = Float32Array.from(a);
  const b2 = Float32Array.from(b);
  const both = cutFilter(SR, 200, 5000)!;
  both.process(a, b, 4000);
  const alone = cutFilter(SR, 200, 5000)!;
  alone.processChannel(a2, 4000, 0);
  alone.processChannel(b2, 4000, 1);
  for (let i = 0; i < 4000; i += 37) {
    assert.ok(Math.abs(a[i] - a2[i]) < 1e-6);
    assert.ok(Math.abs(b[i] - b2[i]) < 1e-6);
  }
});

/* ---------- drive ---------- */

test("drive: odd-symmetric soft curve that keeps the level of typical material", () => {
  for (const drive of [0.1, 0.3, 0.6, 1]) {
    assert.ok(Math.abs(driveCurve(DRIVE_PIVOT, drive) - DRIVE_PIVOT) < 1e-9);
    let previous = -Infinity;
    for (let x = -1.5; x <= 1.5; x += 0.01) {
      const y = driveCurve(x, drive);
      assert.ok(y >= previous - 1e-12, "monotonic");
      assert.ok(Math.abs(y + driveCurve(-x, drive)) < 1e-12, "odd");
      previous = y;
    }
    // peaks are rounded off: full scale comes out lower than it went in
    assert.ok(driveCurve(1, drive) < 1);
  }
  // more drive bends a loud peak further
  assert.ok(driveCurve(0.8, 0.6) < driveCurve(0.8, 0.2));

  // a -18 dBFS RMS signal keeps its loudness within 1 dB up to a strong drive
  const frames = SR;
  for (const drive of [0.1, 0.25, 0.5]) {
    const left = noise(frames, 7, 0.218);
    const right = noise(frames, 8, 0.218);
    const before = rms(left);
    saturate(left, right, frames, drive);
    assert.ok(Math.abs(db(rms(left) / before)) < 1, `drive ${drive}`);
  }

  // third harmonic appears, even harmonics do not
  const tone = sine(frames, 1000, 0.6);
  const copy = Float32Array.from(tone);
  saturate(tone, copy, frames, 0.5);
  const spectrum = powerSpectrum(tone, SR, 4096, 32768);
  const at = (hz: number) => {
    const bin = Math.round(hz / spectrum.binHz);
    let power = 0;
    for (let k = bin - 3; k <= bin + 3; k++) power += spectrum.power[k];
    return 10 * Math.log10(power + 1e-20);
  };
  assert.ok(at(3000) - at(1000) > -30, "audible third harmonic");
  assert.ok(at(2000) - at(1000) < -80, "no second harmonic");
});

test("drive: heavy settings are oversampled, report their latency and alias less", () => {
  const gentle = new Drive(0.2);
  const heavy = new Drive(0.8);
  assert.equal(gentle.latency, 0);
  assert.equal(heavy.latency, Oversampler2x.LATENCY);

  // a 13 kHz tone driven hard: its 3rd harmonic (39 kHz) folds down to
  // 9 kHz at the base rate; the oversampled path filters it out first
  const frames = SR;
  const aliasAt = (process: (l: Float32Array, r: Float32Array) => void) => {
    const left = sine(frames, 13000, 0.7);
    const right = sine(frames, 13000, 0.7);
    process(left, right);
    const spectrum = powerSpectrum(left, SR, 8192, 32768);
    const bin = Math.round(9000 / spectrum.binHz);
    let alias = 0;
    for (let k = bin - 4; k <= bin + 4; k++) alias += spectrum.power[k];
    const fundamental = Math.round(13000 / spectrum.binHz);
    let tone = 0;
    for (let k = fundamental - 4; k <= fundamental + 4; k++)
      tone += spectrum.power[k];
    return 10 * Math.log10(alias / tone);
  };
  const base = aliasAt((l, r) => saturate(l, r, frames, 0.8));
  const oversampled = aliasAt((l, r) =>
    runInsert(new Drive(0.8), l, r, frames),
  );
  assert.ok(base > -30, `base-rate alias ${base} dB`);
  assert.ok(oversampled < base - 25, `oversampled alias ${oversampled} dB`);

  // the latency is exactly what it says: the output lines up when shifted back
  const input = noise(4000, 4, 0.05);
  const left = Float32Array.from(input);
  const right = Float32Array.from(input);
  new Drive(0.8).process(left, right, 4000);
  const low = (data: Float32Array) => {
    const copy = Float32Array.from(data);
    new Biquad().setLowpass(4000, 0.707, SR).process(copy, copy.length);
    return copy;
  };
  const reference = low(Float32Array.from(input, (v) => driveCurve(v, 0.8)));
  const delayed = low(left);
  let best = 0;
  let bestLag = -1;
  for (let lag = 0; lag < 30; lag++) {
    let sum = 0;
    for (let i = 500; i < 3500; i++) sum += reference[i] * delayed[i + lag];
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  assert.equal(bestLag, heavy.latency);
});

/* ---------- width and pan ---------- */

test("width: mid/side scaling that never touches the mono sum", () => {
  const frames = 4096;
  const left = noise(frames, 11);
  const right = noise(frames, 12);
  for (const width of [0, 0.5, 1, 1.5]) {
    const l = Float32Array.from(left);
    const r = Float32Array.from(right);
    setWidth(l, r, frames, width);
    for (let i = 0; i < frames; i += 97) {
      const mid = (left[i] + right[i]) / 2;
      const side = (left[i] - right[i]) / 2;
      assert.ok(Math.abs((l[i] + r[i]) / 2 - mid) < 1e-6, "mono sum unchanged");
      assert.ok(
        Math.abs((l[i] - r[i]) / 2 - side * width) < 1e-6,
        "side scaled",
      );
    }
    if (width === 0)
      assert.ok(
        l.every((value, i) => value === r[i]),
        "width 0 is mono",
      );
    if (width === 1)
      assert.ok(
        l.every((value, i) => value === left[i]) &&
          r.every((value, i) => value === right[i]),
      );
  }
});

test("pan: equal power, unity in the centre, hard sides are silent on the other side", () => {
  assert.deepEqual(
    panGains(0).map((g) => Math.round(g * 1e9) / 1e9),
    [1, 1],
  );
  for (let pan = -1; pan <= 1; pan += 0.125) {
    const [gl, gr] = panGains(pan);
    assert.ok(Math.abs(gl * gl + gr * gr - 2) < 1e-9, "constant total power");
    if (pan > 0) assert.ok(gr > gl);
  }
  assert.ok(
    panGains(-1)[1] < 1e-9 && Math.abs(panGains(-1)[0] - Math.SQRT2) < 1e-9,
  );
  const frames = 1000;
  const left = noise(frames, 3);
  const right = Float32Array.from(left);
  setPan(left, right, frames, 0.5);
  assert.ok(
    Math.abs(
      db(rms(right) / rms(left)) - db(panGains(0.5)[1] / panGains(0.5)[0]),
    ) < 1e-3,
  );
  // width and pan compose into one matrix: mono first, then placed
  const m = stereoMatrix(0, -1);
  assert.ok(
    Math.abs(m.ll - Math.SQRT2 / 2) < 1e-9 &&
      Math.abs(m.lr - Math.SQRT2 / 2) < 1e-9,
  );
  assert.ok(Math.abs(m.rl) < 1e-9 && Math.abs(m.rr) < 1e-9);
});

/* ---------- chorus ---------- */

test("chorus: widens a mono source, keeps its power and survives a mono fold-down", () => {
  const frames = SR * 4;
  for (const amount of [0.3, 0.6, 1]) {
    // band-limited noise, as a pad would be
    const source = noise(frames, 21, 0.3);
    new Biquad().setLowpass(3000, 0.707, SR).process(source, frames);
    new Biquad().setHighpass(150, 0.707, SR).process(source, frames);
    const left = Float32Array.from(source);
    const right = Float32Array.from(source);
    runInsert(new Chorus(SR, amount), left, right, frames);
    const from = SR / 2;
    const inRms = rms(source, from);
    const outRms = Math.sqrt(
      (energy(left, from) + energy(right, from)) / (2 * (frames - from)),
    );
    assert.ok(
      Math.abs(db(outRms / inRms)) < 1,
      `power at ${amount}: ${db(outRms / inRms)}`,
    );
    const mono = Float32Array.from(left, (value, i) => (value + right[i]) / 2);
    const monoDb = db(rms(mono, from) / inRms);
    assert.ok(
      monoDb > -2.5 && monoDb < 1,
      `mono fold-down at ${amount}: ${monoDb} dB`,
    );
    const spread = correlation(left, right, from, frames);
    assert.ok(
      spread < 1 - 0.15 * amount,
      `correlation at ${amount}: ${spread}`,
    );
    assert.ok(spread > 0.3, "still clearly one source");
  }
  // amount 0 is the dry signal
  const left = noise(2000, 5);
  const right = noise(2000, 6);
  const dryLeft = Float32Array.from(left);
  new Chorus(SR, 0).process(left, right, 2000);
  for (let i = 0; i < 2000; i += 13)
    assert.ok(Math.abs(left[i] - dryLeft[i]) < 1e-6);
  const gains = chorusGains(1);
  assert.ok(
    Math.abs(gains.dry * gains.dry + 2 * gains.wet * gains.wet - 1) < 1e-12,
  );
});

test("chorus: pitch stays within a few cents of the note", () => {
  // a steady tone through the wet path only moves by the LFO's delay sweep
  const frames = SR * 3;
  const left = sine(frames, 440, 0.5);
  const right = sine(frames, 440, 0.5);
  runInsert(new Chorus(SR, 1), left, right, frames);
  const spectrum = powerSpectrum(left, SR, SR, 65536);
  let total = 0;
  let near = 0;
  for (let k = 1; k < spectrum.power.length; k++) {
    const hz = k * spectrum.binHz;
    total += spectrum.power[k];
    // ±25 cents around 440 Hz
    if (hz > 440 * 0.9857 && hz < 440 * 1.0145) near += spectrum.power[k];
  }
  assert.ok(near / total > 0.995, `energy near the note: ${near / total}`);
});

/* ---------- delay ---------- */

test("ping-pong delay: echoes on time, alternating sides, each one quieter and darker", () => {
  const time = 0.25;
  const feedback = 0.5;
  const delay = new PingPongDelay(SR, time, feedback, { spill: 0 });
  assert.equal(delay.delayFrames, 12000);
  const frames = SR * 3;
  const inLeft = new Float32Array(frames);
  // a short click, centred
  for (let i = 0; i < 48; i++) inLeft[i] = Math.sin((Math.PI * i) / 48);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  delay.process(inLeft, inLeft, left, right, frames);

  const window = (data: Float32Array, echo: number) =>
    energy(data, echo * 12000 - 200, echo * 12000 + 1500);
  assert.ok(
    energy(left, 0, 11900) + energy(right, 0, 11900) < 1e-12,
    "nothing before the first echo",
  );
  let previous = Infinity;
  for (let echo = 1; echo <= 6; echo++) {
    const onSide = echo % 2 ? left : right;
    const offSide = echo % 2 ? right : left;
    const level = window(onSide, echo);
    assert.ok(level > 1e-6, `echo ${echo} present`);
    assert.ok(
      window(offSide, echo) < level * 1e-6,
      `echo ${echo} only on its side`,
    );
    if (echo > 1) {
      const step = 10 * Math.log10(level / previous);
      // feedback 0.5 is -6 dB; the damping filter takes a little more
      assert.ok(step < -6 && step > -9.5, `echo ${echo}: ${step} dB`);
    }
    previous = level;
  }
  // the echo lands exactly `delayFrames` after the click (peak position)
  const peakAt = (data: Float32Array, from: number, to: number) => {
    let best = from;
    for (let i = from; i < to; i++)
      if (Math.abs(data[i]) > Math.abs(data[best])) best = i;
    return best;
  };
  const first = peakAt(left, 11900, 13000);
  const third = peakAt(left, 35900, 37500);
  assert.ok(Math.abs(first - 12024) <= 12, `first echo at ${first}`);
  // the delay line is exact; the damping filters smear the click by under a millisecond per repeat
  assert.ok(
    Math.abs(third - first - 24000) <= 48,
    `two delays later: ${third - first}`,
  );

  // repeats get darker: share of energy above 3 kHz falls from echo to echo
  const bright = (data: Float32Array, echo: number) => {
    const spectrum = powerSpectrum(data, SR, echo * 12000 - 200, 2048);
    let high = 0;
    let all = 0;
    for (let k = 1; k < spectrum.power.length; k++) {
      all += spectrum.power[k];
      if (k * spectrum.binHz > 3000) high += spectrum.power[k];
    }
    return high / all;
  };
  assert.ok(bright(left, 3) < bright(left, 1) * 0.8);

  // feedback sets the tail length; zero feedback is a single echo
  assert.ok(new PingPongDelay(SR, 0.25, 0.7).tailSeconds > delay.tailSeconds);
  const single = new PingPongDelay(SR, 0.25, 0);
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  single.process(inLeft, inLeft, l, r, frames);
  assert.ok(energy(l, 11800, 14000) > 1e-6);
  assert.ok(energy(l, 20000) + energy(r, 20000) < 1e-12);
  // default spill puts a little of each echo on the far side
  const spilled = new PingPongDelay(SR, 0.25, 0.5);
  const sl = new Float32Array(frames);
  const sr = new Float32Array(frames);
  spilled.process(inLeft, inLeft, sl, sr, frames);
  const ratio = db(Math.sqrt(window(sr, 1) / window(sl, 1)));
  assert.ok(ratio < -12 && ratio > -20, `spill ${ratio} dB`);
});

/* ---------- reverb ---------- */

test("reverb: decay time follows the requested RT60 within 20 %", () => {
  for (const room of ROOMS) {
    const { left, right } = impulseResponse(room, room.decay * 1.7 + 0.6);
    for (const data of [left, right])
      for (const hz of [500, 1000]) {
        const measured = rt60(band(data, hz));
        assert.ok(
          Math.abs(measured / room.decay - 1) < 0.2,
          `RT60 at ${hz} Hz for decay ${room.decay}: ${measured.toFixed(2)} s`,
        );
      }
  }
});

test("reverb: damping shortens the highs, size does not change the decay", () => {
  const base = { size: 0.55, decay: 2, preDelay: 0 };
  const open = impulseResponse({ ...base, damping: 0 }, 4);
  const damped = impulseResponse({ ...base, damping: 0.8 }, 4);
  const openHigh = rt60(band(open.left, 8000));
  const dampedHigh = rt60(band(damped.left, 8000));
  assert.ok(openHigh > 1.4, `undamped highs ring ${openHigh.toFixed(2)} s`);
  assert.ok(
    dampedHigh < openHigh * 0.45,
    `damped highs ring ${dampedHigh.toFixed(2)} s`,
  );
  // roughly what the damping law promises
  assert.ok(Math.abs(dampedHigh / 2 / dampingRatio(0.8) - 1) < 0.5);
  assert.ok(
    Math.abs(rt60(band(damped.left, 500)) / 2 - 1) < 0.2,
    "lows keep their time",
  );
  for (const size of [0, 0.5, 1]) {
    const response = impulseResponse(
      { size, decay: 2.5, damping: 0.3, preDelay: 0 },
      5,
    );
    assert.ok(
      Math.abs(rt60(band(response.left, 500)) / 2.5 - 1) < 0.2,
      `size ${size}`,
    );
  }
  // a larger room has longer delay lines
  const small = new Reverb(SR, {
    size: 0,
    decay: 3,
    damping: 0.3,
    preDelay: 0,
  });
  const large = new Reverb(SR, {
    size: 1,
    decay: 3,
    damping: 0.3,
    preDelay: 0,
  });
  assert.ok(large.lengths[7] > small.lengths[7] * 2.5);
  // the eight lines are mutually prime
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  for (let i = 0; i < 8; i++)
    for (let j = i + 1; j < 8; j++)
      assert.equal(gcd(large.lengths[i], large.lengths[j]), 1);
});

test("reverb: dense and smooth — no discrete echoes, no ringing", () => {
  for (const room of ROOMS) {
    const { left, right } = impulseResponse(room, room.decay + 1);
    const start = room.preDelay;
    for (const data of [left, right]) {
      // echo density: noise-like from 50 ms after the onset
      for (const at of [0.05, 0.08, 0.12, 0.2]) {
        const density = echoDensity(data, start + at);
        assert.ok(
          density > 0.75,
          `density ${density.toFixed(2)} at ${at} s, decay ${room.decay}`,
        );
      }
      assert.ok(
        echoDensity(data, start + 0.02) > 0.5,
        "already diffuse after 20 ms",
      );
      // no spike stands out of the tail: crest of each 20 ms window stays noise-like
      for (let at = 0.05; at < Math.min(0.5, room.decay * 0.8); at += 0.02) {
        const from = Math.round((start + at) * SR);
        const to = from + 960;
        let peak = 0;
        for (let i = from; i < to; i++)
          peak = Math.max(peak, Math.abs(data[i]));
        assert.ok(
          peak / rms(data, from, to) < 6.5,
          `spike at ${at.toFixed(2)} s`,
        );
      }
    }
    // the build-up is fast and the decay smooth: 10 ms energy steps never
    // jump up by more than a few dB once the tail has started
    let previous = energy(
      left,
      Math.round((start + 0.06) * SR),
      Math.round((start + 0.07) * SR),
    );
    for (let at = 0.07; at < Math.min(room.decay * 0.7, 1.5); at += 0.01) {
      const now = energy(
        left,
        Math.round((start + at) * SR),
        Math.round((start + at + 0.01) * SR),
      );
      assert.ok(
        10 * Math.log10(now / previous) < 4.5,
        `energy bump at ${at.toFixed(2)} s`,
      );
      previous = now;
    }
  }
  // ringing: the spectrum of the late tail has no mode towering over its
  // neighbourhood (third-octave smoothed, 150 Hz .. 6 kHz)
  for (const room of [ROOMS[2], ROOMS[4]]) {
    const { left } = impulseResponse(room, room.decay + 1);
    const from = Math.round(room.decay * 0.25 * SR);
    const spectrum = powerSpectrum(left, SR, from, 65536);
    const smooth: number[] = [];
    for (let hz = 150; hz < 6000; hz *= Math.pow(2, 1 / 6)) {
      const lo = Math.round(hz / Math.pow(2, 1 / 6) / spectrum.binHz);
      const hi = Math.round((hz * Math.pow(2, 1 / 6)) / spectrum.binHz);
      let sum = 0;
      for (let k = lo; k <= hi; k++) sum += spectrum.power[k];
      smooth.push(10 * Math.log10(sum / (hi - lo + 1)));
    }
    for (let i = 1; i < smooth.length - 1; i++) {
      const neighbours = (smooth[i - 1] + smooth[i + 1]) / 2;
      assert.ok(
        Math.abs(smooth[i] - neighbours) < 5,
        `spectral bump of ${(smooth[i] - neighbours).toFixed(1)} dB`,
      );
    }
  }
});

test("reverb: left and right are decorrelated, also for a one-sided source", () => {
  for (const room of ROOMS) {
    const centred = impulseResponse(room, room.decay + 0.5);
    assert.ok(
      Math.abs(correlation(centred.left, centred.right)) < 0.12,
      `centred source, decay ${room.decay}: ${correlation(centred.left, centred.right)}`,
    );
    const sided = impulseResponse(
      room,
      room.decay + 0.5,
      { lowCutHz: 0 },
      "left",
    );
    assert.ok(Math.abs(correlation(sided.left, sided.right)) < 0.15);
    // a source on one side still fills both sides of the room
    const balance = db(Math.sqrt(energy(sided.right) / energy(sided.left)));
    assert.ok(Math.abs(balance) < 2.5, `balance ${balance} dB`);
  }
});

test("reverb: unity level for any room, stable, and silent after its tail", () => {
  const frames = SR * 8;
  // music-like spectrum: noise falling above 1.5 kHz
  const source = noise(frames, 31, 0.3);
  new Biquad().setLowpass(1500, 0.707, SR).process(source, frames);
  for (const room of ROOMS) {
    const reverb = new Reverb(SR, room, { lowCutHz: 0 });
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    reverb.process(source, source, left, right, frames);
    const from = Math.round(Math.min(frames - 2 * SR, room.decay * 1.5 * SR));
    const gain = db(rms(left, from) / rms(source, from));
    assert.ok(
      Math.abs(gain) < 2,
      `steady-state gain for decay ${room.decay}: ${gain.toFixed(2)} dB`,
    );
    assert.ok(Math.abs(db(rms(right, from) / rms(left, from))) < 1.5);
    let peak = 0;
    for (let i = 0; i < frames; i++)
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    assert.ok(Number.isFinite(peak) && peak < 3);
    assert.ok(
      reverb.tailSeconds >= room.decay && reverb.tailSeconds < room.decay + 0.3,
    );
  }
  // after three decay times nothing is left (-80 dB under the first 100 ms)
  const room = ROOMS[1];
  const response = impulseResponse(room, room.decay * 3.5);
  const early = rms(response.left, 0, 4800);
  const late = rms(response.left, Math.round(room.decay * 3 * SR));
  assert.ok(db(late / early) < -80, `residue ${db(late / early)} dB`);
  // the default low cut keeps bass out of the tail
  const bass = noise(SR * 6, 77, 0.5);
  for (let pass = 0; pass < 2; pass++) {
    new Biquad().setLowpass(70, 0.707, SR).process(bass, bass.length);
    new Biquad().setHighpass(35, 0.707, SR).process(bass, bass.length);
  }
  const wet = (lowCutHz: number | undefined) => {
    const left = new Float32Array(bass.length);
    const right = new Float32Array(bass.length);
    new Reverb(
      SR,
      ROOMS[2],
      lowCutHz === undefined ? {} : { lowCutHz },
    ).process(bass, bass, left, right, bass.length);
    return rms(left, SR * 3);
  };
  const cut = db(wet(undefined) / wet(0));
  assert.ok(cut < -12, `bass through the default low cut: ${cut} dB`);
});

test("reverb: deterministic, block-size independent, pre-delay is exact", () => {
  const frames = 30000;
  const inLeft = noise(frames, 41, 0.2);
  const inRight = noise(frames, 42, 0.2);
  const whole = {
    left: new Float32Array(frames),
    right: new Float32Array(frames),
  };
  new Reverb(SR, ROOMS[2]).process(
    inLeft,
    inRight,
    whole.left,
    whole.right,
    frames,
  );
  const pieces = {
    left: new Float32Array(frames),
    right: new Float32Array(frames),
  };
  const reverb = new Reverb(SR, ROOMS[2]);
  for (let from = 0; from < frames;) {
    const count = Math.min(frames - from, 1 + ((from * 31) % 700));
    reverb.process(
      inLeft.subarray(from, from + count),
      inRight.subarray(from, from + count),
      pieces.left.subarray(from, from + count),
      pieces.right.subarray(from, from + count),
      count,
    );
    from += count;
  }
  assert.deepEqual(pieces.left, whole.left);
  assert.deepEqual(pieces.right, whole.right);
  // reset() returns to the initial state
  reverb.reset();
  const again = {
    left: new Float32Array(frames),
    right: new Float32Array(frames),
  };
  reverb.process(inLeft, inRight, again.left, again.right, frames);
  assert.deepEqual(again.left, whole.left);

  // nothing comes out before the pre-delay has passed
  const response = impulseResponse(
    { size: 0.5, decay: 1.5, damping: 0.4, preDelay: 0.05 },
    1,
  );
  assert.ok(energy(response.left, 0, 2399) < 1e-20);
  assert.ok(energy(response.left, 2400, 4800) > 1e-6);
  // in place: output buffers may be the input buffers
  const a = Float32Array.from(inLeft);
  const b = Float32Array.from(inRight);
  new Reverb(SR, ROOMS[2]).process(a, b, a, b, frames);
  assert.deepEqual(a, whole.left);
});

/* ---------- loop mode ---------- */

test("loop helpers: forLoopTail walks the end of the loop in playing order", () => {
  const visit = (frames: number, warm: number, block: number) => {
    const order: number[] = [];
    forLoopTail(frames, warm, block, (from, count) => {
      assert.ok(count > 0 && count <= block && from + count <= frames);
      for (let i = 0; i < count; i++) order.push(from + i);
    });
    return order;
  };
  assert.deepEqual(visit(10, 4, 3), [6, 7, 8, 9]);
  assert.deepEqual(visit(10, 0, 3), []);
  // longer than the loop: wraps as often as needed and always ends on the last frame
  assert.deepEqual(visit(4, 10, 3), [2, 3, 0, 1, 2, 3, 0, 1, 2, 3]);
  assert.deepEqual(visit(5, 5, 8), [0, 1, 2, 3, 4]);
  assert.equal(loopSyncedRate(0.53, 8), 0.5);
  assert.equal(loopSyncedRate(0.53, 0.5), 2, "at least one cycle per loop");
  assert.equal(loopSyncedRate(0.53), 0.53);
});

/**
 * The reference for a seamless loop: play the loop several times in a row
 * through a fresh effect and keep the last pass, by which time the effect is
 * in its periodic steady state.
 */
function steadyState(
  frames: number,
  repeats: number,
  run: (from: number, count: number, keep: boolean) => void,
): void {
  for (let pass = 0; pass < repeats; pass++)
    for (let from = 0; from < frames; from += 2048)
      run(from, Math.min(2048, frames - from), pass === repeats - 1);
}

function loopSource(frames: number): [Float32Array, Float32Array] {
  // sparse plucked tones, the last one starting just before the end so its
  // tail has to come back at the beginning
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const starts = [0.1, 0.37, 0.61, 0.83, 0.985];
  starts.forEach((position, index) => {
    const start = Math.round(position * frames);
    const hz = 220 * Math.pow(2, index / 5);
    for (let i = 0; i < 20000; i++) {
      const value =
        0.4 *
        Math.sin((2 * Math.PI * hz * i) / SR) *
        Math.exp(-i / 4000) *
        Math.min(1, i / 48);
      const at = (start + i) % frames;
      left[at] += value * (index % 2 ? 0.4 : 1);
      right[at] += value * (index % 2 ? 1 : 0.4);
    }
  });
  return [left, right];
}

function maxDifference(a: Float32Array, b: Float32Array): number {
  let worst = 0;
  for (let i = 0; i < a.length; i++)
    worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
}

test("loop mode: inserts warmed over the tail equal the endlessly repeated loop", () => {
  const frames = SR * 2;
  const loopSeconds = frames / SR;
  const [srcLeft, srcRight] = loopSource(frames);
  const cases: [
    string,
    () => { process(l: Float32Array, r: Float32Array, n: number): void },
    number,
  ][] = [
    ["filter", () => cutFilter(SR, 120, 4000)!, 0.3],
    ["chorus", () => new Chorus(SR, 0.7, { loopSeconds }), 0.3],
    ["oversampled drive", () => new Drive(0.8), 0.05],
  ];
  for (const [name, make, warmSeconds] of cases) {
    const left = Float32Array.from(srcLeft);
    const right = Float32Array.from(srcRight);
    runInsert(make(), left, right, frames, Math.round(warmSeconds * SR));
    const refLeft = new Float32Array(frames);
    const refRight = new Float32Array(frames);
    const fx = make();
    const workLeft = new Float32Array(2048);
    const workRight = new Float32Array(2048);
    steadyState(frames, 4, (from, count, keep) => {
      workLeft.set(srcLeft.subarray(from, from + count));
      workRight.set(srcRight.subarray(from, from + count));
      fx.process(workLeft, workRight, count);
      if (keep) {
        refLeft.set(workLeft.subarray(0, count), from);
        refRight.set(workRight.subarray(0, count), from);
      }
    });
    assert.ok(
      maxDifference(left, refLeft) < 1e-4,
      `${name}: ${maxDifference(left, refLeft)}`,
    );
    assert.ok(maxDifference(right, refRight) < 1e-4, `${name} (right)`);
    // and without the warm-up the start of the buffer is audibly different
    if (name !== "oversampled drive") {
      const cold = Float32Array.from(srcLeft);
      const coldRight = Float32Array.from(srcRight);
      runInsert(make(), cold, coldRight, frames);
      assert.ok(
        maxDifference(cold, refLeft) > 1e-3,
        `${name}: warm-up matters`,
      );
    }
  }
});

test("loop mode: reverb and delay tails wrap seamlessly", () => {
  const frames = SR * 2;
  const loopSeconds = frames / SR;
  const [srcLeft, srcRight] = loopSource(frames);
  const room = { size: 0.5, decay: 1.4, damping: 0.4, preDelay: 0.015 };
  const cases: [string, () => Reverb | PingPongDelay, number][] = [
    ["reverb", () => new Reverb(SR, room, { loopSeconds }), 0],
    ["delay", () => new PingPongDelay(SR, 0.3, 0.55), 0],
  ];
  for (const [name, make] of cases) {
    const fx = make();
    const warm = Math.ceil(fx.tailSeconds * 1.4 * SR);
    assert.ok(
      warm > frames,
      "the tail is longer than the loop: several laps of warm-up",
    );
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    runSend(fx, srcLeft, srcRight, left, right, frames, 1, warm);

    const refLeft = new Float32Array(frames);
    const refRight = new Float32Array(frames);
    const reference = make();
    const wetLeft = new Float32Array(2048);
    const wetRight = new Float32Array(2048);
    steadyState(frames, 8, (from, count, keep) => {
      reference.process(
        srcLeft.subarray(from, from + count),
        srcRight.subarray(from, from + count),
        wetLeft,
        wetRight,
        count,
      );
      if (keep) {
        refLeft.set(wetLeft.subarray(0, count), from);
        refRight.set(wetRight.subarray(0, count), from);
      }
    });
    const scale = Math.max(...refLeft.map(Math.abs));
    assert.ok(scale > 0.01);
    assert.ok(
      maxDifference(left, refLeft) < scale * 2e-3,
      `${name}: ${maxDifference(left, refLeft) / scale} of peak`,
    );
    assert.ok(maxDifference(right, refRight) < scale * 2e-3, `${name} (right)`);

    // the seam itself: the jump from the last frame back to the first is an
    // ordinary sample step, and the level does not change across it
    for (const data of [left, right]) {
      let step = 0;
      for (let i = frames - 480; i < frames - 1; i++)
        step = Math.max(step, Math.abs(data[i + 1] - data[i]));
      for (let i = 0; i < 480; i++)
        step = Math.max(step, Math.abs(data[i + 1] - data[i]));
      assert.ok(
        Math.abs(data[0] - data[frames - 1]) <= step * 1.5,
        `${name}: seam step`,
      );
      // no cliff either way (a lost tail would be a drop of tens of dB; the
      // few dB allowed here are the notes themselves decaying and entering)
      const before = rms(data, frames - 1200, frames);
      const after = rms(data, 0, 1200);
      assert.ok(
        Math.abs(db(after / before)) < 6,
        `${name}: level across the seam ${db(after / before)} dB`,
      );
    }
    // the start of the buffer carries the tail of the end: a cold run is quiet there
    const coldLeft = new Float32Array(frames);
    const coldRight = new Float32Array(frames);
    runSend(make(), srcLeft, srcRight, coldLeft, coldRight, frames);
    assert.ok(
      rms(left, 0, 2400) > rms(coldLeft, 0, 2400) * 5,
      `${name}: tail present at the start`,
    );
  }
});

/* ---------- ducking ---------- */

test("duck envelope: fast attack just ahead of the kick, hold, smooth release", () => {
  const frames = SR * 2;
  const options = {
    attack: 0.005,
    lookahead: 0.003,
    hold: 0.025,
    release: 0.2,
    step: 1,
  };
  const curve = duckCurve([{ t: 0.5, vel: 1 }], frames, SR, options);
  const at = (seconds: number) => curve[Math.round(seconds * SR)];
  assert.equal(at(0.4), 0, "untouched before the hit");
  assert.equal(at(0.4969), 0, "attack starts 3 ms ahead");
  assert.ok(
    at(0.4995) > 0.4 && at(0.4995) < 0.6,
    "half way down at the middle of the attack",
  );
  assert.ok(at(0.502) > 0.999, "fully ducked 2 ms after the hit");
  assert.ok(at(0.52) > 0.999, "held");
  assert.ok(
    Math.abs(at(0.527 + 0.1) - 0.5) < 0.02,
    "half recovered at the middle of the release",
  );
  assert.ok(
    at(0.527 + 0.199) < 0.001 && at(0.75) === 0,
    "back to unity after the release",
  );
  // smooth: no step larger than the steepest part of the 5 ms attack
  let step = 0;
  for (let i = 1; i < curve.length; i++)
    step = Math.max(step, Math.abs(curve[i] - curve[i - 1]));
  assert.ok(step < (Math.PI / 2 / (0.005 * SR)) * 1.05);
  // monotonic recovery
  for (let i = Math.round(0.53 * SR); i < Math.round(0.72 * SR); i++)
    assert.ok(curve[i + 1] <= curve[i] + 1e-7);

  // velocity: a soft kick ducks less; overlapping hits take the deeper value
  const soft = duckCurve([{ t: 0.5, vel: 0.25 }], frames, SR, options);
  assert.ok(Math.abs(soft[Math.round(0.51 * SR)] - 0.5) < 1e-6);
  const pair = duckCurve(
    [
      { t: 0.5, vel: 1 },
      { t: 0.6, vel: 0.25 },
    ],
    frames,
    SR,
    options,
  );
  for (let i = 0; i < frames; i += 50)
    assert.ok(
      Math.abs(
        pair[i] -
          Math.max(
            curve[i],
            duckCurve([{ t: 0.6, vel: 0.25 }], frames, SR, options)[i],
          ),
      ) < 1e-6,
    );
  assert.ok(duckRelease(120) >= 0.12 && duckRelease(120) <= 0.25);
  assert.ok(duckRelease(60) === 0.25 && duckRelease(240) === 0.12);
});

test("duck envelope: wraps around a loop and is applied as an interpolated gain", () => {
  const frames = SR;
  const options = { release: 0.2, loop: true, step: 1 };
  // a kick 50 ms before the end keeps ducking at the start, and a kick on the
  // downbeat starts its attack at the very end
  const late = duckCurve([{ t: 0.95, vel: 1 }], frames, SR, options);
  assert.ok(
    late[Math.round(0.05 * SR)] > 0.3,
    "release continues after the wrap",
  );
  assert.ok(
    Math.abs(late[0] - late[frames - 1]) < 0.01,
    "continuous across the seam",
  );
  const downbeat = duckCurve([{ t: 0, vel: 1 }], frames, SR, options);
  assert.ok(downbeat[frames - 48] > 0.3, "attack begins before the end");
  assert.ok(Math.abs(downbeat[0] - downbeat[frames - 1]) < 0.12);
  const oneShot = duckCurve([{ t: 0.95, vel: 1 }], frames, SR, {
    release: 0.2,
    step: 1,
  });
  assert.equal(oneShot[Math.round(0.05 * SR)], 0, "no wrap without loop");

  // control-rate curve + interpolation reproduces the full-rate curve
  const hits = [
    { t: 0.1, vel: 1 },
    { t: 0.35, vel: 0.6 },
    { t: 0.6, vel: 0.9 },
  ];
  const fine = duckCurve(hits, frames, SR, { step: 1 });
  const coarse = duckCurve(hits, frames, SR, {});
  for (let frame = 0; frame < frames; frame += 7) {
    const exact = 1 - 0.5 * DUCK_DEPTH * fine[frame];
    assert.ok(Math.abs(duckGainAt(coarse, frame, 0.5) - exact) < 0.01);
  }
  // applyDuck and fillDuckGains agree with duckGainAt for any block offset
  const left = new Float32Array(3000).fill(1);
  const right = new Float32Array(3000).fill(1);
  const gains = new Float32Array(3000);
  applyDuck(left, right, 3000, coarse, 3777, 0.8);
  fillDuckGains(gains, 3000, coarse, 3777, 0.8);
  for (let i = 0; i < 3000; i += 11) {
    const expected = duckGainAt(coarse, 3777 + i, 0.8);
    assert.ok(
      Math.abs(left[i] - expected) < 1e-5 &&
        Math.abs(right[i] - expected) < 1e-5,
    );
    assert.ok(Math.abs(gains[i] - expected) < 1e-5);
  }
  // full duck under a full kick leaves 1 - DUCK_DEPTH of the signal
  assert.ok(
    Math.abs(duckGainAt(coarse, Math.round(0.11 * SR), 1) - (1 - DUCK_DEPTH)) <
      0.01,
  );
  assert.equal(duckGainAt(coarse, Math.round(0.9 * SR), 1), 1);
});
