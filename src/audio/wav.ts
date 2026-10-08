/**
 * 16-bit PCM WAV encoder. Works on anything shaped like an AudioBuffer, so it
 * runs unchanged in the renderer, a Worker and Node.
 *
 * Quantisation uses TPDF dither (triangular, ±1 LSB) from a fixed-seed
 * generator: an export is byte-for-byte reproducible, and the rounding error
 * is noise instead of distortion that follows the music. Samples that are
 * exactly zero stay zero, so silence and muted stems remain digital silence.
 */

/** The part of AudioBuffer the encoder needs. */
export interface WavSource {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

export interface WavOptions {
  /** TPDF dither, on by default */
  dither?: boolean;
}

export const WAV_HEADER_BYTES = 44;
const DITHER_SEED = 0x6d757365; // "muse"
const SCALE = 32768;

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function writeHeader(
  view: DataView,
  sampleRate: number,
  channelCount: number,
  dataBytes: number,
): void {
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++)
      view.setUint8(offset + i, text.charCodeAt(i));
  };
  const blockAlign = channelCount * 2;
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
}

/**
 * Interleave `channels` into a RIFF/WAVE file: 44-byte header followed by
 * little-endian signed 16-bit PCM at `sampleRate`. Input beyond ±1 is clamped.
 * The length is that of the first channel; shorter channels are padded with
 * silence.
 */
export function encodeWavFromChannels(
  channels: Float32Array[],
  sampleRate: number,
  options: WavOptions = {},
): ArrayBuffer {
  const channelCount = channels.length;
  if (channelCount < 1 || channelCount > 65535)
    throw new RangeError("encodeWav: need between 1 and 65535 channels");
  const rate = Math.round(sampleRate);
  if (!(rate > 0)) throw new RangeError("encodeWav: invalid sample rate");
  const frames = channels[0].length;
  const dataBytes = frames * channelCount * 2;
  if (WAV_HEADER_BYTES + dataBytes > 0xffffffff)
    throw new RangeError("encodeWav: audio is too long for a WAV file");
  const result = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(result);
  writeHeader(view, rate, channelCount, dataBytes);

  const dither = options.dither !== false;
  // xorshift32; two draws per sample make the triangular distribution
  let state = DITHER_SEED;
  const unit = 1 / 4294967296;
  const pcm = LITTLE_ENDIAN
    ? new Int16Array(result, WAV_HEADER_BYTES, frames * channelCount)
    : null;
  for (let channel = 0; channel < channelCount; channel++) {
    const data = channels[channel];
    const available = Math.min(frames, data.length);
    let out = channel;
    for (let i = 0; i < frames; i++, out += channelCount) {
      const sample = i < available ? data[i] : 0;
      let value = 0;
      if (sample !== 0) {
        let scaled = sample * SCALE;
        if (dither) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          const first = (state >>> 0) * unit;
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          scaled += first + (state >>> 0) * unit - 1;
        }
        value = Math.round(scaled);
        if (value > 32767) value = 32767;
        else if (value < -32768) value = -32768;
        else if (value !== value) value = 0;
      }
      if (pcm) pcm[out] = value;
      else view.setInt16(WAV_HEADER_BYTES + out * 2, value, true);
    }
  }
  return result;
}

/** Encode an AudioBuffer (or any WavSource) at its own sample rate and channel count. */
export function encodeWav(
  buffer: WavSource,
  options: WavOptions = {},
): ArrayBuffer {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    channels.push(
      data.length === buffer.length ? data : data.subarray(0, buffer.length),
    );
  }
  return encodeWavFromChannels(channels, buffer.sampleRate, options);
}
