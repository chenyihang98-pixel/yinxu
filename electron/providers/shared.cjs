"use strict";

class MusicError extends Error {
  constructor(message) {
    super(message);
    this.name = "MusicError";
  }
}

/** One limit for every stored or transmitted secret (API keys, AK/SK, bearer tokens). */
const SECRET_MIN = 10;
const SECRET_MAX = 4096;
/** Trimmed printable-ASCII secret without spaces, or null when it cannot be one. */
function cleanSecret(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= SECRET_MIN &&
    text.length <= SECRET_MAX &&
    /^[\x21-\x7e]+$/.test(text)
    ? text
    : null;
}

/** Vendor request / trace / task ids are echoed only when they look like an id, never as free text. */
function safeReference(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(value)
    ? value
    : "";
}
function withReference(message, label, value) {
  const reference = safeReference(value);
  return reference ? `${message}（${label} ${reference}）` : message;
}

function httpMessage(status) {
  if (status === 401) return "API Key 无效或已过期，请检查所选服务的密钥。";
  if (status === 403)
    return "没有音乐模型访问权限，请确认模型已开通、密钥权限和所属地域。";
  if (status === 402) return "账户额度不足，请检查所选音乐服务的余额。";
  if (status === 429) return "请求过多或额度不足，请检查控制台后稍后手动重试。";
  if ([400, 422].includes(status))
    return "音乐服务未接受参数，请检查描述、模型及服务配置。";
  if (status >= 500)
    return "音乐服务暂时不可用。请求可能已受理，请先检查控制台再手动重试。";
  return `音乐服务返回错误（${status}），请检查服务配置。`;
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new MusicError("服务返回的数据过大，请缩短描述或生成时长。");
  }
  if (!response.body) throw new MusicError("服务没有返回数据。");
  const reader = response.body.getReader(),
    chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes)
        throw new MusicError("服务返回的数据超过文件大小限制。");
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

const ERROR_BODY_BYTES = 64 * 1024;
/** Best-effort JSON object from a failed response; never throws and never reads more than 64 KiB. */
async function readErrorBody(response) {
  try {
    const value = JSON.parse(
      new TextDecoder().decode(await readBounded(response, ERROR_BODY_BYTES)),
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    await response.body?.cancel().catch(() => {});
    return null;
  }
}

/**
 * `onHttpError({status, body, headers})` lets an adapter turn an enumerated vendor
 * error code into its own safe message. It receives the bounded JSON body (or
 * null) and must return a fixed string or nothing; upstream text is never forwarded.
 */
async function requestJson(
  fetchImpl,
  url,
  options,
  { maxBytes = 2 * 1024 * 1024, onHttpError } = {},
) {
  options?.signal?.throwIfAborted();
  const response = await fetchImpl(url, { ...options, redirect: "error" });
  if (options?.signal?.aborted) {
    await response.body?.cancel().catch(() => {});
    options.signal.throwIfAborted();
  }
  if (!response.ok) {
    let message;
    if (typeof onHttpError === "function") {
      const body = await readErrorBody(response);
      try {
        message = onHttpError({
          status: response.status,
          body,
          headers: response.headers,
        });
      } catch {
        message = undefined;
      }
    } else await response.body?.cancel().catch(() => {});
    throw Object.assign(
      new MusicError(
        typeof message === "string" && message
          ? message
          : httpMessage(response.status),
      ),
      { status: response.status },
    );
  }
  const bytes = await readBounded(response, maxBytes);
  options?.signal?.throwIfAborted();
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw Object.assign(
      new MusicError("音乐服务返回了无效结果。请检查服务记录，避免重复提交。"),
      { invalidBody: true },
    );
  }
}

function decodeAudioBytes(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.length < 4) throw new MusicError("音乐文件为空或已损坏。");
  const ascii = (at, length) =>
    String.fromCharCode(...bytes.subarray(at, at + length));
  let mimeType;
  if (ascii(0, 3) === "ID3" || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0))
    mimeType = "audio/mpeg";
  else if (
    bytes.length >= 44 &&
    ascii(0, 4) === "RIFF" &&
    ascii(8, 4) === "WAVE"
  )
    mimeType = "audio/wav";
  else if (ascii(0, 4) === "fLaC") mimeType = "audio/flac";
  else if (bytes.length >= 12 && ascii(4, 4) === "ftyp") mimeType = "audio/mp4";
  else throw new MusicError("服务返回的音频格式不受支持或文件已损坏。");
  // Strip Buffer pool offsets so IPC never exposes unrelated memory.
  const audio = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return { audio, mimeType };
}

async function readAudio(response, maxBytes = 80 * 1024 * 1024) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new MusicError(httpMessage(response.status));
  }
  return decodeAudioBytes(await readBounded(response, maxBytes));
}

function downloadUrl(raw, allowedHostSuffixes, upgradeHttp, hostAllowed) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new MusicError("服务返回的下载地址无效。");
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    allowedHostSuffixes.some((s) => {
      const suffix = s.replace(/^\./, "").toLowerCase();
      return host === suffix || host.endsWith(`.${suffix}`);
    }) &&
    (!hostAllowed || hostAllowed(host) === true);
  if (
    !allowed ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !["https:", "http:"].includes(url.protocol)
  )
    throw new MusicError("服务返回了非官方音频下载地址，已停止下载。");
  if (url.protocol === "http:") {
    if (!upgradeHttp) throw new MusicError("音频下载地址必须使用 HTTPS。");
    url.protocol = "https:";
  }
  return url;
}

/**
 * Throws unless `rawUrl` is a result address downloadAudio would fetch. For an
 * adapter that wants to know this before it treats the result as retrievable.
 */
function assertDownloadUrl(
  rawUrl,
  { allowedHostSuffixes, upgradeHttp = true, hostAllowed },
) {
  if (!Array.isArray(allowedHostSuffixes) || !allowedHostSuffixes.length)
    throw new MusicError("缺少音频下载域名配置。");
  downloadUrl(rawUrl, allowedHostSuffixes, upgradeHttp, hostAllowed);
}

/**
 * Fetching a finished result costs nothing and can be repeated, unlike the
 * submission that produced it: a short network failure must not throw away
 * music that has already been paid for.
 */
const DOWNLOAD_ATTEMPTS = 4;
const DOWNLOAD_BACKOFF_MS = [1000, 2000, 4000];
const DOWNLOAD_ADVICE =
  "重新生成会再次计费：请先检查网络，再到服务控制台找回这首音乐。";
const isTransientStatus = (status) =>
  status === 408 || status === 429 || status >= 500;
/** The music exists but could not be fetched; `downloadFailed` marks it for callers. Never contains upstream text. */
function downloadFailure(detail) {
  return Object.assign(
    new MusicError(`音乐已生成，但下载失败（${detail}）。${DOWNLOAD_ADVICE}`),
    { downloadFailed: true },
  );
}

/**
 * A task was submitted (and may be billed) but had not finished when the app
 * stopped waiting. The music service keeps such a task, so the same button that
 * fetches a finished result again also resumes the wait - without a new submission.
 */
const TASK_RUNNING_ADVICE =
  "任务已经提交，可能仍在服务商那边运行并计费：点「重新下载」可以继续查询并取回这首音乐，不会再次提交，也不会再次计费。";

/** Resolves after `milliseconds`; rejects with the signal's reason as soon as it aborts. */
function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One attempt: the address policy is applied to the first URL and to every redirect hop. */
async function downloadOnce(
  rawUrl,
  {
    fetchImpl,
    signal,
    maxBytes,
    allowedHostSuffixes,
    upgradeHttp,
    hostAllowed,
  },
) {
  let current = downloadUrl(
    rawUrl,
    allowedHostSuffixes,
    upgradeHttp,
    hostAllowed,
  );
  for (let n = 0; n < 5; n++) {
    signal?.throwIfAborted();
    // No credentials are ever sent to a result/CDN URL.
    const response = await fetchImpl(current.href, {
      method: "GET",
      signal,
      redirect: "manual",
      headers: { Accept: "audio/*,application/octet-stream" },
    });
    if (signal?.aborted) {
      await response.body?.cancel().catch(() => {});
      signal.throwIfAborted();
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      let next;
      try {
        next = location ? new URL(location, current).href : "";
      } catch {
        next = "";
      }
      if (!next) throw new MusicError("音频下载重定向无效。");
      current = downloadUrl(
        next,
        allowedHostSuffixes,
        upgradeHttp,
        hostAllowed,
      );
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new MusicError(httpMessage(response.status)), {
        status: response.status,
      });
    }
    const result = decodeAudioBytes(await readBounded(response, maxBytes));
    signal?.throwIfAborted();
    return result;
  }
  throw new MusicError("音频下载重定向次数过多，请检查服务记录。");
}

/**
 * Download a finished result. Network errors (also in the middle of the body)
 * and HTTP 408 / 429 / 5xx are tried again, up to DOWNLOAD_ATTEMPTS in all, each
 * attempt starting over at `rawUrl` with the address checked again; everything
 * stays inside `signal`, so cancel and the job's time limit end it at once.
 * `hostAllowed(hostname)` optionally narrows the suffix allowlist on every hop.
 * A failure that says the result could not be fetched carries `downloadFailed`.
 */
async function downloadAudio(
  rawUrl,
  {
    fetchImpl = globalThis.fetch,
    signal,
    maxBytes = 80 * 1024 * 1024,
    allowedHostSuffixes,
    upgradeHttp = true,
    hostAllowed,
    attempts = DOWNLOAD_ATTEMPTS,
    sleep = pause,
  },
) {
  if (!Array.isArray(allowedHostSuffixes) || !allowedHostSuffixes.length)
    throw new MusicError("缺少音频下载域名配置。");
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadOnce(rawUrl, {
        fetchImpl,
        signal,
        maxBytes,
        allowedHostSuffixes,
        upgradeHttp,
        hostAllowed,
      });
    } catch (error) {
      signal?.throwIfAborted();
      const status = error instanceof MusicError ? error.status : undefined;
      // Refused addresses, bad redirects, oversized or unreadable files: another attempt would end the same way.
      if (error instanceof MusicError && status === undefined) throw error;
      if (status !== undefined && !isTransientStatus(status))
        throw downloadFailure(`文件服务器返回了 ${status}，下载链接可能已过期`);
      if (attempt >= attempts)
        throw downloadFailure(
          `已尝试 ${attempt} 次，网络不稳定或文件服务器暂时不可用`,
        );
      await sleep(
        DOWNLOAD_BACKOFF_MS[Math.min(attempt, DOWNLOAD_BACKOFF_MS.length) - 1],
        signal,
      );
      signal?.throwIfAborted();
    }
  }
}

module.exports = {
  MusicError,
  SECRET_MIN,
  SECRET_MAX,
  cleanSecret,
  safeReference,
  withReference,
  httpMessage,
  readBounded,
  readErrorBody,
  requestJson,
  decodeAudioBytes,
  readAudio,
  assertDownloadUrl,
  downloadAudio,
  DOWNLOAD_ATTEMPTS,
  TASK_RUNNING_ADVICE,
};
