import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteProject, exportProject, importProject, listProjects, saveProject } from '../src/storage';
import type { Project } from '../src/types';

function fixture(): Project {
  return {
    id: 'original-id', title: '青春晴空', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
    provider: 'local', favorite: true, revision: 2, tags: ['青春', '欢快'],
    config: {
      prompt: '青春欢快的校园 BGM', mood: 'bright', bpm: 112, duration: 30, key: 'C major',
      instrument: 'piano', energy: 0.7, complexity: 0.4, reverb: 0.25, seed: 123456,
      loop: true, volumes: { melody: 0.8, chords: 0.6, bass: 0.65, drums: 0.5 },
    },
  };
}

test('local project round-trip preserves deterministic recipe and creates a separate project', () => {
  const original = fixture();
  const json = exportProject(original);
  const parsed = JSON.parse(json);
  assert.equal(parsed.schemaVersion, 1);
  const imported = importProject(json);
  assert.deepEqual(imported.config, original.config);
  assert.deepEqual(imported.tags, original.tags);
  assert.equal(imported.favorite, true);
  assert.equal(imported.revision, 2);
  assert.notEqual(imported.id, original.id);
  assert.notEqual(imported.createdAt, original.createdAt);
  assert.equal(imported.createdAt, imported.updatedAt);
  assert.notEqual(importProject(json).id, imported.id);
  assert.equal(original.id, 'original-id');
});

test('JSON export omits actual audio and cloud metadata cannot silently import without it', () => {
  const project = { ...fixture(), provider: 'elevenlabs' as const, audioBlob: new Blob(['real-audio'], { type: 'audio/mpeg' }) };
  const json = exportProject(project);
  assert.equal('audioBlob' in JSON.parse(json), false);
  assert.equal(json.includes('real-audio'), false);
  assert.throws(() => importProject(json), /不包含音频/);
});

test('import clamps finite numeric settings to supported engine bounds', () => {
  const project = fixture();
  Object.assign(project.config, { bpm: 999, duration: -1, energy: 2, complexity: -3, reverb: 4, seed: 2 ** 40 });
  project.config.volumes.melody = 10;
  project.config.volumes.drums = -4;
  const imported = importProject(JSON.stringify({ schemaVersion: 1, ...project }));
  assert.equal(imported.config.bpm, 160);
  assert.equal(imported.config.duration, 15);
  assert.equal(imported.config.energy, 1);
  assert.equal(imported.config.complexity, 0);
  assert.equal(imported.config.reverb, 1);
  assert.equal(imported.config.seed, 0xffffffff);
  assert.equal(imported.config.volumes.melody, 1);
  assert.equal(imported.config.volumes.drums, 0);
});

test('import rejects malformed JSON and unsupported schema', () => {
  assert.throws(() => importProject('{'), /有效的 Muse/);
  assert.throws(() => importProject('null'), /必须是对象/);
  assert.throws(() => importProject('[]'), /必须是对象/);
  assert.throws(() => importProject(JSON.stringify({ ...fixture(), schemaVersion: 2 })), /不支持此工程文件版本/);
});

test('size cap measures UTF-8 bytes, including multi-byte text', () => {
  assert.throws(() => importProject(' '.repeat(1024 * 1024 + 1)), /文件过大/);
  assert.throws(() => importProject(JSON.stringify({ padding: '青'.repeat(400000) })), /文件过大/);
});

test('unsafe, unsupported or absent recipe values are rejected', () => {
  for (const [field, value] of [['mood', 'unknown'], ['instrument', 'flute'], ['key', 'X major'], ['bpm', '112'], ['energy', null], ['loop', 'true'], ['volumes', null]]) {
    const project = fixture();
    (project.config as unknown as Record<string, unknown>)[field as string] = value;
    assert.throws(() => importProject(JSON.stringify({ schemaVersion: 1, ...project })), /工程文件格式不正确/);
  }
  const missing = fixture();
  delete (missing.config.volumes as Partial<Project['config']['volumes']>).bass;
  assert.throws(() => importProject(JSON.stringify({ schemaVersion: 1, ...missing })), /bass音量/);
});

test('unknown JSON properties cannot alter imported object prototypes', () => {
  const data = JSON.parse(exportProject(fixture()));
  Object.defineProperty(data, '__proto__', { value: { polluted: true }, enumerable: true });
  data.config.extra = 'discard';
  const imported = importProject(JSON.stringify(data));
  assert.equal(Object.getPrototypeOf(imported), Object.prototype);
  assert.equal('polluted' in imported, false);
  assert.equal('extra' in imported.config, false);
});

test('non-finite settings fail before export can turn them into null', () => {
  const project = fixture();
  project.config.bpm = Infinity;
  assert.throws(() => exportProject(project), /速度必须是有效数字/);
  project.config.bpm = 112;
  project.config.volumes.bass = NaN;
  assert.throws(() => exportProject(project), /bass音量必须是有效数字/);
});

test('metadata is normalized and constrained', () => {
  const project = fixture();
  project.title = `  ${'音'.repeat(100)}\u0000  `;
  project.tags = ['青春', '青春', '  ', ...Array.from({ length: 15 }, (_, index) => String(index))];
  const imported = importProject(exportProject(project));
  assert.equal(imported.title.length, 80);
  assert.equal(imported.title.includes('\u0000'), false);
  assert.equal(imported.tags.length, 12);
  assert.equal(imported.tags.filter(tag => tag === '青春').length, 1);
});

test('cloud saves reject absent or empty audio before claiming success', async () => {
  await assert.rejects(saveProject({ ...fixture(), provider: 'elevenlabs' }), /缺少音频/);
  await assert.rejects(saveProject({ ...fixture(), provider: 'elevenlabs', audioBlob: new Blob([]) }), /音频数据为空/);
});

test('unavailable IndexedDB clearly rejects reads, saves and deletion', async () => {
  if (typeof indexedDB !== 'undefined') return;
  await assert.rejects(listProjects(), /不支持本地作品库/);
  await assert.rejects(saveProject(fixture()), /不支持本地作品库/);
  await assert.rejects(deleteProject('original-id'), /不支持本地作品库/);
});
