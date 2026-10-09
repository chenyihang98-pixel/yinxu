import test from "node:test";
import assert from "node:assert/strict";
import {
  CYMBAL_SWELL_SECONDS,
  DRUM_KINDS,
  DRUM_KITS,
  SAMPLE_RATE,
} from "../src/music/score";
import { SWELL_LEAD_SECONDS } from "../src/music/rhythm";
import type { DrumKind, DrumKitId } from "../src/music/score";
import {
  DRUMS,
  DRUM_PEAKS,
  DRUM_REFERENCE_VELOCITY,
  KIT_LEVELS,
  SWELL_PEAK_SECONDS,
  drumPeak,
} from "../src/audio/drums";
import { createRng, fft, nextPow2 } from "../src/audio/dsp";
import {
  checkClicks,
  dcOffset,
  isFiniteAudio,
  loudestWindowDb,
  peak,
  renderDrum,
  rmsDb,
  stereoCorrelation,
  tailIsSilent,
} from "../src/audio/voices/testing";
import type { Rendered } from "../src/audio/voices/testing";

/* ------------------------------------------------------------------ */
/* measurements                                                        */
/* ------------------------------------------------------------------ */

const NON_CHIP = DRUM_KITS.filter((kit) => kit !== "chip");
const CONSOLE_KINDS: DrumKind[] = ["noiseHit", "noiseTick"];
const SHAKEN: DrumKind[] = ["shaker", "tambourine", "sleighBell"];
/** made by the console engine: discrete levels, stepped envelopes */
const isConsole = (kind: DrumKind, kit: DrumKitId) =>
  kit === "chip" || CONSOLE_KINDS.includes(kind);

function forEachHit(
  run: (kind: DrumKind, kit: DrumKitId, what: string) => void,
): void {
  for (const kit of DRUM_KITS)
    for (const kind of DRUM_KINDS) run(kind, kit, `${kit}/${kind}`);
}

const cache = new Map<string, Rendered>();
/** The hit at velocity 0.8, 48 kHz, seed 1 (cached). */
function hit(kind: DrumKind, kit: DrumKitId): Rendered {
  const key = `${kit}/${kind}`;
  let r = cache.get(key);
  if (!r)
    cache.set(key, (r = renderDrum(DRUMS, kind, kit, DRUM_REFERENCE_VELOCITY)));
  return r;
}

interface Spectrum {
  power: Float64Array;
  binHz: number;
  total: number;
}

/**
 * Power spectrum of a hit WITHOUT a window: a hit starts and ends at zero,
 * and a window would hide the attack, which is where clicks, sticks and
 * cracks live. A span that cuts into the sound gets a short fade at the cut
 * (and only there), so the cut itself does not show up as treble.
 */
function spectrum(
  r: Rendered,
  from = 0,
  to = r.frames / r.sampleRate,
): Spectrum {
  const a = Math.max(0, Math.round(from * r.sampleRate));
  const b = Math.min(r.frames, Math.round(to * r.sampleRate));
  const size = nextPow2(Math.max(2048, b - a));
  const fade = Math.min((b - a) >> 2, Math.round(0.005 * r.sampleRate));
  const power = new Float64Array(size / 2 + 1);
  for (const channel of [r.left, r.right]) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = a; i < b; i++) {
      let gain = 1;
      if (a > 0 && i - a < fade)
        gain *= 0.5 - 0.5 * Math.cos((Math.PI * (i - a)) / fade);
      if (b < r.frames && b - i <= fade)
        gain *= 0.5 - 0.5 * Math.cos((Math.PI * (b - i)) / fade);
      re[i - a] = channel[i] * gain;
    }
    fft(re, im);
    for (let k = 0; k <= size / 2; k++)
      power[k] += 0.5 * (re[k] * re[k] + im[k] * im[k]);
  }
  let total = 0;
  for (const p of power) total += p;
  return { power, binHz: r.sampleRate / size, total };
}

/** Fraction of the energy between two frequencies. */
function share(s: Spectrum, lowHz: number, highHz: number): number {
  const from = Math.max(0, Math.ceil(lowHz / s.binHz));
  const to = Math.min(
    s.power.length - 1,
    Math.floor((highHz - 1e-9) / s.binHz),
  );
  let sum = 0;
  for (let k = from; k <= to; k++) sum += s.power[k];
  return sum / (s.total || 1);
}

function centroid(s: Spectrum): number {
  let weighted = 0;
  for (let k = 1; k < s.power.length; k++) weighted += k * s.binHz * s.power[k];
  return weighted / (s.total || 1);
}

/** Running RMS of both channels over `ms` milliseconds. */
function envelope(r: Rendered, ms: number): Float64Array {
  const width = Math.max(1, Math.round((ms / 1000) * r.sampleRate));
  const out = new Float64Array(r.frames);
  let sum = 0;
  for (let i = 0; i < r.frames; i++) {
    sum += r.left[i] * r.left[i] + r.right[i] * r.right[i];
    if (i >= width)
      sum -=
        r.left[i - width] * r.left[i - width] +
        r.right[i - width] * r.right[i - width];
    out[i] = Math.sqrt(Math.max(0, sum) / (2 * width));
  }
  return out;
}

/** Milliseconds until the 1 ms envelope first reaches half of its maximum. */
function onsetMs(r: Rendered): number {
  const e = envelope(r, 1);
  let top = 0;
  for (const v of e) top = Math.max(top, v);
  for (let i = 0; i < e.length; i++)
    if (e[i] >= 0.5 * top) return (i / r.sampleRate) * 1000;
  return 0;
}

/** Seconds at which the envelope (window `ms`) is loudest; the END of the loudest stretch if it is a plateau. */
function loudestAt(r: Rendered, ms: number): number {
  const e = envelope(r, ms);
  let top = 0;
  for (const v of e) top = Math.max(top, v);
  let at = 0;
  for (let i = 0; i < e.length; i++) if (e[i] >= top * 0.999) at = i;
  return at / r.sampleRate;
}

/** Times (s) of the peaks of the envelope that stand at least `drop` (ratio) above the valleys on both sides. */
function bursts(
  r: Rendered,
  ms: number,
  until: number,
  drop: number,
): number[] {
  const e = envelope(r, ms);
  const end = Math.min(e.length, Math.round(until * r.sampleRate));
  const found: number[] = [];
  let top = 0;
  let topAt = 0;
  let valley = Infinity;
  let rising = true;
  for (let i = 0; i < end; i++) {
    if (rising) {
      if (e[i] > top) {
        top = e[i];
        topAt = i;
      } else if (e[i] < top * drop) {
        // fell far enough: the peak counts, start looking for the next valley
        found.push((topAt - (ms / 2000) * r.sampleRate) / r.sampleRate);
        rising = false;
        valley = e[i];
      }
    } else if (e[i] < valley) valley = e[i];
    else if (e[i] * drop > valley) {
      rising = true;
      top = e[i];
      topAt = i;
    }
  }
  return found;
}

/** T60 of the late decay: three times the span between -20 and -40 dB under the envelope peak. */
function lateT60(r: Rendered): number {
  const e = envelope(r, 10);
  let top = 0;
  let at = 0;
  for (let i = 0; i < e.length; i++)
    if (e[i] > top) {
      top = e[i];
      at = i;
    }
  let t20 = at;
  let t40 = at;
  for (let i = at; i < e.length; i++) {
    if (e[i] >= top * 0.1) t20 = i;
    if (e[i] >= top * 0.01) t40 = i;
  }
  return (3 * (t40 - t20)) / r.sampleRate;
}

const same = (a: Float32Array, b: Float32Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[values.length >> 1];
const mean = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / values.length;
const db = (ratio: number) => 10 * Math.log10(ratio + 1e-30);
/** dB(right) - dB(left) */
const balance = (r: Rendered) => {
  let l = 0;
  let rr = 0;
  for (let i = 0; i < r.frames; i++) {
    l += r.left[i] * r.left[i];
    rr += r.right[i] * r.right[i];
  }
  return db(rr / (l + 1e-30));
};

/* ------------------------------------------------------------------ */
/* the contract of DrumVoice                                           */
/* ------------------------------------------------------------------ */

test("every kind of every kit fills its declared length with finite, bounded, click-free audio", () => {
  const original = Math.random;
  Math.random = () => {
    throw new Error("Math.random() used inside the drums");
  };
  try {
    forEachHit((kind, kit, what) => {
      const length = DRUMS.length(kind, kit);
      assert.ok(
        Number.isFinite(length) && length >= 0.015 && length < 4,
        `${what}: length ${length}`,
      );
      for (const sampleRate of [SAMPLE_RATE, 44100])
        for (const vel of [0.25, 0.8, 1]) {
          const at = `${what} vel ${vel} @${sampleRate}`;
          const r = renderDrum(DRUMS, kind, kit, vel, sampleRate);
          assert.equal(
            r.frames,
            Math.ceil(length * sampleRate),
            `${at}: frames`,
          );
          assert.ok(r.guardIntact, `${at}: wrote beyond frames`);
          assert.ok(isFiniteAudio(r), `${at}: not finite`);
          const top = peak(r);
          // never past the ceiling, and never far under what the velocity law promises
          const promised =
            drumPeak(kind, kit) * Math.pow(Math.min(vel, 0.8) / 0.8, 1.5);
          assert.ok(
            top <= 0.9801 && top > 0.3 * promised,
            `${at}: peak ${top}, expected about ${promised}`,
          );
          // exact zeros at both ends, a faded start, and nothing left at the end
          assert.equal(r.left[0], 0, `${at}: first sample`);
          assert.equal(r.right[0], 0, `${at}: first sample (right)`);
          assert.equal(r.left[r.frames - 1], 0, `${at}: last sample`);
          assert.equal(r.right[r.frames - 1], 0, `${at}: last sample (right)`);
          for (let i = 0; i < 4; i++)
            assert.ok(
              Math.abs(r.left[i]) <= 0.12 * top + 1e-4,
              `${at}: sample ${i} is ${r.left[i]} of peak ${top}`,
            );
          const clicks = checkClicks(r, {
            startJump: 2,
            maxJump: 2,
            releaseJumpRatio: 0,
          });
          assert.ok(clicks.ok, `${at}: ${clicks.problems.join("; ")}`);
          assert.ok(
            tailIsSilent(r, 0.003, -60),
            `${at}: tail ${rmsDb(r, length - 0.003).toFixed(1)} dBFS`,
          );
          // (a short low hit has a small mean by nature: half a cycle more one way than the other)
          assert.ok(dcOffset(r) < 0.01, `${at}: DC ${dcOffset(r)}`);
        }
      // the declared length is used: something still sounds in its second half
      const r = hit(kind, kit);
      const late =
        rmsDb(r, length * 0.5, length * 0.8) - 20 * Math.log10(peak(r));
      assert.ok(
        late > -78,
        `${what}: silent from the middle on (${late.toFixed(0)} dB under its peak)`,
      );
    });
  } finally {
    Math.random = original;
  }
});

test("pure tones have no step anywhere: the soft kit's drums move smoothly from sample to sample", () => {
  for (const kind of [
    "kick",
    "tomLow",
    "tomMid",
    "tomHigh",
    "taiko",
    "subBoom",
  ] as DrumKind[])
    for (const vel of [0.3, 1]) {
      const r = renderDrum(DRUMS, kind, "soft", vel);
      let step = 0;
      for (let i = 1; i < r.frames; i++)
        step = Math.max(step, Math.abs(r.left[i] - r.left[i - 1]));
      // a 200 Hz sine at full scale steps by 0.026; a click would be far above that
      assert.ok(step < 0.03, `soft/${kind} vel ${vel}: step ${step}`);
    }
});

test("deterministic: one draw of ctx.random per hit decides everything, and render() adds", () => {
  forEachHit((kind, kit, what) => {
    const a = hit(kind, kit);
    const b = renderDrum(DRUMS, kind, kit, 0.8);
    assert.ok(
      same(a.left, b.left) && same(a.right, b.right),
      `${what}: not deterministic`,
    );
    const added = renderDrum(DRUMS, kind, kit, 0.8, SAMPLE_RATE, 1, 0.25);
    assert.ok(
      added.guardIntact,
      `${what}: wrote beyond frames into prefilled buffers`,
    );
    for (let i = 0; i < a.frames; i += 7) {
      assert.ok(
        Math.abs(added.left[i] - 0.25 - a.left[i]) < 1e-6,
        `${what}: overwrites (frame ${i})`,
      );
      assert.ok(
        Math.abs(added.right[i] - 0.25 - a.right[i]) < 1e-6,
        `${what}: overwrites (right, frame ${i})`,
      );
    }
    // the parent stream advances by exactly one value, so a hit never shifts the hits after it
    for (const [vel, frames] of [
      [0.8, a.frames],
      [0, a.frames],
      [0.6, 1],
      [1, a.frames + 500],
    ] as const) {
      let draws = 0;
      const random = createRng(9);
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      DRUMS.render(left, right, frames, kind, kit, vel, {
        sampleRate: SAMPLE_RATE,
        random: () => (draws++, random()),
      });
      assert.equal(
        draws,
        1,
        `${what}: ${draws} draws at vel ${vel}, ${frames} frames`,
      );
    }
  });
  // noise is really seeded by that draw
  for (const kit of DRUM_KITS)
    for (const kind of [
      "snare",
      "hatClosed",
      "clap",
      "shaker",
      "crash",
    ] as DrumKind[])
      assert.ok(
        !same(
          hit(kind, kit).left,
          renderDrum(DRUMS, kind, kit, 0.8, SAMPLE_RATE, 2).left,
        ),
        `${kit}/${kind}: ignores the seed`,
      );
});

test("any buffer length: shorter cuts the hit with a fade, longer is left untouched, silly velocities are safe", () => {
  forEachHit((kind, kit, what) => {
    const full = hit(kind, kit);
    const natural = full.frames;
    const render = (frames: number, vel: number, pad = 16) => {
      const left = new Float32Array(frames + pad);
      const right = new Float32Array(frames + pad);
      DRUMS.render(left, right, frames, kind, kit, vel, {
        sampleRate: SAMPLE_RATE,
        random: createRng(1),
      });
      return { left, right };
    };
    // cut short: identical until the fade, exactly zero at the cut, nothing after it
    const cut = Math.max(600, Math.round(natural * 0.37));
    if (cut < natural) {
      const short = render(cut, 0.8);
      const fade = Math.round(0.006 * SAMPLE_RATE) + 1;
      for (let i = 0; i < cut - fade; i += 3)
        assert.ok(
          Math.abs(short.left[i] - full.left[i]) < 1e-6,
          `${what}: cut hit differs at ${i}`,
        );
      assert.equal(
        short.left[cut - 1],
        0,
        `${what}: cut hit ends at ${short.left[cut - 1]}`,
      );
      assert.equal(
        short.right[cut - 1],
        0,
        `${what}: cut hit ends at ${short.right[cut - 1]} (right)`,
      );
      for (let i = cut; i < cut + 16; i++)
        assert.equal(short.left[i], 0, `${what}: wrote past the cut`);
    }
    // more room than needed: the hit ends where length() says
    const long = render(natural + 1000, 0.8, 0);
    assert.ok(
      same(long.left.subarray(0, natural), full.left),
      `${what}: differs in a longer buffer`,
    );
    for (let i = natural; i < natural + 1000; i++)
      assert.ok(
        long.left[i] === 0 && long.right[i] === 0,
        `${what}: wrote past its length`,
      );
    for (const frames of [1, 2, 3, 17, 150])
      for (const vel of [0.5, 5]) {
        const tiny = render(frames, vel);
        for (let i = 0; i < frames + 16; i++)
          assert.ok(
            Number.isFinite(tiny.left[i]) && Math.abs(tiny.left[i]) <= 0.98,
            `${what}: ${frames} frames → ${tiny.left[i]}`,
          );
        assert.equal(tiny.left[0], 0, `${what}: ${frames} frames start`);
        assert.equal(tiny.left[frames - 1], 0, `${what}: ${frames} frames end`);
        assert.equal(tiny.left[frames], 0, `${what}: ${frames} frames overrun`);
      }
    // velocity 0, negative and NaN are silence; above 1 is 1
    for (const vel of [0, -1, Number.NaN]) {
      const silent = render(natural, vel);
      assert.ok(
        silent.left.every((v) => v === 0) && silent.right.every((v) => v === 0),
        `${what}: vel ${vel} is not silent`,
      );
    }
    assert.ok(
      same(render(natural, 3).left, render(natural, 1).left),
      `${what}: vel 3 differs from vel 1`,
    );
  });
});

/* ------------------------------------------------------------------ */
/* level                                                               */
/* ------------------------------------------------------------------ */

test("calibration: at velocity 0.8 a hit peaks at drumPeak(kind, kit), whatever noise it draws", (t) => {
  // the table itself: the anchors the mix is built on
  for (const kit of [
    "pop",
    "electro",
    "acoustic",
    "cinematic",
  ] as DrumKitId[]) {
    assert.equal(KIT_LEVELS[kit], 1);
    assert.ok(drumPeak("kick", kit) >= 0.8 && drumPeak("kick", kit) <= 0.9);
    assert.ok(drumPeak("snare", kit) >= 0.6 && drumPeak("snare", kit) <= 0.7);
    for (const hat of ["hatClosed", "hatOpen", "ride"] as DrumKind[])
      assert.ok(drumPeak(hat, kit) >= 0.25 && drumPeak(hat, kit) <= 0.35);
  }
  for (const kit of NON_CHIP)
    for (const kind of DRUM_KINDS)
      if (!CONSOLE_KINDS.includes(kind))
        assert.equal(drumPeak(kind, kit), DRUM_PEAKS[kind] * KIT_LEVELS[kit]);
  for (const kit of ["lofi", "brush", "soft"] as DrumKitId[])
    assert.ok(
      KIT_LEVELS[kit] < 1 && KIT_LEVELS[kit] >= 0.7,
      `${kit} plays a little quieter`,
    );

  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const rows: string[] = [];
  forEachHit((kind, kit, what) => {
    const nominal = drumPeak(kind, kit);
    const renders = seeds.map((seed) =>
      renderDrum(DRUMS, kind, kit, 0.8, SAMPLE_RATE, seed),
    );
    const peaks = renders.map(peak);
    const levels = renders.map((r) => rmsDb(r));
    const middle = median(peaks);
    const spread = Math.max(...levels) - Math.min(...levels);
    const shaken = SHAKEN.includes(kind) && kit !== "chip";
    // jingles collide at random; everything else stays within a few percent
    assert.ok(
      Math.abs(middle / nominal - 1) <= (shaken ? 0.2 : 0.12),
      `${what}: median peak ${middle.toFixed(3)}, nominal ${nominal}`,
    );
    assert.ok(
      Math.max(...peaks) <= nominal * 1.15 + 1e-4,
      `${what}: peak ${Math.max(...peaks).toFixed(3)} above 1.15 × ${nominal}`,
    );
    assert.ok(
      Math.min(...peaks) >= nominal * (shaken ? 0.35 : 0.6),
      `${what}: peak ${Math.min(...peaks).toFixed(3)} far below ${nominal}`,
    );
    // equal velocities are equally loud: the gain is fixed, not normalised per hit
    // (a 50 ms burst of noise cannot be more repeatable than about ±1.5 dB)
    const allowed = shaken ? 6 : DRUMS.length(kind, kit) < 0.1 ? 3.5 : 2.5;
    assert.ok(
      spread <= allowed,
      `${what}: level varies by ${spread.toFixed(2)} dB between seeds`,
    );
    if (kit === "pop" || kit === "chip")
      rows.push(
        `${what}: peak ${Math.min(...peaks).toFixed(2)}..${Math.max(...peaks).toFixed(2)} (nominal ${nominal.toFixed(3)}), ±${(spread / 2).toFixed(1)} dB`,
      );
  });
  for (const row of rows) t.diagnostic(row);
  // the three anchors as rendered
  for (const kit of [
    "pop",
    "electro",
    "acoustic",
    "cinematic",
  ] as DrumKitId[]) {
    const at = (kind: DrumKind) =>
      median(
        seeds.map((seed) =>
          peak(renderDrum(DRUMS, kind, kit, 0.8, SAMPLE_RATE, seed)),
        ),
      );
    assert.ok(
      at("kick") >= 0.78 && at("kick") <= 0.92,
      `${kit} kick peaks at ${at("kick")}`,
    );
    assert.ok(
      at("snare") >= 0.58 && at("snare") <= 0.72,
      `${kit} snare peaks at ${at("snare")}`,
    );
    assert.ok(
      at("hatClosed") >= 0.24 && at("hatClosed") <= 0.36,
      `${kit} hat peaks at ${at("hatClosed")}`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* velocity                                                            */
/* ------------------------------------------------------------------ */

test("velocity: louder by a steady law, never past the ceiling, and it changes the tone", () => {
  const seeds = [1, 2, 3];
  forEachHit((kind, kit, what) => {
    const level = (vel: number) =>
      mean(
        seeds.map((seed) =>
          loudestWindowDb(
            renderDrum(DRUMS, kind, kit, vel, SAMPLE_RATE, seed),
            0.05,
          ),
        ),
      );
    const steps = [0.15, 0.3, 0.5, 0.7, 0.85, 1].map(level);
    for (let i = 1; i < steps.length; i++)
      assert.ok(
        steps[i] > steps[i - 1] + 0.3,
        `${what}: level does not rise with velocity: ${steps.map((v) => v.toFixed(1)).join(" ")}`,
      );
    // (1 / 0.4)^1.5 is 11.9 dB; timbre adds a little, the headroom of loud drums takes a little
    const span = level(1) - level(0.4);
    assert.ok(
      span >= 9 && span <= 17.5,
      `${what}: vel 1 is ${span.toFixed(1)} dB above vel 0.4`,
    );
    for (const seed of [1, 2, 3, 4, 5, 6])
      assert.ok(
        peak(renderDrum(DRUMS, kind, kit, 1, SAMPLE_RATE, seed)) <= 0.9801,
        `${what}: vel 1 exceeds the ceiling`,
      );

    let bright = 0;
    let treble = 0;
    let softOnset = 0;
    let hardOnset = 0;
    let softRing = 0;
    let hardRing = 0;
    for (const seed of seeds) {
      const soft = renderDrum(DRUMS, kind, kit, 0.3, SAMPLE_RATE, seed);
      const hard = renderDrum(DRUMS, kind, kit, 1, SAMPLE_RATE, seed);
      const a = spectrum(soft);
      const b = spectrum(hard);
      bright += centroid(b) / centroid(a) / seeds.length;
      treble +=
        (db(share(b, 1000, 24000)) - db(share(a, 1000, 24000))) / seeds.length;
      softOnset += onsetMs(soft) / seeds.length;
      hardOnset += onsetMs(hard) / seeds.length;
      softRing += lateT60(soft) / seeds.length;
      hardRing += lateT60(hard) / seeds.length;
    }
    // brighter: the centre of the spectrum moves up, or (low drums, where the
    // fundamental owns the centroid) the share above 1 kHz grows
    const brighter = bright >= 1.03 || treble >= 1;
    const softer = softOnset >= hardOnset + 0.1;
    const longer = hardRing >= softRing * 1.03;
    const detail = `centroid ×${bright.toFixed(3)}, treble ${treble.toFixed(1)} dB, onset ${softOnset.toFixed(2)} → ${hardOnset.toFixed(2)} ms, ring ${softRing.toFixed(3)} → ${hardRing.toFixed(3)} s`;
    if (isConsole(kind, kit))
      // a console has volume steps, a noise clock and duty cycles — one of them must respond
      assert.ok(
        brighter || softer || longer,
        `${what}: velocity only changes the level (${detail})`,
      );
    else if (SHAKEN.includes(kind) || kind === "cymbalSwell")
      // collisions are random and a swell has a fixed shape: only brightness is a fair demand
      assert.ok(brighter, `${what}: not brighter when hit harder (${detail})`);
    else {
      assert.ok(brighter, `${what}: not brighter when hit harder (${detail})`);
      assert.ok(
        softer || longer,
        `${what}: neither a softer attack at low velocity nor a longer ring at high (${detail})`,
      );
    }
  });
  // the headline cases, each on its own
  for (const kit of NON_CHIP) {
    const onset = (kind: DrumKind, vel: number) =>
      onsetMs(renderDrum(DRUMS, kind, kit, vel));
    assert.ok(
      onset("kick", 0.25) > onset("kick", 1) * 1.3,
      `${kit} kick: a soft hit lands softly`,
    );
    assert.ok(
      onset("snare", 0.25) > onset("snare", 1),
      `${kit} snare: a soft stroke has no edge`,
    );
    assert.ok(
      lateT60(renderDrum(DRUMS, "kick", kit, 1)) >
        lateT60(renderDrum(DRUMS, "kick", kit, 0.3)) * 1.1,
      `${kit} kick rings longer when hit hard`,
    );
    const hat = (vel: number) =>
      centroid(spectrum(renderDrum(DRUMS, "hatClosed", kit, vel)));
    assert.ok(hat(1) > hat(0.3) * 1.02, `${kit} hat is brighter when hit hard`);
  }
});

/* ------------------------------------------------------------------ */
/* what the sounds are                                                 */
/* ------------------------------------------------------------------ */

test("kick: most of the energy below 150 Hz, plus a click", () => {
  for (const kit of DRUM_KITS) {
    for (const vel of [0.5, 0.8, 1]) {
      const low = share(spectrum(renderDrum(DRUMS, "kick", kit, vel)), 0, 150);
      assert.ok(
        low >= 0.75,
        `${kit} kick vel ${vel}: ${(low * 100).toFixed(0)} % below 150 Hz`,
      );
    }
    // and it is the lowest drum of its kit after the sub boom
    const pitch = (kind: DrumKind) => centroid(spectrum(hit(kind, kit)));
    assert.ok(
      pitch("kick") < pitch("tomMid") && pitch("kick") < pitch("snare"),
      `${kit}: kick is not low`,
    );
  }
  // beater click: a clicky kit puts far more above 1 kHz in the first 10 ms than the soft one
  const click = (kit: DrumKitId) =>
    db(share(spectrum(hit("kick", kit), 0, 0.01), 1000, 24000));
  for (const kit of ["pop", "acoustic", "electro", "cinematic"] as DrumKitId[])
    assert.ok(
      click(kit) > click("soft") + 10,
      `${kit} kick has no click (${click(kit).toFixed(0)} dB vs soft ${click("soft").toFixed(0)} dB)`,
    );
  // the 808 rings on
  // (it used to ring 1.75× as long; that put a fifth of a dance mix's energy under 60 Hz)
  assert.ok(
    lateT60(hit("kick", "electro")) > lateT60(hit("kick", "pop")) * 1.2,
  );
});

test("snare: a tuned shell and noisy wires at once", () => {
  for (const kit of NON_CHIP) {
    const r = hit("snare", kit);
    const s = spectrum(r);
    const tone = share(s, 110, 450);
    const noise = share(s, 1500, 24000);
    assert.ok(
      tone >= 0.15 && tone <= 0.8,
      `${kit} snare: ${(tone * 100).toFixed(0)} % in the shell band`,
    );
    assert.ok(
      noise >= 0.18,
      `${kit} snare: ${(noise * 100).toFixed(0)} % above 1.5 kHz`,
    );
    // the shell is a spectral line (once a drum-machine shell has settled on its note) …
    const body = spectrum(r, 0.02, 0.1);
    const bins = Array.from(
      body.power.subarray(
        Math.ceil(110 / body.binHz),
        Math.floor(450 / body.binHz),
      ),
    );
    assert.ok(
      Math.max(...bins) > 5 * mean(bins),
      `${kit} snare: no clear shell tone`,
    );
    // … and the wires are noise: flat on average, no lines (white noise scores 0.56)
    const wires = Array.from(
      s.power.subarray(
        Math.ceil(2500 / s.binHz),
        Math.floor(
          Math.min(8000, kit === "lofi" || kit === "soft" ? 4500 : 8000) /
            s.binHz,
        ),
      ),
    );
    const flatness =
      Math.exp(mean(wires.map((p) => Math.log(p + 1e-30)))) / mean(wires);
    assert.ok(
      flatness > 0.3,
      `${kit} snare: wires are not noise (flatness ${flatness.toFixed(2)})`,
    );
  }
  // separate envelopes: on the acoustic drum the wires outlast the shell
  const acoustic = hit("snare", "acoustic");
  const late = spectrum(acoustic, 0.15, 0.3);
  assert.ok(
    share(late, 1500, 24000) > share(spectrum(acoustic, 0, 0.05), 1500, 24000),
  );
});

test("hats and cymbals: energy above 5 kHz, closed short and open long", () => {
  for (const kit of DRUM_KITS) {
    for (const kind of ["hatClosed", "hatOpen"] as DrumKind[]) {
      const high = share(spectrum(hit(kind, kit)), 5000, 24000);
      // (the console hat is plain noise, the lofi one is low-passed: "most", not "nearly all")
      assert.ok(
        high >= (kit === "chip" || kit === "lofi" ? 0.5 : 0.75),
        `${kit} ${kind}: ${(high * 100).toFixed(0)} % above 5 kHz`,
      );
    }
    assert.ok(
      DRUMS.length("hatOpen", kit) >= DRUMS.length("hatClosed", kit) * 3.5,
      `${kit}: open hat is not longer`,
    );
    assert.ok(
      DRUMS.length("hatClosed", kit) <= 0.13,
      `${kit}: closed hat is ${DRUMS.length("hatClosed", kit)} s`,
    );
    assert.ok(
      DRUMS.length("crash", kit) > DRUMS.length("ride", kit),
      `${kit}: crash is not longer than ride`,
    );
    assert.ok(
      DRUMS.length("crash", kit) > DRUMS.length("hatOpen", kit) * 2,
      `${kit}: crash is not longer than the open hat`,
    );
  }
  for (const kit of NON_CHIP) {
    assert.ok(
      lateT60(hit("hatOpen", kit)) > lateT60(hit("hatClosed", kit)) * 3,
      `${kit}: open hat does not ring longer`,
    );
    // the top of a cymbal dies first
    const crash = hit("crash", kit);
    const early = centroid(spectrum(crash, 0.02, 0.2));
    const late = centroid(
      spectrum(
        crash,
        DRUMS.length("crash", kit) * 0.5,
        DRUMS.length("crash", kit) * 0.8,
      ),
    );
    assert.ok(
      late < early * 0.93,
      `${kit} crash: centroid ${early.toFixed(0)} → ${late.toFixed(0)} Hz`,
    );
    for (const kind of ["ride", "crash"] as DrumKind[])
      assert.ok(
        share(spectrum(hit(kind, kit)), 2000, 24000) >
          (kit === "brush" || kit === "soft" || kit === "lofi" ? 0.15 : 0.7),
        `${kit} ${kind} is not metallic`,
      );
  }
  // lofi is darker than pop
  for (const kind of ["hatClosed", "hatOpen", "ride", "crash"] as DrumKind[]) {
    const lofi = spectrum(hit(kind, "lofi"));
    const pop = spectrum(hit(kind, "pop"));
    assert.ok(
      centroid(lofi) < centroid(pop) * 0.8,
      `lofi ${kind}: centroid ${centroid(lofi).toFixed(0)} vs pop ${centroid(pop).toFixed(0)}`,
    );
    assert.ok(
      share(lofi, 10000, 24000) < 0.05 && share(pop, 10000, 24000) > 0.12,
      `lofi ${kind} keeps its top end`,
    );
  }
  // the jazz ride pings: bell modes carry it, the wash stays underneath
  const ping = (kit: DrumKitId) => share(spectrum(hit("ride", kit)), 400, 2500);
  assert.ok(
    ping("brush") > 0.5 && ping("brush") > ping("pop") * 2,
    `brush ride ping ${ping("brush")}`,
  );
  // dense inharmonic partials: the acoustic hat is made of lines, the pop hat mostly of noise
  const lines = (kit: DrumKitId) => {
    const s = spectrum(hit("hatOpen", kit), 0.02, 0.36);
    const bins = Array.from(
      s.power.subarray(Math.ceil(7000 / s.binHz), Math.floor(10000 / s.binHz)),
    );
    return Math.exp(mean(bins.map((p) => Math.log(p + 1e-30)))) / mean(bins);
  };
  assert.ok(
    lines("acoustic") < lines("pop") * 0.8,
    `acoustic hat flatness ${lines("acoustic").toFixed(2)} vs pop ${lines("pop").toFixed(2)}`,
  );
});

test("chip kit: only noise bursts, pulses and staircase triangles — a few discrete levels held for whole samples", () => {
  /** share of sample-to-sample steps that are exactly zero, away from the safety fades */
  const held = (r: Rendered) => {
    const from = Math.round(0.001 * r.sampleRate);
    const to = r.frames - Math.round(0.008 * r.sampleRate);
    let flat = 0;
    let sounding = 0;
    for (let i = from + 1; i < to; i++) {
      if (r.left[i] === 0 && r.left[i - 1] === 0) continue;
      sounding++;
      if (r.left[i] === r.left[i - 1]) flat++;
    }
    return flat / Math.max(1, sounding);
  };
  /** distinct values in a 2 ms window in the middle of the first quarter */
  const levels = (r: Rendered) => {
    const from = Math.round(0.002 * r.sampleRate);
    return new Set(r.left.subarray(from, from + 96)).size;
  };
  for (const kind of DRUM_KINDS) {
    const chip = hit(kind, "chip");
    assert.ok(
      held(chip) > 0.3,
      `chip/${kind}: only ${(held(chip) * 100).toFixed(0)} % of the samples hold their value`,
    );
    assert.ok(
      levels(chip) <= 40,
      `chip/${kind}: ${levels(chip)} different levels in 2 ms`,
    );
    assert.ok(same(chip.left, chip.right), `chip/${kind} is not mono`);
    if (!CONSOLE_KINDS.includes(kind)) {
      const pop = hit(kind, "pop");
      assert.ok(
        held(pop) < 0.02,
        `pop/${kind} holds samples like a console (${held(pop)})`,
      );
      assert.ok(levels(pop) > 60, `pop/${kind}: ${levels(pop)} levels`);
    }
  }
  // the noise channel is binary: one level and its negative while the volume holds
  for (const kind of [
    "noiseHit",
    "noiseTick",
    "hatClosed",
    "hatOpen",
  ] as DrumKind[]) {
    const r = hit(kind, "chip");
    const from = Math.round(0.0045 * r.sampleRate);
    const values = new Set(
      Array.from(r.left.subarray(from, from + 150)).map((v) => Math.abs(v)),
    );
    assert.equal(
      values.size,
      1,
      `chip/${kind}: ${values.size} magnitudes inside one volume step`,
    );
  }
  // volume moves in steps of a 240 Hz tick: the envelope of a hat is a staircase going down
  const hat = hit("hatOpen", "chip");
  const tick = SAMPLE_RATE / 240;
  const steps: number[] = [];
  for (let t = 1; t < 30; t++)
    steps.push(Math.abs(hat.left[Math.round((t + 0.5) * tick)]));
  for (let i = 1; i < steps.length; i++)
    assert.ok(steps[i] <= steps[i - 1] + 1e-9, "chip open hat volume rises");
  assert.ok(
    new Set(steps).size >= 6 && new Set(steps).size <= 15,
    `chip open hat has ${new Set(steps).size} volume levels`,
  );
  // the kick is a triangle that dives: mostly low, pitch falling
  const kick = hit("kick", "chip");
  assert.ok(
    centroid(spectrum(kick, 0, 0.03)) >
      centroid(spectrum(kick, 0.05, 0.1)) * 1.3,
  );
  // the two noise-channel kinds are console sounds in every kit
  for (const kit of NON_CHIP)
    for (const kind of CONSOLE_KINDS) {
      assert.equal(drumPeak(kind, kit), drumPeak(kind, "chip"));
      if (kit !== "lofi" && kit !== "soft" && kit !== "brush")
        assert.ok(
          held(hit(kind, kit)) > 0.3,
          `${kit}/${kind} is not a console sound`,
        );
    }
  assert.ok(
    centroid(spectrum(hit("noiseTick", "pop"))) >
      centroid(spectrum(hit("noiseHit", "pop"))) * 1.5,
    "tick is not brighter than hit",
  );
  assert.ok(
    DRUMS.length("noiseHit", "pop") > DRUMS.length("noiseTick", "pop") * 2.5,
    "hit is not longer than tick",
  );
});

test("toms, taiko and sub boom: tuned, ordered, and the cinematic ones are huge", () => {
  for (const kit of DRUM_KITS) {
    const pitch = (kind: DrumKind) => centroid(spectrum(hit(kind, kit)));
    assert.ok(
      pitch("tomLow") < pitch("tomMid") * 0.9 &&
        pitch("tomMid") < pitch("tomHigh") * 0.9,
      `${kit}: toms are not ordered by pitch`,
    );
    assert.ok(
      DRUMS.length("tomLow", kit) >= DRUMS.length("tomHigh", kit),
      `${kit}: low tom is shorter than high tom`,
    );
    assert.ok(
      share(spectrum(hit("subBoom", kit)), 0, 150) > 0.9,
      `${kit}: sub boom is not sub`,
    );
    assert.ok(
      DRUMS.length("subBoom", kit) > DRUMS.length("kick", kit) * 1.5,
      `${kit}: sub boom is not longer than the kick`,
    );
    assert.ok(
      DRUMS.length("taiko", kit) > DRUMS.length("tomLow", kit) * 1.4,
      `${kit}: taiko is not longer than a tom`,
    );
  }
  // cinematic taiko against pop low tom: longer on paper and in the decay
  assert.ok(
    DRUMS.length("taiko", "cinematic") > DRUMS.length("tomLow", "pop") * 3,
  );
  assert.ok(
    lateT60(hit("taiko", "cinematic")) > lateT60(hit("tomLow", "pop")) * 3,
  );
  for (const kind of [
    "taiko",
    "subBoom",
    "crash",
    "kick",
    "tomLow",
    "snare",
    "gong",
  ] as DrumKind[])
    for (const kit of DRUM_KITS)
      assert.ok(
        DRUMS.length(kind, "cinematic") >= DRUMS.length(kind, kit),
        `cinematic ${kind} is shorter than ${kit}`,
      );
  // skin slap: the first 30 ms of the taiko carry far more above 600 Hz than its ring
  const taiko = hit("taiko", "cinematic");
  assert.ok(
    share(spectrum(taiko, 0, 0.03), 600, 24000) >
      share(spectrum(taiko, 0.3, 1), 600, 24000) * 20,
  );
  // a boom you can hear on small speakers: drive puts harmonics above the 34 Hz fundamental
  assert.ok(share(spectrum(hit("subBoom", "cinematic")), 60, 150) > 0.02);
});

test("cymbalSwell: grows towards SWELL_PEAK_SECONDS in every kit, then lets go", () => {
  assert.ok(SWELL_PEAK_SECONDS >= 1.5 && SWELL_PEAK_SECONDS <= 2.5);
  for (const kit of DRUM_KITS) {
    const r = hit("cymbalSwell", kit);
    const length = DRUMS.length("cymbalSwell", kit);
    assert.ok(
      length > SWELL_PEAK_SECONDS + 0.01 && length <= SWELL_PEAK_SECONDS + 0.3,
      `${kit}: swell is ${length} s`,
    );
    const parts = 6;
    const levels = Array.from({ length: parts }, (_, i) =>
      rmsDb(
        r,
        (i * SWELL_PEAK_SECONDS) / parts,
        ((i + 1) * SWELL_PEAK_SECONDS) / parts,
      ),
    );
    for (let i = 1; i < parts; i++)
      assert.ok(
        levels[i] > levels[i - 1] + 1,
        `${kit} swell does not keep growing: ${levels.map((v) => v.toFixed(1)).join(" ")}`,
      );
    assert.ok(
      levels[parts - 1] - levels[0] > 20,
      `${kit} swell grows only ${(levels[parts - 1] - levels[0]).toFixed(0)} dB`,
    );
    const top = loudestAt(r, 30);
    assert.ok(
      Math.abs(top - SWELL_PEAK_SECONDS) <= 0.05,
      `${kit} swell peaks at ${top.toFixed(3)} s`,
    );
    // the velocity changes the level, not the timing
    for (const vel of [0.3, 1])
      assert.ok(
        Math.abs(
          loudestAt(renderDrum(DRUMS, "cymbalSwell", kit, vel), 30) -
            SWELL_PEAK_SECONDS,
        ) <= 0.05,
        `${kit} swell vel ${vel} peaks elsewhere`,
      );
    // and it gets brighter as it comes
    if (kit !== "soft" && kit !== "lofi")
      assert.ok(
        centroid(spectrum(r, 1.4, 1.8)) >
          centroid(spectrum(r, 0.2, 0.8)) * 1.15,
        `${kit} swell does not brighten`,
      );
  }
  // the composer starts a swell this long before the downbeat: one shared constant
  assert.equal(SWELL_PEAK_SECONDS, CYMBAL_SWELL_SECONDS);
  assert.equal(
    SWELL_LEAD_SECONDS,
    CYMBAL_SWELL_SECONDS,
    "src/music/rhythm.ts places the swell for a different peak time",
  );
});

test("small percussion: claps come in bursts, shakers swell, jingles ring high, wood and snaps are short", () => {
  // clap: several bursts 8–12 ms apart before the tail
  for (const kit of [
    "electro",
    "pop",
    "acoustic",
    "cinematic",
    "lofi",
  ] as DrumKitId[]) {
    const found = bursts(hit("clap", kit), 2, 0.09, 0.6);
    assert.ok(found.length >= 3, `${kit} clap has ${found.length} bursts`);
    const gaps = found.slice(1).map((time, i) => (time - found[i]) * 1000);
    if (kit === "electro" || kit === "pop")
      for (const gap of gaps.slice(0, 2))
        assert.ok(
          gap >= 7 && gap <= 13,
          `${kit} clap bursts are ${gaps.map((g) => g.toFixed(1)).join(", ")} ms apart`,
        );
  }
  for (const kit of NON_CHIP) {
    assert.ok(
      share(spectrum(hit("clap", kit)), 500, 6000) > 0.7,
      `${kit} clap is not band-passed`,
    );
    // a shaker is thrown, not struck (the machine one is the exception)
    if (kit !== "electro")
      assert.ok(
        onsetMs(hit("shaker", kit)) > 6,
        `${kit} shaker onset ${onsetMs(hit("shaker", kit))} ms`,
      );
    assert.ok(
      onsetMs(hit("tambourine", kit)) < 6,
      `${kit} tambourine is not struck`,
    );
    for (const kind of ["tambourine", "sleighBell"] as DrumKind[])
      assert.ok(
        share(spectrum(hit(kind, kit)), 2000, 24000) > 0.75,
        `${kit} ${kind} does not jingle`,
      );
    assert.ok(
      DRUMS.length("sleighBell", kit) > DRUMS.length("shaker", kit) * 2,
      `${kit}: sleigh bells do not ring on`,
    );
    // finger snap: a short band between 1.5 and 5 kHz
    const snap = spectrum(hit("fingerSnap", kit));
    assert.ok(
      share(snap, 1500, 5000) > 0.7,
      `${kit} snap: ${(share(snap, 1500, 5000) * 100).toFixed(0)} % in its band`,
    );
    assert.ok(DRUMS.length("fingerSnap", kit) <= 0.2);
    // wood block and rim: a pitched knock, over quickly
    for (const kind of ["woodblock", "rim"] as DrumKind[]) {
      const s = spectrum(hit(kind, kit));
      assert.ok(
        share(s, 300, 5000) > 0.9,
        `${kit} ${kind} is not in the mid range`,
      );
      const bins = Array.from(
        s.power.subarray(Math.ceil(300 / s.binHz), Math.floor(4000 / s.binHz)),
      );
      assert.ok(
        Math.max(...bins) > 8 * mean(bins),
        `${kit} ${kind} has no pitch`,
      );
      assert.ok(DRUMS.length(kind, kit) <= 0.25);
    }
    // jingles are narrow resonances, a shaker is broad noise
    const flat = (kind: DrumKind) => {
      const s = spectrum(hit(kind, kit));
      const bins = Array.from(
        s.power.subarray(
          Math.ceil(2500 / s.binHz),
          Math.floor(11000 / s.binHz),
        ),
      );
      // smooth over 200 Hz first: this looks at the shape, not at the noise
      const width = Math.max(1, Math.round(200 / s.binHz));
      const smooth: number[] = [];
      for (let i = 0; i + width <= bins.length; i += width)
        smooth.push(mean(bins.slice(i, i + width)));
      return (
        Math.exp(mean(smooth.map((p) => Math.log(p + 1e-30)))) / mean(smooth)
      );
    };
    if (kit !== "electro")
      assert.ok(
        flat("sleighBell") < flat("shaker"),
        `${kit}: sleigh bells are as flat as the shaker`,
      );
  }
  // brush stroke: a swish that swells, unlike the tap of the snare
  for (const kit of NON_CHIP) {
    assert.ok(
      onsetMs(hit("brushSnare", kit)) > 8,
      `${kit} brush stroke starts like a hit`,
    );
    assert.ok(onsetMs(hit("brushSnare", kit)) > onsetMs(hit("snare", kit)) * 5);
    assert.ok(
      share(spectrum(hit("brushSnare", kit)), 1000, 24000) > 0.85,
      `${kit} brush stroke is not a swish`,
    );
  }
});

test("gong: slow inharmonic modes, and the shimmer blooms after the stroke", () => {
  for (const kit of NON_CHIP) {
    const r = hit("gong", kit);
    assert.ok(
      DRUMS.length("gong", kit) >= 2 && lateT60(r) > 1.2,
      `${kit} gong is short (T60 ${lateT60(r)})`,
    );
    // upper partials arrive late: more of them 150–350 ms in than in the first 30 ms
    const high = (from: number, to: number) => {
      const s = spectrum(r, from, to);
      return (
        (share(s, kit === "soft" ? 400 : 600, 24000) * s.total) / (to - from)
      );
    };
    assert.ok(
      high(0.15, 0.35) > high(0, 0.03) * 1.5,
      `${kit} gong does not bloom`,
    );
    const top = loudestAt(r, 40);
    assert.ok(
      top > 0.02 && top < 0.6,
      `${kit} gong is loudest at ${top.toFixed(3)} s`,
    );
    // many partials that are not multiples of the lowest one
    if (kit !== "soft") {
      const s = spectrum(r, 0.2, 1.2);
      const bins = s.power;
      const lines: number[] = [];
      const reach = Math.round(12 / s.binHz);
      let floor = 0;
      for (let k = Math.ceil(50 / s.binHz); k < Math.floor(1500 / s.binHz); k++)
        floor = Math.max(floor, bins[k]);
      for (
        let k = Math.ceil(50 / s.binHz);
        k < Math.floor(1500 / s.binHz);
        k++
      ) {
        let top = bins[k] > floor * 0.002;
        for (let j = k - reach; j <= k + reach && top; j++)
          if (bins[j] > bins[k]) top = false;
        if (top) lines.push(k * s.binHz);
      }
      assert.ok(lines.length >= 6, `${kit} gong has ${lines.length} partials`);
      const offHarmonic = lines.filter((hz) => {
        const ratio = hz / lines[0];
        return Math.abs(ratio - Math.round(ratio)) > 0.06;
      });
      assert.ok(
        offHarmonic.length >= lines.length / 2,
        `${kit} gong is harmonic: ${lines.map((hz) => hz.toFixed(0)).join(" ")}`,
      );
    }
  }
  assert.ok(
    centroid(spectrum(hit("gong", "cinematic"), 0.3, 1.5)) >
      centroid(spectrum(hit("gong", "soft"), 0.3, 1.5)) * 2,
    "the tam-tam has no wash",
  );
});

test("kits differ in character, not only in level", () => {
  // every kind: any two kits differ by at least 10 % in length, brightness, decay or attack, or by 2 dB of treble
  const feature = (kind: DrumKind, kit: DrumKitId) => {
    const r = hit(kind, kit);
    const s = spectrum(r);
    // length, brightness, decay, attack, and how much sits above the body (×1.1 per dB)
    return [
      DRUMS.length(kind, kit),
      centroid(s),
      lateT60(r) + 0.002,
      onsetMs(r) + 0.3,
      Math.pow(1.1, db(share(s, 500, 24000) + 1e-9) / 2),
    ];
  };
  for (const kind of DRUM_KINDS) {
    if (CONSOLE_KINDS.includes(kind)) continue;
    const features = DRUM_KITS.map((kit) => feature(kind, kit));
    for (let a = 0; a < DRUM_KITS.length; a++)
      for (let b = a + 1; b < DRUM_KITS.length; b++) {
        const apart = Math.max(
          ...features[a].map((value, i) =>
            Math.abs(Math.log(value / features[b][i])),
          ),
        );
        assert.ok(
          apart > Math.log(1.1),
          `${kind}: ${DRUM_KITS[a]} and ${DRUM_KITS[b]} are the same sound`,
        );
      }
  }
  // lofi: low-passed, short, saturated (odd harmonics on the kick)
  for (const kind of [
    "snare",
    "hatClosed",
    "clap",
    "crash",
    "rim",
    "shaker",
  ] as DrumKind[]) {
    assert.ok(
      share(spectrum(hit(kind, "lofi")), 9000, 24000) < 0.03,
      `lofi ${kind} is not low-passed`,
    );
    assert.ok(
      DRUMS.length(kind, "lofi") < DRUMS.length(kind, "pop"),
      `lofi ${kind} is not shorter than pop`,
    );
  }
  // saturation: the lofi kick has harmonics between its fundamental and 400 Hz that the clean soft kick lacks
  const harmonics = (kit: DrumKitId) =>
    db(share(spectrum(hit("kick", kit)), 130, 400));
  assert.ok(
    harmonics("lofi") > harmonics("soft") + 8,
    `lofi kick harmonics ${harmonics("lofi").toFixed(0)} dB, soft ${harmonics("soft").toFixed(0)} dB`,
  );
  // soft: quieter, rounder, darker
  for (const kind of DRUM_KINDS) {
    if (CONSOLE_KINDS.includes(kind)) continue;
    assert.ok(
      drumPeak(kind, "soft") < drumPeak(kind, "pop"),
      `soft ${kind} is as loud as pop`,
    );
  }
  for (const kind of [
    "kick",
    "snare",
    "tomMid",
    "hatClosed",
    "crash",
  ] as DrumKind[])
    assert.ok(
      onsetMs(hit(kind, "soft")) > onsetMs(hit(kind, "pop")) * 1.15,
      `soft ${kind} attacks as hard as pop`,
    );
  for (const kind of [
    "hatClosed",
    "ride",
    "crash",
    "snare",
    "clap",
  ] as DrumKind[])
    assert.ok(
      centroid(spectrum(hit(kind, "soft"))) <
        centroid(spectrum(hit(kind, "pop"))) * 0.85,
      `soft ${kind} is as bright as pop`,
    );
  // acoustic: a room answers (the ring of a rim click is longer than the click)
  assert.ok(lateT60(hit("rim", "acoustic")) > lateT60(hit("rim", "pop")) * 1.8);
  const reflections = (kit: DrumKitId) =>
    rmsDb(hit("snare", kit), 0.0065, 0.045) -
    rmsDb(hit("snare", kit), 0, 0.006);
  assert.ok(Number.isFinite(reflections("acoustic")));
  // brush: the ride is a ping, the snare a tap without a crack, the kick soft
  assert.ok(onsetMs(hit("kick", "brush")) > onsetMs(hit("kick", "pop")) * 1.5);
  assert.ok(drumPeak("snare", "brush") < drumPeak("snare", "pop"));
});

/* ------------------------------------------------------------------ */
/* stereo and sample rate                                              */
/* ------------------------------------------------------------------ */

test("stereo: kick, snare and sub are centred mono; cymbals, shakers and toms have modest width and survive mono", () => {
  for (const kit of DRUM_KITS)
    for (const kind of [
      "kick",
      "snare",
      "subBoom",
      "noiseHit",
      "noiseTick",
    ] as DrumKind[]) {
      const r = hit(kind, kit);
      assert.ok(same(r.left, r.right), `${kit}/${kind} is not centred mono`);
    }
  for (const kit of NON_CHIP) {
    for (const kind of [
      "hatClosed",
      "hatOpen",
      "ride",
      "crash",
      "cymbalSwell",
      "shaker",
      "tambourine",
      "sleighBell",
      "tomLow",
      "tomHigh",
    ] as DrumKind[]) {
      const r = hit(kind, kit);
      const what = `${kit}/${kind}`;
      assert.ok(!same(r.left, r.right), `${what} is mono`);
      const correlation = stereoCorrelation(r);
      assert.ok(
        correlation >= 0.4 && correlation <= 1,
        `${what}: L/R correlation ${correlation.toFixed(2)}`,
      );
      assert.ok(
        Math.abs(balance(r)) <= 5.5,
        `${what}: channels differ by ${balance(r).toFixed(1)} dB`,
      );
      // mono sum keeps at least 70 % of the power: nothing important cancels
      let mono = 0;
      let stereo = 0;
      for (let i = 0; i < r.frames; i++) {
        const m = 0.5 * (r.left[i] + r.right[i]);
        mono += m * m;
        stereo += 0.5 * (r.left[i] * r.left[i] + r.right[i] * r.right[i]);
      }
      assert.ok(
        mono / stereo >= 0.7,
        `${what}: mono keeps ${((mono / stereo) * 100).toFixed(0)} %`,
      );
    }
    // real width (not just a pan) on the metal
    for (const kind of [
      "hatOpen",
      "ride",
      "crash",
      "cymbalSwell",
      "tambourine",
      "sleighBell",
    ] as DrumKind[])
      if (!(kit === "soft" && kind === "gong"))
        assert.ok(
          stereoCorrelation(hit(kind, kit)) <= 0.99,
          `${kit}/${kind} is only panned`,
        );
    // drummer's view: hat left, ride right, toms from high (left) to low (right)
    assert.ok(
      balance(hit("hatClosed", kit)) < -0.5,
      `${kit}: hat is not left of centre`,
    );
    assert.ok(
      balance(hit("ride", kit)) > 0.5,
      `${kit}: ride is not right of centre`,
    );
    assert.ok(
      balance(hit("tomHigh", kit)) < balance(hit("tomMid", kit)) - 1 &&
        balance(hit("tomMid", kit)) < balance(hit("tomLow", kit)) - 1,
      `${kit}: toms are not spread`,
    );
  }
});

test("44.1 kHz: the same instruments at the same level", () => {
  forEachHit((kind, kit, what) => {
    const seeds = SHAKEN.includes(kind)
      ? [1, 2, 3, 4, 5, 6, 7, 8]
      : [1, 2, 3, 4];
    const at = (sampleRate: number) =>
      seeds.map((seed) => renderDrum(DRUMS, kind, kit, 0.8, sampleRate, seed));
    const a = at(SAMPLE_RATE);
    const b = at(44100);
    const level = mean(b.map((r) => rmsDb(r))) - mean(a.map((r) => rmsDb(r)));
    assert.ok(
      Math.abs(level) <= (SHAKEN.includes(kind) ? 2.5 : 1.5),
      `${what}: ${level.toFixed(2)} dB different at 44.1 kHz`,
    );
    const colour =
      mean(b.map((r) => centroid(spectrum(r)))) /
      mean(a.map((r) => centroid(spectrum(r))));
    assert.ok(
      colour > 0.85 && colour < 1.15,
      `${what}: centroid ×${colour.toFixed(2)} at 44.1 kHz`,
    );
    const middle = median(b.map(peak));
    assert.ok(
      middle <= drumPeak(kind, kit) * 1.15 + 1e-4 &&
        middle >= drumPeak(kind, kit) * 0.55,
      `${what}: peak ${middle.toFixed(3)} at 44.1 kHz`,
    );
  });
  for (const kit of DRUM_KITS)
    assert.ok(
      Math.abs(
        loudestAt(renderDrum(DRUMS, "cymbalSwell", kit, 0.8, 44100), 30) -
          SWELL_PEAK_SECONDS,
      ) <= 0.05,
    );
});

/* ------------------------------------------------------------------ */
/* cost                                                                */
/* ------------------------------------------------------------------ */

test("render cost: microseconds per hit, and a busy two-minute drum part in a fraction of a second", (t) => {
  const context = { sampleRate: SAMPLE_RATE, random: createRng(5) };
  const cost = (kind: DrumKind, kit: DrumKitId): number => {
    const frames = Math.ceil(DRUMS.length(kind, kit) * SAMPLE_RATE);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < 3; i++)
      DRUMS.render(left, right, frames, kind, kit, 0.8, context);
    const repeats = frames > 60000 ? 4 : 16;
    let best = Infinity;
    for (let pass = 0; pass < 3; pass++) {
      const started = performance.now();
      for (let i = 0; i < repeats; i++)
        DRUMS.render(
          left,
          right,
          frames,
          kind,
          kit,
          0.5 + 0.05 * (i % 10),
          context,
        );
      best = Math.min(best, (performance.now() - started) / repeats);
    }
    return best * 1000;
  };
  let worst = 0;
  for (const kit of DRUM_KITS) {
    const parts: string[] = [];
    for (const kind of DRUM_KINDS) {
      const micros = cost(kind, kit);
      parts.push(`${kind} ${micros.toFixed(0)}`);
      // generous: a hit must render at least 25 times faster than it plays
      const share = micros / 1e6 / DRUMS.length(kind, kit);
      worst = Math.max(worst, share);
      assert.ok(
        share < 1 / 25,
        `${kit}/${kind}: ${micros.toFixed(0)} µs for ${DRUMS.length(kind, kit)} s`,
      );
    }
    t.diagnostic(`${kit} (µs per hit): ${parts.join(", ")}`);
  }
  t.diagnostic(
    `slowest hit renders ${(1 / worst).toFixed(0)}x faster than real time`,
  );

  // 120 s at 120 BPM: 16th-note hats, kick and snare, percussion, fills and accents — about 3300 hits
  const plan: [DrumKind, number][] = [
    ["hatClosed", 1680],
    ["hatOpen", 120],
    ["kick", 480],
    ["snare", 240],
    ["clap", 120],
    ["shaker", 360],
    ["tambourine", 60],
    ["tomLow", 40],
    ["tomMid", 40],
    ["tomHigh", 40],
    ["ride", 60],
    ["crash", 16],
    ["cymbalSwell", 8],
  ];
  for (const kit of ["pop", "acoustic", "cinematic"] as DrumKitId[]) {
    const buffers = new Map<DrumKind, [Float32Array, Float32Array, number]>();
    for (const [kind] of plan) {
      const frames = Math.ceil(DRUMS.length(kind, kit) * SAMPLE_RATE);
      buffers.set(kind, [
        new Float32Array(frames),
        new Float32Array(frames),
        frames,
      ]);
      DRUMS.render(
        new Float32Array(frames),
        new Float32Array(frames),
        frames,
        kind,
        kit,
        0.8,
        context,
      );
    }
    const started = performance.now();
    let hits = 0;
    for (const [kind, count] of plan) {
      const [left, right, frames] = buffers.get(kind)!;
      for (let i = 0; i < count; i++, hits++)
        DRUMS.render(
          left,
          right,
          frames,
          kind,
          kit,
          0.4 + 0.06 * (i % 10),
          context,
        );
    }
    const elapsed = performance.now() - started;
    t.diagnostic(
      `${kit}: ${hits} hits in ${elapsed.toFixed(0)} ms (${((elapsed * 1000) / hits).toFixed(0)} µs per hit on average)`,
    );
    assert.ok(
      elapsed < 2500,
      `${kit}: ${hits} hits took ${elapsed.toFixed(0)} ms`,
    );
  }
});
