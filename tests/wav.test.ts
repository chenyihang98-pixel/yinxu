import test from "node:test";
import assert from "node:assert/strict";
import {
  WAV_HEADER_BYTES,
  encodeWav,
  encodeWavFromChannels,
} from "../src/audio/wav";
import type { WavSource } from "../src/audio/wav";

/** The four members of AudioBuffer the encoder may touch — nothing else exists here. */
function fakeBuffer(channels: Float32Array[], sampleRate: number): WavSource {
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length: channels[0].length,
    getChannelData: (channel: number) => channels[channel],
  };
}

function ascii(buffer: ArrayBuffer, offset: number, length: number): string {
  return String.fromCharCode(...new Uint8Array(buffer, offset, length));
}

function samples(buffer: ArrayBuffer, channelCount: number): Int16Array[] {
  const view = new DataView(buffer);
  const frames = (buffer.byteLength - WAV_HEADER_BYTES) / (2 * channelCount);
  const result = Array.from(
    { length: channelCount },
    () => new Int16Array(frames),
  );
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channelCount; c++)
      result[c][i] = view.getInt16(
        WAV_HEADER_BYTES + (i * channelCount + c) * 2,
        true,
      );
  return result;
}

function testSignal(frames: number, seed: number): Float32Array {
  const data = new Float32Array(frames);
  let state = seed;
  for (let i = 0; i < frames; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    data[i] = 0.6 * Math.sin(i * 0.0371 + seed) + 0.3 * (state / 2147483648);
  }
  return data;
}

test("header describes 16-bit PCM at the buffer's own rate and channel count", () => {
  for (const [sampleRate, channelCount, frames] of [
    [48000, 2, 1000],
    [44100, 2, 777],
    [32000, 1, 5],
    [96000, 4, 12],
  ]) {
    const channels = Array.from({ length: channelCount }, (_, c) =>
      testSignal(frames, c + 1),
    );
    const wav = encodeWav(fakeBuffer(channels, sampleRate));
    const view = new DataView(wav);
    const dataBytes = frames * channelCount * 2;
    assert.equal(wav.byteLength, 44 + dataBytes);
    assert.equal(ascii(wav, 0, 4), "RIFF");
    assert.equal(view.getUint32(4, true), wav.byteLength - 8);
    assert.equal(ascii(wav, 8, 4), "WAVE");
    assert.equal(ascii(wav, 12, 4), "fmt ");
    assert.equal(view.getUint32(16, true), 16);
    assert.equal(view.getUint16(20, true), 1, "PCM format tag");
    assert.equal(view.getUint16(22, true), channelCount);
    assert.equal(view.getUint32(24, true), sampleRate);
    assert.equal(view.getUint32(28, true), sampleRate * channelCount * 2);
    assert.equal(view.getUint16(32, true), channelCount * 2, "block align");
    assert.equal(view.getUint16(34, true), 16, "bits per sample");
    assert.equal(ascii(wav, 36, 4), "data");
    assert.equal(view.getUint32(40, true), dataBytes);
  }
});

test("samples are interleaved little-endian and clamped", () => {
  const left = Float32Array.of(-1, 0, 0.5, 1, 2, -2, 0.25);
  const right = Float32Array.of(0.5, -0.5, 0, -1, -3, 3, -0.25);
  const wav = encodeWavFromChannels([left, right], 48000, { dither: false });
  const [l, r] = samples(wav, 2);
  assert.deepEqual(
    Array.from(l),
    [-32768, 0, 16384, 32767, 32767, -32768, 8192],
  );
  assert.deepEqual(
    Array.from(r),
    [16384, -16384, 0, -32768, -32768, 32767, -8192],
  );
  // byte order: the first sample is -32768 = 0x8000 → bytes 00 80
  assert.deepEqual(
    Array.from(new Uint8Array(wav, 44, 4)),
    [0x00, 0x80, 0x00, 0x40],
  );
});

test("round trip is within half an LSB without dither and 1.5 LSB with TPDF dither", () => {
  const frames = 48000;
  const channels = [testSignal(frames, 3), testSignal(frames, 9)];
  const plain = samples(
    encodeWavFromChannels(channels, 48000, { dither: false }),
    2,
  );
  const dithered = samples(encodeWavFromChannels(channels, 48000), 2);
  let worstPlain = 0;
  let worstDithered = 0;
  let sum = 0;
  let sumSquares = 0;
  let differs = 0;
  for (let c = 0; c < 2; c++)
    for (let i = 0; i < frames; i++) {
      const exact = channels[c][i] * 32768;
      worstPlain = Math.max(worstPlain, Math.abs(plain[c][i] - exact));
      const error = dithered[c][i] - exact;
      worstDithered = Math.max(worstDithered, Math.abs(error));
      sum += error;
      sumSquares += error * error;
      if (plain[c][i] !== dithered[c][i]) differs++;
    }
  assert.ok(worstPlain <= 0.5 + 1e-6, `plain error ${worstPlain} LSB`);
  assert.ok(worstDithered <= 1.5 + 1e-6, `dithered error ${worstDithered} LSB`);
  assert.ok(differs > frames * 0.2, "dither must actually change samples");
  const count = frames * 2;
  const mean = sum / count;
  const rms = Math.sqrt(sumSquares / count);
  // TPDF (variance 1/6) plus rounding (variance 1/12): total RMS 0.5 LSB, zero mean
  assert.ok(Math.abs(mean) < 0.02, `dither mean ${mean}`);
  assert.ok(Math.abs(rms - 0.5) < 0.03, `dither + rounding rms ${rms}`);
});

test("dither makes the quantisation error independent of the signal", () => {
  // a sine of 0.4 LSB vanishes when rounded, but survives in the dithered
  // stream: correlating with it recovers its amplitude
  const frames = 96000;
  const tone = new Float32Array(frames);
  for (let i = 0; i < frames; i++)
    tone[i] = (0.4 / 32768) * Math.sin((2 * Math.PI * 441 * i) / 48000);
  const plain = samples(
    encodeWavFromChannels([tone], 48000, { dither: false }),
    1,
  )[0];
  const dithered = samples(encodeWavFromChannels([tone], 48000), 1)[0];
  assert.ok(
    plain.every((value) => value === 0),
    "undithered: the tone is lost",
  );
  let projection = 0;
  for (let i = 0; i < frames; i++)
    projection += dithered[i] * Math.sin((2 * Math.PI * 441 * i) / 48000);
  const amplitude = (2 * projection) / frames;
  assert.ok(Math.abs(amplitude - 0.4) < 0.05, `recovered ${amplitude} LSB`);
});

test("exports are reproducible and digital silence stays silent", () => {
  const channels = [testSignal(5000, 5), testSignal(5000, 6)];
  const first = new Uint8Array(encodeWavFromChannels(channels, 48000));
  const second = new Uint8Array(encodeWavFromChannels(channels, 48000));
  assert.deepEqual(
    first,
    second,
    "fixed-seed dither: identical bytes every time",
  );

  const silent = [new Float32Array(2000), new Float32Array(2000)];
  const [l, r] = samples(encodeWavFromChannels(silent, 48000), 2);
  assert.ok(l.every((value) => value === 0) && r.every((value) => value === 0));

  // silence around a sound stays exact silence, the sound itself is dithered
  const padded = new Float32Array(3000);
  for (let i = 1000; i < 2000; i++) padded[i] = 0.1 * Math.sin(i * 0.05) + 1e-6;
  const [mono] = samples(encodeWavFromChannels([padded], 48000), 1);
  assert.ok(mono.subarray(0, 1000).every((value) => value === 0));
  assert.ok(mono.subarray(2000).every((value) => value === 0));
  assert.ok(mono.subarray(1000, 2000).some((value) => value !== 0));
});

test("only the four AudioBuffer members are needed, and odd inputs are handled", () => {
  // a buffer whose channel data is longer than `length` is cut at `length`
  const long = testSignal(100, 2);
  const wav = encodeWav({
    sampleRate: 22050,
    numberOfChannels: 1,
    length: 60,
    getChannelData: () => long,
  });
  assert.equal(wav.byteLength, 44 + 60 * 2);
  // non-finite samples must not produce garbage
  const odd = samples(
    encodeWavFromChannels(
      [Float32Array.of(NaN, Infinity, -Infinity, 0.5)],
      48000,
      {
        dither: false,
      },
    ),
    1,
  )[0];
  assert.deepEqual(Array.from(odd), [0, 32767, -32768, 16384]);
  assert.throws(() => encodeWavFromChannels([], 48000), RangeError);
  assert.throws(
    () => encodeWavFromChannels([new Float32Array(4)], 0),
    RangeError,
  );
  // an empty buffer is just a header
  assert.equal(
    encodeWavFromChannels([new Float32Array(0)], 48000).byteLength,
    44,
  );
});
