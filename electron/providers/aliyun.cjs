'use strict';
const { MusicError, requestJson, downloadAudio, cleanSecret, httpMessage, withReference } = require('./shared.cjs');
const MODELS = new Set(['fun-music-v1', 'fun-music-preview']);

/**
 * Results are documented as OSS links (`<bucket>.oss-cn-<region>.aliyuncs.com`).
 * Accept only that virtual-hosted form: not other aliyuncs.com products, not the
 * bare regional endpoint and not VPC-internal endpoints.
 */
function isOssHost(hostname) {
  return /^[a-z0-9][a-z0-9-]{1,62}\.oss-[a-z0-9-]{2,40}\.aliyuncs\.com$/.test(hostname) && !/-internal\.aliyuncs\.com$/.test(hostname);
}

function buildRequest(input, credentials) {
  if (!input || typeof input.prompt !== 'string' || !input.prompt.trim()) throw new MusicError('请输入音乐描述。');
  const model = input.model ?? credentials.model ?? 'fun-music-preview';
  if (!MODELS.has(model)) throw new MusicError('阿里云音乐模型不受支持。');
  const key = cleanSecret(credentials.apiKey);
  if (!key) throw new MusicError('请填写北京地域百炼 API Key。');
  if (typeof credentials.workspaceId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(credentials.workspaceId)) throw new MusicError('请填写有效的百炼 Workspace ID（仅字母、数字与连字符）。');
  const prompt = `${input.prompt.trim()}\n目标时长约 ${input.duration} 秒，以纯音乐自然收尾。`;
  if (prompt.length > 2000) throw new MusicError('阿里云音乐描述连同编曲参数需不超过 2000 字符，请缩短描述。');
  return {
    url: `https://${credentials.workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/music/generation`,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: { model, input: { prompt, is_instrumental: true, format: 'mp3' } },
  };
}

/** Enumerated DashScope error codes only; anything else falls back to the status-based text. */
function codeMessage(code) {
  const value = String(code ?? '');
  if (/^(?:InvalidApiKey|InvalidAPIKey|Unauthorized)$/i.test(value)) return '百炼 API Key 无效，请确认使用的是北京地域的密钥。';
  if (/^Arrearage$/i.test(value)) return '阿里云账户已欠费，请充值后重试。';
  if (/^DataInspectionFailed$/i.test(value)) return '百炼未通过内容安全审核，请调整音乐描述。';
  if (/^Throttling(?:\.[A-Za-z]+)?$/.test(value)) return '百炼触发限流或额度不足，请稍后手动重试。';
  if (/^(?:AccessDenied|Model\.AccessDenied|AccessDenied\.Unpurchased|ModelNotFound|Model\.NotFound)$/i.test(value)) return '当前账号没有 Fun-Music 模型的使用权限，请确认已通过邀测并在北京地域开通。';
  return '';
}

function httpFailure({ status, body }) {
  return withReference(codeMessage(body?.code) || httpMessage(status), '请求编号', body?.request_id);
}

async function generate({ input, credentials, signal, fetchImpl = globalThis.fetch, maxBytes = 80 * 1024 * 1024 }) {
  const request = buildRequest(input, credentials);
  const result = await requestJson(fetchImpl, request.url, { method: 'POST', signal, headers: request.headers, body: JSON.stringify(request.body) }, { onHttpError: httpFailure });
  if (result.code) throw new MusicError(withReference(codeMessage(result.code) || '百炼未完成音乐生成。请确认 Fun-Music 邀测权限、北京地域密钥和余额已就绪。', '请求编号', result.request_id));
  if (result.output?.finish_reason !== 'stop' || typeof result.output?.audio?.url !== 'string') throw new MusicError(withReference('百炼未返回完整音乐文件。请在服务控制台检查本次请求后再决定是否重试。', '请求编号', result.request_id));
  return downloadAudio(result.output.audio.url, { fetchImpl, signal, maxBytes, allowedHostSuffixes: ['aliyuncs.com'], hostAllowed: isOssHost, upgradeHttp: true });
}
module.exports = { generate, buildRequest, isOssHost };
