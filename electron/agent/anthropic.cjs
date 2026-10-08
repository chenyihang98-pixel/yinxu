'use strict';

/**
 * Producer plan through the Claude API, using the official SDK.
 * The SDK is given our own fetch, so the system proxy, the no-redirect rule and
 * the response size cap apply to it as well, and unit tests can mock the wire.
 */
const { MusicError, safeReference } = require('../providers/shared.cjs');
const { ANTHROPIC_MODELS, safeModelId } = require('../credentials.cjs');
const { buildMessages, validatePlan, PLAN_SCHEMA } = require('./plan-schema.cjs');

const API_ORIGIN = 'https://api.anthropic.com';
const MAX_TOKENS = 16000;
const REQUEST_TIMEOUT_MS = 90_000;
// Server-side refusal fallback (beta) exists for these models only; Claude Haiku 5.5 has none.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

function loadSdk() {
  const sdk = require('@anthropic-ai/sdk');
  return sdk.Anthropic ?? sdk.default ?? sdk;
}

/** Pin every SDK request to the official API host, forbid redirects and cap the response size. */
function guardFetch(fetchImpl, maxBytes) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url));
    if (url.origin !== API_ORIGIN) throw new TypeError('Unexpected request target');
    const response = await fetchImpl(url.href, { ...init, redirect: 'error' });
    const tooLarge = () => new MusicError('Claude 返回的内容过大，已停止读取。请重试。');
    if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel().catch(() => {}); throw tooLarge(); }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let total = 0;
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { controller.close(); return; }
          total += value.byteLength;
          if (total > maxBytes) { await reader.cancel().catch(() => {}); controller.error(tooLarge()); return; }
          controller.enqueue(value);
        } catch (error) { controller.error(error); }
      },
      cancel(reason) { return reader.cancel(reason).catch(() => {}); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** SDK errors -> fixed Chinese messages, most specific class first. Raw upstream text never passes. */
function mapError(error, Anthropic) {
  if (error instanceof MusicError) return error;
  if (error?.cause instanceof MusicError) return error.cause;
  const withId = message => {
    const id = safeReference(error?.requestID);
    return new MusicError(id ? `${message}（请求编号 ${id}）` : message);
  };
  if (error instanceof Anthropic.AuthenticationError) return new MusicError('Claude API Key 无效或已过期，请在设置中更新。');
  if (error instanceof Anthropic.PermissionDeniedError) return new MusicError('当前密钥没有使用这个 Claude 模型的权限（可能受所在地区或组织设置限制），请在 Claude 控制台确认。');
  if (error instanceof Anthropic.NotFoundError) return new MusicError('所选的 Claude 模型当前不可用，请在设置中换一个模型。');
  if (error instanceof Anthropic.RateLimitError) return new MusicError('Claude 请求过于频繁或额度已用尽，请稍后再试。');
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new MusicError('连接 Claude 服务超时。请检查网络；如果需要代理，请确认系统代理已开启。');
  if (error instanceof Anthropic.APIConnectionError) return new MusicError('无法连接 Claude 服务。请检查网络；如果需要代理，请确认系统代理已开启。');
  if (error instanceof Anthropic.APIUserAbortError) return new MusicError('已取消本次编排。');
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    if (status === 400 || status === 422) return withId('Claude 没有接受这次请求，请换一个模型后重试。');
    if (status === 402) return new MusicError('Claude 账户余额不足，请充值后重试。');
    if (status === 413) return new MusicError('这次对话内容太长，Claude 无法处理。请缩短描述后重试。');
    if (status === 529) return new MusicError('Claude 服务当前繁忙（过载），请稍后再试。');
    if (status >= 500) return withId('Claude 服务暂时不可用，请稍后再试。');
    return withId(typeof status === 'number' ? `Claude 服务返回了错误（${status}），请稍后重试。` : '调用 Claude 失败，请稍后重试。');
  }
  return new MusicError('调用 Claude 失败，请稍后重试。');
}

function readPlan(response, requestedModel) {
  const invalid = () => new MusicError('Claude 返回的方案无法识别，请重试。');
  if (!response || typeof response !== 'object') throw invalid();
  // Check why the model stopped before trusting the content.
  if (response.stop_reason === 'refusal') throw new MusicError('Claude 出于安全策略拒绝了这次请求。请换一种描述，或改用离线规则生成。');
  if (response.stop_reason === 'max_tokens') throw new MusicError('Claude 的回答被截断，没有得到完整方案。请简化描述后重试。');
  const block = Array.isArray(response.content) ? response.content.find(item => item?.type === 'text' && typeof item.text === 'string') : null;
  if (!block) throw invalid();
  let parsed;
  try { parsed = JSON.parse(block.text); } catch { throw invalid(); }
  // A fallback model may have answered: report the model named by the response itself.
  return { plan: validatePlan(parsed), model: safeModelId(response.model, requestedModel) };
}

async function plan({ settings, input, signal, fetchImpl = globalThis.fetch, maxBytes = 1024 * 1024, Anthropic = loadSdk() }) {
  const model = settings.model;
  if (!ANTHROPIC_MODELS.includes(model)) throw new MusicError('所选 Claude 模型不受支持，请从列表中选择。');
  const { system, messages } = buildMessages(input);
  // baseURL and authToken are pinned so that ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN
  // in the user's environment can never redirect the stored key or change the auth scheme.
  const client = new Anthropic({ apiKey: settings.apiKey, authToken: null, baseURL: API_ORIGIN, fetch: guardFetch(fetchImpl, maxBytes), maxRetries: 1, timeout: REQUEST_TIMEOUT_MS });
  const body = { model, max_tokens: MAX_TOKENS, system, messages, output_config: { effort: 'medium', format: { type: 'json_schema', schema: PLAN_SCHEMA } } };
  let response;
  try {
    if (FALLBACK_MODELS.has(model)) {
      try {
        response = await client.beta.messages.create({ ...body, betas: [FALLBACK_BETA], fallbacks: 'default' }, { signal });
      } catch (error) {
        // An organisation without the fallback beta gets a 400 for the header alone;
        // such a request is never billed, so ask once more through the stable endpoint.
        if (!(error instanceof Anthropic.BadRequestError) || signal?.aborted) throw error;
        response = await client.messages.create(body, { signal });
      }
    } else {
      response = await client.messages.create(body, { signal });
    }
  } catch (error) { throw mapError(error, Anthropic); }
  return readPlan(response, model);
}

module.exports = { plan, API_ORIGIN, FALLBACK_BETA, FALLBACK_MODELS, MAX_TOKENS };
