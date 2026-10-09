/**
 * audio-audit — objective measurements of what the local engine renders.
 *
 *   npx tsx scripts/audio-audit.ts --style <id[,id…]|all> [options]
 *
 *   --style <ids|all>     styles to render (default: all 22)
 *   --loop | --no-loop    loop or a piece that ends (default: loop); --both renders each style twice
 *   --duration <s>        15..120 (default 30)
 *   --seed <n[,n…]>       default 1234; several seeds render several pieces
 *   --energy <0..1>  --complexity <0..1>  --reverb <0..1>
 *   --instrument <id>  --bpm <n>  --key "<name>"       override the style's preset
 *   --arrangement '<json>'  ArrangementHints, as an LLM would send them
 *   --json <file>         write everything measured as JSON
 *   --wav <dir>           write <id>-mix.wav (what the user hears at the default faders) and the four
 *                         raw stems <id>-melody|chords|bass|drums.wav (16-bit, 48 kHz)
 *   --png <dir>           write <id>-spectrogram.png: log-frequency spectrogram of the mix, 20 Hz–24 kHz,
 *                         100 dB range; --png-stems adds one per stem
 *   --solo-parts          also render every part alone (slow) and report its level against the raw mix
 *   --quiet               no table, only the JSON/WAV/PNG files and a one-line summary
 *
 * UNITS. The spectral slope is the least-squares slope of the OCTAVE-BAND
 * levels 63 Hz–8 kHz: pink noise reads 0 and white noise +3 dB per octave. An
 * FFT analyser shows power per hertz, which falls 3 dB per octave more: a mix
 * described as "-4.5 dB/octave" on such a display reads -1.5 here.
 *
 * Everything is measured on the mix the user hears at the default faders:
 * softClip(Σ stem × REFERENCE_VOLUMES). The table prints one line per render;
 * the JSON holds the full detail (see the Audit interface below). `flags`
 * lists whatever falls outside the bounds in LIMITS — the same bounds
 * tests/audio-quality.test.ts enforces.
 *
 * The same functions are importable: auditConfig(config) → Audit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { DRUMS } from "../src/audio/drums";
import { Biquad, fft } from "../src/audio/dsp";
import {
  LoudnessMeter,
  energyToLufs,
  integratedFromHops,
} from "../src/audio/loudness";
import type { MasterReport } from "../src/audio/master";
import { renderScoreWith } from "../src/audio/render";
import type { RenderReport } from "../src/audio/render";
import { REFERENCE_VOLUMES } from "../src/audio/render-types";
import type { RenderedAudio, StereoPcm } from "../src/audio/render-types";
import { CEILING, KNEE, softClipBuffer } from "../src/audio/softclip";
import { VOICES } from "../src/audio/voices";
import { encodeWavFromChannels } from "../src/audio/wav";
import {
  STYLE_IDS,
  isInstrumentId,
  isKey,
  isStyleId,
} from "../src/music/catalog";
import type { StyleId } from "../src/music/catalog";
import { compose } from "../src/music/compose";
import {
  DEFAULT_CONFIG,
  clampConfig,
  stylePreset,
} from "../src/music/defaults";
import { TRACKS } from "../src/music/score";
import type { Part, PartMix, Score, TrackName } from "../src/music/score";
import type { MusicConfig } from "../src/types";

/* ------------------------------------------------------------------ */
/* what is measured                                                    */
/* ------------------------------------------------------------------ */

export const BANDS = [
  { id: "sub", low: 0, high: 60 },
  { id: "bass", low: 60, high: 250 },
  { id: "lowMid", low: 250, high: 500 },
  { id: "mid", low: 500, high: 2000 },
  { id: "presence", low: 2000, high: 6000 },
  { id: "air", low: 6000, high: Infinity },
] as const;
export type BandId = (typeof BANDS)[number]["id"];
/** Power per band in dB relative to the total power of the MIX (so a stem's bands show where it sits in the mix). */
export type BandLevels = Record<BandId, number>;

/** The bounds behind Audit.flags (tests/audio-quality.test.ts asserts the same ones). */
export const LIMITS = {
  /** mix loudness within this many LU of the target */
  lufsTolerance: 1.0,
  /** share of samples of the reference mix past the soft clipper's knee */
  kneeShare: 0.02,
  /** the loudest 400 ms of a track with notes must reach this in the default mix, LUFS */
  audibleLufs: -45,
  /** a stem (ungated, at its fader) may exceed the mix it is part of by this much: more means the stems cancel each other */
  stemOverMixLu: 0.5,
  /** a loop's wrap may step this many times the 99th-percentile step around it */
  seamRatio: 3,
  /** a piece that ends starts below this (first sample) and ends below this (last 50 ms RMS, dBFS) */
  startSample: 0.01,
  endDb: -60,
  /** no band may carry more than this share of the mix's energy */
  bandShare: 0.85,
  /** |mean| of a channel */
  dc: 0.002,
  /** L/R correlation of what is left under LOW_END_HZ: the master folds the lows to mono */
  lowCorrelation: 0.9,
  /** … checked when that part holds more than this share of the mix's power, dB (1 %) */
  lowEndFloorDb: -20,
  /** a sample step this many times the steepest step within 20 ms of it (and above clickStep) is a click */
  clickRatio: 4,
  clickStep: 0.03,
};

/**
 * Corner of the "low end" whose mono-ness is checked. The master makes the
 * side signal fall away below 120 Hz at 24 dB per octave, so only well under
 * that corner is the mix mono by construction (a piano's 120–200 Hz may be as
 * wide as it likes).
 */
export const LOW_END_HZ = 80;

export interface SpectrumAudit {
  bands: BandLevels;
  /** least-squares slope of the octave-band levels 63 Hz–8 kHz, dB per octave (pink noise 0, white +3) */
  slopeDbPerOctave: number;
  /** power-weighted mean frequency, Hz */
  centroidHz: number;
}

export interface StemAudit {
  /** no part plays on this track */
  empty: boolean;
  /** integrated loudness as heard in the default mix (stem × its reference fader), LUFS */
  lufs: number;
  /** the same at fader 1 */
  rawLufs: number;
  /**
   * its loudest 400 ms in the default mix, LUFS — what decides whether a
   * sparse track (a woodblock on two and four) can be heard at all; its
   * integrated loudness is low simply because it is silent most of the time
   */
  momentaryMax: number;
  /** sample peak at the reference fader */
  peak: number;
  /**
   * LU below the mix (positive = quieter than the mix), both UNGATED: gating
   * drops the quiet stretches of a stem that plays only now and then, which
   * can make its gated loudness exceed that of the mix it is part of
   */
  belowMixLu: number;
  spectrum: SpectrumAudit | null;
  /**
   * loudness in each section of the score (same order as Audit.sections), at
   * the reference fader, ungated: a kit that plays in the chorus only shows
   * there at its real level instead of being averaged over the whole piece
   */
  sections: number[];
  /** wet energy against the track's own dry energy, dB (-Infinity: no send) */
  reverbDb: number;
  delayDb: number;
  correlation: number;
}

export interface PartAudit {
  id: string;
  role: string;
  track: TrackName;
  voice: string;
  /** the part alone, before the master, at its track's reference fader */
  rawLufs: number;
  /** against the raw (pre-master) mix: 0 would be as loud as everything together */
  relLu: number;
  peak: number;
  bands: BandLevels;
}

export interface Audit {
  id: string;
  config: Omit<MusicConfig, "prompt" | "volumes">;
  score: {
    style: StyleId;
    lead: string;
    bars: number;
    bpm: number;
    duration: number;
    loop: boolean;
    key: string;
    swing: number;
    sections: {
      type: string;
      label: string;
      bars: number;
      start: number;
      end: number;
      energy: number;
    }[];
    parts: {
      id: string;
      role: string;
      track: TrackName;
      voice: string;
      events: number;
      /** summed held time of the notes, seconds (0 for drums) */
      heldSeconds: number;
      /** lowest and highest MIDI note (notes only) */
      range: [number, number] | null;
      meanVelocity: number;
      mix: PartMix;
    }[];
    space: Score["space"];
    master: Score["master"];
    notes: string[];
  };
  render: {
    /** wall-clock seconds; not reproducible, everything else is */
    seconds: number;
    stages: RenderReport["seconds"];
    notes: number;
    hits: number;
    bufferBytes: number;
    master: MasterReport;
  };
  mix: {
    /** integrated loudness, LUFS (BS.1770-4, gated) */
    lufs: number;
    /** the same without the gates: K-weighted mean power of the whole piece */
    ungatedLufs: number;
    targetLufs: number;
    /** loudness range after EBU Tech 3342, LU */
    lra: number;
    shortTermMax: number;
    momentaryMax: number;
    /** sample peak after the soft clipper (linear and dBFS) */
    peak: number;
    peakDb: number;
    /** sample peak before the soft clipper */
    prePeak: number;
    /** 4× oversampled peak estimate after the soft clipper, dBFS */
    truePeakDb: number;
    rmsDb: number;
    /** peak over RMS, dB */
    crestDb: number;
    /** share of samples past the soft clipper's knee (before clipping) */
    kneeShare: number;
    dc: [number, number];
    /** L/R correlation of the whole mix, and of what is left under LOW_END_HZ */
    correlation: number;
    correlationLow: number;
    /** power of what is left under LOW_END_HZ against the whole mix, dB */
    lowEndDb: number;
    /**
     * isolated sample steps (a note or an effect that starts or stops without
     * a fade): how many, the largest against its surroundings, and where
     */
    clicks: {
      count: number;
      worstRatio: number;
      worstStep: number;
      at: number;
    };
    /** side energy over mid energy, dB */
    sideDb: number;
    spectrum: SpectrumAudit;
    finite: boolean;
  };
  sections: {
    label: string;
    type: string;
    start: number;
    end: number;
    lufs: number;
    shortTermMax: number;
  }[];
  stems: Record<TrackName, StemAudit>;
  /** loops: how the last sample meets the first */
  seam?: {
    /** |first − last| sample, worst channel */
    jump: number;
    /** the jump over the 99th-percentile sample step within ±40 ms of the wrap */
    jumpRatio: number;
    /** the same for the slope (second difference) */
    kinkRatio: number;
    /** RMS of the last and the first 30 ms, dBFS */
    beforeDb: number;
    afterDb: number;
    /** RMS of the last 30 ms against the last 300 ms: far below 0 means the end was faded or left empty */
    endDipDb: number;
  };
  /** pieces that end */
  edges?: {
    firstSample: number;
    /** RMS of the first 2 ms, dBFS */
    startDb: number;
    /** RMS of the last 50 ms, dBFS */
    endDb: number;
    lastSample: number;
    /** seconds between the last sample above -60 dBFS and the end */
    silentTail: number;
  };
  parts?: PartAudit[];
  flags: string[];
}

export interface AuditOptions {
  soloParts?: boolean;
  /** receive the audio that was measured (mix after the soft clipper, and the raw stems) */
  onAudio?: (audio: {
    id: string;
    mix: StereoPcm;
    stems: Record<TrackName, StereoPcm>;
    sampleRate: number;
    score: Score;
  }) => void;
}

/* ------------------------------------------------------------------ */
/* measurement helpers                                                 */
/* ------------------------------------------------------------------ */

const db = (ratio: number) => (ratio > 0 ? 10 * Math.log10(ratio) : -Infinity);
const amplitudeDb = (value: number) =>
  value > 0 ? 20 * Math.log10(value) : -Infinity;
const round = (value: number, digits = 2) => {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/** Scratch buffers that only grow, shared by every audit of a run. */
const pool = new Map<string, Float32Array>();
function scratch(name: string, frames: number): Float32Array {
  let buffer = pool.get(name);
  if (!buffer || buffer.length < frames) {
    buffer = new Float32Array(frames);
    pool.set(name, buffer);
  }
  return buffer;
}

const FFT_SIZE = 8192;
const fftRe = new Float64Array(FFT_SIZE);
const fftIm = new Float64Array(FFT_SIZE);
const fftWindow = Float64Array.from(
  { length: FFT_SIZE },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE),
);
const WINDOW_POWER = fftWindow.reduce((sum, value) => sum + value * value, 0);
/** At most this many FFT frames go into a long-term spectrum (spread evenly over the piece). */
const SPECTRUM_FRAMES = 220;

/**
 * One FFT for both channels: with z = left + i·right,
 * |Z[k]|² + |Z[N−k]|² = 2·(|L[k]|² + |R[k]|²). Adds that sum, times `scale`,
 * to out[0 .. FFT_SIZE/2]; the window is applied here, `start` may reach
 * outside the signal (zeros).
 */
function addStereoPower(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  start: number,
  out: Float64Array,
  scale: number,
): void {
  for (let i = 0; i < FFT_SIZE; i++) {
    const at = start + i;
    if (at >= 0 && at < frames) {
      fftRe[i] = left[at] * fftWindow[i];
      fftIm[i] = right[at] * fftWindow[i];
    } else {
      fftRe[i] = 0;
      fftIm[i] = 0;
    }
  }
  fft(fftRe, fftIm);
  const half = FFT_SIZE / 2;
  out[0] += scale * (fftRe[0] * fftRe[0] + fftIm[0] * fftIm[0]);
  out[half] += scale * (fftRe[half] * fftRe[half] + fftIm[half] * fftIm[half]);
  for (let k = 1; k < half; k++) {
    const m = FFT_SIZE - k;
    out[k] +=
      scale *
      0.5 *
      (fftRe[k] * fftRe[k] +
        fftIm[k] * fftIm[k] +
        fftRe[m] * fftRe[m] +
        fftIm[m] * fftIm[m]);
  }
}

/** Long-term average power spectrum of a stereo signal (mean of both channels), bins 0..FFT_SIZE/2. */
function averageSpectrum(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  out: Float64Array,
): Float64Array {
  out.fill(0);
  const available = Math.max(
    1,
    Math.floor((frames - FFT_SIZE) / (FFT_SIZE / 2)) + 1,
  );
  const count = Math.min(available, SPECTRUM_FRAMES);
  const stride = count > 1 ? (frames - FFT_SIZE) / (count - 1) : 0;
  for (let index = 0; index < count; index++)
    addStereoPower(
      left,
      right,
      frames,
      Math.max(0, Math.round(index * stride)),
      out,
      1,
    );
  // mean square of the signal per bin (one-sided), averaged over frames and the two channels
  const norm = 2 / (FFT_SIZE * WINDOW_POWER * count * 2);
  for (let k = 0; k <= FFT_SIZE / 2; k++)
    out[k] *= k === 0 || k === FFT_SIZE / 2 ? norm / 2 : norm;
  return out;
}

function powerBetween(
  power: Float64Array,
  sampleRate: number,
  low: number,
  high: number,
): number {
  const binHz = sampleRate / FFT_SIZE;
  const from = Math.max(0, Math.ceil(low / binHz - 0.5));
  const to = Math.min(power.length - 1, Math.ceil(high / binHz - 0.5) - 1);
  let total = 0;
  for (let k = from; k <= to; k++) total += power[k];
  return total;
}

function describeSpectrum(
  power: Float64Array,
  sampleRate: number,
  reference: number,
): SpectrumAudit {
  const bands = {} as BandLevels;
  for (const band of BANDS)
    bands[band.id] = round(
      db(powerBetween(power, sampleRate, band.low, band.high) / reference),
      2,
    );
  // octave bands 63 Hz .. 8 kHz
  const xs: number[] = [];
  const ys: number[] = [];
  for (let centre = 62.5; centre <= 8000; centre *= 2) {
    const level = powerBetween(
      power,
      sampleRate,
      centre / Math.SQRT2,
      centre * Math.SQRT2,
    );
    if (level > 0) {
      xs.push(Math.log2(centre));
      ys.push(10 * Math.log10(level));
    }
  }
  let slope = NaN;
  if (xs.length >= 3) {
    const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
    const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
    let top = 0;
    let bottom = 0;
    for (let i = 0; i < xs.length; i++) {
      top += (xs[i] - meanX) * (ys[i] - meanY);
      bottom += (xs[i] - meanX) ** 2;
    }
    slope = top / bottom;
  }
  let weighted = 0;
  let total = 0;
  const binHz = sampleRate / FFT_SIZE;
  for (let k = 1; k < power.length; k++) {
    weighted += k * binHz * power[k];
    total += power[k];
  }
  return {
    bands,
    slopeDbPerOctave: round(slope, 2),
    centroidHz: round(total > 0 ? weighted / total : 0, 0),
  };
}

function correlation(
  left: Float32Array,
  right: Float32Array,
  frames: number,
): number {
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < frames; i++) {
    lr += left[i] * right[i];
    ll += left[i] * left[i];
    rr += right[i] * right[i];
  }
  return ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 1;
}

/** Correlation of what a fourth-order Butterworth low-pass at `hz` leaves of both channels, and that part's mean power. */
function lowCorrelation(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  sampleRate: number,
  hz: number,
): { correlation: number; power: number } {
  const first = new Biquad().setLowpass(hz, 0.5412, sampleRate);
  const second = new Biquad().setLowpass(hz, 1.3066, sampleRate);
  // four sections (two per channel) in one pass, transposed direct form II
  const state = new Float64Array(8);
  const run = (x: number, section: Biquad, at: number) => {
    const y = section.b0 * x + state[at];
    state[at] = section.b1 * x - section.a1 * y + state[at + 1];
    state[at + 1] = section.b2 * x - section.a2 * y;
    return y;
  };
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < frames; i++) {
    // a whisper of offset keeps the filter states out of the (slow) denormal range in silence
    const l = run(run(left[i] + 1e-18, first, 0), second, 2);
    const r = run(run(right[i] + 1e-18, first, 4), second, 6);
    lr += l * r;
    ll += l * l;
    rr += r * r;
  }
  return {
    correlation: ll > 1e-24 && rr > 1e-24 ? lr / Math.sqrt(ll * rr) : 1,
    power: (ll + rr) / (2 * Math.max(1, frames)),
  };
}

/**
 * Clicks: sample-to-sample steps that stand alone. A step counts when it is
 * larger than LIMITS.clickStep and more than LIMITS.clickRatio times the
 * steepest step within 20 ms on either side of it (leaving out its own four
 * neighbours). Drum strokes, square waves and bit-crushing are full of steep
 * steps but never of a single one, so they do not count.
 */
export function clicksOf(
  channels: Float32Array[],
  frames: number,
  sampleRate: number,
  loop: boolean,
): Audit["mix"]["clicks"] {
  const reach = Math.round(0.02 * sampleRate);
  const guard = 4;
  let count = 0;
  let worstRatio = 0;
  let worstStep = 0;
  let at = 0;
  if (frames < reach * 4) return { count, worstRatio, worstStep, at };
  const total = loop ? frames : frames - 1;
  const steps = new Float32Array(total);
  const before = new Float32Array(total);
  const queue = new Int32Array(total);
  for (const data of channels) {
    for (let i = 0; i < total; i++)
      steps[i] = Math.abs(data[(i + 1) % frames] - data[i]);
    // highest step in [i − reach, i − guard − 1] (sliding maximum), then the same looking ahead
    for (const direction of [1, -1]) {
      let head = 0;
      let tail = 0;
      for (let n = 0; n < total; n++) {
        const i = direction > 0 ? n : total - 1 - n;
        const entering = i - direction * (guard + 1);
        if (entering >= 0 && entering < total) {
          while (tail > head && steps[queue[tail - 1]] <= steps[entering])
            tail--;
          queue[tail++] = entering;
        }
        while (tail > head && Math.abs(queue[head] - i) > reach) head++;
        const around = tail > head ? steps[queue[head]] : 0;
        if (direction > 0) before[i] = around;
        else {
          const step = steps[i];
          if (step <= LIMITS.clickStep) continue;
          const neighbourhood = Math.max(before[i], around, 1e-9);
          const ratio = step / neighbourhood;
          if (ratio > LIMITS.clickRatio) {
            count++;
            if (ratio > worstRatio) {
              worstRatio = ratio;
              worstStep = step;
              at = i / sampleRate;
            }
          }
        }
      }
    }
  }
  return {
    count,
    worstRatio: round(worstRatio, 1),
    worstStep: round(worstStep, 4),
    at: round(at, 4),
  };
}

function rms(
  left: Float32Array,
  right: Float32Array,
  from: number,
  to: number,
): number {
  let sum = 0;
  const a = Math.max(0, Math.floor(from));
  const b = Math.max(a, Math.floor(to));
  for (let i = a; i < b; i++) sum += left[i] * left[i] + right[i] * right[i];
  return b > a ? Math.sqrt(sum / (2 * (b - a))) : 0;
}

/** Loudness range (EBU Tech 3342) from short-term loudness values. */
function loudnessRange(shortTerm: Float64Array): number {
  const energies: number[] = [];
  for (const value of shortTerm)
    if (value > -70) energies.push(10 ** (value / 10));
  if (energies.length < 2) return 0;
  const gate =
    10 * Math.log10(energies.reduce((a, b) => a + b, 0) / energies.length) - 20;
  const kept = Array.from(shortTerm)
    .filter((value) => value > -70 && value > gate)
    .sort((a, b) => a - b);
  if (kept.length < 2) return 0;
  const at = (fraction: number) =>
    kept[
      Math.min(
        kept.length - 1,
        Math.max(0, Math.round(fraction * (kept.length - 1))),
      )
    ];
  return at(0.95) - at(0.1);
}

const TRUE_PEAK_TAPS = 8;
/** Hann-windowed sinc for the three points between two samples. */
const TRUE_PEAK_KERNEL = (() => {
  const kernel = new Float64Array(3 * 2 * TRUE_PEAK_TAPS);
  for (let phase = 1; phase < 4; phase++)
    for (let k = -TRUE_PEAK_TAPS + 1; k <= TRUE_PEAK_TAPS; k++) {
      const x = phase / 4 - k;
      kernel[(phase - 1) * 2 * TRUE_PEAK_TAPS + k + TRUE_PEAK_TAPS - 1] =
        (Math.sin(Math.PI * x) / (Math.PI * x)) *
        (0.5 + 0.5 * Math.cos((Math.PI * x) / TRUE_PEAK_TAPS));
    }
  return kernel;
})();

/** Highest value of the band-limited signal between the samples (4× windowed-sinc), looked for near the sample peaks. */
function truePeak(
  channels: Float32Array[],
  frames: number,
  samplePeak: number,
): number {
  const taps = TRUE_PEAK_TAPS;
  let best = samplePeak;
  const threshold = samplePeak * 0.8;
  for (const data of channels)
    for (let i = taps; i < frames - taps - 1; i++) {
      const a = data[i];
      const b = data[i + 1];
      if ((a < 0 ? -a : a) < threshold && (b < 0 ? -b : b) < threshold)
        continue;
      for (let phase = 0; phase < 3; phase++) {
        let sum = 0;
        const base = phase * 2 * taps;
        for (let k = 0; k < 2 * taps; k++)
          sum += data[i - taps + 1 + k] * TRUE_PEAK_KERNEL[base + k];
        if (sum < 0) sum = -sum;
        if (sum > best) best = sum;
      }
    }
  return best;
}

function percentile(values: Float64Array, fraction: number): number {
  const sorted = Float64Array.from(values).sort();
  return (
    sorted[
      Math.min(
        sorted.length - 1,
        Math.max(0, Math.round(fraction * (sorted.length - 1))),
      )
    ] ?? 0
  );
}

function seamOf(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  sampleRate: number,
): NonNullable<Audit["seam"]> {
  const span = Math.min(Math.floor(frames / 2), Math.round(0.04 * sampleRate));
  let jump = 0;
  let jumpRatio = 0;
  let kinkRatio = 0;
  for (const data of [left, right]) {
    // the wrap, unrolled: [end − span, end) followed by [0, span)
    const around = new Float64Array(span * 2);
    for (let i = 0; i < span; i++) {
      around[i] = data[frames - span + i];
      around[span + i] = data[i];
    }
    const steps = new Float64Array(span * 2 - 1);
    for (let i = 0; i < steps.length; i++)
      steps[i] = Math.abs(around[i + 1] - around[i]);
    const kinks = new Float64Array(span * 2 - 2);
    for (let i = 0; i < kinks.length; i++)
      kinks[i] = Math.abs(around[i + 2] - 2 * around[i + 1] + around[i]);
    const step = steps[span - 1];
    const kink = Math.max(kinks[span - 2], kinks[span - 1]);
    jump = Math.max(jump, step);
    // a wrap in near silence cannot click, whatever the ratio says
    if (step > 1e-4)
      jumpRatio = Math.max(
        jumpRatio,
        step / Math.max(1e-9, percentile(steps, 0.99)),
      );
    if (kink > 1e-4)
      kinkRatio = Math.max(
        kinkRatio,
        kink / Math.max(1e-9, percentile(kinks, 0.99)),
      );
  }
  const short = Math.round(0.03 * sampleRate);
  const long = Math.round(0.3 * sampleRate);
  const before = rms(left, right, frames - short, frames);
  return {
    jump: round(jump, 5),
    jumpRatio: round(jumpRatio, 2),
    kinkRatio: round(kinkRatio, 2),
    beforeDb: round(amplitudeDb(before), 1),
    afterDb: round(amplitudeDb(rms(left, right, 0, short)), 1),
    endDipDb: round(
      amplitudeDb(
        before / Math.max(1e-12, rms(left, right, frames - long, frames)),
      ),
      1,
    ),
  };
}

function edgesOf(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  sampleRate: number,
): NonNullable<Audit["edges"]> {
  const floor = 10 ** (-60 / 20);
  let lastLoud = -1;
  for (let i = frames - 1; i >= 0; i--)
    if (Math.abs(left[i]) > floor || Math.abs(right[i]) > floor) {
      lastLoud = i;
      break;
    }
  return {
    firstSample: round(Math.max(Math.abs(left[0]), Math.abs(right[0])), 6),
    startDb: round(amplitudeDb(rms(left, right, 0, 0.002 * sampleRate)), 1),
    endDb: round(
      amplitudeDb(rms(left, right, frames - 0.05 * sampleRate, frames)),
      1,
    ),
    lastSample: round(
      Math.max(Math.abs(left[frames - 1]), Math.abs(right[frames - 1])),
      6,
    ),
    silentTail: round((frames - 1 - lastLoud) / sampleRate, 3),
  };
}

/** K-weighted loudness of everything a meter heard, without gating. */
function ungatedLoudness(meter: LoudnessMeter): number {
  const hops = meter.hopEnergies;
  let sum = 0;
  for (let i = 0; i < hops.length; i++) sum += hops[i];
  return hops.length ? energyToLufs(sum / hops.length) : -Infinity;
}

const BANKS = { voices: VOICES, drums: DRUMS };

function partFacts(part: Part): Audit["score"]["parts"][number] {
  if (part.kind === "drums") {
    const velocity =
      part.hits.reduce((sum, hit) => sum + hit.vel, 0) /
      Math.max(1, part.hits.length);
    return {
      id: part.id,
      role: part.role,
      track: part.track,
      voice: `${part.kit} kit`,
      events: part.hits.length,
      heldSeconds: 0,
      range: null,
      meanVelocity: round(velocity, 3),
      mix: part.mix,
    };
  }
  let low = Infinity;
  let high = -Infinity;
  let held = 0;
  let velocity = 0;
  for (const note of part.notes) {
    low = Math.min(low, note.midi);
    high = Math.max(high, note.midi);
    held += note.d;
    velocity += note.vel;
  }
  return {
    id: part.id,
    role: part.role,
    track: part.track,
    voice: part.voice,
    events: part.notes.length,
    heldSeconds: round(held, 1),
    range: part.notes.length ? [low, high] : null,
    meanVelocity: round(velocity / Math.max(1, part.notes.length), 3),
    mix: part.mix,
  };
}

export function auditId(config: MusicConfig): string {
  return `${config.mood}-${config.loop ? "loop" : "song"}-${config.duration}s-s${config.seed}`;
}

/* ------------------------------------------------------------------ */
/* the audit                                                           */
/* ------------------------------------------------------------------ */

/** Compose and render `config`, then measure the mix, the stems and (optionally) every part. */
export async function auditConfig(
  input: MusicConfig,
  options: AuditOptions = {},
): Promise<Audit> {
  const config = clampConfig(input);
  const id = auditId(config);
  const score = compose(config);
  let report: RenderReport | undefined;
  const started = performance.now();
  const audio = await renderScoreWith(score, BANKS, {
    onReport: (value) => (report = value),
    measureAmbience: true,
  });
  const seconds = (performance.now() - started) / 1000;
  const done = report as RenderReport;
  const { frames, sampleRate } = audio;
  const flags: string[] = [];

  /* ---- the mix the user hears ---- */
  const mixLeft = scratch("mixLeft", frames).subarray(0, frames);
  const mixRight = scratch("mixRight", frames).subarray(0, frames);
  mixLeft.fill(0);
  mixRight.fill(0);
  let finite = true;
  for (const track of TRACKS) {
    const [left, right] = audio.stems[track];
    const fader = REFERENCE_VOLUMES[track];
    for (let i = 0; i < frames; i++) {
      mixLeft[i] += left[i] * fader;
      mixRight[i] += right[i] * fader;
    }
  }
  let prePeak = 0;
  let pastKnee = 0;
  for (const data of [mixLeft, mixRight])
    for (let i = 0; i < frames; i++) {
      const value = data[i];
      if (value !== value || value === Infinity || value === -Infinity)
        finite = false;
      const magnitude = value < 0 ? -value : value;
      if (magnitude > prePeak) prePeak = magnitude;
      if (magnitude > KNEE) pastKnee++;
    }
  softClipBuffer(mixLeft);
  softClipBuffer(mixRight);

  const meter = new LoudnessMeter(sampleRate);
  meter.push(mixLeft, mixRight, frames);
  const lufs = meter.integrated;
  const ungated = ungatedLoudness(meter);
  const shortTerm = meter.shortTerm();
  let sumLeft = 0;
  let sumRight = 0;
  let squares = 0;
  let mid = 0;
  let side = 0;
  for (let i = 0; i < frames; i++) {
    const l = mixLeft[i];
    const r = mixRight[i];
    sumLeft += l;
    sumRight += r;
    squares += l * l + r * r;
    mid += (l + r) * (l + r);
    side += (l - r) * (l - r);
  }
  const mixRms = Math.sqrt(squares / (2 * frames));
  const peak = meter.peak;
  const mixPower = averageSpectrum(
    mixLeft,
    mixRight,
    frames,
    new Float64Array(FFT_SIZE / 2 + 1),
  );
  let mixTotal = 0;
  for (let k = 0; k < mixPower.length; k++) mixTotal += mixPower[k];
  const mixSpectrum = describeSpectrum(mixPower, sampleRate, mixTotal);
  const lowEnd = lowCorrelation(
    mixLeft,
    mixRight,
    frames,
    sampleRate,
    LOW_END_HZ,
  );
  const mix: Audit["mix"] = {
    lufs: round(lufs, 2),
    ungatedLufs: round(ungated, 2),
    targetLufs: score.master.targetLufs,
    lra: round(loudnessRange(shortTerm), 2),
    shortTermMax: round(meter.shortTermMax, 2),
    momentaryMax: round(meter.momentaryMax, 2),
    peak: round(peak, 4),
    peakDb: round(amplitudeDb(peak), 2),
    prePeak: round(prePeak, 4),
    truePeakDb: round(
      amplitudeDb(truePeak([mixLeft, mixRight], frames, peak)),
      2,
    ),
    rmsDb: round(amplitudeDb(mixRms), 2),
    crestDb: round(amplitudeDb(peak / Math.max(1e-12, mixRms)), 2),
    kneeShare: round(pastKnee / (2 * frames), 5),
    dc: [round(sumLeft / frames, 6), round(sumRight / frames, 6)],
    correlation: round(correlation(mixLeft, mixRight, frames), 3),
    correlationLow: round(lowEnd.correlation, 3),
    lowEndDb: round(db(lowEnd.power / Math.max(1e-30, mixRms * mixRms)), 1),
    clicks: clicksOf([mixLeft, mixRight], frames, sampleRate, score.loop),
    sideDb: round(db(side / Math.max(1e-30, mid)), 2),
    spectrum: mixSpectrum,
    finite,
  };

  /* ---- sections ---- */
  const hops = meter.hopEnergies;
  const sections = score.sections.map((section) => {
    const from = Math.min(hops.length, Math.round(section.start * 10));
    const to = Math.min(hops.length, Math.round(section.end * 10));
    let loudest = -Infinity;
    for (
      let i = Math.max(0, from - 29);
      i < to - 29 && i < shortTerm.length;
      i++
    )
      loudest = Math.max(loudest, shortTerm[i]);
    return {
      label: section.label,
      type: section.type,
      start: round(section.start, 3),
      end: round(section.end, 3),
      lufs: round(integratedFromHops(hops.subarray(from, to)), 2),
      shortTermMax: round(loudest, 2),
    };
  });

  /* ---- stems ---- */
  const stemPower = new Float64Array(FFT_SIZE / 2 + 1);
  const stems = {} as Record<TrackName, StemAudit>;
  for (const track of TRACKS) {
    const [left, right] = audio.stems[track];
    const fader = REFERENCE_VOLUMES[track];
    const empty = !score.parts.some(
      (part) =>
        part.track === track &&
        (part.kind === "notes" ? part.notes.length : part.hits.length) > 0,
    );
    const stemMeter = new LoudnessMeter(sampleRate);
    stemMeter.push(left, right, frames);
    const rawLufs = stemMeter.integrated;
    const stemLufs = rawLufs + 20 * Math.log10(fader);
    const stemUngated = ungatedLoudness(stemMeter) + 20 * Math.log10(fader);
    const energy = done.ambience?.[track];
    let spectrum: SpectrumAudit | null = null;
    if (stemMeter.peak > 0) {
      averageSpectrum(left, right, frames, stemPower);
      // at the reference fader, against the mix
      spectrum = describeSpectrum(
        stemPower,
        sampleRate,
        mixTotal / (fader * fader),
      );
    }
    stems[track] = {
      empty,
      lufs: round(stemLufs, 2),
      rawLufs: round(rawLufs, 2),
      momentaryMax: round(stemMeter.momentaryMax + 20 * Math.log10(fader), 2),
      peak: round(stemMeter.peak * fader, 4),
      belowMixLu: round(ungated - stemUngated, 2),
      spectrum,
      sections: score.sections.map((section) => {
        const stemHops = stemMeter.hopEnergies;
        const from = Math.min(stemHops.length, Math.round(section.start * 10));
        const to = Math.min(stemHops.length, Math.round(section.end * 10));
        let sum = 0;
        for (let i = from; i < to; i++) sum += stemHops[i];
        return to > from && sum > 0
          ? round(energyToLufs(sum / (to - from)) + 20 * Math.log10(fader), 2)
          : -Infinity;
      }),
      reverbDb: round(
        energy && energy.dry > 0 ? db(energy.reverb / energy.dry) : -Infinity,
        1,
      ),
      delayDb: round(
        energy && energy.dry > 0 ? db(energy.delay / energy.dry) : -Infinity,
        1,
      ),
      correlation: round(correlation(left, right, frames), 3),
    };
  }

  /* ---- the ends ---- */
  const seam = score.loop
    ? seamOf(mixLeft, mixRight, frames, sampleRate)
    : undefined;
  const edges = score.loop
    ? undefined
    : edgesOf(mixLeft, mixRight, frames, sampleRate);

  /* ---- flags ---- */
  if (!finite) flags.push("non-finite samples");
  if (!(Math.abs(lufs - score.master.targetLufs) <= LIMITS.lufsTolerance))
    flags.push(
      `mix at ${round(lufs, 2)} LUFS (target ${score.master.targetLufs})`,
    );
  if (peak > CEILING + 1e-6)
    flags.push(`peak ${round(peak, 4)} above the clipper ceiling`);
  if (mix.kneeShare > LIMITS.kneeShare)
    flags.push(
      `${round(mix.kneeShare * 100, 2)} % of the samples past the clipper knee`,
    );
  if (Math.max(Math.abs(mix.dc[0]), Math.abs(mix.dc[1])) > LIMITS.dc)
    flags.push(`DC offset ${mix.dc.join(" / ")}`);
  if (!(mix.correlation > 0))
    flags.push(`stereo correlation ${mix.correlation}`);
  // (a mix with next to nothing down there has no low end to keep in the middle)
  if (
    mix.lowEndDb > LIMITS.lowEndFloorDb &&
    !(mix.correlationLow >= LIMITS.lowCorrelation)
  )
    flags.push(
      `low-end correlation ${mix.correlationLow} (below ${LOW_END_HZ} Hz)`,
    );
  if (mix.clicks.count > 0)
    flags.push(
      `${mix.clicks.count} click(s): a step of ${mix.clicks.worstStep} at ${mix.clicks.at} s, ${mix.clicks.worstRatio}× its surroundings`,
    );
  for (const band of BANDS)
    if (10 ** (mixSpectrum.bands[band.id] / 10) > LIMITS.bandShare)
      flags.push(
        `${band.id} band carries ${round(10 ** (mixSpectrum.bands[band.id] / 10) * 100, 0)} % of the energy`,
      );
  for (const track of TRACKS) {
    const stem = stems[track];
    if (stem.empty) continue;
    if (!(stem.momentaryMax > LIMITS.audibleLufs))
      flags.push(
        `${track} is inaudible (its loudest 400 ms reach ${stem.momentaryMax} LUFS)`,
      );
    if (stem.belowMixLu < -LIMITS.stemOverMixLu)
      flags.push(
        `${track} alone is ${-stem.belowMixLu} LU louder than the mix it is part of`,
      );
  }
  if (seam && seam.jumpRatio > LIMITS.seamRatio)
    flags.push(
      `loop seam steps ${seam.jumpRatio}× the usual sample step (${seam.jump})`,
    );
  if (seam && seam.endDipDb < -30)
    flags.push(
      `the loop's last 30 ms are ${seam.endDipDb} dB under the last 300 ms (a rest there, or an end that was faded)`,
    );
  if (edges && edges.firstSample > LIMITS.startSample)
    flags.push(`the piece starts at sample value ${edges.firstSample}`);
  if (edges && edges.endDb > LIMITS.endDb)
    flags.push(`the piece ends at ${edges.endDb} dBFS`);
  if (done.master.shortfallLu > 0.05)
    flags.push(
      `master stayed ${round(done.master.shortfallLu, 2)} LU short of the target`,
    );

  /* ---- every part on its own, before the master ---- */
  let parts: PartAudit[] | undefined;
  if (options.soloParts) {
    const raw = await renderScoreWith(score, BANKS, { master: false });
    const rawLeft = scratch("rawLeft", frames).subarray(0, frames);
    const rawRight = scratch("rawRight", frames).subarray(0, frames);
    rawLeft.fill(0);
    rawRight.fill(0);
    for (const track of TRACKS) {
      const fader = REFERENCE_VOLUMES[track];
      const [left, right] = raw.stems[track];
      for (let i = 0; i < frames; i++) {
        rawLeft[i] += left[i] * fader;
        rawRight[i] += right[i] * fader;
      }
    }
    const rawMeter = new LoudnessMeter(sampleRate);
    rawMeter.push(rawLeft, rawRight, frames);
    const rawPower = averageSpectrum(
      rawLeft,
      rawRight,
      frames,
      new Float64Array(FFT_SIZE / 2 + 1),
    );
    let rawTotal = 0;
    for (let k = 0; k < rawPower.length; k++) rawTotal += rawPower[k];
    parts = [];
    for (const part of score.parts) {
      const solo = await renderScoreWith({ ...score, parts: [part] }, BANKS, {
        master: false,
      });
      const [left, right] = solo.stems[part.track];
      const fader = REFERENCE_VOLUMES[part.track];
      const partMeter = new LoudnessMeter(sampleRate);
      partMeter.push(left, right, frames);
      const partLufs = partMeter.integrated + 20 * Math.log10(fader);
      averageSpectrum(left, right, frames, stemPower);
      parts.push({
        id: part.id,
        role: part.role,
        track: part.track,
        voice: part.kind === "notes" ? part.voice : `${part.kit} kit`,
        rawLufs: round(partLufs, 2),
        relLu: round(partLufs - rawMeter.integrated, 2),
        peak: round(partMeter.peak * fader, 4),
        bands: describeSpectrum(
          stemPower,
          sampleRate,
          rawTotal / (fader * fader),
        ).bands,
      });
    }
  }

  options.onAudio?.({
    id,
    mix: [mixLeft, mixRight],
    stems: audio.stems,
    sampleRate,
    score,
  });

  const { prompt: _prompt, volumes: _volumes, ...shownConfig } = config;
  return {
    id,
    config: shownConfig,
    score: {
      style: score.style,
      lead: score.lead,
      bars: score.bars,
      bpm: round(score.bpm, 3),
      duration: round(score.duration, 4),
      loop: score.loop,
      key: score.key.label,
      swing: score.swing,
      sections: score.sections.map((section) => ({
        type: section.type,
        label: section.label,
        bars: section.bars,
        start: round(section.start, 3),
        end: round(section.end, 3),
        energy: section.energy,
      })),
      parts: score.parts.map(partFacts),
      space: score.space,
      master: score.master,
      notes: score.notes,
    },
    render: {
      seconds: round(seconds, 3),
      stages: done.seconds,
      notes: done.notes,
      hits: done.hits,
      bufferBytes: done.bufferBytes,
      master: done.master,
    },
    mix,
    sections,
    stems,
    ...(seam ? { seam } : {}),
    ...(edges ? { edges } : {}),
    ...(parts ? { parts } : {}),
    flags,
  };
}

/** Raw stems → the mix the user hears, in new buffers (for callers that keep it). */
export function referenceMix(audio: RenderedAudio): StereoPcm {
  const left = new Float32Array(audio.frames);
  const right = new Float32Array(audio.frames);
  for (const track of TRACKS) {
    const fader = REFERENCE_VOLUMES[track];
    const [l, r] = audio.stems[track];
    for (let i = 0; i < audio.frames; i++) {
      left[i] += l[i] * fader;
      right[i] += r[i] * fader;
    }
  }
  softClipBuffer(left);
  softClipBuffer(right);
  return [left, right];
}

/* ------------------------------------------------------------------ */
/* spectrogram PNG                                                     */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Encode 8-bit RGB pixels (row-major, 3 bytes per pixel) as a PNG file. */
export function encodePng(
  width: number,
  height: number,
  rgb: Uint8Array,
): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(
      rgb.subarray(y * width * 3, (y + 1) * width * 3),
      y * (width * 3 + 1) + 1,
    );
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 6 }))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// black → violet → red → orange → pale yellow
const COLOUR_STOPS = [
  [0, 0, 4],
  [31, 12, 72],
  [85, 15, 109],
  [136, 34, 106],
  [186, 54, 85],
  [227, 89, 51],
  [249, 140, 10],
  [249, 201, 50],
  [252, 255, 164],
];
const PALETTE = (() => {
  const palette = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const position = (i / 255) * (COLOUR_STOPS.length - 1);
    const index = Math.min(COLOUR_STOPS.length - 2, Math.floor(position));
    const t = position - index;
    for (let c = 0; c < 3; c++)
      palette[i * 3 + c] = Math.round(
        COLOUR_STOPS[index][c] * (1 - t) + COLOUR_STOPS[index + 1][c] * t,
      );
  }
  return palette;
})();

// 3×5 glyphs, one bit per pixel, rows from the top
const GLYPHS: Record<string, number[]> = {
  "0": [7, 5, 5, 5, 7],
  "1": [2, 6, 2, 2, 7],
  "2": [7, 1, 7, 4, 7],
  "3": [7, 1, 7, 1, 7],
  "4": [5, 5, 7, 1, 1],
  "5": [7, 4, 7, 1, 7],
  "6": [7, 4, 7, 5, 7],
  "7": [7, 1, 2, 2, 2],
  "8": [7, 5, 7, 5, 7],
  "9": [7, 5, 7, 1, 7],
  k: [4, 5, 6, 5, 5],
  s: [0, 7, 6, 3, 7],
  ".": [0, 0, 0, 0, 2],
  "-": [0, 0, 7, 0, 0],
  " ": [0, 0, 0, 0, 0],
};

const SPECTROGRAM = {
  left: 44,
  bottom: 16,
  top: 4,
  right: 4,
  height: 480,
  lowHz: 20,
  floorDb: -100,
};

/**
 * Log-frequency spectrogram (20 Hz – Nyquist, 100 dB range) of a stereo
 * signal as RGB pixels: frequency lines at 50/100/200/500/1k/2k/5k/10k/20k,
 * a tick every 10 s, dotted lines at `marks` (section starts, seconds).
 */
export function spectrogram(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  marks: readonly number[] = [],
): { width: number; height: number; rgb: Uint8Array } {
  const frames = left.length;
  const duration = frames / sampleRate;
  const plotWidth = Math.max(480, Math.min(1800, Math.round(duration * 15)));
  const plotHeight = SPECTROGRAM.height;
  const width = SPECTROGRAM.left + plotWidth + SPECTROGRAM.right;
  const height = SPECTROGRAM.top + plotHeight + SPECTROGRAM.bottom;
  const rgb = new Uint8Array(width * height * 3).fill(18);
  const nyquist = sampleRate / 2;
  const binHz = sampleRate / FFT_SIZE;
  const ratio = nyquist / SPECTROGRAM.lowHz;
  const rowHz = (row: number) =>
    SPECTROGRAM.lowHz * ratio ** (1 - row / plotHeight);
  // bins each row looks at (a row narrower than a bin interpolates between two)
  const rowFrom = new Float64Array(plotHeight);
  const rowTo = new Float64Array(plotHeight);
  for (let row = 0; row < plotHeight; row++) {
    rowFrom[row] = rowHz(row + 1) / binHz;
    rowTo[row] = rowHz(row) / binHz;
  }
  const power = new Float64Array(FFT_SIZE / 2 + 1);
  // a full-scale sine reads 0 dB
  const norm = 4 / fftWindow.reduce((sum, value) => sum + value, 0) ** 2;
  for (let column = 0; column < plotWidth; column++) {
    const centre = Math.round(((column + 0.5) / plotWidth) * frames);
    const start = centre - FFT_SIZE / 2;
    power.fill(0);
    addStereoPower(left, right, frames, start, power, 0.5 * norm);
    for (let row = 0; row < plotHeight; row++) {
      let value: number;
      const from = rowFrom[row];
      const to = rowTo[row];
      if (Math.floor(to) > Math.ceil(from)) {
        value = 0;
        for (
          let k = Math.ceil(from);
          k <= Math.min(FFT_SIZE / 2, Math.floor(to));
          k++
        )
          if (power[k] > value) value = power[k];
      } else {
        const position = Math.min(FFT_SIZE / 2 - 1, (from + to) / 2);
        const k = Math.floor(position);
        value = power[k] + (power[k + 1] - power[k]) * (position - k);
      }
      const level = value > 0 ? 10 * Math.log10(value) : -Infinity;
      const shade = Math.max(
        0,
        Math.min(
          255,
          Math.round(
            ((level - SPECTROGRAM.floorDb) / -SPECTROGRAM.floorDb) * 255,
          ),
        ),
      );
      const pixel =
        ((SPECTROGRAM.top + row) * width + SPECTROGRAM.left + column) * 3;
      rgb[pixel] = PALETTE[shade * 3];
      rgb[pixel + 1] = PALETTE[shade * 3 + 1];
      rgb[pixel + 2] = PALETTE[shade * 3 + 2];
    }
  }
  const put = (x: number, y: number, value: number, blend = 1) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const pixel = (y * width + x) * 3;
    for (let c = 0; c < 3; c++)
      rgb[pixel + c] = Math.round(rgb[pixel + c] * (1 - blend) + value * blend);
  };
  const text = (label: string, x: number, y: number) => {
    let at = x;
    for (const character of label) {
      const glyph = GLYPHS[character] ?? GLYPHS[" "];
      for (let row = 0; row < 5; row++)
        for (let column = 0; column < 3; column++)
          if (glyph[row] & (4 >> column))
            for (let dy = 0; dy < 2; dy++)
              for (let dx = 0; dx < 2; dx++)
                put(at + column * 2 + dx, y + row * 2 + dy, 210);
      at += 8;
    }
  };
  const rowOf = (hz: number) =>
    Math.round(
      plotHeight * (1 - Math.log(hz / SPECTROGRAM.lowHz) / Math.log(ratio)),
    );
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (hz >= nyquist) continue;
    const y = SPECTROGRAM.top + rowOf(hz);
    for (let x = SPECTROGRAM.left; x < SPECTROGRAM.left + plotWidth; x += 4)
      put(x, y, 255, 0.28);
    const label = hz >= 1000 ? `${hz / 1000}k` : String(hz);
    text(label, SPECTROGRAM.left - 4 - label.length * 8, y - 5);
  }
  const columnOf = (seconds: number) =>
    SPECTROGRAM.left + Math.round((seconds / duration) * plotWidth);
  const step = duration > 60 ? 10 : 5;
  for (let seconds = 0; seconds < duration; seconds += step) {
    const x = columnOf(seconds);
    for (
      let y = SPECTROGRAM.top + plotHeight;
      y < SPECTROGRAM.top + plotHeight + 3;
      y++
    )
      put(x, y, 210);
    text(`${seconds}s`, x + 2, SPECTROGRAM.top + plotHeight + 4);
  }
  for (const seconds of marks) {
    if (!(seconds > 0 && seconds < duration)) continue;
    const x = columnOf(seconds);
    for (let y = SPECTROGRAM.top; y < SPECTROGRAM.top + plotHeight; y += 3)
      put(x, y, 255, 0.5);
  }
  return { width, height, rgb };
}

/* ------------------------------------------------------------------ */
/* command line                                                        */
/* ------------------------------------------------------------------ */

const USAGE = `npx tsx scripts/audio-audit.ts --style <id[,id…]|all> [options]

  --style <ids|all>      styles to render (default: all ${STYLE_IDS.length})
  --loop | --no-loop     a loop or a piece that ends (default: loop); --both renders each style twice
  --duration <s>         15..120 (default 30)
  --seed <n[,n…]>        default 1234; several seeds render several pieces
  --energy <0..1>  --complexity <0..1>  --reverb <0..1>
  --instrument <id>  --bpm <n>  --key "<name>"     override the style's preset
  --arrangement '<json>' ArrangementHints, as a language model would send them
  --json <file>          everything measured, as JSON
  --wav <dir>            <id>-mix.wav (softClip(Σ stem × default fader)) and the four raw stems
  --png <dir>            <id>-spectrogram.png of the mix (log frequency 20 Hz–24 kHz, 100 dB); --png-stems adds the stems
  --solo-parts           render every part alone before the master and compare it with the raw mix (slow)
  --quiet                files and the summary line only

columns: LUFS (integrated), LRA, peak dBFS after the soft clipper, crest dB, % of samples past the clipper knee,
L/R correlation (whole mix, below 80 Hz), spectral slope of the octave bands in dB/octave (pink 0, white +3; an FFT
analyser's "-4.5 dB/octave" reads -1.5 here), six bands in dB relative
to the mix (sub <60, bass 60–250, low-mid 250–500, mid 500–2k, presence 2k–6k, air >6k), the four stems in LUFS at
their default faders, reverb wet/dry in dB per track, and the loop seam (step ÷ usual step) or the start/end level.
Lines starting with "!" are measurements outside the bounds tests/audio-quality.test.ts enforces.`;

interface Arguments {
  styles: StyleId[];
  modes: boolean[];
  seeds: number[];
  overrides: Partial<MusicConfig>;
  json?: string;
  wav?: string;
  png?: string;
  pngStems: boolean;
  soloParts: boolean;
  quiet: boolean;
}

function parseArguments(argv: string[]): Arguments {
  const result: Arguments = {
    styles: [...STYLE_IDS],
    modes: [true],
    seeds: [1234],
    overrides: { duration: 30 },
    pngStems: false,
    soloParts: false,
    quiet: false,
  };
  const fail = (message: string): never => {
    console.error(
      `audio-audit: ${message}\n(see the comment at the top of scripts/audio-audit.ts for the options)`,
    );
    process.exit(2);
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => argv[++i] ?? fail(`${flag} needs a value`);
    const number = () => {
      const parsed = Number(value());
      return Number.isFinite(parsed) ? parsed : fail(`${flag} needs a number`);
    };
    switch (flag) {
      case "--style": {
        const text = value();
        if (text !== "all") {
          const ids = text.split(",").map((item) => item.trim());
          for (const item of ids)
            if (!isStyleId(item))
              fail(`unknown style "${item}" (${STYLE_IDS.join(", ")})`);
          result.styles = ids as StyleId[];
        }
        break;
      }
      case "--loop":
        result.modes = [true];
        break;
      case "--no-loop":
        result.modes = [false];
        break;
      case "--both":
        result.modes = [true, false];
        break;
      case "--duration":
        result.overrides.duration = number();
        break;
      case "--seed":
        result.seeds = value()
          .split(",")
          .map((item) => Number(item) >>> 0);
        break;
      case "--energy":
        result.overrides.energy = number();
        break;
      case "--complexity":
        result.overrides.complexity = number();
        break;
      case "--reverb":
        result.overrides.reverb = number();
        break;
      case "--bpm":
        result.overrides.bpm = number();
        break;
      case "--instrument": {
        const text = value();
        if (!isInstrumentId(text)) fail(`unknown instrument "${text}"`);
        else result.overrides.instrument = text;
        break;
      }
      case "--key": {
        const text = value();
        if (!isKey(text))
          fail(`unknown key "${text}" (for example "C major", "F# minor")`);
        result.overrides.key = text;
        break;
      }
      case "--arrangement":
        try {
          result.overrides.arrangement = JSON.parse(value());
        } catch {
          fail("--arrangement needs JSON");
        }
        break;
      case "--json":
        result.json = value();
        break;
      case "--wav":
        result.wav = value();
        break;
      case "--png":
        result.png = value();
        break;
      case "--png-stems":
        result.pngStems = true;
        break;
      case "--solo-parts":
        result.soloParts = true;
        break;
      case "--quiet":
        result.quiet = true;
        break;
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail(`unknown option ${flag}`);
    }
  }
  return result;
}

const cell = (value: number, width: number, digits = 1) =>
  (Number.isFinite(value)
    ? value.toFixed(digits)
    : value > 0
      ? "inf"
      : "-inf"
  ).padStart(width);

const HEADER =
  "style      mode bars   bpm    dur pt  render |   LUFS  LRA peakdB crest knee%  corr   <80 slope |  sub bass lmid  mid pres  air | LUFS mel   chd   bas   drm | reverb dB mel chd bas drm | ends";

export function formatRow(audit: Audit): string {
  const bands = audit.mix.spectrum.bands;
  const stem = (track: TrackName) =>
    audit.stems[track].empty ? "    –" : cell(audit.stems[track].lufs, 5);
  const wet = (track: TrackName) =>
    audit.stems[track].empty ? "  –" : cell(audit.stems[track].reverbDb, 3, 0);
  const ends = audit.seam
    ? `seam ×${audit.seam.jumpRatio} (${audit.seam.jump})`
    : audit.edges
      ? `start ${audit.edges.firstSample} end ${cell(audit.edges.endDb, 0, 0)} dB`
      : "";
  return [
    audit.score.style.padEnd(10),
    audit.score.loop ? "loop" : "song",
    String(audit.score.bars).padStart(4),
    cell(audit.score.bpm, 5),
    cell(audit.score.duration, 6),
    String(audit.score.parts.length).padStart(2),
    `${cell(audit.render.seconds, 6, 2)}s`,
    "|",
    cell(audit.mix.lufs, 6, 2),
    cell(audit.mix.lra, 4),
    cell(audit.mix.peakDb, 6),
    cell(audit.mix.crestDb, 5),
    cell(audit.mix.kneeShare * 100, 5, 2),
    cell(audit.mix.correlation, 5, 2),
    cell(audit.mix.correlationLow, 5, 2),
    cell(audit.mix.spectrum.slopeDbPerOctave, 5),
    "|",
    cell(bands.sub, 4, 0),
    cell(bands.bass, 4, 0),
    cell(bands.lowMid, 4, 0),
    cell(bands.mid, 4, 0),
    cell(bands.presence, 4, 0),
    cell(bands.air, 4, 0),
    "|",
    stem("melody"),
    stem("chords"),
    stem("bass"),
    stem("drums"),
    "|",
    "         ",
    wet("melody"),
    wet("chords"),
    wet("bass"),
    wet("drums"),
    "|",
    ends,
  ].join(" ");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  for (const directory of [args.wav, args.png])
    if (directory) mkdirSync(resolve(directory), { recursive: true });
  const audits: Audit[] = [];
  if (!args.quiet) console.log(HEADER);
  const started = performance.now();
  for (const style of args.styles)
    for (const loop of args.modes)
      for (const seed of args.seeds) {
        const config: MusicConfig = {
          ...DEFAULT_CONFIG,
          ...stylePreset(style),
          ...args.overrides,
          loop,
          seed,
        };
        const audit = await auditConfig(config, {
          soloParts: args.soloParts,
          onAudio: ({ id, mix, stems, sampleRate, score }) => {
            if (args.wav) {
              writeFileSync(
                join(resolve(args.wav), `${id}-mix.wav`),
                new Uint8Array(encodeWavFromChannels(mix, sampleRate)),
              );
              for (const track of TRACKS)
                writeFileSync(
                  join(resolve(args.wav), `${id}-${track}.wav`),
                  new Uint8Array(
                    encodeWavFromChannels(stems[track], sampleRate),
                  ),
                );
            }
            if (args.png) {
              const marks = score.sections.map((section) => section.start);
              const image = spectrogram(mix[0], mix[1], sampleRate, marks);
              writeFileSync(
                join(resolve(args.png), `${id}-spectrogram.png`),
                encodePng(image.width, image.height, image.rgb),
              );
              if (args.pngStems)
                for (const track of TRACKS) {
                  const picture = spectrogram(
                    stems[track][0],
                    stems[track][1],
                    sampleRate,
                    marks,
                  );
                  writeFileSync(
                    join(resolve(args.png), `${id}-${track}-spectrogram.png`),
                    encodePng(picture.width, picture.height, picture.rgb),
                  );
                }
            }
          },
        });
        audits.push(audit);
        if (!args.quiet) {
          console.log(formatRow(audit));
          for (const flag of audit.flags) console.log(`           ! ${flag}`);
          if (audit.parts)
            for (const part of audit.parts)
              console.log(
                `           · ${part.id.padEnd(8)} ${part.voice.padEnd(14)} ${part.track.padEnd(7)} ${cell(part.relLu, 6)} LU vs raw mix, peak ${part.peak.toFixed(3)}`,
              );
        }
      }
  if (args.json) {
    mkdirSync(resolve(args.json, ".."), { recursive: true });
    const text = JSON.stringify(
      {
        tool: "audio-audit",
        referenceVolumes: REFERENCE_VOLUMES,
        limits: LIMITS,
        bands: BANDS.map((band) => ({
          ...band,
          high: Number.isFinite(band.high) ? band.high : null,
        })),
        audits,
      },
      (_key, value) =>
        value === -Infinity ? "-inf" : value === Infinity ? "inf" : value,
      1,
    );
    writeFileSync(resolve(args.json), text);
  }
  const flagged = audits.filter((audit) => audit.flags.length).length;
  const loudness = audits
    .map((audit) => audit.mix.lufs)
    .filter(Number.isFinite);
  console.log(
    `${audits.length} render(s) in ${((performance.now() - started) / 1000).toFixed(1)} s — LUFS ${Math.min(...loudness).toFixed(2)} … ${Math.max(...loudness).toFixed(2)}, ${flagged} flagged${args.json ? `, JSON → ${args.json}` : ""}${args.wav ? `, WAV → ${args.wav}` : ""}${args.png ? `, PNG → ${args.png}` : ""}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
