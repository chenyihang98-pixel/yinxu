'use strict';
const { MusicError } = require('./providers/shared.cjs');
const PROVIDERS = ['elevenlabs', 'tencent', 'volcengine', 'aliyun'];
function validateProvider(value = 'elevenlabs') { if (!PROVIDERS.includes(value)) throw new MusicError('不支持的音乐生成服务。'); return value; }
function secret(value, label) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{10,512}$/.test(value.trim())) throw new MusicError(`${label} 格式不正确，请填写完整凭据。`);
  return value.trim();
}
function normalizeCredentials(provider, input) {
  validateProvider(provider);
  if (!input || typeof input !== 'object') throw new MusicError('请填写所选服务的连接信息。');
  if (provider === 'volcengine') {
    const billingMode = input.billingMode ?? 'postpaid';
    if (!['postpaid', 'prepaid'].includes(billingMode)) throw new MusicError('请选择正确的火山引擎计费方式。');
    return { accessKeyId: secret(input.accessKeyId, 'Access Key ID'), secretAccessKey: secret(input.secretAccessKey, 'Secret Access Key'), billingMode };
  }
  const apiKey = secret(input.apiKey, 'API Key');
  const models = { elevenlabs: ['music_v1', 'music_v2', 'music_v2_5'], tencent: ['minimax-music-v3.0', 'minimax-music-v2.6'], aliyun: ['fun-music-preview', 'fun-music-v1'] };
  const model = input.model ?? models[provider][0];
  if (!models[provider].includes(model)) throw new MusicError('所选音乐模型不受支持。');
  if (provider === 'aliyun') {
    const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : '';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(workspaceId)) throw new MusicError('Workspace ID 格式不正确，请从北京地域业务空间详情复制。');
    return { apiKey, workspaceId, model };
  }
  return { apiKey, model };
}
module.exports = { PROVIDERS, validateProvider, normalizeCredentials };
