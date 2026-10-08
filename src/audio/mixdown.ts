/**
 * The export mixdown on plain sample arrays: sum the stems at their faders,
 * finish the way the engine does, optionally fade, encode 16-bit WAV.
 *
 * No DOM types in here, so the UI thread (mixStems in engine.ts, the exporter)
 * and the render worker run the very same arithmetic: an export is the same
 * bytes wherever it is made.
 */
import type { MixdownJob } from "./render-types";
import { softClipBuffer } from "./softclip";
import { encodeWavFromChannels } from "./wav";

/** destination += source × gain, sample by sample in 32-bit floats. */
export function addScaled(
  destination: Float32Array,
  source: Float32Array,
  gain: number,
): void {
  for (let i = 0; i < destination.length; i++)
    destination[i] += source[i] * gain;
}

/**
 * What follows the sum. Engine 2 ends with the soft clipper the player uses;
 * engine 1 keeps the v0.2 behaviour: the plain sum, scaled down only if it
 * would clip.
 */
export function finishMix(
  channels: Float32Array[],
  finish: "softclip" | "legacy",
): void {
  if (finish === "softclip") {
    for (const data of channels) softClipBuffer(data);
    return;
  }
  let peak = 0;
  for (const data of channels)
    for (let i = 0; i < data.length; i++)
      peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0.96) {
    const scale = 0.96 / peak;
    for (const data of channels)
      for (let i = 0; i < data.length; i++) data[i] *= scale;
  }
}

/** The v0.2 fade: up to 1 s in and out, never more than a third of the audio. */
export function fadeChannels(
  channels: Float32Array[],
  frames: number,
  sampleRate: number,
): void {
  const ramp = Math.floor(Math.min(sampleRate, frames / 3));
  if (ramp < 1) return;
  for (const data of channels)
    for (let i = 0; i < ramp; i++) {
      const gain = i / ramp;
      data[i] *= gain;
      data[frames - 1 - i] *= gain;
    }
}

/**
 * One export, start to finish. The job's channels may be changed in place
 * (they are copies made for this job).
 */
export function mixdownToWav(job: MixdownJob): ArrayBuffer {
  let channels: Float32Array[];
  if (job.finish === "none") {
    // a decoded file: its own channels, untouched
    channels = job.sources[0]?.channels ?? [];
  } else {
    channels = [new Float32Array(job.frames), new Float32Array(job.frames)];
    for (let channel = 0; channel < 2; channel++)
      for (const source of job.sources) {
        if (!source.gain) continue;
        addScaled(
          channels[channel],
          // a mono stem feeds both sides
          source.channels[Math.min(channel, source.channels.length - 1)],
          source.gain,
        );
      }
    finishMix(channels, job.finish);
  }
  if (job.fade) fadeChannels(channels, job.frames, job.sampleRate);
  return encodeWavFromChannels(channels, job.sampleRate);
}
