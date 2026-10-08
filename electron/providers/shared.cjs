'use strict';

class MusicError extends Error { constructor(message) { super(message); this.name = 'MusicError'; } }

function httpMessage(status) {
  if (status === 401) return 'API Key 无效或已过期，请检查所选服务的密钥。';
  if (status === 403) return '没有音乐模型访问权限，请确认模型已开通、密钥权限和所属地域。';
  if (status === 402) return '账户额度不足，请检查所选音乐服务的余额。';
  if (status === 429) return '请求过多或额度不足，请检查控制台后稍后手动重试。';
  if ([400, 422].includes(status)) return '音乐服务未接受参数，请检查描述、模型及服务配置。';
  if (status >= 500) return '音乐服务暂时不可用。请求可能已受理，请先检查控制台再手动重试。';
  return `音乐服务返回错误（${status}），请检查服务配置。`;
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) { await response.body?.cancel().catch(() => {}); throw new MusicError('服务返回的数据过大，请缩短描述或生成时长。'); }
  if (!response.body) throw new MusicError('服务没有返回数据。');
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new MusicError('服务返回的数据超过文件大小限制。');
      chunks.push(value);
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  finally { reader.releaseLock(); }
  const data = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}

async function requestJson(fetchImpl, url, options, { maxBytes = 2 * 1024 * 1024 } = {}) {
  options?.signal?.throwIfAborted();
  const response = await fetchImpl(url, { ...options, redirect: 'error' });
  if (options?.signal?.aborted) { await response.body?.cancel().catch(() => {}); options.signal.throwIfAborted(); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new MusicError(httpMessage(response.status)); }
  const bytes = await readBounded(response, maxBytes);
  options?.signal?.throwIfAborted();
  try { const value = JSON.parse(new TextDecoder().decode(bytes)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new MusicError('音乐服务返回了无效结果。请检查服务记录，避免重复提交。'); }
}

function decodeAudioBytes(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.length < 4) throw new MusicError('音乐文件为空或已损坏。');
  const ascii = (at, length) => String.fromCharCode(...bytes.subarray(at, at + length));
  let mimeType;
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0)) mimeType = 'audio/mpeg';
  else if (bytes.length >= 44 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') mimeType = 'audio/wav';
  else if (ascii(0, 4) === 'fLaC') mimeType = 'audio/flac';
  else if (bytes.length >= 12 && ascii(4, 4) === 'ftyp') mimeType = 'audio/mp4';
  else throw new MusicError('服务返回的音频格式不受支持或文件已损坏。');
  // Strip Buffer pool offsets so IPC never exposes unrelated memory.
  const audio = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return { audio, mimeType };
}

async function readAudio(response, maxBytes = 80 * 1024 * 1024) {
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new MusicError(httpMessage(response.status)); }
  return decodeAudioBytes(await readBounded(response, maxBytes));
}

function downloadUrl(raw, allowedHostSuffixes, upgradeHttp) {
  let url; try { url = new URL(raw); } catch { throw new MusicError('服务返回的下载地址无效。'); }
  const host = url.hostname.toLowerCase();
  const allowed = allowedHostSuffixes.some(s => {const suffix=s.replace(/^\./,'').toLowerCase();return host===suffix || host.endsWith(`.${suffix}`);});
  if (!allowed || url.username || url.password || (url.port && url.port !== '443') || !['https:', 'http:'].includes(url.protocol)) throw new MusicError('服务返回了非官方音频下载地址，已停止下载。');
  if (url.protocol === 'http:') { if (!upgradeHttp) throw new MusicError('音频下载地址必须使用 HTTPS。'); url.protocol = 'https:'; }
  return url;
}

async function downloadAudio(rawUrl, { fetchImpl = globalThis.fetch, signal, maxBytes = 80 * 1024 * 1024, allowedHostSuffixes, upgradeHttp = true }) {
  if (!Array.isArray(allowedHostSuffixes) || !allowedHostSuffixes.length) throw new MusicError('缺少音频下载域名配置。');
  let current = downloadUrl(rawUrl, allowedHostSuffixes, upgradeHttp);
  for (let n = 0; n < 5; n++) {
    signal?.throwIfAborted();
    // No credentials are ever sent to a result/CDN URL.
    const response = await fetchImpl(current.href, { method: 'GET', signal, redirect: 'manual', headers: { Accept: 'audio/*,application/octet-stream' } });
    if (signal?.aborted) { await response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel().catch(() => {});
      if (!location) throw new MusicError('音频下载重定向无效。');
      current = downloadUrl(new URL(location, current).href, allowedHostSuffixes, upgradeHttp); continue;
    }
    const result = await readAudio(response, maxBytes);
    signal?.throwIfAborted();
    return result;
  }
  throw new MusicError('音频下载重定向次数过多，请检查服务记录。');
}

module.exports = { MusicError, httpMessage, readBounded, requestJson, decodeAudioBytes, readAudio, downloadAudio };
