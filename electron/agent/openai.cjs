"use strict";

/**
 * Producer plan through any OpenAI-compatible chat/completions endpoint
 * (kind "openai": public HTTPS; kind "ollama": this computer only).
 * No SDK: one guarded fetch, no redirects, bounded reads, and nothing from the
 * upstream answer leaves this module except a validated plan and a model id.
 */
const {
  MusicError,
  readBounded,
  readErrorBody,
} = require("../providers/shared.cjs");
const { safeModelId } = require("../credentials.cjs");
const { validateBaseUrl, assertPublicHost } = require("./base-url.cjs");
const {
  buildMessages,
  buildSystemPrompt,
  completePlan,
  validatePlan,
  PLAN_SCHEMA,
} = require("./plan-schema.cjs");

const MAX_TOKENS = 4096;
const RETRY_DELAY_MS = 1500;
const MAX_ADAPTATIONS = 3;
/**
 * Bounds on what is read from the endpoint. An honest answer is a few kilobytes
 * (max_tokens is 4096); the whole body adds a reasoning side channel and usage
 * figures. Everything below is linear in these sizes, so a broken or hostile
 * endpoint cannot keep the main thread busy: the time limit and cancel still fire.
 */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_ANSWER_CHARS = 64 * 1024;
/** Parsing the candidates of one answer may cost this many times its length (see lastJsonObject). */
const PARSE_BUDGET_FACTOR = 4;
const MIN_CANDIDATE_COST = 64;

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function statusMessage(status, local) {
  if (status === 401)
    return "API Key 无效或已过期，请在设置中更新大模型的密钥。";
  if (status === 402) return "大模型账户余额不足，请充值后重试。";
  if (status === 403)
    return "当前密钥没有调用这个模型的权限，请在服务商控制台确认。";
  if (status === 404)
    return local
      ? "本机 Ollama 里没有这个模型。请先下载模型，或在设置中改成已安装的模型名称。"
      : "找不到这个模型或接口地址。请检查设置里的模型名称和接口地址（多数服务需要以 /v1 结尾）。";
  if (status === 429) return "大模型请求过于频繁或额度已用尽，请稍后再试。";
  if (status === 400 || status === 422)
    return "大模型没有接受这次请求，请检查模型名称是否正确，或换一个模型。";
  if (status >= 500)
    return local
      ? "本机 Ollama 出错了，请确认它正在运行且模型可以正常加载。"
      : "大模型服务暂时不可用，请稍后重试。";
  return `大模型服务返回了错误（${status}），请检查设置。`;
}

/** Text of the first choice. `reasoning_content` and other side channels are ignored on purpose. */
function messageText(data) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const content = choice?.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              typeof part === "string"
                ? part
                : part?.type === "text" && typeof part.text === "string"
                  ? part.text
                  : "",
            )
            .join("")
        : "";
  return {
    text,
    finishReason:
      typeof choice?.finish_reason === "string" ? choice.finish_reason : "",
  };
}

/**
 * The balanced {...} groups of the text as a tree: the top-level groups in the
 * order they appear, each with the groups directly inside it. Braces inside
 * JSON strings are ignored. A brace that never closes means the answer was cut
 * off there: that group and everything in it are left out, so a complete inner
 * object (one form section, say) can never be mistaken for the plan. One pass.
 */
function braceGroups(text) {
  const top = [];
  const open = [];
  let inString = false,
    escaped = false;
  let index = text.indexOf("{");
  while (index !== -1 && index < text.length) {
    const code = text.charCodeAt(index);
    if (open.length === 0) {
      // Always an opening brace here; quotes between groups are prose.
      open.push({ start: index, end: -1, inner: null });
    } else if (inString) {
      if (escaped) escaped = false;
      else if (code === 92)
        escaped = true; // backslash
      else if (code === 34) inString = false; // "
    } else if (code === 34) inString = true;
    else if (code === 123) open.push({ start: index, end: -1, inner: null });
    else if (code === 125) {
      const group = open.pop();
      group.end = index;
      if (open.length) {
        const parent = open[open.length - 1];
        if (parent.inner) parent.inner.push(group);
        else parent.inner = [group];
      } else {
        top.push(group);
        index = text.indexOf("{", index + 1);
        continue;
      }
    }
    index++;
  }
  return top;
}

/** A JSON object starts with a key or closes at once; prose in braces is told apart without parsing it. */
function startsLikeObject(text, group) {
  for (let index = group.start + 1; ; index++) {
    const code = text.charCodeAt(index);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13)
      return code === 34 || index === group.end;
  }
}

/**
 * The plan in a model's answer: the LAST complete top-level {...} that parses
 * as a JSON object and that `accept` takes (it returns the value to use, or
 * throws). Models that add prose put the answer at the end, after their
 * placeholders, examples and drafts, so the search runs from the end: however
 * many brace groups come first, a plan in the last one is found at once. Only
 * when no top-level group is the plan are the groups inside prose-in-braces
 * tried ("{{...}}", "{方案：{...}}"), last first as well.
 *
 * Returns null when the text holds no JSON object. When it holds some and none
 * is accepted, the refusal of the last one is thrown: that is the one the model
 * meant as its answer.
 *
 * Linear: one pass finds the groups, prose is rejected by its first character,
 * and what is handed to JSON.parse and to `accept` is paid for from a budget of
 * PARSE_BUDGET_FACTOR times the text (at least MIN_CANDIDATE_COST per
 * candidate). Every top-level object of a normal answer fits in it; a text
 * built to be parsed over and over runs out, and the search ends there.
 */
function lastJsonObject(text, accept) {
  let budget = Math.max(text.length, MIN_CANDIDATE_COST) * PARSE_BUDGET_FACTOR;
  let refusal = null;
  let accepted = null;
  const ACCEPTED = 1,
    REFUSED = 2,
    NOT_JSON = 3,
    SPENT = 4;
  const consider = (group) => {
    if (!startsLikeObject(text, group)) return NOT_JSON;
    const length = group.end - group.start + 1;
    const cost = Math.max(length, MIN_CANDIDATE_COST);
    if (budget < cost) return SPENT;
    budget -= cost;
    let value;
    try {
      value = JSON.parse(text.slice(group.start, group.end + 1));
    } catch {
      return NOT_JSON; // prose in braces
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      return NOT_JSON;
    budget -= Math.min(budget, length);
    try {
      accepted = { value: accept(value) };
      return ACCEPTED;
    } catch (error) {
      if (!refusal) refusal = { error };
      return REFUSED;
    }
  };
  const search = () => {
    const top = braceGroups(text);
    const prose = [];
    for (let at = top.length - 1; at >= 0; at--) {
      const outcome = consider(top[at]);
      if (outcome === ACCEPTED || outcome === SPENT) return;
      if (outcome === NOT_JSON && top[at].inner) prose.push(top[at]);
    }
    // Popped from the end: the last group inside the last piece of prose comes first.
    const waiting = [];
    for (let at = prose.length - 1; at >= 0; at--)
      for (const group of prose[at].inner) waiting.push(group);
    while (waiting.length) {
      const group = waiting.pop();
      const outcome = consider(group);
      if (outcome === ACCEPTED || outcome === SPENT) return;
      if (outcome === NOT_JSON && group.inner)
        for (const inner of group.inner) waiting.push(inner);
    }
  };
  search();
  if (accepted) return accepted.value;
  if (refusal) throw refusal.error;
  return null;
}

const THINK_TAG = /<(\/?)think(?:ing)?>/gi;
/**
 * Remove reasoning blocks: <think>…</think> pairs, and everything up to a closing
 * tag whose opening tag was cut off by the server. An opening tag that never
 * closes is left alone. A single scan over the tags (no backtracking).
 */
function stripReasoning(text) {
  let kept = "",
    cursor = 0,
    openAt = -1;
  for (const match of text.matchAll(THINK_TAG)) {
    if (!match[1]) {
      if (openAt === -1) openAt = match.index;
    } else if (openAt !== -1) {
      kept += `${text.slice(cursor, openAt)} `;
      openAt = -1;
      cursor = match.index + match[0].length;
    } else {
      kept = " ";
      cursor = match.index + match[0].length;
    }
  }
  return kept + text.slice(cursor);
}

/**
 * Remove reasoning blocks and code fences that models wrap around the JSON, then
 * find the plan (see lastJsonObject). Without `accept` any JSON object will do.
 */
function extractPlanObject(text, accept = (value) => value) {
  if (typeof text !== "string" || text.length > MAX_ANSWER_CHARS) return null;
  return lastJsonObject(
    stripReasoning(text).replace(/```[a-zA-Z0-9_-]*\s*/g, " "),
    accept,
  );
}

/**
 * Why a request never got an answer, from the error codes of either network
 * stack (Chromium: net::ERR_…; Node: cause.code). Only the class is used; the
 * raw text never leaves this module.
 */
function connectionFailure(error) {
  const seen = new Set();
  let text = "";
  const visit = (value) => {
    if (
      !value ||
      typeof value !== "object" ||
      seen.has(value) ||
      seen.size >= 8
    )
      return;
    seen.add(value);
    text += ` ${typeof value.code === "string" ? value.code : ""} ${typeof value.message === "string" ? value.message.slice(0, 200) : ""}`;
    visit(value.cause);
    if (Array.isArray(value.errors))
      for (const inner of value.errors.slice(0, 4)) visit(inner);
  };
  visit(error);
  if (/ERR_UNSAFE_PORT|bad port/i.test(text)) return "port";
  // Nothing is listening on that port.
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(text)) return "refused";
  // The address cannot be used, or something answered that does not speak HTTP.
  if (
    /ERR_ADDRESS_INVALID|ERR_ADDRESS_UNREACHABLE|EADDRNOTAVAIL|EHOSTUNREACH|ENETUNREACH|ERR_CONNECTION_RESET|ECONNRESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_INVALID_HTTP_RESPONSE|ERR_SSL_PROTOCOL_ERROR|UND_ERR_SOCKET|HPE_/.test(
      text,
    )
  )
    return "address";
  return "unknown";
}

function unreachableMessage(error, local) {
  if (!local)
    return "无法连接大模型服务。请检查网络和接口地址；如果需要代理，请确认系统代理已开启。";
  const kind = connectionFailure(error);
  // By far the most common case: Ollama has not been started.
  if (kind === "refused")
    return "无法连接本机的 Ollama：它没有运行，或不在设置的端口上。请先启动 Ollama，再确认设置里的地址和端口。";
  if (kind === "address")
    return "本机的这个地址或端口不可用：那里运行的不是 Ollama，或连接被中断。请检查设置里的地址和端口。";
  if (kind === "port")
    return "设置里的端口是受限端口，应用无法连接。请让 Ollama 改用其他端口（默认 11434），并在设置里更新地址。";
  return "无法连接本机的 Ollama。请确认 Ollama 已启动，且设置里的地址和端口正确。";
}

/**
 * Servers differ in what they accept. After an HTTP 400 the error text is searched
 * for the name of a parameter we sent (nothing else is read from it) and that one
 * parameter is downgraded. Returns false when there is nothing left to try.
 */
function adapt(body, detail) {
  if (
    body.response_format &&
    /response_format|json_schema|json_object/.test(detail)
  ) {
    if (body.response_format.type === "json_schema")
      body.response_format = { type: "json_object" };
    else delete body.response_format;
    return true;
  }
  if (body.max_tokens && detail.includes("max_completion_tokens")) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    return true;
  }
  if (body.reasoning_effort && detail.includes("reasoning")) {
    delete body.reasoning_effort;
    return true;
  }
  return false;
}

async function plan({
  settings,
  input,
  signal,
  fetchImpl = globalThis.fetch,
  maxBytes = MAX_BODY_BYTES,
  lookup,
  sleep = wait,
}) {
  const bodyLimit = Math.min(maxBytes, MAX_BODY_BYTES);
  const local = settings.kind === "ollama";
  // The stored address is checked again on every call: the policy may be stricter than when it was saved.
  const baseUrl = validateBaseUrl(
    local ? "ollama" : "openai",
    settings.baseUrl,
  );
  if (!local) await assertPublicHost(baseUrl, { lookup, signal });
  const { system, messages } = buildMessages(input);
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (!local && settings.apiKey)
    headers.Authorization = `Bearer ${settings.apiKey}`;
  const body = {
    model: settings.model,
    messages: [{ role: "system", content: system }, ...messages],
    max_tokens: MAX_TOKENS,
    response_format: { type: "json_object" },
  };
  if (local) {
    // Measured with a 9B local model: with thinking on it spent the whole token budget
    // reasoning (empty answer) or closed the JSON after the first field. Ollama can
    // switch thinking off and constrain the answer to the schema, so ask for both.
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "music_plan", strict: true, schema: PLAN_SCHEMA },
    };
    body.reasoning_effort = "none";
  }

  let adaptations = 0; // request-shape downgrades after an HTTP 400 (never billed)
  let retried = false; // one retry on 429 / 5xx at most
  for (;;) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        redirect: "error",
        signal,
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof MusicError) throw error;
      throw new MusicError(unreachableMessage(error, local));
    }
    if (!response.ok) {
      const status = response.status;
      const detail = JSON.stringify(
        (await readErrorBody(response)) ?? {},
      ).toLowerCase();
      signal?.throwIfAborted();
      if (
        status === 400 &&
        adaptations < MAX_ADAPTATIONS &&
        adapt(body, detail)
      ) {
        adaptations++;
        continue;
      }
      if ((status === 429 || status >= 500) && !retried) {
        retried = true;
        await sleep(RETRY_DELAY_MS, signal);
        continue;
      }
      throw new MusicError(statusMessage(status, local));
    }
    const unrecognised = () =>
      new MusicError(
        "大模型返回了无法识别的内容。请确认接口地址是 OpenAI 兼容接口。",
      );
    if (!response.body) throw unrecognised();
    let bytes;
    try {
      bytes = await readBounded(response, bodyLimit);
    } catch (error) {
      signal?.throwIfAborted();
      throw new MusicError(
        error instanceof MusicError
          ? "大模型返回的内容过大，已停止读取。"
          : "读取大模型的回答时连接中断了，请重试。",
      );
    }
    signal?.throwIfAborted();
    let data;
    try {
      data = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw unrecognised();
    }
    const { text, finishReason } = messageText(data);
    if (finishReason === "content_filter")
      throw new MusicError(
        "大模型拒绝了这次请求。请换一种描述，或改用离线规则生成。",
      );
    if (text.length > MAX_ANSWER_CHARS)
      throw new MusicError(
        "大模型返回的内容过长，不是一份编排方案。请重试，或换一个模型。",
      );
    // Used is the last object that is a valid plan, not merely the last pair of braces.
    const plan = extractPlanObject(text, (raw) =>
      validatePlan(completePlan(raw, input)),
    );
    if (!plan) {
      if (finishReason === "length")
        throw new MusicError(
          "大模型的回答被截断，没有得到完整方案。请换一个模型，或关闭它的深度思考后重试。",
        );
      throw new MusicError(
        "大模型没有按约定返回方案。请重试，或换一个更擅长结构化输出的模型。",
      );
    }
    return { plan, model: safeModelId(data?.model, settings.model) };
  }
}

/**
 * Load a model on this computer before the first real request: one request for a
 * single token. It carries the same system prompt as a plan request, so Ollama
 * also has that long, constant prefix evaluated and cached. Only for kind
 * "ollama" (a hosted service would bill it); the answer is discarded unread.
 */
async function warmUp({ settings, signal, fetchImpl = globalThis.fetch }) {
  if (settings.kind !== "ollama") return;
  const baseUrl = validateBaseUrl("ollama", settings.baseUrl);
  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: "你好" },
    ],
    max_tokens: 1,
  };
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    redirect: "error",
    signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  await response.body?.cancel().catch(() => {});
}

module.exports = {
  plan,
  warmUp,
  extractPlanObject,
  connectionFailure,
  MAX_TOKENS,
  MAX_BODY_BYTES,
  MAX_ANSWER_CHARS,
};
