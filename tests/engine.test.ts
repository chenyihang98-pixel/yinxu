import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, planFromPrompt, refineFromPrompt } from '../src/composer';
import { computePeaks, encodeWav, mixStems, renderMusic, seededRandom } from '../src/audio/engine';

class TestAudioBuffer {
  readonly length: number; readonly sampleRate: number; readonly numberOfChannels: number; readonly duration: number;
  private channels: Float32Array[];
  constructor(options: { length: number; sampleRate: number; numberOfChannels: number }) {
    Object.assign(this, options); this.length = options.length; this.sampleRate = options.sampleRate;
    this.numberOfChannels = options.numberOfChannels; this.duration = options.length / options.sampleRate;
    this.channels = Array.from({ length: options.numberOfChannels }, () => new Float32Array(options.length));
  }
  getChannelData(channel: number) { return this.channels[channel]; }
}
Object.defineProperty(globalThis, 'AudioBuffer', { value: TestAudioBuffer, configurable: true });

test('prompt planning parses mood, tempo, instrument, duration, key and mute independently', () => {
  const plan = planFromPrompt('青春欢快，用吉他，128 BPM，60秒，D major，不要鼓点');
  assert.equal(plan.config.mood, 'bright'); assert.equal(plan.config.instrument, 'guitar');
  assert.equal(plan.config.bpm, 128); assert.equal(plan.config.duration, 60);
  assert.equal(plan.config.key, 'D major'); assert.equal(plan.config.volumes.drums, 0);
  assert.deepEqual(planFromPrompt('coffee chill guitar 80 bpm').config, planFromPrompt('coffee chill guitar 80 bpm').config);
});

test('refinements preserve other settings and input while applying explicit changes', () => {
  const original = structuredClone(DEFAULT_CONFIG);
  const plan = refineFromPrompt(original, '慢一点，钢琴更柔和，减少混响，去掉鼓点');
  assert.equal(plan.config.bpm, original.bpm - 12); assert.equal(plan.config.volumes.drums, 0);
  assert.equal(plan.config.seed, original.seed); assert.equal(plan.config.duration, original.duration);
  assert.ok(plan.config.energy < original.energy); assert.ok(plan.config.reverb < original.reverb);
  assert.deepEqual(original, DEFAULT_CONFIG);
  assert.equal(refineFromPrompt(plan.config, '恢复鼓点').config.volumes.drums, DEFAULT_CONFIG.volumes.drums);
});

test('explicit numeric parameters are bounded and looping can be disabled', () => {
  const config = planFromPrompt('cinematic piano 999 bpm 500秒 A minor，不要循环').config;
  assert.equal(config.bpm, 160); assert.equal(config.duration, 120); assert.equal(config.loop, false);
  assert.equal(config.key, 'A minor');
});

test('random sources are repeatable and different seeds produce different music choices', () => {
  const a = seededRandom(31), b = seededRandom(31), c = seededRandom(32);
  const one = Array.from({ length: 30 }, () => a());
  assert.deepEqual(one, Array.from({ length: 30 }, () => b()));
  assert.notDeepEqual(one, Array.from({ length: 30 }, () => c()));
});

test('WAV export has valid stereo PCM metadata and signed clamped samples', () => {
  const buffer = new AudioBuffer({ length: 4, numberOfChannels: 2, sampleRate: 32000 });
  buffer.getChannelData(0).set([-1, 0, 1, 2]); buffer.getChannelData(1).set([0.5, -0.5, 0, -2]);
  const wav = encodeWav(buffer), view = new DataView(wav);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint32(4, true), wav.byteLength - 8); assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 32000); assert.equal(view.getUint32(40, true), 16);
  assert.equal(view.getInt16(44, true), -32768); assert.equal(view.getInt16(56, true), 32767);
  assert.equal(view.getInt16(58, true), -32768);
  assert.equal(computePeaks(buffer, 4).length, 4);
});

test('offline render produces finite independent stems, deterministic audio and an exact duration', async () => {
  const config = { ...DEFAULT_CONFIG, duration: 15, reverb: 0, loop: false };
  const progress: number[] = [];
  const rendered = await renderMusic(config, value => progress.push(value));
  assert.equal(rendered.buffer.duration, 15); assert.equal(rendered.buffer.sampleRate, 32000);
  for (const track of Object.values(rendered.stems)) {
    const data = track.getChannelData(0); let power = 0;
    for (const sample of data) { assert.ok(Number.isFinite(sample)); power += sample * sample; }
    assert.ok(power > 1); assert.equal(data[data.length - 1], 0);
  }
  const muted = mixStems(rendered.stems, { melody: 0, chords: 0, bass: 0, drums: 0 });
  assert.ok(muted.getChannelData(0).every(value => value === 0));
  const again = await renderMusic(config);
  assert.deepEqual(rendered.buffer.getChannelData(0), again.buffer.getChannelData(0));
  assert.equal(progress.at(-1), 1); assert.ok(progress.every((value, i) => !i || value >= progress[i - 1]));
});

test('generation propagates progress callback cancellation', async () => {
  await assert.rejects(renderMusic(DEFAULT_CONFIG, () => { throw new Error('cancelled'); }), /cancelled/);
});

test('loop tails wrap without a sample discontinuity and changes of seed change the music', async () => {
  const config = { ...DEFAULT_CONFIG, duration: 15, loop: true, reverb: 0.6 };
  const rendered = await renderMusic(config);
  for (const stem of Object.values(rendered.stems)) {
    const samples = stem.getChannelData(0);
    assert.ok(Math.abs(samples[0] - samples[samples.length - 1]) < 0.035, 'loop seam should not click');
  }
  const varied = await renderMusic({ ...config, seed: config.seed + 1 });
  assert.notDeepEqual(rendered.stems.melody.getChannelData(0), varied.stems.melody.getChannelData(0));
});
