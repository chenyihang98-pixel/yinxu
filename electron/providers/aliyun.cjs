'use strict';
const { MusicError, requestJson, downloadAudio } = require('./shared.cjs');
const MODELS = new Set(['fun-music-v1', 'fun-music-preview']);

function buildRequest(input, credentials) {
  if (!input || typeof input.prompt !== 'string' || !input.prompt.trim()) throw new MusicError('请输入音乐描述。');
  const model = input.model ?? credentials.model ?? 'fun-music-preview';
  if (!MODELS.has(model)) throw new MusicError('阿里云音乐模型不受支持。');
  const key = credentials.apiKey;
  if (typeof key !== 'string' || !/^[\x21-\x7e]{10,512}$/.test(key)) throw new MusicError('请填写北京地域百炼 API Key。');
  if (typeof credentials.workspaceId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(credentials.workspaceId)) throw new MusicError('请填写有效的百炼 Workspace ID（仅字母、数字与连字符）。');
  const prompt = `${input.prompt.trim()}\n目标时长约 ${input.duration} 秒，以纯音乐自然收尾。`;
  if (prompt.length > 2000) throw new MusicError('阿里云音乐描述连同编曲参数需不超过 2000 字符，请缩短描述。');
  return {
    url: `https://${credentials.workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/music/generation`,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: { model, input: { prompt, is_instrumental: true, format: 'mp3' } },
  };
}

async function generate({ input, credentials, signal, fetchImpl = globalThis.fetch, maxBytes = 80 * 1024 * 1024 }) {
  const request = buildRequest(input, credentials);
  const result = await requestJson(fetchImpl, request.url, { method: 'POST', signal, headers: request.headers, body: JSON.stringify(request.body) });
  if (result.code) throw new MusicError('百炼未完成音乐生成。请确认 Fun-Music 邀测权限、北京地域密钥和余额已就绪。');
  if (result.output?.finish_reason !== 'stop' || typeof result.output?.audio?.url !== 'string') throw new MusicError('百炼未返回完整音乐文件。请在服务控制台检查本次请求后再决定是否重试。');
  return downloadAudio(result.output.audio.url, { fetchImpl, signal, maxBytes, allowedHostSuffixes: ['aliyuncs.com'], upgradeHttp: true });
}
module.exports = { generate, buildRequest };
