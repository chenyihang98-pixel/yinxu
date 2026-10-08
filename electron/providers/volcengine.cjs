'use strict';

const crypto = require('node:crypto');
const shared = require('./shared.cjs');
const { MusicError } = shared;

const HOST = 'open.volcengineapi.com';
const REGION = 'cn-beijing';
const SERVICE = 'imagination';
const API_VERSION = '2024-08-12';
const SIGNED_HEADERS = 'content-type;host;x-content-sha256;x-date';
const AUDIO_HOSTS = Array.from({ length: 50 }, (_, index) => `v${index + 1}-default.douyinvod.com`);
const ALLOWED_ACTIONS = new Set(['GenBGM', 'GenBGMForTime', 'QuerySong']);

const hash = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value, 'utf8').digest();

function validateCredentials(credentials) {
  if (!credentials || typeof credentials !== 'object') throw new MusicError('请先保存火山引擎 Access Key ID 和 Secret Access Key。');
  const result = {};
  for (const name of ['accessKeyId', 'secretAccessKey']) {
    const value = credentials[name];
    if (typeof value !== 'string' || value.trim().length < 8 || value.trim().length > 512 || !/^[\x21-\x7e]+$/.test(value.trim())) {
      throw new MusicError('火山引擎 AK/SK 格式不正确，请重新粘贴完整密钥。');
    }
    result[name] = value.trim();
  }
  const billingMode = credentials.billingMode ?? 'postpaid';
  if (!['prepaid', 'postpaid'].includes(billingMode)) throw new MusicError('请选择火山引擎预付费或按量后付费模式。');
  return { ...result, billingMode };
}

function buildBody(input) {
  if (!input || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.trim().length > 4100) {
    throw new MusicError('请输入有效的音乐描述，长度不可超过 4100 个字符。');
  }
  if (!/[\u3400-\u9fff]/u.test(input.prompt)) throw new MusicError('火山引擎纯音乐接口支持中文描述，请用中文描述音乐。');
  if (!Number.isInteger(input.duration) || input.duration < 30 || input.duration > 120) {
    throw new MusicError('火山引擎音乐 v5.0 支持 30–120 秒，请调整生成时长。');
  }
  if (input.model !== undefined && input.model !== 'v5.0') throw new MusicError('火山引擎纯音乐已升级为 v5.0，请使用该模型。');
  return {
    Text: `背景纯音乐，无人声、无歌词。${input.prompt.trim()}`,
    Duration: input.duration,
    Version: 'v5.0',
    EnableInputRewrite: false,
    // Official precedence: Segments > duration written in Text > outer Duration.
    Segments: [{ Name: 'inst', Duration: input.duration }],
  };
}

/** Sign exactly the UTF-8 JSON bytes sent. Based on the official Volcengine V4 algorithm. */
function signRequest({ action, body, credentials, now = new Date() }) {
  if (!ALLOWED_ACTIONS.has(action)) throw new MusicError('不支持的火山引擎音乐操作。');
  const { accessKeyId, secretAccessKey } = validateCredentials(credentials);
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) throw new MusicError('系统时间无效，请同步系统时间。');
  const serialized = JSON.stringify(body);
  const timestamp = now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const shortDate = timestamp.slice(0, 8);
  const query = `Action=${action}&Version=${API_VERSION}`;
  const payloadHash = hash(serialized);
  const canonicalHeaders = `content-type:application/json\nhost:${HOST}\nx-content-sha256:${payloadHash}\nx-date:${timestamp}\n`;
  const canonicalRequest = ['POST', '/', query, canonicalHeaders, SIGNED_HEADERS, payloadHash].join('\n');
  const scope = `${shortDate}/${REGION}/${SERVICE}/request`;
  const stringToSign = ['HMAC-SHA256', timestamp, scope, hash(canonicalRequest)].join('\n');
  const signingKey = [shortDate, REGION, SERVICE, 'request'].reduce((key, part) => hmac(key, part), Buffer.from(secretAccessKey, 'utf8'));
  const signature = hmac(signingKey, stringToSign).toString('hex');
  return {
    url: `https://${HOST}/?${query}`,
    options: {
      method: 'POST', redirect: 'error', body: serialized,
      headers: {
        Host: HOST, 'Content-Type': 'application/json', 'X-Date': timestamp,
        'X-Content-Sha256': payloadHash,
        Authorization: `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
      },
    },
  };
}

function failureMessage(code) {
  const value = String(code ?? '');
  if (/^(?:InvalidAccessKeyId|InvalidAccessKey|SignatureDoesNotMatch|SignatureMismatch|InvalidAuthorization|Unauthorized|MissingAuthenticationToken|AccessDenied)$/i.test(value)) {
    return '火山引擎鉴权失败，请检查 AK/SK、子账号权限及纯音乐服务开通状态。';
  }
  if (/^(?:InvalidTimestamp|RequestExpired|SignatureExpired|InvalidXDate)$/i.test(value)) {
    return '火山引擎签名时间无效，请同步电脑时间后重试。';
  }
  if (value === '50000001' || value === '300061') return '音乐服务的内容或版权校验未通过，请重新描述原创音乐需求后手动重试。';
  return '火山引擎未能完成音乐任务，请检查服务开通、计费模式、账户额度和输入描述后手动重试。';
}

function assertSuccess(data) {
  if (!data || typeof data !== 'object') throw new MusicError('火山引擎返回了无法识别的结果。');
  const metadataError = data.ResponseMetadata?.Error;
  if (metadataError || data.Code !== 0) throw new MusicError(failureMessage(metadataError?.Code ?? data.Code));
  if (!data.Result || typeof data.Result !== 'object') throw new MusicError('火山引擎响应缺少任务结果。');
  return data.Result;
}

function checkAbort(signal) { if (signal?.aborted) throw new MusicError('已取消等待火山引擎音乐生成，服务端任务可能仍在运行或计费。'); }

function wait(milliseconds, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const abort = () => {
      clearTimeout(timer); cleanup();
      reject(new MusicError('已取消等待火山引擎音乐生成，服务端任务可能仍在运行或计费。'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function generate({ input, credentials, signal, fetchImpl = globalThis.fetch, maxBytes = 64 * 1024 * 1024, helpers = {} }) {
  const body = buildBody(input);
  const verifiedCredentials = validateCredentials(credentials);
  const sleep = helpers.sleep ?? wait;
  const requestJson = helpers.requestJson ?? shared.requestJson;
  const downloadAudio = helpers.downloadAudio ?? shared.downloadAudio;
  const request = async (action, requestBody) => {
    checkAbort(signal);
    const signed = signRequest({ action, body: requestBody, credentials: verifiedCredentials });
    const data = await requestJson(fetchImpl, signed.url, { ...signed.options, signal });
    checkAbort(signal);
    return assertSuccess(data);
  };
  try {
    // Do not retry this billable submission or switch billing modes automatically.
    const submission = await request(verifiedCredentials.billingMode === 'prepaid' ? 'GenBGM' : 'GenBGMForTime', body);
    if (typeof submission.TaskID !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(submission.TaskID)) throw new MusicError('火山引擎响应缺少有效任务编号，未自动重试，请先检查账户任务记录。');
    for (let attempt = 0; attempt < 150; attempt++) {
      const task = await request('QuerySong', { TaskID: submission.TaskID });
      if (task.Status === 2) {
        const detail = task.SongDetail;
        let audioUrl;
        try { audioUrl = new URL(detail?.AudioUrl); } catch { throw new MusicError('火山引擎任务完成，但没有返回有效音频地址。'); }
        if (audioUrl.protocol !== 'https:' || audioUrl.username || audioUrl.password || (audioUrl.port && audioUrl.port !== '443') || !AUDIO_HOSTS.includes(audioUrl.hostname)) {
          throw new MusicError('火山引擎音频地址不在官方 CDN 白名单中，已停止下载。');
        }
        checkAbort(signal);
        const audio = await downloadAudio(audioUrl.href, { fetchImpl, signal, maxBytes, allowedHostSuffixes: AUDIO_HOSTS });
        checkAbort(signal);
        return { ...audio, requestedDuration: input.duration, ...(Number.isFinite(detail.Duration) && detail.Duration > 0 ? { providerDuration: detail.Duration } : {}) };
      }
      if (task.Status === 3) throw new MusicError(failureMessage(task.FailureReason?.Code));
      if (task.Status !== 0 && task.Status !== 1) throw new MusicError('火山引擎返回了未知任务状态，未重新提交，请先检查账户任务记录。');
      if (attempt < 149) await sleep(2000, signal);
    }
    throw new MusicError('火山引擎音乐任务等待超过 5 分钟。任务可能仍在运行，请先检查账户记录再重试。');
  } catch (error) {
    checkAbort(signal);
    if (error instanceof MusicError) throw error;
    throw new MusicError('无法连接火山引擎音乐服务，请检查网络。任务未自动重试，请先检查账户记录。');
  }
}

module.exports = { generate, buildBody, signRequest, validateCredentials, AUDIO_HOSTS };
