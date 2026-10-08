/**
 * Engine facade — the only audio entry point the UI uses.
 *   config.engine === 1 → frozen v0.2 synthesizer (old works sound the same)
 *   config.engine === 2 → compose() a Score, then renderScore() it
 */
import type { MusicConfig, RenderResult, TrackName } from "../types";
import { TRACKS } from "../music/score";
import { compose, summarize } from "../music/compose";
import { renderScore } from "./render";
import type { RenderedAudio } from "./render-types";
import { renderMusic as renderLegacy } from "./engine-v1";
import { softClipBuffer } from "./softclip";

export { encodeWav } from "./wav";
export { REFERENCE_VOLUMES } from "./render-types";

export interface RenderOptions {
  /** 0..1 */
  onProgress?: (fraction: number) => void;
  /** abort to cancel; renderMusic then rejects with an AbortError */
  signal?: AbortSignal;
}

const PEAK_BINS = 140;

function abortError(): DOMException {
  return new DOMException("已取消生成", "AbortError");
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function toAudioBuffer(
  pcm: [Float32Array, Float32Array],
  sampleRate: number,
): AudioBuffer {
  const buffer = new AudioBuffer({
    length: pcm[0].length,
    numberOfChannels: 2,
    sampleRate,
  });
  buffer.getChannelData(0).set(pcm[0]);
  buffer.getChannelData(1).set(pcm[1]);
  return buffer;
}

/** Normalised 0..1 waveform outline of one or more stereo buffers summed with gains. */
export function computePeaks(
  buffers: { buffer: AudioBuffer; gain: number }[],
  bins = PEAK_BINS,
): number[] {
  const count = Math.max(1, Math.floor(bins));
  const result = new Array<number>(count).fill(0);
  const length = buffers[0]?.buffer.length ?? 0;
  if (!length) return result;
  const channels = buffers
    .filter((entry) => entry.gain > 0)
    .map((entry) => ({
      left: entry.buffer.getChannelData(0),
      right: entry.buffer.getChannelData(
        Math.min(1, entry.buffer.numberOfChannels - 1),
      ),
      gain: entry.gain,
    }));
  for (let bin = 0; bin < count; bin++) {
    const start = Math.floor((bin * length) / count);
    const end = Math.floor(((bin + 1) * length) / count);
    const step = Math.max(1, Math.floor((end - start) / 160));
    let peak = 0;
    for (let i = start; i < end; i += step) {
      let left = 0;
      let right = 0;
      for (const channel of channels) {
        left += channel.left[i] * channel.gain;
        right += channel.right[i] * channel.gain;
      }
      peak = Math.max(peak, Math.abs(left), Math.abs(right));
    }
    result[bin] = peak;
  }
  return result;
}

function normalise(peaks: number[], reference?: number): number[] {
  const max = Math.max(reference ?? 0, ...peaks, 0.001);
  return peaks.map((value) => value / max);
}

function describe(
  stems: Record<TrackName, AudioBuffer>,
  volumes: Record<TrackName, number>,
) {
  const mix = computePeaks(
    TRACKS.map((track) => ({
      buffer: stems[track],
      gain: clamp01(volumes[track]),
    })),
  );
  const raw = Object.fromEntries(
    TRACKS.map((track) => [
      track,
      computePeaks([{ buffer: stems[track], gain: 1 }], 48),
    ]),
  ) as Record<TrackName, number[]>;
  const loudest = Math.max(...TRACKS.flatMap((track) => raw[track]), 0.001);
  const stemPeaks = Object.fromEntries(
    TRACKS.map((track) => [track, normalise(raw[track], loudest)]),
  ) as Record<TrackName, number[]>;
  return { peaks: normalise(mix), stemPeaks };
}

function fromRendered(
  audio: RenderedAudio,
  config: MusicConfig,
): Pick<RenderResult, "stems" | "peaks" | "stemPeaks" | "duration" | "sampleRate"> {
  const stems = Object.fromEntries(
    TRACKS.map((track) => [
      track,
      toAudioBuffer(audio.stems[track], audio.sampleRate),
    ]),
  ) as Record<TrackName, AudioBuffer>;
  return {
    stems,
    ...describe(stems, config.volumes),
    duration: audio.frames / audio.sampleRate,
    sampleRate: audio.sampleRate,
  };
}

/** Offline, deterministic composition + synthesis. No network, no audio permission. */
export async function renderMusic(
  config: MusicConfig,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const { onProgress, signal } = options;
  if (signal?.aborted) throw abortError();
  if (config.engine === 1) {
    const legacy = await renderLegacy(config, (fraction) => {
      if (signal?.aborted) throw abortError();
      onProgress?.(fraction);
    });
    return {
      stems: legacy.stems,
      ...describe(legacy.stems, config.volumes),
      duration: legacy.buffer.duration,
      sampleRate: legacy.buffer.sampleRate,
    };
  }
  const score = compose(config);
  onProgress?.(0.02);
  const audio = await renderScore(score, {
    onProgress: (fraction) => onProgress?.(0.02 + fraction * 0.97),
    checkpoint: () =>
      new Promise<void>((resolve, reject) =>
        setTimeout(() => (signal?.aborted ? reject(abortError()) : resolve()), 0),
      ),
  });
  if (signal?.aborted) throw abortError();
  onProgress?.(1);
  return { ...fromRendered(audio, config), arrangement: summarize(score) };
}

/**
 * Offline mixdown for export. `only` renders a single stem at its fader level.
 * Engine 2 ends with the same soft clipper the player uses; engine 1 keeps the
 * v0.2 behaviour (plain sum, scaled down only if it would clip).
 */
export function mixStems(
  stems: Record<TrackName, AudioBuffer>,
  volumes: Record<TrackName, number>,
  engine: 1 | 2,
  only?: TrackName | null,
): AudioBuffer {
  const first = stems.melody;
  const result = new AudioBuffer({
    length: first.length,
    numberOfChannels: 2,
    sampleRate: first.sampleRate,
  });
  let peak = 0;
  for (let channel = 0; channel < 2; channel++) {
    const destination = result.getChannelData(channel);
    for (const track of TRACKS) {
      if (only && track !== only) continue;
      const gain = clamp01(volumes[track]);
      if (!gain) continue;
      const source = stems[track].getChannelData(
        Math.min(channel, stems[track].numberOfChannels - 1),
      );
      for (let i = 0; i < destination.length; i++)
        destination[i] += source[i] * gain;
    }
    if (engine === 2) softClipBuffer(destination);
    else
      for (let i = 0; i < destination.length; i++)
        peak = Math.max(peak, Math.abs(destination[i]));
  }
  if (engine === 1 && peak > 0.96) {
    const scale = 0.96 / peak;
    for (let channel = 0; channel < 2; channel++) {
      const data = result.getChannelData(channel);
      for (let i = 0; i < data.length; i++) data[i] *= scale;
    }
  }
  return result;
}
