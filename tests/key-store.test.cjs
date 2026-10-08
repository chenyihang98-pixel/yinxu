'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createKeyStore } = require('../electron/key-store.cjs');
const { normalizeCredentials, normalizeLlmSettings, PROVIDERS, LLM_KINDS, ANTHROPIC_MODELS } = require('../electron/credentials.cjs');
const { SECRET_MAX, cleanSecret } = require('../electron/providers/shared.cjs');

const KEYS = {
  elevenlabs: { apiKey: 'fake-elevenlabs-key-only', model: 'music_v2_5' },
  tencent: { apiKey: 'fake-tokenhub-key-only', model: 'minimax-music-v2.6' },
  volcengine: { accessKeyId: 'AKIDEXAMPLEFAKE', secretAccessKey: 'fake-volcengine-secret-only', billingMode: 'prepaid' },
  aliyun: { apiKey: 'fake-bailian-key-only', workspaceId: 'workspace-test-123', model: 'fun-music-v1' },
};
const LLM = {
  anthropic: { kind: 'anthropic', preset: 'claude', apiKey: 'sk-ant-fake-key-for-tests-only', model: 'claude-sonnet-5-5' },
  openai: { kind: 'openai', preset: 'deepseek', apiKey: 'sk-fake-deepseek-key-for-tests', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/' },
  ollama: { kind: 'ollama', preset: 'ollama', apiKey: '', model: 'qwen3.5:9b-q4_K_M' },
};

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from([...Buffer.from(value)].map(byte => byte ^ 0xa7)),
    decryptString: value => Buffer.from([...value].map(byte => byte ^ 0xa7)).toString(),
  };
}
async function fixture(t, safeStorage = fakeSafeStorage()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-key-store-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('muse-key-store-')) await fs.rm(resolved, { recursive: true, force: true });
  });
  const filename = path.join(directory, 'music-credentials.json');
  return { directory, filename, safeStorage, store: createKeyStore(directory, safeStorage), readFile: async () => JSON.parse(await fs.readFile(filename, 'utf8')) };
}
const NOT_CONFIGURED = Object.fromEntries(PROVIDERS.map(provider => [provider, { configured: false }]));

test('F03: one undecryptable entry is reported as damaged and hides nothing else', async t => {
  const { filename, store, readFile } = await fixture(t);
  for (const provider of PROVIDERS) await store.saveCredentials(provider, KEYS[provider]);
  const value = await readFile();
  value.providers.aliyun.encryptedCredentials = Buffer.from('not what was encrypted').toString('base64');
  await fs.writeFile(filename, JSON.stringify(value));

  const statuses = await store.getStatuses();
  assert.deepEqual(statuses, {
    elevenlabs: { configured: true, model: 'music_v2_5' },
    tencent: { configured: true, model: 'minimax-music-v2.6' },
    volcengine: { configured: true, billingMode: 'prepaid' },
    aliyun: { configured: true, damaged: true },
  });
  assert.deepEqual(await store.getCredentials('tencent'), KEYS.tencent, 'healthy services keep working');
  await assert.rejects(store.getCredentials('aliyun'), /无法解密此服务的凭据/);
  // Saving again repairs exactly that entry.
  await store.saveCredentials('aliyun', KEYS.aliyun);
  assert.deepEqual((await store.getStatuses()).aliyun, { configured: true, model: 'fun-music-v1', workspaceId: 'workspace-test-123' });
});

test('F03: malformed entries, missing secrets and a failing OS decrypt are isolated per service', async t => {
  const { filename, store, safeStorage, readFile } = await fixture(t);
  await store.saveCredentials('tencent', KEYS.tencent);
  await store.saveCredentials('elevenlabs', KEYS.elevenlabs);
  const value = await readFile();
  const seal = data => safeStorage.encryptString(JSON.stringify(data)).toString('base64');
  value.providers.volcengine = { encryptedCredentials: 42 };
  value.providers.aliyun = { encryptedCredentials: seal({ model: 'fun-music-v1', workspaceId: 'workspace-1' }) }; // decrypts, but the key is gone
  value.providers.tencent = { encryptedCredentials: seal({ apiKey: KEYS.tencent.apiKey, model: 'a-model-this-build-does-not-know' }) };
  await fs.writeFile(filename, JSON.stringify(value));
  assert.deepEqual(await store.getStatuses(), {
    elevenlabs: { configured: true, model: 'music_v2_5' },
    tencent: { configured: true, model: 'a-model-this-build-does-not-know' }, // lenient read: a stale model no longer fails the whole call
    volcengine: { configured: true, damaged: true },
    aliyun: { configured: true, damaged: true },
  });
  await assert.rejects(store.getCredentials('tencent'), /所选音乐模型不受支持/, 'using it is still strict');
  await store.deleteCredentials('volcengine');
  assert.deepEqual((await store.getStatuses()).volcengine, { configured: false });

  const { directory } = await fixture(t);
  const broken = createKeyStore(directory, { ...fakeSafeStorage(), decryptString() { throw new Error('OS could not decrypt: key from another Windows account'); } });
  await broken.saveCredentials('tencent', KEYS.tencent);
  const overview = await broken.getOverview();
  assert.deepEqual(overview.providers.tencent, { configured: true, damaged: true });
  assert.deepEqual(overview.providers.aliyun, { configured: false });
  assert.equal(JSON.stringify(overview).includes('another Windows account'), false, 'raw OS errors never leave the store');
});

test('F03: status values never contain secrets or non-status fields', async t => {
  const { filename, store, safeStorage, readFile } = await fixture(t);
  await store.saveCredentials('tencent', KEYS.tencent);
  const value = await readFile();
  value.providers.tencent.encryptedCredentials = safeStorage.encryptString(JSON.stringify({ apiKey: KEYS.tencent.apiKey, model: 'has spaces and <html>', workspaceId: { nested: true }, billingMode: 'x'.repeat(500), note: 'extra' })).toString('base64');
  await fs.writeFile(filename, JSON.stringify(value));
  assert.deepEqual((await store.getStatuses()).tencent, { configured: true }, 'only short id-like status fields are projected');
});

test('F03: an unreadable credential file fails no status call, and writes stay refused', async t => {
  for (const content of ['{ not json', '[]', 'null', JSON.stringify({ version: 3, providers: {} }), JSON.stringify({ version: 2, providers: [] }), JSON.stringify({ version: 1, encryptedApiKey: '***' })]) {
    const { filename, store } = await fixture(t);
    await fs.writeFile(filename, content);
    const overview = await store.getOverview();
    for (const provider of PROVIDERS) assert.deepEqual(overview.providers[provider], { configured: false, damaged: true });
    assert.deepEqual(overview.llm, { configured: false, damaged: true });
    assert.deepEqual(await store.getStatuses(), overview.providers);
    assert.deepEqual(await store.getLlmStatus(), overview.llm);
    await assert.rejects(store.saveCredentials('tencent', KEYS.tencent), /无法读取服务凭据/);
    await assert.rejects(store.saveLlmSettings(LLM.anthropic), /无法读取服务凭据/);
    await assert.rejects(store.getLlmSettings(), /无法读取服务凭据/);
    assert.equal(await fs.readFile(filename, 'utf8'), content, 'the file is left exactly as it was');
  }
});

test('F07: ids and top-level keys from a newer build are tolerated and survive every write', async t => {
  const { filename, store, safeStorage, readFile } = await fixture(t);
  await store.saveCredentials('tencent', KEYS.tencent);
  const value = await readFile();
  const future = { encryptedCredentials: safeStorage.encryptString('{"apiKey":"future-service-key"}').toString('base64'), addedIn: '0.9' };
  value.providers.suno = future;
  value.providers.udio = { shape: 'unknown to this build' };
  value.agents = { planner: { encrypted: 'abc' } };
  value.schemaHints = [1, 2, 3];
  await fs.writeFile(filename, JSON.stringify(value));

  assert.deepEqual(await store.getStatuses(), { ...NOT_CONFIGURED, tencent: { configured: true, model: 'minimax-music-v2.6' } });
  assert.deepEqual(await store.getCredentials('tencent'), KEYS.tencent);
  assert.equal(await store.hasKey('tencent'), true);
  assert.throws(() => normalizeCredentials('suno', { apiKey: 'future-service-key' }), /不支持/, 'unknown ids are preserved, not usable');

  await store.saveCredentials('aliyun', KEYS.aliyun);
  await store.saveLlmSettings(LLM.anthropic);
  await store.deleteCredentials('tencent');
  await store.deleteLlmSettings();
  const after = await readFile();
  assert.deepEqual(after.providers.suno, future);
  assert.deepEqual(after.providers.udio, { shape: 'unknown to this build' });
  assert.deepEqual(after.agents, { planner: { encrypted: 'abc' } });
  assert.deepEqual(after.schemaHints, [1, 2, 3]);
  assert.deepEqual(Object.keys(after.providers).sort(), ['aliyun', 'suno', 'udio']);
  assert.equal(after.version, 2);
});

test('LLM settings are stored encrypted under their own top-level key and never listed as a music service', async t => {
  const { filename, store, readFile } = await fixture(t);
  assert.deepEqual(await store.getLlmStatus(), { configured: false });
  await assert.rejects(store.getLlmSettings(), /还没有配置大模型/);
  await store.saveCredentials('tencent', KEYS.tencent);
  await store.saveLlmSettings(LLM.openai);

  const value = await readFile();
  assert.deepEqual(Object.keys(value).sort(), ['llm', 'providers', 'version']);
  assert.deepEqual(Object.keys(value.providers), ['tencent'], 'old builds reject unknown ids inside providers, so the LLM never goes there');
  assert.deepEqual(Object.keys(value.llm), ['encryptedSettings']);
  const raw = await fs.readFile(filename, 'utf8');
  for (const secret of [LLM.openai.apiKey, 'deepseek', KEYS.tencent.apiKey]) assert.equal(raw.includes(secret), false);

  const status = await store.getLlmStatus();
  assert.deepEqual(status, { configured: true, kind: 'openai', model: 'deepseek-chat', preset: 'deepseek', baseUrl: 'https://api.deepseek.com' });
  assert.equal(JSON.stringify(await store.getOverview()).includes(LLM.openai.apiKey), false, 'the key is never part of a status');
  assert.deepEqual(await store.getLlmSettings(), { kind: 'openai', preset: 'deepseek', apiKey: LLM.openai.apiKey, model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' });
  assert.deepEqual(await store.getStatuses(), { ...NOT_CONFIGURED, tencent: { configured: true, model: 'minimax-music-v2.6' } });
  for (const kind of LLM_KINDS) assert.equal(PROVIDERS.includes(kind), false);

  await store.saveLlmSettings(LLM.anthropic);
  assert.deepEqual(await store.getLlmStatus(), { configured: true, kind: 'anthropic', model: 'claude-sonnet-5-5', preset: 'claude' });
  await store.saveLlmSettings(LLM.ollama);
  assert.deepEqual(await store.getLlmStatus(), { configured: true, kind: 'ollama', model: 'qwen3.5:9b-q4_K_M', preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' });
  assert.deepEqual(await store.getLlmSettings(), { kind: 'ollama', preset: 'ollama', apiKey: '', model: 'qwen3.5:9b-q4_K_M', baseUrl: 'http://127.0.0.1:11434/v1' });

  await store.deleteLlmSettings();
  assert.deepEqual(await store.getLlmStatus(), { configured: false });
  assert.deepEqual(await store.getCredentials('tencent'), KEYS.tencent, 'music credentials are untouched');
  await store.deleteLlmSettings(); // deleting twice is fine
});

test('LLM settings: invalid input and unavailable encryption never change the file; damaged entry is isolated', async t => {
  const { directory, filename, store, readFile } = await fixture(t);
  await store.saveLlmSettings(LLM.anthropic);
  const original = await fs.readFile(filename, 'utf8');
  for (const invalid of [
    null, 'text', [], {}, { ...LLM.anthropic, kind: 'tencent' }, { ...LLM.anthropic, kind: 'elevenlabs' }, { ...LLM.anthropic, apiKey: 'short' }, { ...LLM.anthropic, apiKey: 'has space inside key' },
    { ...LLM.anthropic, model: 'claude-opus-4-1' }, { ...LLM.anthropic, preset: '../../x' }, { ...LLM.openai, model: 'bad model name' }, { ...LLM.openai, model: '' },
    { ...LLM.openai, baseUrl: 'http://api.deepseek.com' }, { ...LLM.openai, baseUrl: undefined }, { ...LLM.openai, apiKey: '' }, { ...LLM.ollama, baseUrl: 'http://192.168.1.5:11434/v1' },
  ]) {
    await assert.rejects(store.saveLlmSettings(invalid), error => error.name === 'MusicError', JSON.stringify(invalid));
    assert.equal(await fs.readFile(filename, 'utf8'), original);
  }
  await assert.rejects(createKeyStore(directory, fakeSafeStorage(false)).saveLlmSettings(LLM.openai), /系统密钥保护不可用/);
  assert.equal(await fs.readFile(filename, 'utf8'), original);

  await store.saveCredentials('tencent', KEYS.tencent);
  const value = await readFile();
  value.llm = { encryptedSettings: 'Z2FyYmFnZQ==' };
  await fs.writeFile(filename, JSON.stringify(value));
  const overview = await store.getOverview();
  assert.deepEqual(overview.llm, { configured: true, damaged: true });
  assert.deepEqual(overview.providers.tencent, { configured: true, model: 'minimax-music-v2.6' });
  await assert.rejects(store.getLlmSettings(), /无法解密大模型设置/);
  await store.saveLlmSettings(LLM.anthropic); // saving again repairs it
  assert.equal((await store.getLlmStatus()).configured, true);
  assert.equal((await store.getLlmStatus()).damaged, undefined);
});

test('LLM settings can be added to a legacy V1 file without losing the ElevenLabs key', async t => {
  const { filename, store, safeStorage, readFile } = await fixture(t);
  const legacyKey = 'legacy-elevenlabs-secret-key';
  await fs.writeFile(filename, JSON.stringify({ version: 1, encryptedApiKey: safeStorage.encryptString(legacyKey).toString('base64'), keptForLater: 'yes' }));
  assert.deepEqual(await store.getLlmStatus(), { configured: false });
  assert.deepEqual((await store.getStatuses()).elevenlabs, { configured: true });
  await store.saveLlmSettings(LLM.anthropic);
  const migrated = await readFile();
  assert.equal(migrated.version, 2);
  assert.equal(migrated.keptForLater, 'yes');
  assert.equal('encryptedApiKey' in migrated, false);
  assert.equal(await store.getKey(), legacyKey);
  assert.equal((await store.getLlmSettings()).model, 'claude-sonnet-5-5');
});

test('normalizeLlmSettings returns exactly {kind, preset, apiKey, model, baseUrl}', () => {
  assert.deepEqual(normalizeLlmSettings({ kind: 'anthropic', apiKey: '  sk-ant-fake-key-for-tests-only  ', model: '', extra: 'dropped', baseUrl: 'https://evil.test' }),
    { kind: 'anthropic', preset: 'custom', apiKey: 'sk-ant-fake-key-for-tests-only', model: 'claude-opus-5-5', baseUrl: '' });
  assert.deepEqual(ANTHROPIC_MODELS, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  for (const model of ANTHROPIC_MODELS) assert.equal(normalizeLlmSettings({ ...LLM.anthropic, model }).model, model);
  for (const model of ['deepseek-chat', 'ep-20260801123456-abcde', 'qwen3.5:9b-q4_K_M', 'Qwen/Qwen3-72B-Instruct', 'gpt-5.1', 'glm-4.6', 'a'.repeat(128)]) {
    assert.equal(normalizeLlmSettings({ ...LLM.openai, model }).model, model);
  }
  for (const model of ['', ' ', '-leading-dash', 'has space', 'semi;colon', 'a'.repeat(129), '模型', 'new\nline', undefined, 42]) {
    assert.throws(() => normalizeLlmSettings({ ...LLM.openai, model }), /模型名称格式不正确/, String(model));
  }
  assert.equal(normalizeLlmSettings({ ...LLM.ollama, apiKey: 'ignored-key-for-local-model' }).apiKey, '', 'a local model never gets a key');
  assert.equal(normalizeLlmSettings({ ...LLM.ollama, baseUrl: 'http://localhost:8080/v1/' }).baseUrl, 'http://127.0.0.1:8080/v1');
});

test('F16: one secret length limit for the store, the adapters and the LLM key', async t => {
  const long = 'k'.repeat(SECRET_MAX);
  assert.equal(SECRET_MAX, 4096);
  assert.equal(cleanSecret(`  ${long}  `), long);
  assert.equal(cleanSecret(`${long}k`), null);
  assert.equal(cleanSecret('k'.repeat(9)), null);
  assert.equal(cleanSecret('has space in the middle'), null);
  assert.equal(cleanSecret('line\nbreak-inside-key'), null);
  assert.equal(cleanSecret(42), null);
  // A JWT-sized key (600 chars) was rejected by the v0.2 store although the adapter accepted it.
  const jwt = `eyJ${'a'.repeat(597)}`;
  assert.equal(normalizeCredentials('tencent', { apiKey: jwt }).apiKey, jwt);
  assert.equal(normalizeCredentials('volcengine', { accessKeyId: jwt, secretAccessKey: long }).secretAccessKey, long);
  assert.equal(normalizeLlmSettings({ ...LLM.openai, apiKey: long }).apiKey, long);
  for (const tooLong of [`${long}k`]) {
    assert.throws(() => normalizeCredentials('tencent', { apiKey: tooLong }));
    assert.throws(() => normalizeLlmSettings({ ...LLM.openai, apiKey: tooLong }));
  }
  const tencent = require('../electron/providers/tencent.cjs');
  const volcengine = require('../electron/providers/volcengine.cjs');
  const aliyun = require('../electron/providers/aliyun.cjs');
  const { validateApiKey } = require('../electron/music-service.cjs');
  assert.equal(validateApiKey(long), long);
  assert.throws(() => validateApiKey(`${long}k`));
  assert.equal(volcengine.validateCredentials({ accessKeyId: long, secretAccessKey: long }).accessKeyId, long);
  assert.throws(() => volcengine.validateCredentials({ accessKeyId: `${long}k`, secretAccessKey: long }));
  assert.equal(aliyun.buildRequest({ prompt: '测试', duration: 30 }, { apiKey: long, workspaceId: 'workspace-1' }).headers.Authorization, `Bearer ${long}`);
  assert.throws(() => aliyun.buildRequest({ prompt: '测试', duration: 30 }, { apiKey: `${long}k`, workspaceId: 'workspace-1' }));
  let sent = 0;
  await assert.rejects(tencent.generate({ input: { prompt: '测试', duration: 30 }, credentials: { apiKey: `${long}k` }, fetchImpl: async () => { sent++; return new Response('{}'); } }), /API Key/);
  assert.equal(sent, 0);
  // The whole set of maximum-length secrets still fits the credential file.
  const { store } = await (async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-key-store-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return { store: createKeyStore(directory, fakeSafeStorage()) };
  })();
  await store.saveCredentials('elevenlabs', { apiKey: long });
  await store.saveCredentials('tencent', { apiKey: long });
  await store.saveCredentials('aliyun', { apiKey: long, workspaceId: 'workspace-1' });
  await store.saveCredentials('volcengine', { accessKeyId: long, secretAccessKey: long });
  await store.saveLlmSettings({ ...LLM.openai, apiKey: long });
  assert.equal((await store.getCredentials('volcengine')).secretAccessKey, long);
  assert.equal((await store.getLlmSettings()).apiKey, long);
});
