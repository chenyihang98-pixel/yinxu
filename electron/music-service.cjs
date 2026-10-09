"use strict";
const {
  MusicError,
  cleanSecret,
  TASK_RUNNING_ADVICE,
} = require("./providers/shared.cjs");
const { validateProvider } = require("./credentials.cjs");
const { wasNotSent } = require("./net-fetch.cjs");

const MUSIC_ENDPOINT =
  "https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128";
const MAX_AUDIO_BYTES = 80 * 1024 * 1024;
const ALLOWED_MODELS = new Set(["music_v1", "music_v2", "music_v2_5"]);

function validateInput(input) {
  if (!input || typeof input !== "object" || typeof input.prompt !== "string") {
    throw new MusicError("请输入想要的背景音乐描述。");
  }
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 4100)
    throw new MusicError("音乐描述需要为 1–4100 个字符。");
  if (
    typeof input.duration !== "number" ||
    !Number.isFinite(input.duration) ||
    input.duration < 3 ||
    input.duration > 600
  ) {
    throw new MusicError("AI 音乐时长需要在 3–600 秒之间。");
  }
  const model = input.model ?? "music_v1";
  if (!ALLOWED_MODELS.has(model))
    throw new MusicError(
      "不支持的音乐模型，请选择已支持的 ElevenLabs Music 模型。",
    );
  return {
    prompt,
    music_length_ms: Math.round(input.duration * 1000),
    force_instrumental: true,
    model_id: model,
  };
}

function validateApiKey(key) {
  const text = cleanSecret(key);
  if (!text) throw new MusicError("API Key 格式不正确，请粘贴完整密钥。");
  return text;
}

function statusMessage(status) {
  if (status === 401) return "API Key 无效或已过期，请在设置中更新密钥。";
  if (status === 402) return "ElevenLabs 账户额度不足，请检查账户余额与套餐。";
  if (status === 403)
    return "此密钥没有音乐生成权限，请检查 ElevenLabs 的密钥权限与套餐。";
  if (status === 429)
    return "ElevenLabs 请求过多或额度已用尽，请检查账户后稍后重试。";
  if (status === 400 || status === 422)
    return "音乐服务未接受这段描述或参数，请调整描述后重试。";
  if (status >= 500) return "ElevenLabs 服务暂时不可用，请稍后手动重试。";
  return `音乐服务返回错误（${status}），请检查设置后手动重试。`;
}

async function readAudio(response, maxBytes) {
  const sizeHeader = Number(response.headers.get("content-length"));
  if (sizeHeader > maxBytes)
    throw new MusicError("音乐文件过大，请缩短时长后重试。");
  const contentType = (response.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (
    contentType !== "audio/mpeg" &&
    contentType !== "audio/mp3" &&
    contentType !== "application/octet-stream"
  ) {
    throw new MusicError("音乐服务没有返回可播放的 MP3 音频，请稍后手动重试。");
  }
  if (!response.body)
    throw new MusicError("音乐服务返回了空文件，请稍后手动重试。");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes)
        throw new MusicError("音乐文件过大，请缩短时长后重试。");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (total < 4)
    throw new MusicError("音乐服务返回了空文件或无效音频，请稍后手动重试。");
  const audio = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const id3 = audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33;
  const frame = audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0;
  if (!id3 && !frame)
    throw new MusicError("音乐服务返回的文件不是有效的 MP3 音频。");
  return { audio: audio.buffer, mimeType: "audio/mpeg" };
}

/** The promise's result, or a rejection as soon as the signal aborts (the promise itself is left to finish). */
function untilAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const BUSY = "已有一首 AI 音乐正在生成，请等待完成或取消。";
/** The billable request never left this computer: the one case in which a failure certainly costs nothing. */
const NOT_SENT = "这次请求还没有发出，不会计费。";
/**
 * A paid generation was asked for while an earlier paid result is still waiting
 * to be collected. Only the text of an error reaches the renderer, so the
 * message starts with a fixed phrase; `code` is for callers in this process.
 */
const PENDING_RESULT = "PENDING_RESULT";
const PENDING_RESULT_PREFIX = "还有一首已经付费的音乐没有取回";
function pendingRefusal(provider) {
  return Object.assign(
    new MusicError(
      `${PENDING_RESULT_PREFIX}，这次没有发出新的生成请求。请先点「重新下载」把它取回；确认不要它之后，才能开始新的生成。`,
    ),
    { code: PENDING_RESULT, provider },
  );
}

/**
 * `fetchImpl` carries everything that is free and repeatable (status queries,
 * downloads). `submitFetch` carries the one request of a generation that is
 * billed whenever the service receives it; the desktop app gives it a transport
 * that cannot re-send (see createBillingFetch in net-fetch.cjs). Tests inject
 * one function for both. When that transport rejects with an error for which
 * wasNotSent() holds, the request never left this computer, and the failure is
 * reported as such instead of as an unconfirmed (possibly billed) one.
 */
function createMusicService({
  fetchImpl = globalThis.fetch,
  submitFetch = fetchImpl,
  timeoutMs = 300_000,
  maxBytes = MAX_AUDIO_BYTES,
} = {}) {
  let active = null;
  /**
   * The one paid result that has not reached the user:
   *   { provider, reference, fetchAgain, resume }
   * `fetchAgain` when the music exists and only its file is missing (download
   * it again); otherwise `resume`, for a task that was accepted but had not
   * finished when the wait ended (wait for it again, then download). Neither
   * submits anything. Kept in memory only. While it exists a new generation is
   * refused unless the caller says it may be given up (`discardPending`).
   */
  let pending = null;

  function start() {
    const job = {
      controller: new AbortController(),
      cancelled: false,
      timedOut: false,
      taskRef: "",
      taskLabel: "任务编号",
      fetchAgain: null,
      resume: null,
      // The billable request was handed to the transport / the transport says it never went out.
      submitted: false,
      unsent: false,
    };
    active = job;
    job.timer = setTimeout(() => {
      job.timedOut = true;
      job.controller.abort();
    }, timeoutMs);
    // An adapter that has a server-side task or request id reports it, so it can be quoted if we stop waiting.
    job.reference = () =>
      job.taskRef ? `（${job.taskLabel} ${job.taskRef}）` : "";
    return job;
  }
  function finish(job) {
    clearTimeout(job.timer);
    // Close unconsumed response streams too (e.g. an oversized Content-Length).
    job.controller.abort();
    if (active === job) active = null;
  }
  /** Why a job that already has a finished result on the server stopped before the file arrived. */
  function downloadStopped(job, error, reference) {
    if (job.timedOut)
      return new MusicError(
        `下载等待超过 5 分钟，已停止。音乐已经生成，重新生成会再次计费：请先检查网络，再到服务控制台找回这首音乐。${reference}`,
      );
    if (job.cancelled)
      return new MusicError(
        `已取消下载。音乐已经生成，重新生成会再次计费：需要时请到服务控制台找回这首音乐。${reference}`,
      );
    if (error instanceof MusicError) return error;
    return new MusicError(
      `音乐已生成，但下载失败。重新生成会再次计费：请先检查网络，再到服务控制台找回这首音乐。${reference}`,
    );
  }
  /** Why the wait for an accepted task ended before the task did. The task is kept: it can be collected later. */
  function taskStopped(job, error, reference) {
    if (job.timedOut)
      return new MusicError(
        `AI 生成等待超过 5 分钟，已停止等待。${TASK_RUNNING_ADVICE}${reference}`,
      );
    if (job.cancelled)
      return new MusicError(
        `已取消等待生成。${TASK_RUNNING_ADVICE}${reference}`,
      );
    if (error instanceof MusicError) return error;
    return new MusicError(
      `无法确认任务的状态。${TASK_RUNNING_ADVICE}${reference}`,
    );
  }

  return {
    get busy() {
      return active !== null;
    },
    /** The service whose paid result is waiting to be collected, or null. */
    get pendingDownload() {
      return pending ? pending.provider : null;
    },
    /**
     * The same, with what is waiting: "download" (the music exists, its file
     * has not arrived) or "task" (accepted by the service, not finished when the
     * wait ended). retryLastDownload() collects either without a new submission.
     */
    get pendingResult() {
      return pending
        ? {
            provider: pending.provider,
            kind: pending.fetchAgain ? "download" : "task",
          }
        : null;
    },
    cancel() {
      if (active) {
        active.cancelled = true;
        active.controller.abort();
      }
    },
    /**
     * `credentials` is the stored configuration (or a bare ElevenLabs key), or a
     * function returning it. The function form is read only after the lock is
     * taken, so a cancel that arrives while the key store is being read still
     * cancels this job instead of being lost.
     *
     * While a paid result is waiting to be collected the call is refused
     * (code PENDING_RESULT) unless `input.discardPending` is true. The waiting
     * result is then given up at the moment this job's own paid request goes
     * out - not earlier, so a job that sends nothing takes nothing away.
     */
    async generate(input, credentials) {
      // Keep the lock until the original request has settled, including cancellation.
      if (active) throw new MusicError(BUSY);
      const provider = validateProvider(input?.provider);
      if (
        !input ||
        typeof input.prompt !== "string" ||
        !input.prompt.trim() ||
        input.prompt.length > 4100 ||
        typeof input.duration !== "number" ||
        !Number.isFinite(input.duration) ||
        input.duration < 3 ||
        input.duration > 600
      )
        throw new MusicError("音乐描述或时长无效，请检查参数。");
      if (pending && input.discardPending !== true)
        throw pendingRefusal(pending.provider);
      const job = start();
      // Every adapter sends its one billable request through here.
      const submit = async (url, options) => {
        const displaced = pending;
        job.submitted = true;
        pending = null;
        try {
          return await submitFetch(url, options);
        } catch (error) {
          if (wasNotSent(error)) {
            job.unsent = true;
            pending = displaced;
          }
          throw error;
        }
      };
      try {
        // Nothing has been sent yet, so a cancel or timeout during the read may answer at once.
        const loaded =
          typeof credentials === "function"
            ? await untilAborted(credentials(), job.controller.signal)
            : credentials;
        if (job.cancelled || job.timedOut) throw new Error("aborted");
        const config = typeof loaded === "string" ? { apiKey: loaded } : loaded;
        const body =
          provider === "elevenlabs"
            ? validateInput({ ...input, model: input.model ?? config?.model })
            : null;
        const key =
          provider === "elevenlabs" ? validateApiKey(config?.apiKey) : null;
        if (provider !== "elevenlabs") {
          const adapter = require(`./providers/${provider}.cjs`);
          const result = await adapter.generate({
            input,
            credentials: config,
            signal: job.controller.signal,
            fetchImpl,
            submitFetch: submit,
            maxBytes,
            onTask: (taskRef, label) => {
              job.taskRef = String(taskRef);
              if (typeof label === "string" && label) job.taskLabel = label;
            },
            // A paid task exists from this point: remember how to wait for it again
            // (null: it ended without a result, nothing is left to wait for).
            onRunning: (resume) => {
              job.resume = typeof resume === "function" ? resume : null;
            },
            // The music exists on the server from this point: remember how to fetch it.
            onResult: (fetchAgain) => {
              if (typeof fetchAgain === "function") job.fetchAgain = fetchAgain;
            },
          });
          if (job.cancelled || job.timedOut) throw new Error("aborted");
          return result;
        }
        // Never retry a generation automatically: each request may incur a charge.
        const response = await submit(MUSIC_ENDPOINT, {
          method: "POST",
          redirect: "error",
          signal: job.controller.signal,
          headers: {
            "xi-api-key": key,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new MusicError(statusMessage(response.status));
        }
        const result = await readAudio(response, maxBytes);
        if (job.cancelled || job.timedOut) throw new Error("aborted");
        return result;
      } catch (error) {
        if (job.fetchAgain || job.resume) {
          const reference = job.reference();
          pending = {
            provider,
            reference,
            fetchAgain: job.fetchAgain,
            resume: job.fetchAgain ? null : job.resume,
          };
          throw job.fetchAgain
            ? downloadStopped(job, error, reference)
            : taskStopped(job, error, reference);
        }
        if (!job.submitted || job.unsent) {
          if (job.timedOut)
            throw new MusicError(
              `AI 生成等待超过 5 分钟，已停止等待。${NOT_SENT}`,
            );
          if (job.cancelled)
            throw new MusicError(`已取消等待生成。${NOT_SENT}`);
          // Missing credentials, a refused parameter: the adapter's own words.
          if (!job.unsent && error instanceof MusicError) throw error;
          throw new MusicError(
            job.unsent
              ? "没有发出请求，不会计费：应用没能为这次付费请求准备好独立的网络连接。请稍后重试；如果反复出现，请重启应用。"
              : "没有发出请求，不会计费：应用在发送之前出了问题。请稍后重试；如果反复出现，请重启应用。",
          );
        }
        if (job.timedOut)
          throw new MusicError(
            `AI 生成等待超过 5 分钟，已停止等待。服务端任务可能仍在运行，请先检查账户记录再重试。${job.reference()}`,
          );
        if (job.cancelled)
          throw new MusicError(
            `已取消等待生成。服务端可能仍会完成并计费，请先检查账户记录再重试。${job.reference()}`,
          );
        if (error instanceof MusicError) throw error;
        // Do not forward upstream response bodies, headers, URLs, or raw network errors.
        throw new MusicError(
          "无法连接音乐服务，请检查网络。请求结果未确认，先查看服务控制台记录，再决定是否手动重试。",
        );
      } finally {
        finish(job);
      }
    },
    /**
     * Collect the paid result of `provider` that is waiting: download the
     * finished file again, or - for a task that had not finished - go on
     * querying it (as bounded as the first wait) and then download. No new
     * submission, nothing billed. Same result as generate(); the address never
     * leaves the main process. Shares the lock (and cancel, and the time limit)
     * with generate(). The result stays available until it has been delivered,
     * or until the service reports that the task ended without one.
     */
    async retryLastDownload(provider) {
      if (active) throw new MusicError(BUSY);
      const requested = validateProvider(
        typeof provider === "string" ? provider : null,
      );
      const entry = pending;
      if (!entry || entry.provider !== requested)
        throw new MusicError(
          "没有等待重新下载的音乐。如需这首音乐，请到服务控制台查找，或重新生成。",
        );
      const job = start();
      try {
        const context = { signal: job.controller.signal, fetchImpl, maxBytes };
        const result = entry.fetchAgain
          ? await entry.fetchAgain(context)
          : await entry.resume({
              ...context,
              // The task has finished: from now on only its file is missing.
              onResult: (fetchAgain) => {
                if (typeof fetchAgain !== "function") return;
                entry.fetchAgain = fetchAgain;
                entry.resume = null;
              },
              onRunning: (resume) => {
                if (typeof resume !== "function") entry.resume = null;
              },
            });
        if (job.cancelled || job.timedOut) throw new Error("aborted");
        if (pending === entry) pending = null;
        return result;
      } catch (error) {
        if (entry.fetchAgain)
          throw downloadStopped(job, error, entry.reference);
        if (entry.resume) throw taskStopped(job, error, entry.reference);
        // The task ended without a result: there is nothing to keep.
        if (pending === entry) pending = null;
        throw error instanceof MusicError
          ? error
          : new MusicError(
              `这个任务没有产生可以取回的音乐，请先检查账户记录。${entry.reference}`,
            );
      } finally {
        finish(job);
      }
    },
    /**
     * Give up the paid result of `provider` that is waiting to be collected
     * (the user said so): it can no longer be fetched, and the next generation
     * is not refused because of it. Returns whether there was one.
     */
    discardPending(provider) {
      if (active) throw new MusicError(BUSY);
      const requested = validateProvider(
        typeof provider === "string" ? provider : null,
      );
      if (!pending || pending.provider !== requested) return false;
      pending = null;
      return true;
    },
  };
}

function safeFilename(name, format) {
  if (!["wav", "mp3", "m4a", "flac", "json"].includes(format))
    throw new MusicError("不支持的导出格式。");
  let base = typeof name === "string" ? name.normalize("NFKC") : "Muse-BGM";
  base = base
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\.(wav|mp3|m4a|flac|json)$/i, "")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 100);
  if (!base || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(base))
    base = "Muse-BGM";
  return `${base}.${format}`;
}

const EXTERNAL_URLS = new Set([
  "https://elevenlabs.io/app/settings/api-keys",
  "https://elevenlabs.io/app/developers/api-keys",
  "https://elevenlabs.io/docs/api-reference/music/compose",
  "https://elevenlabs.io/docs/overview/capabilities/music",
  "https://elevenlabs.io/pricing",
  "https://cloud.tencent.com/document/product/1823/135323",
  "https://cloud.tencent.cn/document/product/1823/135323",
  "https://console.cloud.tencent.com/tokenhub",
  "https://console.volcengine.com/ai-music/product",
  "https://console.volcengine.com/iam/keymanage/",
  "https://docs.volcengine.com/docs/Audiovideounderstandingandprocessing/Generatepuremusic?lang=zh",
  "https://help.aliyun.com/zh/model-studio/fun-music",
  "https://help.aliyun.com/zh/model-studio/get-api-key",
  "https://bailian.console.aliyun.com/",
  // Producer agent: where to get a key for each large-language-model preset.
  "https://platform.claude.com/settings/keys",
  "https://console.anthropic.com/settings/keys",
  "https://platform.deepseek.com/api_keys",
  "https://bailian.console.aliyun.com/?tab=model#/api-key",
  "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
  "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
  "https://platform.moonshot.cn/console/api-keys",
  "https://cloud.siliconflow.cn/account/ak",
  "https://platform.openai.com/api-keys",
  "https://openrouter.ai/settings/keys",
  "https://ollama.com/download",
  "https://ollama.com/library",
]);

function isAllowedExternal(url) {
  return typeof url === "string" && EXTERNAL_URLS.has(url);
}

module.exports = {
  createMusicService,
  validateInput,
  validateApiKey,
  safeFilename,
  isAllowedExternal,
  MusicError,
  MAX_AUDIO_BYTES,
  PENDING_RESULT,
  PENDING_RESULT_PREFIX,
};
