'use strict';
const { MusicError, cleanSecret } = require('./providers/shared.cjs');
const { validateProvider } = require('./credentials.cjs');

const MUSIC_ENDPOINT = 'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128';
const MAX_AUDIO_BYTES = 80 * 1024 * 1024;
const ALLOWED_MODELS = new Set(['music_v1', 'music_v2', 'music_v2_5']);

function validateInput(input) {
  if (!input || typeof input !== 'object' || typeof input.prompt !== 'string') {
    throw new MusicError('请输入想要的背景音乐描述。');
  }
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 4100) throw new MusicError('音乐描述需要为 1–4100 个字符。');
  if (typeof input.duration !== 'number' || !Number.isFinite(input.duration) || input.duration < 3 || input.duration > 600) {
    throw new MusicError('AI 音乐时长需要在 3–600 秒之间。');
  }
  const model = input.model ?? 'music_v1';
  if (!ALLOWED_MODELS.has(model)) throw new MusicError('不支持的音乐模型，请选择已支持的 ElevenLabs Music 模型。');
  return { prompt, music_length_ms: Math.round(input.duration * 1000), force_instrumental: true, model_id: model };
}

function validateApiKey(key) {
  const text = cleanSecret(key);
  if (!text) throw new MusicError('API Key 格式不正确，请粘贴完整密钥。');
  return text;
}

function statusMessage(status) {
  if (status === 401) return 'API Key 无效或已过期，请在设置中更新密钥。';
  if (status === 402) return 'ElevenLabs 账户额度不足，请检查账户余额与套餐。';
  if (status === 403) return '此密钥没有音乐生成权限，请检查 ElevenLabs 的密钥权限与套餐。';
  if (status === 429) return 'ElevenLabs 请求过多或额度已用尽，请检查账户后稍后重试。';
  if (status === 400 || status === 422) return '音乐服务未接受这段描述或参数，请调整描述后重试。';
  if (status >= 500) return 'ElevenLabs 服务暂时不可用，请稍后手动重试。';
  return `音乐服务返回错误（${status}），请检查设置后手动重试。`;
}

async function readAudio(response, maxBytes) {
  const sizeHeader = Number(response.headers.get('content-length'));
  if (sizeHeader > maxBytes) throw new MusicError('音乐文件过大，请缩短时长后重试。');
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'audio/mpeg' && contentType !== 'audio/mp3' && contentType !== 'application/octet-stream') {
    throw new MusicError('音乐服务没有返回可播放的 MP3 音频，请稍后手动重试。');
  }
  if (!response.body) throw new MusicError('音乐服务返回了空文件，请稍后手动重试。');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new MusicError('音乐文件过大，请缩短时长后重试。');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (total < 4) throw new MusicError('音乐服务返回了空文件或无效音频，请稍后手动重试。');
  const audio = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.byteLength; }
  const id3 = audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33;
  const frame = audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0;
  if (!id3 && !frame) throw new MusicError('音乐服务返回的文件不是有效的 MP3 音频。');
  return { audio: audio.buffer, mimeType: 'audio/mpeg' };
}

/** The promise's result, or a rejection as soon as the signal aborts (the promise itself is left to finish). */
function untilAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function createMusicService({ fetchImpl = globalThis.fetch, timeoutMs = 300_000, maxBytes = MAX_AUDIO_BYTES } = {}) {
  let active = null;
  return {
    get busy() { return active !== null; },
    cancel() {
      if (active) { active.cancelled = true; active.controller.abort(); }
    },
    /**
     * `credentials` is the stored configuration (or a bare ElevenLabs key), or a
     * function returning it. The function form is read only after the lock is
     * taken, so a cancel that arrives while the key store is being read still
     * cancels this job instead of being lost.
     */
    async generate(input, credentials) {
      // Keep the lock until the original request has settled, including cancellation.
      if (active) throw new MusicError('已有一首 AI 音乐正在生成，请等待完成或取消。');
      const provider = validateProvider(input?.provider);
      if (!input || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4100 || typeof input.duration !== 'number' || !Number.isFinite(input.duration) || input.duration < 3 || input.duration > 600) throw new MusicError('音乐描述或时长无效，请检查参数。');
      const job = { controller: new AbortController(), cancelled: false, timedOut: false, taskRef: '' };
      active = job;
      const timer = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, timeoutMs);
      // An adapter that has a server-side task id reports it, so it can be quoted if we stop waiting.
      const reference = () => (job.taskRef ? `（任务编号 ${job.taskRef}）` : '');
      try {
        // Nothing has been sent yet, so a cancel or timeout during the read may answer at once.
        const loaded = typeof credentials === 'function' ? await untilAborted(credentials(), job.controller.signal) : credentials;
        if (job.cancelled || job.timedOut) throw new Error('aborted');
        const config = typeof loaded === 'string' ? { apiKey: loaded } : loaded;
        const body = provider === 'elevenlabs' ? validateInput({ ...input, model: input.model ?? config?.model }) : null;
        const key = provider === 'elevenlabs' ? validateApiKey(config?.apiKey) : null;
        if (provider !== 'elevenlabs') {
          const adapter = require(`./providers/${provider}.cjs`);
          const result = await adapter.generate({ input, credentials: config, signal: job.controller.signal, fetchImpl, maxBytes, onTask: taskRef => { job.taskRef = String(taskRef); } });
          if (job.cancelled || job.timedOut) throw new Error('aborted');
          return result;
        }
        // Never retry a generation automatically: each request may incur a charge.
        const response = await fetchImpl(MUSIC_ENDPOINT, {
          method: 'POST', redirect: 'error', signal: job.controller.signal,
          headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new MusicError(statusMessage(response.status));
        }
        const result = await readAudio(response, maxBytes);
        if (job.cancelled || job.timedOut) throw new Error('aborted');
        return result;
      } catch (error) {
        if (job.timedOut) throw new MusicError(`AI 生成等待超过 5 分钟，已停止等待。服务端任务可能仍在运行，请先检查账户记录再重试。${reference()}`);
        if (job.cancelled) throw new MusicError(`已取消等待生成。服务端可能仍会完成并计费，请先检查账户记录再重试。${reference()}`);
        if (error instanceof MusicError) throw error;
        // Do not forward upstream response bodies, headers, URLs, or raw network errors.
        throw new MusicError('无法连接音乐服务，请检查网络。请求结果未确认，先查看服务控制台记录，再决定是否手动重试。');
      } finally {
        clearTimeout(timer);
        // Close unconsumed response streams too (e.g. an oversized Content-Length).
        job.controller.abort();
        if (active === job) active = null;
      }
    },
  };
}

function safeFilename(name, format) {
  if (!['wav', 'mp3', 'm4a', 'flac', 'json'].includes(format)) throw new MusicError('不支持的导出格式。');
  let base = typeof name === 'string' ? name.normalize('NFKC') : 'Muse-BGM';
  base = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.(wav|mp3|m4a|flac|json)$/i, '').replace(/[. ]+$/g, '').trim().slice(0, 100);
  if (!base || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(base)) base = 'Muse-BGM';
  return `${base}.${format}`;
}

const EXTERNAL_URLS = new Set([
  'https://elevenlabs.io/app/settings/api-keys',
  'https://elevenlabs.io/app/developers/api-keys',
  'https://elevenlabs.io/docs/api-reference/music/compose',
  'https://elevenlabs.io/docs/overview/capabilities/music',
  'https://elevenlabs.io/pricing',
  'https://cloud.tencent.com/document/product/1823/135323',
  'https://cloud.tencent.cn/document/product/1823/135323',
  'https://console.cloud.tencent.com/tokenhub',
  'https://console.volcengine.com/ai-music/product',
  'https://console.volcengine.com/iam/keymanage/',
  'https://docs.volcengine.com/docs/Audiovideounderstandingandprocessing/Generatepuremusic?lang=zh',
  'https://help.aliyun.com/zh/model-studio/fun-music',
  'https://help.aliyun.com/zh/model-studio/get-api-key',
  'https://bailian.console.aliyun.com/',
  // Producer agent: where to get a key for each large-language-model preset.
  'https://platform.claude.com/settings/keys',
  'https://console.anthropic.com/settings/keys',
  'https://platform.deepseek.com/api_keys',
  'https://bailian.console.aliyun.com/?tab=model#/api-key',
  'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  'https://platform.moonshot.cn/console/api-keys',
  'https://cloud.siliconflow.cn/account/ak',
  'https://platform.openai.com/api-keys',
  'https://openrouter.ai/settings/keys',
  'https://ollama.com/download',
  'https://ollama.com/library',
]);

function isAllowedExternal(url) { return typeof url === 'string' && EXTERNAL_URLS.has(url); }

module.exports = { createMusicService, validateInput, validateApiKey, safeFilename, isAllowedExternal, MusicError, MAX_AUDIO_BYTES };
