"use strict";

/**
 * The producer agent's desk in the main process: one plan request at a time,
 * cancellable, with a time limit (90 s for a hosted service, 240 s for a model
 * on this computer), and nothing but a validated plan and a model id ever goes
 * back to the renderer.
 *
 * Deliberately separate from the music service: planning and generating are two
 * steps the user can cancel independently, and a plan costs cents, not a song.
 */
const { MusicError } = require("./providers/shared.cjs");
const { normalizeLlmSettings, safeModelId } = require("./credentials.cjs");
const { validatePlanInput, validatePlan } = require("./agent/plan-schema.cjs");

const MAX_RESPONSE_BYTES = 1024 * 1024;
const HOSTED_TIMEOUT_MS = 90_000;
/**
 * A local model first has to be read from disk into memory: 92 s was not enough
 * for a 9B model's first answer after a start, while later answers took 26–67 s.
 */
const LOCAL_TIMEOUT_MS = 240_000;
const defaultAdapters = {
  // Loaded on first use: the Anthropic SDK is not needed until someone picks Claude.
  get anthropic() {
    return require("./agent/anthropic.cjs");
  },
  get openai() {
    return require("./agent/openai.cjs");
  },
};

function createAgentService({
  fetchImpl = globalThis.fetch,
  timeoutMs = HOSTED_TIMEOUT_MS,
  localTimeoutMs = LOCAL_TIMEOUT_MS,
  warmUpTimeoutMs = LOCAL_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES,
  adapters = defaultAdapters,
  lookup,
} = {}) {
  let active = null;
  let warming = null;
  const stopWarmUp = () => {
    if (warming) {
      warming.abort();
      warming = null;
    }
  };
  return {
    get busy() {
      return active !== null;
    },
    get warming() {
      return warming !== null;
    },
    /** Stops the plan in flight and any warm-up; also what the app calls when it quits. */
    cancel() {
      stopWarmUp();
      if (active) {
        active.cancelled = true;
        active.controller.abort();
      }
    },
    stopWarmUp,
    /**
     * Best effort, in the background: ask a model on this computer for one token so
     * it is in memory before the user's first message. Does nothing for a hosted
     * service (that would be a billed request nobody asked for). Never rejects and
     * never reports anything: whatever is wrong shows up, with a proper message,
     * when a real request is made. `settings` is as for plan().
     */
    warmUp(settings) {
      stopWarmUp();
      const controller = new AbortController();
      warming = controller;
      const timer = setTimeout(() => controller.abort(), warmUpTimeoutMs);
      timer.unref?.();
      return (async () => {
        try {
          const stored = normalizeLlmSettings(
            typeof settings === "function" ? await settings() : settings,
          );
          if (stored.kind !== "ollama" || controller.signal.aborted || active)
            return;
          await adapters.openai.warmUp?.({
            settings: stored,
            signal: controller.signal,
            fetchImpl,
          });
        } catch {
          /* best effort */
        } finally {
          clearTimeout(timer);
          if (warming === controller) warming = null;
        }
      })();
    },
    /**
     * `input` is the untrusted AgentPlanInput from the renderer. `settings` is the
     * stored LLM configuration or a function returning it; it is read only after
     * the lock is taken, so a cancel that arrives during the read still counts.
     */
    async plan(input, settings) {
      if (active)
        throw new MusicError("上一次编排还在进行，请等待完成或先取消。");
      const request = validatePlanInput(input);
      const job = {
        controller: new AbortController(),
        cancelled: false,
        timedOut: false,
        limit: timeoutMs,
        local: false,
      };
      active = job;
      // The user is waiting for this one: a warm-up still in flight gives way.
      stopWarmUp();
      const started = Date.now();
      let timer;
      const arm = (limit) => {
        clearTimeout(timer);
        job.limit = limit;
        timer = setTimeout(
          () => {
            job.timedOut = true;
            job.controller.abort();
          },
          Math.max(0, limit - (Date.now() - started)),
        );
      };
      arm(timeoutMs);
      const signal = job.controller.signal;
      // Cancel and timeout answer at once; whatever the abandoned call returns later is dropped.
      const interrupted = new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
      const work = (async () => {
        const stored = normalizeLlmSettings(
          typeof settings === "function" ? await settings() : settings,
        );
        signal.throwIfAborted();
        if (stored.kind === "ollama") {
          job.local = true;
          arm(localTimeoutMs);
        }
        const adapter =
          stored.kind === "anthropic" ? adapters.anthropic : adapters.openai;
        const result = await adapter.plan({
          settings: stored,
          input: request,
          signal,
          fetchImpl,
          maxBytes,
          lookup,
        });
        // Checked again here, whichever adapter produced it: only known, typed plan fields cross the IPC boundary.
        return {
          plan: validatePlan(result?.plan),
          model: safeModelId(result?.model, stored.model),
        };
      })();
      work.catch(() => {});
      try {
        const result = await Promise.race([work, interrupted]);
        if (job.cancelled || job.timedOut) throw new Error("aborted");
        return result;
      } catch (error) {
        if (job.timedOut) {
          const seconds = Math.round(job.limit / 1000);
          throw new MusicError(
            job.local
              ? `本机模型超过 ${seconds} 秒没有回应，已停止等待。请确认 Ollama 运行正常，或换一个更小的模型；也可以先用离线规则生成。`
              : `大模型超过 ${seconds} 秒没有回应，已停止等待。可以稍后重试，或先用离线规则生成。`,
          );
        }
        if (job.cancelled) throw new MusicError("已取消本次编排。");
        if (error instanceof MusicError) throw error;
        // Network errors, SDK internals and anything unexpected stay inside the main process.
        throw new MusicError(
          "大模型调用失败，请稍后重试，或先用离线规则生成。",
        );
      } finally {
        clearTimeout(timer);
        job.controller.abort();
        if (active === job) active = null;
      }
    },
  };
}

module.exports = {
  createAgentService,
  MAX_RESPONSE_BYTES,
  HOSTED_TIMEOUT_MS,
  LOCAL_TIMEOUT_MS,
};
