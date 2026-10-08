'use strict';

// The renderer's preset list (src/agent/llm-presets.ts) and the main process must agree:
// every preset has to pass the checks its settings will meet when the user saves them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateBaseUrl } = require('../electron/agent/base-url.cjs');
const { normalizeLlmSettings, ANTHROPIC_MODELS, LLM_KINDS } = require('../electron/credentials.cjs');
const { isAllowedExternal } = require('../electron/music-service.cjs');

const file = path.join(__dirname, '..', 'src', 'agent', 'llm-presets.ts');

function readPresets() {
  const source = fs.readFileSync(file, 'utf8');
  const list = /LLM_PRESETS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(source)?.[1];
  if (!list) return null;
  return [...list.matchAll(/\{[^{}]*\}/g)].map(([block]) => {
    const field = name => new RegExp(`\\b${name}:\\s*"([^"]*)"`).exec(block)?.[1];
    const models = /models:\s*\[([^\]]*)\]/.exec(block)?.[1] ?? '';
    return { id: field('id'), kind: field('kind'), baseUrl: field('baseUrl'), keyUrl: field('keyUrl'), models: [...models.matchAll(/"([^"]+)"/g)].map(match => match[1]) };
  });
}

test('every LLM preset of the renderer is accepted by the main process', t => {
  if (!fs.existsSync(file)) { t.skip('src/agent/llm-presets.ts does not exist yet'); return; }
  const presets = readPresets();
  if (!presets?.length) { t.skip('LLM_PRESETS is no longer a plain array literal'); return; }
  assert.equal(new Set(presets.map(preset => preset.id)).size, presets.length, 'preset ids are unique');
  for (const preset of presets) {
    assert.ok(LLM_KINDS.includes(preset.kind), `${preset.id}: kind ${preset.kind}`);
    const model = preset.models[0] ?? 'some-model-id';
    const apiKey = preset.kind === 'ollama' ? '' : 'sk-fake-key-for-preset-test';
    if (preset.kind === 'anthropic') {
      assert.deepEqual(preset.models, ANTHROPIC_MODELS, 'the Claude models offered in the UI are the ones the adapter sends');
      assert.equal(preset.baseUrl, undefined, 'Claude has no configurable address');
      for (const each of preset.models) assert.equal(normalizeLlmSettings({ kind: preset.kind, preset: preset.id, apiKey, model: each }).model, each);
    } else if (preset.baseUrl !== undefined) {
      assert.equal(validateBaseUrl(preset.kind, preset.baseUrl), preset.baseUrl, `${preset.id}: base URL is already in normal form`);
      const saved = normalizeLlmSettings({ kind: preset.kind, preset: preset.id, apiKey, model, baseUrl: preset.baseUrl });
      assert.deepEqual(saved, { kind: preset.kind, preset: preset.id, apiKey, model, baseUrl: preset.baseUrl });
    } else {
      // "custom": the user types the address; the id itself must still be storable.
      assert.equal(normalizeLlmSettings({ kind: preset.kind, preset: preset.id, apiKey, model, baseUrl: 'https://llm.example-gateway.com/v1' }).preset, preset.id);
    }
    if (preset.keyUrl !== undefined) assert.equal(isAllowedExternal(preset.keyUrl), true, `${preset.id}: ${preset.keyUrl} can be opened from the app`);
  }
  assert.ok(presets.some(preset => preset.kind === 'anthropic') && presets.some(preset => preset.kind === 'openai') && presets.some(preset => preset.kind === 'ollama'));
});
