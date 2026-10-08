/**
 * Master bus. The chain is applied to the four stems in such a way that their
 * sum at REFERENCE_VOLUMES is the mastered mix:
 *
 *   drums stem only      bus "glue": a look-ahead peak compressor that holds
 *                        the strokes of the kit down by a few dB and gives the
 *                        level back as gain (same energy, lower peaks), so the
 *                        kit can sit at its place in the mix without its
 *                        transients deciding how loud everything else may be
 *   per stem, linear     lows below ~120 Hz folded to mono (zero-phase side
 *                        high-pass), then the stereo guard: a stem whose
 *                        channels have (almost) nothing in common is narrowed
 *                        until they do → 30 Hz high-pass → tilt EQ → character EQ
 *   per stem, character  warm: low shelf up, soft roll-off of the top
 *                        lofi: 80 Hz – 9 kHz band, wow, soft saturation and
 *                              a very quiet hiss bed
 *                        punchy: slower compressor attack, a little parallel
 *                              saturation
 *                        bitcrush: sample-and-hold to ~22 kHz, 11-bit grid
 *                        wide: sides lifted above 300 Hz
 *   keyed by the mix     glue compressor (2:1), look-ahead peak limiter and
 *                        the static loudness gain. ONE gain curve is computed
 *                        from the reference mix and multiplied into every
 *                        stem, so the stems still sum to the mastered mix and
 *                        the faders stay linear. The limiter's ceiling comes
 *                        down with the density of the master (up to 5 dB), as
 *                        far as the limiter stays unobtrusive: the moments
 *                        where everything strikes together are held down
 *                        instead of standing 15 dB over the body of the music.
 *
 * The static gain is solved so that softClip(reference mix) measures
 * MasterSettings.targetLufs (BS.1770 integrated). The limiter keeps the
 * reference mix under LIMITER_CEILING, a little above the soft-clip knee, so
 * the clipper only rounds off the very tips of limited peaks and has headroom
 * left for fader moves.
 */
import { SAMPLE_RATE, TRACKS } from "../music/score";
import type {
  MasterCharacter,
  MasterSettings,
  TrackName,
} from "../music/score";
import { REFERENCE_VOLUMES } from "./render-types";
import type { StereoPcm } from "./render-types";
import { KNEE, softClip } from "./softclip";
import {
  HOP_SECONDS,
  LoudnessMeter,
  energyToLufs,
  integratedFromHops,
  kWeightingCoefs,
} from "./loudness";
import {
  Biquad,
  TAU,
  clamp,
  dbToGain,
  fastTanh,
  gainToDb,
  hashSeed,
  nextPow2,
} from "./dsp";
import {
  ANTI_DENORMAL,
  BiquadCascade,
  forLoopTail,
  loopSyncedRate,
} from "./fx/common";

export type Stems = Record<TrackName, StereoPcm>;

export interface MasterOptions {
  sampleRate: number;
  /** the piece loops: every stage must be continuous across the end → start seam */
  loop: boolean;
  /** seeds the lofi wow phase and hiss */
  seed?: number;
  /**
   * Called between blocks with the progress of the master stage (0..1). May
   * return a promise, which is awaited (yield to the host, or reject to cancel).
   */
  tick?: (fraction: number) => void | Promise<void>;
  /**
   * A work buffer of at least one channel's length that the master may
   * overwrite (the renderer hands over its part bus); allocated when absent.
   */
  scratch?: Float32Array;
}

export interface MixMeasurement {
  /** BS.1770 integrated loudness of softClip(mix), LUFS */
  lufs: number;
  /** sample peak of the mix BEFORE the soft clipper */
  peak: number;
  /** fraction of samples (both channels) beyond the soft-clip knee before clipping */
  clippedRatio: number;
}

export interface MasterReport extends MixMeasurement {
  /** nothing to master: every stem is digital silence */
  silent: boolean;
  targetLufs: number;
  /** LU the master was deliberately left under the target (0 unless the limiter would have had to work too hard) */
  shortfallLu: number;
  /** static gain multiplied into every stem, dB */
  gainDb: number;
  compressor: {
    thresholdDb: number;
    maxReductionDb: number;
    meanReductionDb: number;
  };
  limiter: {
    ceiling: number;
    maxReductionDb: number;
    /** fraction of the piece with more than 0.5 dB of limiting */
    activeRatio: number;
  };
  /** the drum-bus glue (absent: no drums, or density 0) */
  glue?: GlueReport;
  /** stems the stereo guard narrowed: the factor their side signal was multiplied by */
  narrowed?: Partial<Record<TrackName, number>>;
}

export interface GlueReport {
  /** threshold in dB under the kit's typical stroke peak */
  depthDb: number;
  /** most the strokes were held down, dB */
  maxReductionDb: number;
  /** gain that gives the stem its energy back, dB */
  makeupDb: number;
}

/** Frames per work block. */
const BLOCK = 4096;
/** Frames per point of the shared gain curve (must divide BLOCK). */
const CONTROL = 16;
/** Peak level the limiter holds the reference mix to (the knee is 0.7, the clipper tops out at 0.881). */
export const LIMITER_CEILING = 0.8;
/**
 * Most the master may fall short of the target when the limiter would
 * otherwise overwork. Half an LU keeps every piece inside the ±0.7 LU the
 * loudness contract allows.
 */
export const MAX_SHORTFALL_LU = 0.5;
/**
 * Share of the piece the limiter may spend more than 0.5 dB down before level
 * is given up instead. Staccato mallets and plucked strings sit at 10–20 %
 * with only 2–4 dB of reduction, which is still transparent.
 */
const LIMITER_BUSY_RATIO = 0.25;

const HIGH_PASS_HZ = 30;
/** The side signal is 3 dB down here and falls at 24 dB per octave below. */
const MONO_BELOW_HZ = 120;
const TILT_DB = 4.5;
const COMP_RATIO = 2;
const COMP_KNEE_DB = 6;
const COMP_MAX_REDUCTION_DB = 3.5;
const DETECTOR_SECONDS = 0.01;
const LIMITER_LOOKAHEAD = 0.005;
const LIMITER_RELEASE = 0.15;
const FADE_IN_SECONDS = 0.005;
/**
 * A piece that ends is faded to digital silence over its last moments (at
 * most a quarter of it). The composer leaves at least 1.5 s after the last
 * note-off, so this only shapes release and reverb tails: a tail that has
 * died by itself does not change, and a long hall (ambient, a reverb turned
 * all the way up) glides out instead of being cut off 40 dB down.
 */
const FADE_OUT_SECONDS = 1.2;
/**
 * How hard each character holds the drum bus, 0..1 (MasterSettings.density
 * overrides it). Dense, loud genres live from a kit whose strokes are level
 * with its body; an acoustic or cinematic kit keeps most of its dynamics.
 */
export const CHARACTER_DENSITY: Record<MasterCharacter, number> = {
  clean: 0.5,
  warm: 0.35,
  lofi: 0.55,
  wide: 0.4,
  punchy: 0.8,
  bitcrush: 0.45,
};
/**
 * Threshold of the glue under the typical stroke peak at density 1, dB. With
 * the ratio below, the strokes of a "punchy" kit are held 5 dB down and those
 * of a "warm" one 2 dB: the range of ordinary drum-bus compression.
 */
const GLUE_DEPTH_DB = 10;
const GLUE_RATIO = 3;
/**
 * How far the limiter's ceiling comes down at density 1, dB. Where everything
 * strikes together (the downbeat) the stems add up to far more than any one
 * of them peaks at; a dense master holds those moments down instead of
 * leaving 15 dB between them and the body of the music. The ceiling is only
 * lowered as far as the limiter stays unobtrusive (see DENSE_BUSY_RATIO).
 */
const DENSE_CEILING_DB = 5;
/** A lowered ceiling may keep the limiter this busy and this deep; else it is raised again. */
const DENSE_BUSY_RATIO = 0.2;
const DENSE_MAX_REDUCTION_DB = 5;
const GLUE_KNEE_DB = 4;
const GLUE_LOOKAHEAD = 0.003;
/** Fast enough to let the body of a kick back up within its first cycles. */
const GLUE_RELEASE = 0.045;
/**
 * L/R correlation every stem is given at least. Below it the two channels
 * are close to unrelated: the stem hollows out on headphones and cancels on a
 * mono speaker. Wide pads under a long reverb get there when the ambience is
 * turned all the way up.
 */
export const MIN_STEM_CORRELATION = 0.12;
const BITCRUSH_HZ = 22050;
const BITCRUSH_STEP = 1 / 1024; // 11 bits across ±1
const HISS_RMS = 0.0007; // -63 dBFS in the reference mix

/* ---- per-stem linear chain ---- */

/**
 * Tilt EQ: two first-order shelves (pivots 220 Hz and 2.8 kHz) that lean the
 * spectrum by ±TILT_DB between about 100 Hz and 8 kHz, folded into one biquad.
 */
function tiltSections(tilt: number, sampleRate: number): Biquad[] {
  const amount = clamp(tilt, -1, 1);
  if (Math.abs(amount) < 0.01) return [];
  const g = dbToGain((TILT_DB * amount) / 2);
  const [low, high] = [220, 2800].map((pivot) => {
    // H(s) = (g·s + w0) / (s + g·w0): 1/g at DC, 1 at the pivot, g at Nyquist
    const k = Math.tan((Math.PI * pivot) / sampleRate);
    const norm = 1 / (1 + g * k);
    return { b0: (g + k) * norm, b1: (k - g) * norm, a1: (g * k - 1) * norm };
  });
  const section = new Biquad();
  section.b0 = low.b0 * high.b0;
  section.b1 = low.b0 * high.b1 + low.b1 * high.b0;
  section.b2 = low.b1 * high.b1;
  section.a1 = low.a1 + high.a1;
  section.a2 = low.a1 * high.a1;
  return [section];
}

/** High-pass, tilt and character EQ, then (bitcrush) the sample-and-hold. */
class StemChain {
  private readonly main: BiquadCascade;
  private readonly holdStep: number;
  private holdPhase = 1;
  private heldLeft = 0;
  private heldRight = 0;

  constructor(sampleRate: number, settings: MasterSettings) {
    const character = settings.character;
    const main: Biquad[] = [
      new Biquad().setHighpass(
        character === "lofi" ? 80 : HIGH_PASS_HZ,
        Math.SQRT1_2,
        sampleRate,
      ),
      ...tiltSections(settings.tilt, sampleRate),
    ];
    if (character === "warm") {
      main.push(new Biquad().setLowShelf(160, 1.5, sampleRate, 0.7));
      main.push(new Biquad().setHighShelf(7000, -2.2, sampleRate, 0.6));
    }
    if (character === "lofi")
      main.push(new Biquad().setLowpass(9000, Math.SQRT1_2, sampleRate));
    this.main = new BiquadCascade(main);
    this.holdStep =
      character === "bitcrush" ? Math.min(1, BITCRUSH_HZ / sampleRate) : 0;
  }

  /** Restart the sample-and-hold clock so frame 0 always takes a fresh sample. */
  alignClock(): void {
    this.holdPhase = 1;
  }

  process(left: Float32Array, right: Float32Array, n: number): void {
    this.main.process(left, right, n);
    const step = this.holdStep;
    if (step > 0 && step < 1) {
      let phase = this.holdPhase;
      let heldLeft = this.heldLeft;
      let heldRight = this.heldRight;
      for (let i = 0; i < n; i++) {
        if (phase >= 1) {
          phase -= 1;
          heldLeft = left[i];
          heldRight = right[i];
        }
        phase += step;
        left[i] = heldLeft;
        right[i] = heldRight;
      }
      this.holdPhase = phase;
      this.heldLeft = heldLeft;
      this.heldRight = heldRight;
    }
  }
}

/**
 * Stereo field of one stem: the side signal (L − R)/2 is high-passed so that
 * everything below about MONO_BELOW_HZ is mono, and for the "wide" character
 * lifted above 300 Hz. The filter runs forwards and then backwards over the
 * whole stem: zero phase, so a hard-panned part stays hard-panned (a causal
 * side filter would smear up to -14 dB of it into the other channel).
 * A stem that is already mono is left alone. `side` is work space.
 */
function shapeSide(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  sampleRate: number,
  wide: boolean,
  loop: boolean,
  side: Float32Array,
): void {
  if (sideForward(left, right, frames, sampleRate, wide, loop, side))
    sideBackward(left, right, frames, sampleRate, wide, loop, side);
}

/** The two filters of one pass of shapeSide, and the loop warm-up length. */
function sideFilters(
  frames: number,
  sampleRate: number,
  wide: boolean,
  loop: boolean,
) {
  // two passes of a Butterworth high-pass make a 4th-order magnitude; this
  // corner puts their combined -3 dB point on MONO_BELOW_HZ
  const cut = new Biquad().setHighpass(
    MONO_BELOW_HZ * 0.802,
    Math.SQRT1_2,
    sampleRate,
  );
  // half the lift per pass; an untouched Biquad passes the signal through
  const lift = wide
    ? new Biquad().setHighShelf(300, 1.25, sampleRate, 0.7)
    : new Biquad();
  // in a loop each pass first hears what precedes its first sample: the end
  // of the stem when running forwards, the beginning when running backwards
  const warm = loop ? Math.min(frames, Math.round(sampleRate * 0.25)) : 0;
  return { cut, lift, warm };
}

/**
 * First half of shapeSide: the filtered side signal, forwards, into `side`.
 * Returns false (and does nothing) for a stem that is mono.
 */
function sideForward(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  sampleRate: number,
  wide: boolean,
  loop: boolean,
  side: Float32Array,
): boolean {
  let stereo = false;
  for (let i = 0; i < frames; i++)
    if (left[i] !== right[i]) {
      stereo = true;
      break;
    }
  if (!stereo) return false;
  const { cut, lift, warm } = sideFilters(frames, sampleRate, wide, loop);
  const { b0, b1, b2, a1, a2 } = cut;
  const { b0: c0, b1: c1, b2: c2, a1: d1, a2: d2 } = lift;

  let z1 = 0;
  let z2 = 0;
  let w1 = 0;
  let w2 = 0;
  for (let i = frames - warm; i < frames; i++) {
    const x = (left[i] - right[i]) * 0.5 + ANTI_DENORMAL;
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    const v = c0 * y + w1;
    w1 = c1 * y - d1 * v + w2;
    w2 = c2 * y - d2 * v;
  }
  for (let i = 0; i < frames; i++) {
    const x = (left[i] - right[i]) * 0.5 + ANTI_DENORMAL;
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    const v = c0 * y + w1;
    w1 = c1 * y - d1 * v + w2;
    w2 = c2 * y - d2 * v;
    side[i] = v;
  }
  return true;
}

/** Second half of shapeSide: `side` filtered backwards and put back under the mid signal. */
function sideBackward(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  sampleRate: number,
  wide: boolean,
  loop: boolean,
  side: Float32Array,
): void {
  const { cut, lift, warm } = sideFilters(frames, sampleRate, wide, loop);
  const { b0, b1, b2, a1, a2 } = cut;
  const { b0: c0, b1: c1, b2: c2, a1: d1, a2: d2 } = lift;
  let z1 = 0;
  let z2 = 0;
  let w1 = 0;
  let w2 = 0;
  for (let i = warm - 1; i >= 0; i--) {
    const x = side[i] + ANTI_DENORMAL;
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    const v = c0 * y + w1;
    w1 = c1 * y - d1 * v + w2;
    w2 = c2 * y - d2 * v;
  }
  for (let i = frames - 1; i >= 0; i--) {
    const x = side[i] + ANTI_DENORMAL;
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    const v = c0 * y + w1;
    w1 = c1 * y - d1 * v + w2;
    w2 = c2 * y - d2 * v;
    const mid = (left[i] + right[i]) * 0.5;
    left[i] = mid + v;
    right[i] = mid - v;
  }
}

/* ---- drum-bus glue ---- */

/**
 * Peak compression of the drums stem, in place. The threshold sits
 * `density` × GLUE_DEPTH_DB under the level the kit's strokes typically reach,
 * so quiet strokes pass untouched and the loud ones are held down by up to
 * three quarters of that; the gain recovers within a few hundredths of a
 * second, which shortens the stroke's tip and leaves its body alone. The
 * energy the stem lost is given back as plain gain: the same loudness with
 * lower peaks. Continuous across the seam of a loop.
 */
function glueDrums(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  sampleRate: number,
  density: number,
  loop: boolean,
): GlueReport | undefined {
  const depthDb = GLUE_DEPTH_DB * clamp(density, 0, 1);
  if (!(depthDb > 0.25) || frames < CONTROL * 4) return undefined;
  const count = Math.ceil(frames / CONTROL);
  const peaks = new Float32Array(count);
  const energy = new Float64Array(count);
  let top = 0;
  for (let k = 0; k < count; k++) {
    const end = Math.min(frames, (k + 1) * CONTROL);
    let peak = 0;
    let sum = 0;
    for (let i = k * CONTROL; i < end; i++) {
      const l = left[i] < 0 ? -left[i] : left[i];
      const r = right[i] < 0 ? -right[i] : right[i];
      if (l > peak) peak = l;
      if (r > peak) peak = r;
      sum += l * l + r * r;
    }
    peaks[k] = peak;
    energy[k] = sum;
    if (peak > top) top = peak;
  }
  if (!(top > 1e-5)) return undefined;

  // The typical stroke: the level 0.5 % of the sounding blocks exceed (the
  // tip of a kick lasts a few blocks, a bar has a few kicks). One freak
  // coincidence of three drums does not move it.
  const bins = new Uint32Array(501);
  let sounding = 0;
  for (let k = 0; k < count; k++) {
    const level = gainToDb(peaks[k] / top);
    if (level > -50) {
      bins[Math.min(500, Math.floor((level + 50) * 10))]++;
      sounding++;
    }
  }
  let above = 0;
  let bin = 500;
  while (bin > 0 && above + bins[bin] < sounding * 0.005) above += bins[bin--];
  const typical = top * dbToGain(bin / 10 - 50);
  const threshold = typical * dbToGain(-depthDb);

  // static curve → gain needed per block
  const need = new Float32Array(count);
  const slope = 1 - 1 / GLUE_RATIO;
  const half = GLUE_KNEE_DB / 2;
  for (let k = 0; k < count; k++) {
    const over = peaks[k] > 0 ? gainToDb(peaks[k] / threshold) : -100;
    const reduction =
      over <= -half
        ? 0
        : over < half
          ? ((over + half) * (over + half) * slope) / (2 * GLUE_KNEE_DB)
          : over * slope;
    need[k] = reduction > 0 ? dbToGain(-reduction) : 1;
  }
  // look ahead (the gain is down before the stroke arrives), instant attack,
  // exponential release, then the steps smoothed into ramps
  const look = Math.max(1, Math.ceil((GLUE_LOOKAHEAD * sampleRate) / CONTROL));
  const held = new Float32Array(need);
  for (let k = 0; k < count; k++) {
    const wanted = need[k];
    if (wanted >= 1) continue;
    for (let j = 1; j <= look; j++) {
      let index = k - j;
      if (index < 0) {
        if (!loop) break;
        index = ((index % count) + count) % count;
      }
      if (wanted < held[index]) held[index] = wanted;
    }
  }
  const release = 1 - Math.exp(-CONTROL / (GLUE_RELEASE * sampleRate));
  let value = 1;
  let lowest = 1;
  for (let pass = loop ? 0 : 1; pass < 2; pass++)
    for (let k = 0; k < count; k++) {
      value += (1 - value) * release;
      if (held[k] < value) value = held[k];
      if (pass === 1) {
        need[k] = value;
        if (value < lowest) lowest = value;
      }
    }
  if (lowest > 0.985) return undefined;
  const curve = new Float32Array(count);
  const window = look + 1;
  const before = (index: number) =>
    index >= 0 ? need[index] : loop ? need[((index % count) + count) % count] : 1;
  let sum = 0;
  for (let j = 0; j < window; j++) sum += before(-j);
  for (let k = 0; k < count; k++) {
    if (k > 0) sum += need[k] - before(k - window);
    curve[k] = sum / window;
  }

  // The energy lost comes back as gain. It is worked out from the control
  // blocks (their energy × the gain across them), so the stem is written once.
  let energyBefore = 0;
  let energyAfter = 0;
  for (let k = 0; k < count; k++) {
    const start = k > 0 ? curve[k - 1] : loop ? curve[count - 1] : curve[0];
    const g = 0.5 * (curve[k] + start);
    energyBefore += energy[k];
    energyAfter += energy[k] * g * g;
  }
  const makeup =
    energyAfter > 0
      ? clamp(Math.sqrt(energyBefore / energyAfter), 1, dbToGain(depthDb * slope))
      : 1;
  const gains = new Float32Array(BLOCK);
  for (let from = 0; from < frames; from += BLOCK) {
    const n = Math.min(BLOCK, frames - from);
    fillGains(gains, curve, from, n, loop);
    for (let i = 0; i < n; i++) {
      const g = gains[i] * makeup;
      left[from + i] *= g;
      right[from + i] *= g;
    }
  }
  return {
    depthDb,
    maxReductionDb: -gainToDb(lowest),
    makeupDb: gainToDb(makeup),
  };
}

/* ---- stereo guard ---- */

/**
 * Narrow a stem whose L/R correlation is under MIN_STEM_CORRELATION, in
 * place, by scaling its side signal just far enough to reach that floor.
 * Returns the factor used (1: nothing was done).
 */
function guardStereo(
  left: Float32Array,
  right: Float32Array,
  frames: number,
): number {
  let mm = 0;
  let ss = 0;
  let ms = 0;
  // every third frame is plenty to tell how related two channels are
  for (let i = 0; i < frames; i += 3) {
    const m = 0.5 * (left[i] + right[i]);
    const d = 0.5 * (left[i] - right[i]);
    mm += m * m;
    ss += d * d;
    ms += m * d;
  }
  if (!(ss > 0) || !(mm > 0)) return 1;
  // L = M + k·S, R = M − k·S
  const correlationAt = (k: number) => {
    const a = mm + k * k * ss;
    const b = 2 * k * ms;
    const denominator = Math.sqrt(Math.max(1e-30, (a + b) * (a - b)));
    return (mm - k * k * ss) / denominator;
  };
  if (correlationAt(1) >= MIN_STEM_CORRELATION) return 1;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i++) {
    const middle = 0.5 * (low + high);
    if (correlationAt(middle) >= MIN_STEM_CORRELATION) low = middle;
    else high = middle;
  }
  const k = low;
  const same = 0.5 * (1 + k);
  const cross = 0.5 * (1 - k);
  for (let i = 0; i < frames; i++) {
    const l = left[i];
    const r = right[i];
    left[i] = same * l + cross * r;
    right[i] = cross * l + same * r;
  }
  return k;
}

/* ---- character colour (per stem, stateless) ---- */

/** lofi: gentle symmetric saturation, unity gain for quiet signals. */
function lofiShape(buf: Float32Array, n: number, gain: number): void {
  const k = 1.2;
  const pre = gain * k;
  const post = 1 / k;
  for (let i = 0; i < n; i++) buf[i] = fastTanh(buf[i] * pre) * post;
}

/** punchy: a quarter of the signal replaced by a hard-driven copy (parallel saturation). */
function punchyShape(buf: Float32Array, n: number, gain: number): void {
  const k = 3;
  const pivot = 0.2;
  const wet = (0.25 * pivot) / fastTanh(k * pivot);
  const dry = 0.75 * gain;
  const pre = gain * k;
  for (let i = 0; i < n; i++) {
    const x = buf[i];
    buf[i] = dry * x + wet * fastTanh(x * pre);
  }
}

function shaperFor(
  character: MasterCharacter,
): ((buf: Float32Array, n: number, gain: number) => void) | null {
  if (character === "lofi") return lofiShape;
  if (character === "punchy") return punchyShape;
  return null;
}

/**
 * Tape-style wow and flutter: both channels of a stem are re-read at a slowly
 * wandering position (about ±0.09 % and ±0.04 % of pitch). The same curve is
 * used for every stem, so the stems stay phase-coherent with each other.
 */
function applyWow(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  sampleRate: number,
  loop: boolean,
  seed: number,
): void {
  const duration = frames / sampleRate;
  const wowHz = loopSyncedRate(0.55, loop ? duration : undefined);
  const flutterHz = loopSyncedRate(2.7, loop ? duration : undefined);
  const wowDepth = (0.0009 / (TAU * wowHz)) * sampleRate;
  const flutterDepth = (0.0004 / (TAU * flutterHz)) * sampleRate;
  const reach = nextPow2(Math.ceil(wowDepth + flutterDepth) + 4);
  if (frames < reach * 4) return;
  const phaseA = (hashSeed(seed, 11) / 4294967296) * TAU;
  const phaseB = (hashSeed(seed, 12) / 4294967296) * TAU;
  let sinA = Math.sin(phaseA);
  let cosA = Math.cos(phaseA);
  let sinB = Math.sin(phaseB);
  let cosB = Math.cos(phaseB);
  const stepSinA = Math.sin((TAU * wowHz) / sampleRate);
  const stepCosA = Math.cos((TAU * wowHz) / sampleRate);
  const stepSinB = Math.sin((TAU * flutterHz) / sampleRate);
  const stepCosB = Math.cos((TAU * flutterHz) / sampleRate);

  // window = [reach originals before the block | block | reach originals after it]
  const windowLeft = new Float32Array(BLOCK + 2 * reach);
  const windowRight = new Float32Array(BLOCK + 2 * reach);
  const headLeft = left.slice(0, reach);
  const headRight = right.slice(0, reach);
  if (loop) {
    windowLeft.set(left.subarray(frames - reach, frames), 0);
    windowRight.set(right.subarray(frames - reach, frames), 0);
  }
  for (let from = 0; from < frames; from += BLOCK) {
    const count = Math.min(BLOCK, frames - from);
    windowLeft.set(left.subarray(from, from + count), reach);
    windowRight.set(right.subarray(from, from + count), reach);
    for (let i = 0; i < reach; i++) {
      const index = from + count + i;
      const wrapped = index - frames;
      windowLeft[reach + count + i] =
        index < frames ? left[index] : loop ? headLeft[wrapped] : 0;
      windowRight[reach + count + i] =
        index < frames ? right[index] : loop ? headRight[wrapped] : 0;
    }
    for (let i = 0; i < count; i++) {
      const position = reach + i + wowDepth * sinA + flutterDepth * sinB;
      const whole = Math.floor(position);
      const t = position - whole;
      // 4-point Hermite read of each channel
      let x0 = windowLeft[whole];
      let x1 = windowLeft[whole + 1];
      let c = (x1 - windowLeft[whole - 1]) * 0.5;
      let v = x0 - x1;
      let u = c + v;
      let a = u + v + (windowLeft[whole + 2] - x0) * 0.5;
      left[from + i] = ((a * t - (u + a)) * t + c) * t + x0;
      x0 = windowRight[whole];
      x1 = windowRight[whole + 1];
      c = (x1 - windowRight[whole - 1]) * 0.5;
      v = x0 - x1;
      u = c + v;
      a = u + v + (windowRight[whole + 2] - x0) * 0.5;
      right[from + i] = ((a * t - (u + a)) * t + c) * t + x0;
      let next = sinA * stepCosA + cosA * stepSinA;
      cosA = cosA * stepCosA - sinA * stepSinA;
      sinA = next;
      next = sinB * stepCosB + cosB * stepSinB;
      cosB = cosB * stepCosB - sinB * stepSinB;
      sinB = next;
    }
    // the last `reach` originals of this block lead the next one
    windowLeft.copyWithin(0, count, count + reach);
    windowRight.copyWithin(0, count, count + reach);
  }
}

/** Quiet band-limited hiss for the lofi character (one channel). */
class Hiss {
  private state: number;
  private low = 0;
  private high = 0;
  private readonly lowCoef: number;
  private readonly highCoef: number;
  private readonly gain: number;

  constructor(seed: number, sampleRate: number, rms: number) {
    this.state = (seed | 0) === 0 ? 0x1234567 : seed | 0;
    this.lowCoef = 1 - Math.exp((-TAU * 5000) / sampleRate);
    this.highCoef = 1 - Math.exp((-TAU * 300) / sampleRate);
    // uniform noise has an RMS of 0.577; the band-pass keeps roughly a third of its power
    this.gain = rms / (0.577 * 0.55) / 2147483648;
  }

  /** Write n samples of hiss, each scaled by scale[i] when a scale is given. */
  fill(out: Float32Array, n: number, scale: Float32Array | null): void {
    let s = this.state;
    let low = this.low;
    let high = this.high;
    const { lowCoef, highCoef, gain } = this;
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      low += lowCoef * (s * gain - low);
      high += highCoef * (low - high);
      out[i] = scale ? (low - high) * scale[i] : low - high;
    }
    this.state = s;
    this.low = low;
    this.high = high;
  }
}

/* ---- analysis of the reference mix at control rate ---- */

class MixAnalyser {
  /** smoothed power of the mix at the end of each control block */
  readonly detector: Float32Array;
  /** highest |sample| of the mix inside each control block */
  readonly peaks: Float32Array;
  /** K-weighted energy (both channels) of each control block */
  readonly energy: Float64Array;
  count = 0;
  private readonly detectorCoef: number;
  private readonly coefs: Float64Array;
  private readonly state = new Float64Array(8);
  private power = 0;
  private fill = 0;
  private blockPeak = 0;
  private blockEnergy = 0;

  constructor(frames: number, sampleRate: number) {
    const points = Math.ceil(frames / CONTROL);
    this.detector = new Float32Array(points);
    this.peaks = new Float32Array(points);
    this.energy = new Float64Array(points);
    this.detectorCoef = 1 - Math.exp(-1 / (DETECTOR_SECONDS * sampleRate));
    const { shelf, highpass } = kWeightingCoefs(sampleRate);
    this.coefs = Float64Array.of(
      shelf.b0,
      shelf.b1,
      shelf.b2,
      shelf.a1,
      shelf.a2,
      highpass.a1,
      highpass.a2,
    );
  }

  /** Feed n mix frames. With `store` false only the filters run (loop warm-up). */
  push(
    left: Float32Array,
    right: Float32Array,
    n: number,
    store: boolean,
  ): void {
    const [sb0, sb1, sb2, sa1, sa2, ha1, ha2] = this.coefs;
    const state = this.state;
    let l1 = state[0];
    let l2 = state[1];
    let l3 = state[2];
    let l4 = state[3];
    let r1 = state[4];
    let r2 = state[5];
    let r3 = state[6];
    let r4 = state[7];
    let power = this.power;
    let fill = this.fill;
    let peak = this.blockPeak;
    let energy = this.blockEnergy;
    const coef = this.detectorCoef;
    for (let i = 0; i < n; i++) {
      const xl = left[i] + ANTI_DENORMAL;
      const xr = right[i] + ANTI_DENORMAL;
      const al = xl < 0 ? -xl : xl;
      const ar = xr < 0 ? -xr : xr;
      if (al > peak) peak = al;
      if (ar > peak) peak = ar;
      power += coef * ((xl * xl + xr * xr) * 0.5 - power);
      const sl = sb0 * xl + l1;
      l1 = sb1 * xl - sa1 * sl + l2;
      l2 = sb2 * xl - sa2 * sl;
      const yl = sl + l3;
      l3 = -2 * sl - ha1 * yl + l4;
      l4 = sl - ha2 * yl;
      const sr = sb0 * xr + r1;
      r1 = sb1 * xr - sa1 * sr + r2;
      r2 = sb2 * xr - sa2 * sr;
      const yr = sr + r3;
      r3 = -2 * sr - ha1 * yr + r4;
      r4 = sr - ha2 * yr;
      energy += yl * yl + yr * yr;
      if (++fill === CONTROL) {
        if (store) this.store(power, peak, energy);
        fill = 0;
        peak = 0;
        energy = 0;
      }
    }
    state[0] = l1;
    state[1] = l2;
    state[2] = l3;
    state[3] = l4;
    state[4] = r1;
    state[5] = r2;
    state[6] = r3;
    state[7] = r4;
    this.power = power;
    this.fill = store ? fill : 0;
    this.blockPeak = store ? peak : 0;
    this.blockEnergy = store ? energy : 0;
  }

  /** Close a last, partial control block. */
  finish(): void {
    if (this.fill > 0)
      this.store(this.power, this.blockPeak, this.blockEnergy);
    this.fill = 0;
  }

  private store(power: number, peak: number, energy: number): void {
    if (this.count >= this.detector.length) return;
    this.detector[this.count] = power;
    this.peaks[this.count] = peak;
    this.energy[this.count] = energy;
    this.count++;
  }
}

/* ---- glue compressor (gain per control block) ---- */

interface Compression {
  gain: Float32Array;
  thresholdDb: number;
  maxReductionDb: number;
  meanReductionDb: number;
}

function compressorCurve(
  analysis: MixAnalyser,
  sampleRate: number,
  attackSeconds: number,
  loop: boolean,
): Compression {
  const count = analysis.count;
  const level = new Float32Array(count);
  let loudest = -Infinity;
  for (let k = 0; k < count; k++) {
    level[k] = 10 * Math.log10(analysis.detector[k] + 1e-30);
    if (level[k] > loudest) loudest = level[k];
  }
  const gain = new Float32Array(count).fill(1);
  if (!(loudest > -200))
    return { gain, thresholdDb: 0, maxReductionDb: 0, meanReductionDb: 0 };

  // threshold 4.5 dB under the level the loudest 1 % of the piece reaches
  const floor = loudest - 50;
  const bins = new Uint32Array(501);
  let audible = 0;
  for (let k = 0; k < count; k++)
    if (level[k] > floor) {
      bins[Math.min(500, Math.floor((level[k] - floor) * 10))]++;
      audible++;
    }
  let above = 0;
  let bin = 500;
  while (bin > 0 && above + bins[bin] < audible * 0.01) above += bins[bin--];
  const thresholdDb = floor + bin / 10 - 4.5;

  const controlRate = sampleRate / CONTROL;
  const attack = 1 - Math.exp(-1 / (attackSeconds * controlRate));
  const releaseFast = 1 - Math.exp(-1 / (0.15 * controlRate));
  const chargeSlow = 1 - Math.exp(-1 / (0.8 * controlRate));
  const releaseSlow = 1 - Math.exp(-1 / (2 * controlRate));
  const slope = 1 - 1 / COMP_RATIO;
  const half = COMP_KNEE_DB / 2;
  let fast = 0;
  let slow = 0;
  let maxReduction = 0;
  let sumReduction = 0;
  // a looping piece is walked twice so the envelope at frame 0 continues from the end
  for (let pass = loop ? 0 : 1; pass < 2; pass++)
    for (let k = 0; k < count; k++) {
      const over = level[k] - thresholdDb;
      let target =
        over <= -half
          ? 0
          : over < half
            ? ((over + half) * (over + half) * slope) / (2 * COMP_KNEE_DB)
            : over * slope;
      if (target > COMP_MAX_REDUCTION_DB) target = COMP_MAX_REDUCTION_DB;
      fast += (target > fast ? attack : releaseFast) * (target - fast);
      // "auto release": sustained loudness charges a slow stage that holds the
      // gain down between hits, while a lone transient recovers quickly
      slow += (fast > slow ? chargeSlow : releaseSlow) * (fast - slow);
      const reduction = fast > slow ? fast : slow;
      if (pass === 1) {
        gain[k] = Math.pow(10, -reduction / 20);
        if (reduction > maxReduction) maxReduction = reduction;
        if (level[k] > floor) sumReduction += reduction;
      }
    }
  return {
    gain,
    thresholdDb,
    maxReductionDb: maxReduction,
    meanReductionDb: audible ? sumReduction / audible : 0,
  };
}

/* ---- limiter + loudness gain, solved at control rate ---- */

interface GainPlan {
  /** total gain at the end of each control block: static × compressor × limiter */
  curve: Float32Array;
  staticGain: number;
  /** loudness the plan is expected to produce (control-rate estimate) */
  estimatedLufs: number;
  shortfallLu: number;
  ceiling: number;
  limiterMaxReductionDb: number;
  limiterActiveRatio: number;
}

class GainSolver {
  private readonly count: number;
  private readonly need: Float32Array;
  private readonly held: Float32Array;
  private readonly limit: Float32Array;
  private readonly hops: Float64Array;
  private readonly hopOf: Int32Array;
  private readonly completeHops: number;
  private readonly hopFrames: number;
  private readonly lookBlocks: number;
  private readonly release: number;

  constructor(
    private readonly analysis: MixAnalyser,
    private readonly compression: Float32Array,
    private readonly frames: number,
    sampleRate: number,
    private readonly loop: boolean,
  ) {
    const count = analysis.count;
    this.count = count;
    this.need = new Float32Array(count);
    this.held = new Float32Array(count);
    this.limit = new Float32Array(count);
    this.hopFrames = Math.max(1, Math.round(sampleRate * HOP_SECONDS));
    this.completeHops = Math.floor(frames / this.hopFrames);
    this.hops = new Float64Array(this.completeHops + 1);
    this.hopOf = new Int32Array(count);
    for (let k = 0; k < count; k++)
      this.hopOf[k] = Math.min(
        this.completeHops,
        Math.floor((k * CONTROL) / this.hopFrames),
      );
    this.lookBlocks = Math.max(
      1,
      Math.ceil((LIMITER_LOOKAHEAD * sampleRate) / CONTROL),
    );
    this.release = 1 - Math.exp(-CONTROL / (LIMITER_RELEASE * sampleRate));
  }

  /**
   * Limiter gain per control block for static gain `g`. Guarantee: with the
   * total gain interpolated linearly across each block (from the previous
   * block's value to this block's), the reference mix never exceeds `ceiling`.
   */
  private limiter(g: number, ceiling: number): void {
    const { count, need, held, limit, loop } = this;
    const peaks = this.analysis.peaks;
    const comp = this.compression;
    for (let k = 0; k < count; k++) {
      const before = k > 0 ? comp[k - 1] : loop ? comp[count - 1] : comp[0];
      const level = g * peaks[k] * (before > comp[k] ? before : comp[k]);
      need[k] = level > ceiling ? ceiling / level : 1;
    }
    // look ahead: the lowest gain needed in this block and the next few.
    // Limited blocks are rare, so each one is spread backwards instead of
    // every block searching forwards.
    const span = this.lookBlocks + 1;
    held.set(need);
    for (let k = 0; k < count; k++) {
      const wanted = need[k];
      if (wanted >= 1) continue;
      for (let j = 1; j <= span; j++) {
        let index = k - j;
        if (index < 0) {
          if (!loop) break;
          index = ((index % count) + count) % count;
        }
        if (wanted < held[index]) held[index] = wanted;
      }
    }
    // instant attack, exponential release
    let value = 1;
    const release = this.release;
    for (let pass = loop ? 0 : 1; pass < 2; pass++)
      for (let k = 0; k < count; k++) {
        value += (1 - value) * release;
        if (held[k] < value) value = held[k];
        if (pass === 1) need[k] = value;
      }
    // smooth the steps into ramps as long as the look-ahead
    const window = this.lookBlocks + 1;
    const before = (index: number) =>
      index >= 0
        ? need[index]
        : loop
          ? need[((index % count) + count) % count]
          : 1;
    let sum = 0;
    for (let j = 0; j < window; j++) sum += before(-j);
    for (let k = 0; k < count; k++) {
      if (k > 0) sum += need[k] - before(k - window);
      limit[k] = sum / window;
    }
  }

  private loudness(g: number): number {
    const { count, hops, hopOf, limit } = this;
    const energy = this.analysis.energy;
    const comp = this.compression;
    hops.fill(0);
    let total = 0;
    for (let k = 0; k < count; k++) {
      const gain = g * comp[k] * limit[k];
      const e = energy[k] * gain * gain;
      hops[hopOf[k]] += e;
      total += e;
    }
    for (let h = 0; h < this.completeHops; h++) hops[h] /= this.hopFrames;
    const gated = integratedFromHops(hops, this.completeHops);
    // too short to gate: fall back to the plain mean
    return gated > -Infinity ? gated : energyToLufs(total / this.frames);
  }

  private stats(g: number): {
    maxReductionDb: number;
    activeRatio: number;
    kneeRatio: number;
  } {
    const { count, limit } = this;
    const peaks = this.analysis.peaks;
    const comp = this.compression;
    let lowest = 1;
    let active = 0;
    let overKnee = 0;
    let audible = 0;
    for (let k = 0; k < count; k++) {
      if (limit[k] < lowest) lowest = limit[k];
      const level = g * peaks[k] * comp[k] * limit[k];
      if (level > 1e-4) {
        audible++;
        if (limit[k] < 0.944) active++;
        if (level > KNEE) overKnee++;
      }
    }
    return {
      maxReductionDb: -gainToDb(lowest),
      activeRatio: audible ? active / audible : 0,
      kneeRatio: audible ? overKnee / audible : 0,
    };
  }

  /** Static gain that puts the mix on `targetLufs` with the limiter out of the way. */
  private openGain(targetLufs: number): number {
    this.limit.fill(1);
    const open = this.loudness(1);
    return open > -Infinity ? clamp(dbToGain(targetLufs - open), 1e-4, 1e4) : 1;
  }

  /** Static gain that puts the limited mix on `targetLufs`. */
  private solveFor(targetLufs: number, ceiling: number): number {
    let g = this.openGain(targetLufs);
    for (let i = 0; i < 12; i++) {
      this.limiter(g, ceiling);
      const error = targetLufs - this.loudness(g);
      if (Math.abs(error) < 0.01) break;
      g = clamp(g * dbToGain(error), 1e-4, 1e4);
    }
    this.limiter(g, ceiling);
    return g;
  }

  /**
   * The gain plan for `targetLufs`. `biasLu` is added to what the solver aims
   * at: the caller measures the real result and feeds the estimate's error
   * back through it.
   */
  solve(
    targetLufs: number,
    ceiling: number,
    biasLu = 0,
    denseCeiling = ceiling,
  ): GainPlan {
    let shortfall = 0;
    // a dense master asks for a lower ceiling; it gets as much of it as the
    // limiter can deliver without working all the time
    let limit = Math.min(ceiling, denseCeiling);
    let g = this.solveFor(targetLufs + biasLu, limit);
    let stats = this.stats(g);
    while (
      limit < ceiling &&
      (stats.activeRatio > DENSE_BUSY_RATIO ||
        stats.maxReductionDb > DENSE_MAX_REDUCTION_DB)
    ) {
      limit = Math.min(ceiling, limit * dbToGain(1));
      g = this.solveFor(targetLufs + biasLu, limit);
      stats = this.stats(g);
    }
    // the reference mix should stay under the knee for all but ~1 % of the time
    if (stats.kneeRatio > 0.01 && limit > KNEE) {
      limit = Math.min(limit, KNEE);
      g = this.solveFor(targetLufs + biasLu, limit);
      stats = this.stats(g);
    }
    // a limiter that is busy most of the time is no longer transparent: give up some level
    while (
      (stats.activeRatio > LIMITER_BUSY_RATIO || stats.maxReductionDb > 9) &&
      shortfall < MAX_SHORTFALL_LU - 1e-9
    ) {
      shortfall += 0.25;
      g = this.solveFor(targetLufs + biasLu - shortfall, limit);
      stats = this.stats(g);
    }
    const curve = new Float32Array(this.count);
    for (let k = 0; k < this.count; k++)
      curve[k] = g * this.compression[k] * this.limit[k];
    return {
      curve,
      staticGain: g,
      estimatedLufs: this.loudness(g) - biasLu,
      shortfallLu: shortfall,
      ceiling: limit,
      limiterMaxReductionDb: stats.maxReductionDb,
      limiterActiveRatio: stats.activeRatio,
    };
  }
}

/* ---- measuring a mix ---- */

class MixMeter {
  private readonly meter: LoudnessMeter;
  private over = 0;
  private samples = 0;
  peak = 0;
  private readonly left = new Float32Array(BLOCK);
  private readonly right = new Float32Array(BLOCK);

  constructor(sampleRate: number) {
    this.meter = new LoudnessMeter(sampleRate);
  }

  /** Feed n frames of the mix BEFORE the soft clipper. */
  push(mixLeft: Float32Array, mixRight: Float32Array, n: number): void {
    const left = this.left;
    const right = this.right;
    let peak = this.peak;
    let over = 0;
    for (let i = 0; i < n; i++) {
      const l = mixLeft[i];
      const r = mixRight[i];
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > peak) peak = al;
      if (ar > peak) peak = ar;
      if (al > KNEE) {
        over++;
        left[i] = softClip(l);
      } else left[i] = l;
      if (ar > KNEE) {
        over++;
        right[i] = softClip(r);
      } else right[i] = r;
    }
    this.peak = peak;
    this.over += over;
    this.samples += n * 2;
    this.meter.push(left, right, n);
  }

  result(fallbackLufs = -Infinity): MixMeasurement {
    const lufs = this.meter.integrated;
    return {
      lufs: lufs > -Infinity ? lufs : fallbackLufs,
      peak: this.peak,
      clippedRatio: this.samples ? this.over / this.samples : 0,
    };
  }
}

/**
 * Loudness and peak statistics of Σ stem × volume, as the player and the
 * export produce it (the loudness is measured after softClip, the peak and
 * the clipped ratio before it).
 */
export function measureMix(
  stems: Stems,
  volumes: Record<TrackName, number> = REFERENCE_VOLUMES,
  sampleRate = SAMPLE_RATE,
): MixMeasurement {
  const frames = stems.melody[0].length;
  const meter = new MixMeter(sampleRate);
  const mixLeft = new Float32Array(BLOCK);
  const mixRight = new Float32Array(BLOCK);
  for (let from = 0; from < frames; from += BLOCK) {
    const count = Math.min(BLOCK, frames - from);
    mixLeft.fill(0, 0, count);
    mixRight.fill(0, 0, count);
    for (const track of TRACKS) {
      const volume = volumes[track];
      if (!volume) continue;
      accumulate(
        mixLeft,
        mixRight,
        stems[track][0].subarray(from, from + count),
        stems[track][1].subarray(from, from + count),
        count,
        volume,
      );
    }
    meter.push(mixLeft, mixRight, count);
  }
  return meter.result();
}

/**
 * Rough gated loudness of the raw reference mix from 200 ms probes spread
 * over the piece (the first half of each probe only settles the filters).
 * Good to about 1 LU at an eighth of the cost of a full pass; it only sets
 * the level at which the character saturation works.
 */
function probeLoudness(
  active: readonly ActiveStem[],
  frames: number,
  sampleRate: number,
): number {
  const hop = Math.max(1, Math.round(sampleRate * HOP_SECONDS));
  const window = Math.min(frames, hop * 2);
  const stride = window * 8;
  const mixLeft = new Float32Array(window);
  const mixRight = new Float32Array(window);
  const energies: number[] = [];
  for (let from = 0; from + window <= frames; from += stride) {
    mixLeft.fill(0);
    mixRight.fill(0);
    for (const stem of active)
      accumulate(
        mixLeft,
        mixRight,
        stem.left.subarray(from, from + window),
        stem.right.subarray(from, from + window),
        window,
        stem.volume,
      );
    const meter = new LoudnessMeter(sampleRate);
    meter.push(mixLeft, mixRight, window);
    const hops = meter.hopEnergies;
    if (hops.length) energies.push(hops[hops.length - 1]);
  }
  const mean = (floor: number) => {
    let sum = 0;
    let kept = 0;
    for (const energy of energies)
      if (energy > floor) {
        sum += energy;
        kept++;
      }
    return kept ? sum / kept : 0;
  };
  // the two gates of BS.1770, applied to the probes
  const absolute = Math.pow(10, (-70 + 0.691) / 10);
  return energyToLufs(mean(Math.max(absolute, mean(absolute) * 0.1)));
}

/* ---- block loops (plain functions: loops inside the async master run slower) ---- */

/** mix += volume · stem for one block. */
function accumulate(
  mixLeft: Float32Array,
  mixRight: Float32Array,
  left: Float32Array,
  right: Float32Array,
  n: number,
  volume: number,
): void {
  for (let i = 0; i < n; i++) {
    mixLeft[i] += left[i] * volume;
    mixRight[i] += right[i] * volume;
  }
}

/** mix += volume · gain · stem for one block (the stem itself is not changed). */
function accumulateGained(
  mixLeft: Float32Array,
  mixRight: Float32Array,
  left: Float32Array,
  right: Float32Array,
  gains: Float32Array,
  from: number,
  n: number,
  volume: number,
): void {
  for (let i = 0; i < n; i++) {
    const gain = gains[i] * volume;
    mixLeft[i] += left[from + i] * gain;
    mixRight[i] += right[from + i] * gain;
  }
}

/**
 * Gain of frames [from, from + n): linear from the previous control point to
 * the one that closes each control block.
 */
function fillGains(
  gains: Float32Array,
  curve: Float32Array,
  from: number,
  n: number,
  loop: boolean,
): void {
  const points = curve.length;
  for (let i = 0; i < n; ) {
    const frame = from + i;
    const k = Math.min(points - 1, Math.floor(frame / CONTROL));
    const start = k > 0 ? curve[k - 1] : loop ? curve[points - 1] : curve[0];
    const slope = (curve[k] - start) / CONTROL;
    const end = Math.min(n, (k + 1) * CONTROL - from);
    let value = start + slope * (frame - k * CONTROL + 1);
    for (; i < end; i++) {
      gains[i] = value;
      value += slope;
    }
  }
}

/** Fold the fade-in / fade-out of a non-looping piece into the gains of a block. */
function fadeGains(
  gains: Float32Array,
  from: number,
  n: number,
  frames: number,
  fadeIn: number,
  fadeOut: number,
): void {
  for (let i = 0; i < n; i++) {
    const frame = from + i;
    if (frame < fadeIn)
      gains[i] *= 0.5 - 0.5 * Math.cos((Math.PI * frame) / fadeIn);
    const remaining = frames - 1 - frame;
    if (remaining < fadeOut)
      gains[i] *=
        0.5 - 0.5 * Math.cos((Math.PI * remaining) / (fadeOut - 1));
  }
}

function applyGains(
  left: Float32Array,
  right: Float32Array,
  gains: Float32Array,
  n: number,
): void {
  for (let i = 0; i < n; i++) {
    const gain = gains[i];
    left[i] *= gain;
    right[i] *= gain;
  }
}

/** Round to the bitcrush grid (mid-tread: silence stays silence). */
function quantise(buf: Float32Array, n: number): void {
  for (let i = 0; i < n; i++)
    buf[i] = Math.round(buf[i] / BITCRUSH_STEP) * BITCRUSH_STEP;
}

/* ---- the master ---- */

interface ActiveStem {
  track: TrackName;
  left: Float32Array;
  right: Float32Array;
  volume: number;
}

/** In-place processing of one block of the stem with index `index`. */
type StemProcess = (
  index: number,
  left: Float32Array,
  right: Float32Array,
  n: number,
) => void;

function hasSignal(data: Float32Array): boolean {
  for (let i = 0; i < data.length; i++) if (data[i] !== 0) return true;
  return false;
}

function silentReport(settings: MasterSettings): MasterReport {
  return {
    silent: true,
    targetLufs: settings.targetLufs,
    lufs: -Infinity,
    peak: 0,
    clippedRatio: 0,
    shortfallLu: 0,
    gainDb: 0,
    compressor: { thresholdDb: 0, maxReductionDb: 0, meanReductionDb: 0 },
    limiter: { ceiling: LIMITER_CEILING, maxReductionDb: 0, activeRatio: 0 },
  };
}

/**
 * Master the four stems IN PLACE (see the file comment for the chain) and
 * report what was done. Stems that are digital silence stay silent.
 */
export async function masterStems(
  stems: Stems,
  settings: MasterSettings,
  options: MasterOptions,
): Promise<MasterReport> {
  const { sampleRate, loop } = options;
  const seed = options.seed ?? 0;
  const frames = stems.melody[0].length;
  const active: ActiveStem[] = [];
  for (const track of TRACKS) {
    const [left, right] = stems[track];
    if (hasSignal(left) || hasSignal(right))
      active.push({ track, left, right, volume: REFERENCE_VOLUMES[track] });
  }
  if (!active.length || frames < 2) return silentReport(settings);

  const character = settings.character;
  const shaper = shaperFor(character);
  const density = clamp(
    settings.density ?? CHARACTER_DENSITY[character] ?? 0.4,
    0,
    1,
  );
  const drums = active.find((stem) => stem.track === "drums");
  const glue = drums
    ? glueDrums(drums.left, drums.right, frames, sampleRate, density, loop)
    : undefined;
  const narrowed: Partial<Record<TrackName, number>> = {};
  // progress: stem preparation, the analysis sweep, the final pass
  const steps = 3;
  let step = 0;
  const tick = (part: number) => options.tick?.((step + part) / steps);

  const mixLeft = new Float32Array(BLOCK);
  const mixRight = new Float32Array(BLOCK);
  const workLeft = new Float32Array(BLOCK);
  const workRight = new Float32Array(BLOCK);

  // whole-stem preparation: wow (lofi), then the stereo field
  const side =
    options.scratch && options.scratch.length >= frames
      ? options.scratch
      : new Float32Array(frames);
  for (let index = 0; index < active.length; index++) {
    const stem = active[index];
    // each of these is one pass over the whole stem (tens of milliseconds for
    // two minutes): the host gets a turn between them
    const wide = character === "wide";
    if (character === "lofi") {
      applyWow(stem.left, stem.right, frames, sampleRate, loop, seed);
      const waiting = tick((index + 0.4) / active.length);
      if (waiting) await waiting;
    }
    if (
      sideForward(stem.left, stem.right, frames, sampleRate, wide, loop, side)
    ) {
      const waiting = tick((index + 0.7) / active.length);
      if (waiting) await waiting;
      sideBackward(stem.left, stem.right, frames, sampleRate, wide, loop, side);
      const kept = guardStereo(stem.left, stem.right, frames);
      if (kept < 1) narrowed[stem.track] = kept;
    }
    const pending = tick((index + 1) / active.length);
    if (pending) await pending;
  }
  step++;

  /**
   * One sweep over the piece: every stem block goes through `process` (and is
   * written back unless this is a loop warm-up), the reference mix of the
   * result feeds the analyser.
   */
  const sweepBlock = (
    process: StemProcess,
    analyser: MixAnalyser,
    from: number,
    count: number,
    write: boolean,
  ) => {
    mixLeft.fill(0, 0, count);
    mixRight.fill(0, 0, count);
    for (let index = 0; index < active.length; index++) {
      const stem = active[index];
      workLeft.set(stem.left.subarray(from, from + count));
      workRight.set(stem.right.subarray(from, from + count));
      process(index, workLeft, workRight, count);
      if (write) {
        stem.left.set(workLeft.subarray(0, count), from);
        stem.right.set(workRight.subarray(0, count), from);
      }
      accumulate(mixLeft, mixRight, workLeft, workRight, count, stem.volume);
    }
    analyser.push(mixLeft, mixRight, count, write);
  };
  const sweep = async (
    process: StemProcess,
    analyser: MixAnalyser,
    warmFrames: number,
    beforeMain?: () => void,
  ) => {
    if (loop && warmFrames > 0)
      forLoopTail(frames, warmFrames, BLOCK, (from, count) =>
        sweepBlock(process, analyser, from, count, false),
      );
    beforeMain?.();
    for (let from = 0; from < frames; from += BLOCK) {
      sweepBlock(process, analyser, from, Math.min(BLOCK, frames - from), true);
      const pending = tick(from / frames);
      if (pending) await pending;
    }
    analyser.finish();
    step++;
  };

  // lofi / punchy colour each stem with a saturation curve, which needs the
  // mix near its final level first: a quick probe of the loudness sets that gain
  let preGain = 1;
  if (shaper) {
    const rough = probeLoudness(active, frames, sampleRate);
    if (rough > -Infinity)
      preGain = clamp(dbToGain(settings.targetLufs - rough), 1e-3, 1e3);
  }

  // the sweep: linear chain per stem, then the character's saturation
  const chains = active.map(() => new StemChain(sampleRate, settings));
  const analysis = new MixAnalyser(frames, sampleRate);
  const warmFrames = Math.min(frames * 4, Math.round(sampleRate * 0.4));
  await sweep(
    (index, l, r, n) => {
      chains[index].process(l, r, n);
      if (shaper) {
        shaper(l, n, preGain);
        shaper(r, n, preGain);
      }
    },
    analysis,
    warmFrames,
    () => chains.forEach((chain) => chain.alignClock()),
  );

  // one gain curve for all stems: compressor × limiter × loudness gain
  const compression = compressorCurve(
    analysis,
    sampleRate,
    character === "punchy" ? 0.06 : 0.025,
    loop,
  );
  const ceiling = Math.min(LIMITER_CEILING, dbToGain(settings.ceilingDb));
  // (an explicit ceiling lower than that simply stays)
  const denseCeiling = LIMITER_CEILING * dbToGain(-DENSE_CEILING_DB * density);
  const solver = new GainSolver(
    analysis,
    compression.gain,
    frames,
    sampleRate,
    loop,
  );
  let plan = solver.solve(settings.targetLufs, ceiling, 0, denseCeiling);
  if (!(plan.estimatedLufs > -Infinity)) return silentReport(settings);

  const gains = new Float32Array(BLOCK);
  /** Loudness the plan really produces: softClip(Σ stem × gain × volume), without touching the stems. */
  const rehearse = (curve: Float32Array): number => {
    const meter = new MixMeter(sampleRate);
    for (let from = 0; from < frames; from += BLOCK) {
      const count = Math.min(BLOCK, frames - from);
      fillGains(gains, curve, from, count, loop);
      mixLeft.fill(0, 0, count);
      mixRight.fill(0, 0, count);
      for (const stem of active)
        accumulateGained(
          mixLeft,
          mixRight,
          stem.left,
          stem.right,
          gains,
          from,
          count,
          stem.volume,
        );
      meter.push(mixLeft, mixRight, count);
    }
    return meter.result(plan.estimatedLufs).lufs;
  };
  // The control-rate loudness estimate is within 0.01 LU for ordinary music
  // (measured up to 9 % limiter activity and 4.5 dB of reduction). When the
  // limiter works far harder than that, its fast gain changes are beyond what
  // the estimate models, so the plan is rehearsed and corrected.
  if (plan.limiterActiveRatio > 0.1 || plan.limiterMaxReductionDb > 6) {
    let bias = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const error =
        settings.targetLufs - plan.shortfallLu - rehearse(plan.curve);
      if (Math.abs(error) < 0.05) break;
      bias += error;
      plan = solver.solve(settings.targetLufs, ceiling, bias, denseCeiling);
      const pending = tick(0);
      if (pending) await pending;
    }
  }

  // pass F: apply the curve, the character's last touches and the edge fades; meter the result
  const curve = plan.curve;
  // One stereo hiss bed, shared out between the sounding stems so that it
  // adds up to HISS_RMS in the reference mix and leaves with any muted track.
  const hissGains = new Float32Array(BLOCK);
  const hissLeft = new Float32Array(BLOCK);
  const hissRight = new Float32Array(BLOCK);
  const hissShare =
    1 / active.reduce((sum, stem) => sum + stem.volume, 0);
  const hiss =
    character === "lofi"
      ? [
          new Hiss(hashSeed(seed, 21), sampleRate, HISS_RMS * hissShare),
          new Hiss(hashSeed(seed, 22), sampleRate, HISS_RMS * hissShare),
        ]
      : null;
  const fadeIn = loop
    ? 0
    : Math.min(frames, Math.round(FADE_IN_SECONDS * sampleRate));
  const fadeOut = loop
    ? 0
    : Math.max(
        2,
        Math.min(
          Math.floor(frames / 4),
          Math.round(FADE_OUT_SECONDS * sampleRate),
        ),
      );
  const crush = character === "bitcrush";
  const meter = new MixMeter(sampleRate);
  for (let from = 0; from < frames; from += BLOCK) {
    const count = Math.min(BLOCK, frames - from);
    fillGains(gains, curve, from, count, loop);
    const fading =
      (fadeIn > 0 && from < fadeIn) ||
      (fadeOut > 0 && from + count > frames - fadeOut);
    if (fading) {
      // the hiss must fade with the music, so it gets the fade alone
      hissGains.fill(1, 0, count);
      fadeGains(hissGains, from, count, frames, fadeIn, fadeOut);
      fadeGains(gains, from, count, frames, fadeIn, fadeOut);
    }
    if (hiss) {
      hiss[0].fill(hissLeft, count, fading ? hissGains : null);
      hiss[1].fill(hissRight, count, fading ? hissGains : null);
    }
    mixLeft.fill(0, 0, count);
    mixRight.fill(0, 0, count);
    for (const stem of active) {
      const left = stem.left.subarray(from, from + count);
      const right = stem.right.subarray(from, from + count);
      applyGains(left, right, gains, count);
      if (hiss) accumulate(left, right, hissLeft, hissRight, count, 1);
      if (crush) {
        quantise(left, count);
        quantise(right, count);
      }
      accumulate(mixLeft, mixRight, left, right, count, stem.volume);
    }
    meter.push(mixLeft, mixRight, count);
    const pending = tick(from / frames);
    if (pending) await pending;
  }
  if (!loop)
    for (const stem of active) {
      stem.left[frames - 1] = 0;
      stem.right[frames - 1] = 0;
    }

  let measured = meter.result(plan.estimatedLufs);
  const wanted = settings.targetLufs - plan.shortfallLu;
  let trimDb = 0;
  // Safety net: should the result still be off, a plain gain corrects it as
  // far as the limiter's ceiling allows (it can always turn down).
  if (Math.abs(wanted - measured.lufs) > 0.1 && measured.peak > 0) {
    const headroomDb = gainToDb((plan.ceiling * 1.02) / measured.peak);
    trimDb = Math.min(clamp(wanted - measured.lufs, -3, 3), headroomDb);
    if (Math.abs(trimDb) > 0.01) {
      const trim = dbToGain(trimDb);
      for (const stem of active)
        for (let i = 0; i < frames; i++) {
          stem.left[i] *= trim;
          stem.right[i] *= trim;
        }
      const again = measureMix(stems, REFERENCE_VOLUMES, sampleRate);
      measured = {
        ...again,
        lufs: again.lufs > -Infinity ? again.lufs : measured.lufs + trimDb,
      };
    } else trimDb = 0;
  }
  const last = options.tick?.(1);
  if (last) await last;

  return {
    silent: false,
    targetLufs: settings.targetLufs,
    ...measured,
    shortfallLu: plan.shortfallLu,
    gainDb: gainToDb(plan.staticGain * preGain) + trimDb,
    compressor: {
      thresholdDb: compression.thresholdDb,
      maxReductionDb: compression.maxReductionDb,
      meanReductionDb: compression.meanReductionDb,
    },
    limiter: {
      ceiling: plan.ceiling,
      maxReductionDb: plan.limiterMaxReductionDb,
      activeRatio: plan.limiterActiveRatio,
    },
    ...(glue ? { glue } : {}),
    ...(Object.keys(narrowed).length ? { narrowed } : {}),
  };
}
