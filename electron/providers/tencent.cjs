'use strict';

const { MusicError, requestJson, decodeAudioBytes } = require('./shared.cjs');

const ENDPOINT = 'https://tokenhub.tencentmaas.com/v1/wand/minimax-music/generation';
const DEFAULT_MODEL = 'minimax-music-v3.0';
const MODELS = Object.freeze(['minimax-music-v3.0', 'minimax-music-v2.6']);
const DEFAULT_MAX_BYTES = 80 * 1024 * 1024;

function buildRequest(input) {
  if (!input || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.trim().length > 2000) {
    throw new MusicError('腾讯云音乐描述需要为 1–2000 个字符。');
  }
  const model = input.model ?? DEFAULT_MODEL;
  if (!MODELS.includes(model)) throw new MusicError('腾讯云音乐模型不受支持，请选择 MiniMax Music v3.0 或 v2.6。');
  let prompt = input.prompt.trim();
  if (input.duration !== undefined) {
    if (typeof input.duration !== 'number' || !Number.isFinite(input.duration) || input.duration < 3 || input.duration > 600) {
      throw new MusicError('期望音乐时长需要在 3–600 秒之间。');
    }
    const hint = `\n目标时长约 ${Math.round(input.duration)} 秒；纯音乐，无人声。`;
    if (prompt.length + hint.length > 2000) throw new MusicError('描述过长，请缩短至 1960 个字符以内，为时长要求留出空间。');
    prompt += hint;
  }
  return { model, prompt, is_instrumental: true, lyrics_optimizer: false, output_format: 'hex',
    audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' } };
}

function serviceError(code) {
  if (code === 1002 || code === 429) return '腾讯云音乐服务触发限流，请稍后手动重试。';
  if (code === 1004 || code === 2049 || code === 401) return 'TokenHub API Key 无效或已过期，请检查密钥。';
  if (code === 1008 || code === 402) return '腾讯云账户余额或音乐额度不足，请检查后付费状态。';
  if (code === 403) return '请先在 TokenHub 控制台开通对应音乐模型的后付费权限。';
  if (code === 2013 || code === 400 || code === 422) return '腾讯云未接受音乐参数，请调整描述或检查所选模型。';
  if (code === 1026) return '腾讯云未通过内容审核，请调整音乐描述。';
  const suffix = typeof code === 'number' && Number.isFinite(code) ? `（服务码 ${code}）` : '';
  return `腾讯云音乐生成失败${suffix}，请检查 TokenHub 模型权限和账户状态后手动重试。`;
}

async function generate({ input, credentials, signal, fetchImpl = globalThis.fetch, maxBytes = DEFAULT_MAX_BYTES }) {
  const body = buildRequest({ ...input, model: input?.model ?? credentials?.model });
  const key = typeof credentials?.apiKey === 'string' ? credentials.apiKey.trim() : '';
  if (typeof key !== 'string' || key.length < 10 || key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new MusicError('请填写完整的腾讯云 TokenHub API Key。');
  }
  signal?.throwIfAborted();
  const result = await requestJson(fetchImpl, ENDPOINT, {
    method: 'POST', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { maxBytes: maxBytes * 2 + 65536 });
  signal?.throwIfAborted();
  if (result?.base_resp?.status_code !== 0) throw new MusicError(serviceError(result?.base_resp?.status_code));
  if (result?.data?.status !== 2) throw new MusicError('腾讯云尚未返回完整音乐。为避免重复计费，本次不会自动重发；请检查控制台记录后手动重试。');
  const hex = result.data.audio;
  if (typeof hex === 'string' && hex.length / 2 > maxBytes) throw new MusicError('腾讯云返回的音乐文件过大，请缩短期望时长后重试。');
  if (typeof hex !== 'string' || hex.length < 8 || hex.length % 2 || !/^[\da-f]+$/i.test(hex)) {
    throw new MusicError('腾讯云返回的音频编码无效，请稍后手动重试。');
  }
  const audio = decodeAudioBytes(new Uint8Array(Buffer.from(hex, 'hex')));
  return audio;
}

module.exports = { generate, buildRequest, ENDPOINT, DEFAULT_MODEL, MODELS };
