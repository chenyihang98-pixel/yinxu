'use strict';

/**
 * The producer agent's desk in the main process: one plan request at a time,
 * cancellable, 90 s at most, and nothing but a validated plan and a model id
 * ever goes back to the renderer.
 *
 * Deliberately separate from the music service: planning and generating are two
 * steps the user can cancel independently, and a plan costs cents, not a song.
 */
const { MusicError } = require('./providers/shared.cjs');
const { normalizeLlmSettings, safeModelId } = require('./credentials.cjs');
const { validatePlanInput, validatePlan } = require('./agent/plan-schema.cjs');

const MAX_RESPONSE_BYTES = 1024 * 1024;
const defaultAdapters = {
  // Loaded on first use: the Anthropic SDK is not needed until someone picks Claude.
  get anthropic() { return require('./agent/anthropic.cjs'); },
  get openai() { return require('./agent/openai.cjs'); },
};

function createAgentService({ fetchImpl = globalThis.fetch, timeoutMs = 90_000, maxBytes = MAX_RESPONSE_BYTES, adapters = defaultAdapters, lookup } = {}) {
  let active = null;
  return {
    get busy() { return active !== null; },
    cancel() {
      if (active) { active.cancelled = true; active.controller.abort(); }
    },
    /**
     * `input` is the untrusted AgentPlanInput from the renderer. `settings` is the
     * stored LLM configuration or a function returning it; it is read only after
     * the lock is taken, so a cancel that arrives during the read still counts.
     */
    async plan(input, settings) {
      if (active) throw new MusicError('上一次编排还在进行，请等待完成或先取消。');
      const request = validatePlanInput(input);
      const job = { controller: new AbortController(), cancelled: false, timedOut: false };
      active = job;
      const timer = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, timeoutMs);
      const signal = job.controller.signal;
      // Cancel and timeout answer at once; whatever the abandoned call returns later is dropped.
      const interrupted = new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      const work = (async () => {
        const stored = normalizeLlmSettings(typeof settings === 'function' ? await settings() : settings);
        signal.throwIfAborted();
        const adapter = stored.kind === 'anthropic' ? adapters.anthropic : adapters.openai;
        const result = await adapter.plan({ settings: stored, input: request, signal, fetchImpl, maxBytes, lookup });
        // Checked again here, whichever adapter produced it: only known, typed plan fields cross the IPC boundary.
        return { plan: validatePlan(result?.plan), model: safeModelId(result?.model, stored.model) };
      })();
      work.catch(() => {});
      try {
        const result = await Promise.race([work, interrupted]);
        if (job.cancelled || job.timedOut) throw new Error('aborted');
        return result;
      } catch (error) {
        if (job.timedOut) throw new MusicError(`大模型超过 ${Math.round(timeoutMs / 1000)} 秒没有回应，已停止等待。可以稍后重试，或先用内置规则生成。`);
        if (job.cancelled) throw new MusicError('已取消本次编排。');
        if (error instanceof MusicError) throw error;
        // Network errors, SDK internals and anything unexpected stay inside the main process.
        throw new MusicError('大模型调用失败，请稍后重试，或先用内置规则生成。');
      } finally {
        clearTimeout(timer);
        job.controller.abort();
        if (active === job) active = null;
      }
    },
  };
}

module.exports = { createAgentService, MAX_RESPONSE_BYTES };
