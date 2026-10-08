'use strict';

/**
 * Producer plan through any OpenAI-compatible chat/completions endpoint
 * (kind "openai": public HTTPS; kind "ollama": this computer only).
 * No SDK: one guarded fetch, no redirects, bounded reads, and nothing from the
 * upstream answer leaves this module except a validated plan and a model id.
 */
const { MusicError, readBounded, readErrorBody } = require('../providers/shared.cjs');
const { safeModelId } = require('../credentials.cjs');
const { validateBaseUrl, assertPublicHost } = require('./base-url.cjs');
const { buildMessages, completePlan, validatePlan, PLAN_SCHEMA } = require('./plan-schema.cjs');

const MAX_TOKENS = 4096;
const RETRY_DELAY_MS = 1500;
const MAX_ADAPTATIONS = 3;

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function statusMessage(status, local) {
  if (status === 401) return 'API Key 无效或已过期，请在设置中更新大模型的密钥。';
  if (status === 402) return '大模型账户余额不足，请充值后重试。';
  if (status === 403) return '当前密钥没有调用这个模型的权限，请在服务商控制台确认。';
  if (status === 404) return local ? '本机 Ollama 里没有这个模型。请先下载模型，或在设置中改成已安装的模型名称。' : '找不到这个模型或接口地址。请检查设置里的模型名称和接口地址（多数服务需要以 /v1 结尾）。';
  if (status === 429) return '大模型请求过于频繁或额度已用尽，请稍后再试。';
  if (status === 400 || status === 422) return '大模型没有接受这次请求，请检查模型名称是否正确，或换一个模型。';
  if (status >= 500) return local ? '本机 Ollama 出错了，请确认它正在运行且模型可以正常加载。' : '大模型服务暂时不可用，请稍后重试。';
  return `大模型服务返回了错误（${status}），请检查设置。`;
}

/** Text of the first choice. `reasoning_content` and other side channels are ignored on purpose. */
function messageText(data) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const content = choice?.message?.content;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(part => (typeof part === 'string' ? part : part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('')
      : '';
  return { text, finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : '' };
}

/**
 * The first balanced {...} in the text that parses as a JSON object, ignoring
 * braces inside JSON strings. A brace that never closes means the answer was cut
 * off: nothing after it is used, so a complete inner object (one form section,
 * say) can never be mistaken for the plan.
 */
function firstJsonObject(text) {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0, inString = false, escaped = false, end = -1;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) { end = index; break; }
    }
    if (end === -1) return null;
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* prose in braces, not JSON: try the next opening brace */ }
  }
  return null;
}

/** Remove reasoning blocks and code fences that models wrap around the JSON, then find the object. */
function extractPlanObject(text) {
  const cleaned = text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, ' ')
    .replace(/^[\s\S]*<\/think(?:ing)?>/i, ' ') // an unterminated opening tag was cut by the server
    .replace(/```[a-zA-Z0-9_-]*\s*/g, ' ');
  return firstJsonObject(cleaned);
}

/**
 * Servers differ in what they accept. After an HTTP 400 the error text is searched
 * for the name of a parameter we sent (nothing else is read from it) and that one
 * parameter is downgraded. Returns false when there is nothing left to try.
 */
function adapt(body, detail) {
  if (body.response_format && /response_format|json_schema|json_object/.test(detail)) {
    if (body.response_format.type === 'json_schema') body.response_format = { type: 'json_object' };
    else delete body.response_format;
    return true;
  }
  if (body.max_tokens && detail.includes('max_completion_tokens')) {
    body.max_completion_tokens = body.max_tokens; delete body.max_tokens;
    return true;
  }
  if (body.reasoning_effort && detail.includes('reasoning')) { delete body.reasoning_effort; return true; }
  return false;
}

async function plan({ settings, input, signal, fetchImpl = globalThis.fetch, maxBytes = 1024 * 1024, lookup, sleep = wait }) {
  const local = settings.kind === 'ollama';
  // The stored address is checked again on every call: the policy may be stricter than when it was saved.
  const baseUrl = validateBaseUrl(local ? 'ollama' : 'openai', settings.baseUrl);
  if (!local) await assertPublicHost(baseUrl, { lookup, signal });
  const { system, messages } = buildMessages(input);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (!local && settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  const body = { model: settings.model, messages: [{ role: 'system', content: system }, ...messages], max_tokens: MAX_TOKENS, response_format: { type: 'json_object' } };
  if (local) {
    // Measured with a 9B local model: with thinking on it spent the whole token budget
    // reasoning (empty answer) or closed the JSON after the first field. Ollama can
    // switch thinking off and constrain the answer to the schema, so ask for both.
    body.response_format = { type: 'json_schema', json_schema: { name: 'music_plan', strict: true, schema: PLAN_SCHEMA } };
    body.reasoning_effort = 'none';
  }
  const unreachable = local
    ? '无法连接本机的 Ollama。请确认 Ollama 已启动，且设置里的地址和端口正确。'
    : '无法连接大模型服务。请检查网络和接口地址；如果需要代理，请确认系统代理已开启。';

  let adaptations = 0; // request-shape downgrades after an HTTP 400 (never billed)
  let retried = false; // one retry on 429 / 5xx at most
  for (;;) {
    signal?.throwIfAborted();
    let response;
    try { response = await fetchImpl(`${baseUrl}/chat/completions`, { method: 'POST', redirect: 'error', signal, headers, body: JSON.stringify(body) }); }
    catch (error) {
      signal?.throwIfAborted();
      if (error instanceof MusicError) throw error;
      throw new MusicError(unreachable);
    }
    if (!response.ok) {
      const status = response.status;
      const detail = JSON.stringify(await readErrorBody(response) ?? {}).toLowerCase();
      signal?.throwIfAborted();
      if (status === 400 && adaptations < MAX_ADAPTATIONS && adapt(body, detail)) { adaptations++; continue; }
      if ((status === 429 || status >= 500) && !retried) { retried = true; await sleep(RETRY_DELAY_MS, signal); continue; }
      throw new MusicError(statusMessage(status, local));
    }
    const unrecognised = () => new MusicError('大模型返回了无法识别的内容。请确认接口地址是 OpenAI 兼容接口。');
    if (!response.body) throw unrecognised();
    let bytes;
    try { bytes = await readBounded(response, maxBytes); }
    catch (error) {
      signal?.throwIfAborted();
      throw new MusicError(error instanceof MusicError ? '大模型返回的内容过大，已停止读取。' : '读取大模型的回答时连接中断了，请重试。');
    }
    signal?.throwIfAborted();
    let data;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw unrecognised(); }
    const { text, finishReason } = messageText(data);
    if (finishReason === 'content_filter') throw new MusicError('大模型拒绝了这次请求。请换一种描述，或改用内置规则生成。');
    const raw = extractPlanObject(text);
    if (!raw) {
      if (finishReason === 'length') throw new MusicError('大模型的回答被截断，没有得到完整方案。请换一个模型，或关闭它的深度思考后重试。');
      throw new MusicError('大模型没有按约定返回方案。请重试，或换一个更擅长结构化输出的模型。');
    }
    return { plan: validatePlan(completePlan(raw, input)), model: safeModelId(data?.model, settings.model) };
  }
}

module.exports = { plan, extractPlanObject, MAX_TOKENS };
