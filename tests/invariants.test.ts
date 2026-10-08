import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG, planFromPrompt, refineFromPrompt } from '../src/composer';
import type { TrackName } from '../src/types';

test('English unmute restores each muted track instead of matching mute within unmute', () => {
  for (const track of ['drums', 'bass', 'melody', 'chords'] as TrackName[]) {
    const original = structuredClone(DEFAULT_CONFIG);
    const muted = refineFromPrompt(original, `mute ${track}`).config;
    assert.equal(muted.volumes[track], 0);
    const restored = refineFromPrompt(muted, `unmute ${track}`).config;
    assert.equal(restored.volumes[track], DEFAULT_CONFIG.volumes[track], track);
    assert.equal(restored.seed, original.seed);
    assert.equal(restored.bpm, original.bpm);
    assert.deepEqual(original, DEFAULT_CONFIG);
  }
});

test('gentler instructions never increase energy, even at the minimum', () => {
  for (const energy of [0, 0.01, 0.05, 0.2, 0.7, 1]) {
    const current = { ...structuredClone(DEFAULT_CONFIG), energy };
    const result = refineFromPrompt(current, '更温柔一点').config;
    assert.ok(result.energy <= energy, `energy ${energy} must not become stronger`);
    assert.ok(result.energy >= 0);
  }
});

test('Chinese mute and restore preserve an existing melody and other parameters', () => {
  const initial = planFromPrompt('青春吉他，94 BPM，45秒，D major').config;
  const muted = refineFromPrompt(initial, '不要鼓点').config;
  const restored = refineFromPrompt(muted, '恢复鼓点').config;
  assert.equal(muted.volumes.drums, 0);
  assert.equal(restored.volumes.drums, DEFAULT_CONFIG.volumes.drums);
  for (const field of ['seed', 'bpm', 'duration', 'key', 'instrument'] as const) {
    assert.equal(restored[field], initial[field]);
  }
});

test('unknown refinement is a true no-op, while explicit variation changes only the seed', () => {
  const initial = structuredClone(DEFAULT_CONFIG);
  assert.deepEqual(refineFromPrompt(initial, '像一只穿雨衣的河马').config, initial);
  const changed = refineFromPrompt(initial, '换一版新旋律').config;
  assert.notEqual(changed.seed, initial.seed);
  assert.deepEqual({ ...changed, seed: initial.seed }, initial);
});
