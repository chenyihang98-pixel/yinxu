"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Anthropic = require("@anthropic-ai/sdk");
const anthropic = require("../electron/agent/anthropic.cjs");
const { createAgentService } = require("../electron/agent-service.cjs");
const {
  PLAN_SCHEMA,
  buildSystemPrompt,
  validatePlanInput,
} = require("../electron/agent/plan-schema.cjs");

const KEY = "sk-ant-fake-key-for-tests-only";
const CURRENT = {
  style: "bright",
  instrument: "piano",
  key: "C major",
  bpm: 112,
  duration: 30,
  energy: 0.62,
  complexity: 0.5,
  reverb: 0.25,
  loop: true,
  volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 },
};
const RAW_INPUT = {
  mode: "refine",
  request: "再慢一点，换成钢琴",
  provider: "local",
  history: [
    { role: "user", text: "雨天咖啡馆里的慵懒爵士" },
    { role: "agent", text: "好的，已编排。" },
  ],
  current: CURRENT,
};
const INPUT = validatePlanInput(RAW_INPUT);
const PLAN = {
  reply: "已经放慢，并换成了钢琴。",
  title: "雨天特调",
  style: "jazz",
  instrument: "piano",
  key: "F major",
  bpm: 76,
  duration: 60,
  energy: 0.35,
  complexity: 0.6,
  reverb: 0.35,
  loop: true,
  newMelody: false,
  volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 },
  arrangement: {
    progression: ["ii7", "V7", "Imaj7", "vi7"],
    form: [],
    drums: "none",
    bass: "walking",
    swing: 0.4,
    layers: { pad: true, arp: false, counter: false, perc: false },
    melody: { density: -1, register: "mid", motion: "stepwise" },
  },
  reasoning: ["放慢速度", "主奏换成钢琴"],
  cloudPrompt: "慵懒的咖啡馆爵士，钢琴主奏，76 BPM，纯音乐，无人声，无歌词。",
};
const settings = (model = "claude-opus-5-5") => ({
  kind: "anthropic",
  preset: "claude",
  apiKey: KEY,
  model,
  baseUrl: "",
});
const REQUEST_ID = "req_011CSHoEeqs5C35K2UUqR7Fy";

function message({
  text = JSON.stringify(PLAN),
  model = "claude-opus-5-5",
  stop_reason = "end_turn",
  content,
} = {}) {
  return new Response(
    JSON.stringify({
      id: "msg_01",
      type: "message",
      role: "assistant",
      model,
      stop_reason,
      stop_sequence: null,
      content: content ?? [{ type: "text", text }],
      usage: { input_tokens: 2200, output_tokens: 480 },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json", "request-id": REQUEST_ID },
    },
  );
}
function apiError(
  status,
  type,
  text = `upstream detail that must not leak ${KEY}`,
) {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type, message: text },
      request_id: REQUEST_ID,
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "request-id": REQUEST_ID,
        "retry-after-ms": "1",
      },
    },
  );
}
/** A fetch mock that records each request the SDK makes. */
function recorder(respond) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method,
      redirect: init.redirect,
      signal: init.signal,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    };
    calls.push(call);
    return respond(call, calls.length);
  };
  return { calls, fetchImpl };
}
const plan = (fetchImpl, extra = {}) =>
  anthropic.plan({ settings: settings(), input: INPUT, fetchImpl, ...extra });
const safe = (error) =>
  error.name === "MusicError" &&
  !error.message.includes(KEY) &&
  !error.message.includes("upstream detail");

test("Claude Opus 5.5 / Sonnet 5.5: exact request through the SDK on the beta endpoint with server-side fallback", async () => {
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
    const { calls, fetchImpl } = recorder(() => message({ model }));
    const controller = new AbortController();
    const result = await anthropic.plan({
      settings: settings(model),
      input: INPUT,
      fetchImpl,
      signal: controller.signal,
    });
    assert.deepEqual(result, { plan: PLAN, model });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(call.method, "POST");
    assert.equal(call.redirect, "error");
    assert.ok(call.signal instanceof AbortSignal);
    assert.equal(call.headers["x-api-key"], KEY);
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers["anthropic-version"], "2023-06-01");
    assert.equal(
      call.headers["anthropic-beta"],
      "server-side-fallback-2026-07-01",
    );
    assert.equal(call.headers["content-type"], "application/json");
    assert.deepEqual(call.body, {
      model,
      max_tokens: 16000,
      system: buildSystemPrompt(),
      messages: [
        { role: "user", content: "雨天咖啡馆里的慵懒爵士" },
        { role: "assistant", content: "好的，已编排。" },
        {
          role: "user",
          content: `【模式】refine（修改当前作品）\n【生成方式】本地合成引擎\n【当前设置】${JSON.stringify(CURRENT)}\n【用户的话】\n<<<\n再慢一点，换成钢琴\n>>>`,
        },
      ],
      output_config: {
        effort: "medium",
        format: {
          type: "json_schema",
          schema: JSON.parse(JSON.stringify(PLAN_SCHEMA)),
        },
      },
      fallbacks: "default",
    });
    // Parameters current models reject, and no assistant prefill.
    for (const banned of [
      "temperature",
      "top_p",
      "top_k",
      "thinking",
      "tool_choice",
      "tools",
      "stream",
      "betas",
      "output_format",
    ])
      assert.equal(banned in call.body, false, banned);
    assert.equal(call.body.messages.at(-1).role, "user");
  }
});

test("Claude Haiku 5.5: same body on the stable endpoint, without betas or fallbacks", async () => {
  const { calls, fetchImpl } = recorder(() =>
    message({ model: "claude-haiku-5-5" }),
  );
  const result = await anthropic.plan({
    settings: settings("claude-haiku-5-5"),
    input: INPUT,
    fetchImpl,
  });
  assert.deepEqual(result, { plan: PLAN, model: "claude-haiku-5-5" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].headers["anthropic-beta"], undefined);
  assert.deepEqual(Object.keys(calls[0].body).sort(), [
    "max_tokens",
    "messages",
    "model",
    "output_config",
    "system",
  ]);
  assert.equal(calls[0].body.model, "claude-haiku-5-5");
  assert.equal(calls[0].body.max_tokens, 16000);
  assert.deepEqual(calls[0].body.output_config, {
    effort: "medium",
    format: {
      type: "json_schema",
      schema: JSON.parse(JSON.stringify(PLAN_SCHEMA)),
    },
  });
});

test("client options: official SDK, pinned host, one retry, 90 s; environment variables cannot redirect the key", async (t) => {
  const saved = {};
  for (const [name, value] of Object.entries({
    ANTHROPIC_BASE_URL: "https://evil.test/proxy",
    ANTHROPIC_AUTH_TOKEN: "env-oauth-token",
    ANTHROPIC_API_KEY: "sk-ant-env-key-must-not-be-used",
  })) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  let options;
  class Spy extends Anthropic {
    constructor(given) {
      options = given;
      super(given);
    }
  }
  const { calls, fetchImpl } = recorder(() => message());
  await plan(fetchImpl, { Anthropic: Spy });
  assert.equal(options.apiKey, KEY);
  assert.equal(options.authToken, null);
  assert.equal(options.baseURL, "https://api.anthropic.com");
  assert.equal(options.maxRetries, 1);
  assert.equal(options.timeout, 90000);
  assert.equal(typeof options.fetch, "function");
  assert.notEqual(
    options.fetch,
    fetchImpl,
    "the SDK gets the guarded fetch, not the raw one",
  );
  assert.equal(new URL(calls[0].url).origin, "https://api.anthropic.com");
  assert.equal(calls[0].headers["x-api-key"], KEY);
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(JSON.stringify(calls).includes("env-"), false);
  // The default export of the installed package is the Anthropic class the adapter uses.
  assert.equal(typeof Anthropic, "function");
  assert.equal(Anthropic.Anthropic, Anthropic.default);
  const real = recorder(() => message());
  assert.deepEqual(await plan(real.fetchImpl), {
    plan: PLAN,
    model: "claude-opus-5-5",
  });
});

test("result: the model named by the response is returned (a fallback model may have answered)", async () => {
  const fallback = recorder(() => message({ model: "claude-opus-4-8" }));
  assert.equal((await plan(fallback.fetchImpl)).model, "claude-opus-4-8");
  for (const model of [
    undefined,
    null,
    "",
    "not a model id",
    "x".repeat(300),
  ]) {
    const odd = recorder(() => message({ model }));
    assert.equal(
      (await plan(odd.fetchImpl)).model,
      "claude-opus-5-5",
      String(model),
    );
  }
  // Thinking and fallback blocks may precede the answer: the first text block is the plan.
  const blocks = recorder(() =>
    message({
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        {
          type: "fallback",
          from: { model: "claude-opus-5-5" },
          to: { model: "claude-opus-4-8" },
        },
        { type: "text", text: JSON.stringify(PLAN) },
        { type: "text", text: "ignored" },
      ],
    }),
  );
  assert.deepEqual((await plan(blocks.fetchImpl)).plan, PLAN);
  // Unknown fields from the model are dropped by validation.
  const extra = recorder(() =>
    message({
      text: JSON.stringify({
        ...PLAN,
        secret: "x",
        arrangement: { ...PLAN.arrangement, solo: true },
      }),
    }),
  );
  assert.deepEqual((await plan(extra.fetchImpl)).plan, PLAN);
});

test("stop_reason is checked before the content: refusal and max_tokens", async () => {
  const refusal = recorder(() =>
    message({ stop_reason: "refusal", content: [] }),
  );
  await assert.rejects(
    plan(refusal.fetchImpl),
    (error) => safe(error) && /拒绝了这次请求/.test(error.message),
  );
  assert.equal(refusal.calls.length, 1, "a refusal is not retried");
  // Even when a refusal carries schema-valid text, it is not used.
  const refusalWithText = recorder(() => message({ stop_reason: "refusal" }));
  await assert.rejects(plan(refusalWithText.fetchImpl), /拒绝了这次请求/);
  const cut = recorder(() =>
    message({
      stop_reason: "max_tokens",
      text: JSON.stringify(PLAN).slice(0, 200),
    }),
  );
  await assert.rejects(
    plan(cut.fetchImpl),
    (error) => safe(error) && /被截断/.test(error.message),
  );
  const cutButComplete = recorder(() => message({ stop_reason: "max_tokens" }));
  await assert.rejects(plan(cutButComplete.fetchImpl), /被截断/);
  assert.equal(cut.calls.length, 1);
});

test("malformed answers never reach the caller", async () => {
  for (const response of [
    () => message({ text: '这是我为你设计的方案：{"style":"jazz"' }),
    () => message({ text: "not json at all" }),
    () => message({ text: "" }),
    () => message({ content: [] }),
    () =>
      message({
        content: [
          { type: "thinking", thinking: "only thinking", signature: "s" },
        ],
      }),
    () => message({ content: [{ type: "text" }] }),
    () => message({ text: JSON.stringify([PLAN]) }),
    () => message({ text: JSON.stringify({ ...PLAN, style: "lofi" }) }),
    () => message({ text: JSON.stringify({ ...PLAN, bpm: "76" }) }),
    () => message({ text: JSON.stringify({ reply: "只有一句话" }) }),
    () =>
      new Response("<html>gateway page</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    () =>
      new Response("null", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ]) {
    const { calls, fetchImpl } = recorder(response);
    await assert.rejects(plan(fetchImpl), safe);
    assert.equal(calls.length, 1);
  }
});

test("HTTP errors map to fixed Chinese messages through the SDK error classes; raw text never leaks", async () => {
  const cases = [
    [401, "authentication_error", /API Key 无效或已过期/, 1],
    [403, "permission_error", /没有使用这个 Claude 模型的权限/, 1],
    [404, "not_found_error", /模型当前不可用/, 1],
    [402, "billing_error", /余额不足/, 1],
    [413, "request_too_large", /内容太长/, 1],
    [429, "rate_limit_error", /过于频繁或额度已用尽/, 2],
    [529, "overloaded_error", /繁忙（过载）/, 2],
    [500, "api_error", /暂时不可用/, 2],
    [503, "api_error", /暂时不可用/, 2],
    [418, "invalid_request_error", /返回了错误（418）/, 1],
  ];
  for (const [status, type, expected, requests] of cases) {
    const { calls, fetchImpl } = recorder(() => apiError(status, type));
    await assert.rejects(
      plan(fetchImpl),
      (error) => safe(error) && expected.test(error.message),
      `HTTP ${status}`,
    );
    assert.equal(
      calls.length,
      requests,
      `HTTP ${status}: ${requests === 2 ? "retried exactly once (maxRetries 1)" : "not retried"}`,
    );
  }
  // A server error keeps the request id (id-shaped only) so support can find it.
  const server = recorder(() => apiError(500, "api_error"));
  await assert.rejects(plan(server.fetchImpl), (error) =>
    error.message.includes(`请求编号 ${REQUEST_ID}`),
  );
  // One transient failure, then success: the single SDK retry recovers.
  const flaky = recorder((_call, count) =>
    count === 1 ? apiError(529, "overloaded_error") : message(),
  );
  assert.deepEqual((await plan(flaky.fetchImpl)).plan, PLAN);
  assert.equal(flaky.calls.length, 2);
});

test("HTTP 400 on the beta endpoint falls back once to the stable endpoint; a second 400 is reported", async () => {
  const recovered = recorder((call, count) =>
    count === 1
      ? apiError(
          400,
          "invalid_request_error",
          "Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.",
        )
      : message(),
  );
  assert.deepEqual(await plan(recovered.fetchImpl), {
    plan: PLAN,
    model: "claude-opus-5-5",
  });
  assert.equal(recovered.calls.length, 2);
  assert.equal(
    recovered.calls[0].url,
    "https://api.anthropic.com/v1/messages?beta=true",
  );
  assert.equal(recovered.calls[1].url, "https://api.anthropic.com/v1/messages");
  assert.equal(recovered.calls[1].headers["anthropic-beta"], undefined);
  assert.equal("fallbacks" in recovered.calls[1].body, false);
  const { fallbacks: _fallbacks, ...withoutFallbacks } =
    recovered.calls[0].body;
  assert.deepEqual(
    recovered.calls[1].body,
    withoutFallbacks,
    "otherwise the same request",
  );

  const rejected = recorder(() => apiError(400, "invalid_request_error"));
  await assert.rejects(
    plan(rejected.fetchImpl),
    (error) =>
      safe(error) &&
      /没有接受这次请求/.test(error.message) &&
      error.message.includes(REQUEST_ID),
  );
  assert.equal(rejected.calls.length, 2);
  // Haiku is already on the stable endpoint: no second attempt.
  const haiku = recorder(() => apiError(400, "invalid_request_error"));
  await assert.rejects(
    anthropic.plan({
      settings: settings("claude-haiku-5-5"),
      input: INPUT,
      fetchImpl: haiku.fetchImpl,
    }),
    /没有接受这次请求/,
  );
  assert.equal(haiku.calls.length, 1);
  // Other failures on the beta endpoint are not turned into a second request shape.
  const unauthorised = recorder(() => apiError(401, "authentication_error"));
  await assert.rejects(plan(unauthorised.fetchImpl), /API Key 无效/);
  assert.equal(unauthorised.calls.length, 1);
});

test("network failure and SDK timeout mention the system proxy and reveal nothing", async () => {
  const offline = recorder(() => {
    throw new TypeError(
      `fetch failed: getaddrinfo ENOTFOUND api.anthropic.com via 10.1.2.3 ${KEY}`,
    );
  });
  await assert.rejects(
    plan(offline.fetchImpl),
    (error) =>
      safe(error) &&
      /无法连接 Claude 服务/.test(error.message) &&
      /系统代理/.test(error.message) &&
      !/ENOTFOUND|10\.1\.2\.3/.test(error.message),
  );
  assert.equal(
    offline.calls.length,
    2,
    "connection errors are retried once by the SDK",
  );

  // The SDK's own timeout (shortened here; the adapter passes 90 s) raises APIConnectionTimeoutError.
  class Impatient extends Anthropic {
    constructor(given) {
      super({ ...given, timeout: 25, maxRetries: 0 });
    }
  }
  const hanging = recorder(
    (call) =>
      new Promise((_resolve, reject) =>
        call.signal.addEventListener(
          "abort",
          () =>
            reject(
              new DOMException("This operation was aborted", "AbortError"),
            ),
          { once: true },
        ),
      ),
  );
  await assert.rejects(
    plan(hanging.fetchImpl, { Anthropic: Impatient }),
    (error) =>
      safe(error) &&
      /连接 Claude 服务超时/.test(error.message) &&
      /系统代理/.test(error.message),
  );
});

test("cancel: an aborted signal stops the request and is reported as cancelled", async () => {
  const before = new AbortController();
  before.abort();
  const never = recorder(() => message());
  await assert.rejects(
    plan(never.fetchImpl, { signal: before.signal }),
    (error) => safe(error) && /已取消本次编排/.test(error.message),
  );
  assert.equal(never.calls.length, 0, "nothing is sent after a cancel");

  const controller = new AbortController();
  const hanging = recorder(
    (call) =>
      new Promise((_resolve, reject) =>
        call.signal.addEventListener(
          "abort",
          () =>
            reject(
              new DOMException("This operation was aborted", "AbortError"),
            ),
          { once: true },
        ),
      ),
  );
  const pending = plan(hanging.fetchImpl, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hanging.calls.length, 1);
  controller.abort();
  await assert.rejects(
    pending,
    (error) => safe(error) && /已取消本次编排/.test(error.message),
  );
  assert.equal(hanging.calls.length, 1, "a cancelled request is not retried");
});

test("through the agent service: timeout and a late answer after cancel are discarded", async () => {
  // Timeout: the service stops after its own limit even though the SDK would wait longer.
  const slow = recorder(
    (call) =>
      new Promise((_resolve, reject) =>
        call.signal.addEventListener(
          "abort",
          () =>
            reject(
              new DOMException("This operation was aborted", "AbortError"),
            ),
          { once: true },
        ),
      ),
  );
  const timed = createAgentService({
    fetchImpl: slow.fetchImpl,
    timeoutMs: 40,
  });
  await assert.rejects(
    timed.plan(RAW_INPUT, settings()),
    (error) => safe(error) && /没有回应，已停止等待/.test(error.message),
  );
  assert.equal(slow.calls.length, 1);
  assert.equal(slow.calls[0].signal.aborted, true);
  assert.equal(timed.busy, false);

  // Late result: the server answers after the user cancelled; the answer must go nowhere.
  let answer;
  const late = recorder(
    () =>
      new Promise((resolve) => {
        answer = () =>
          resolve(
            message({ text: JSON.stringify({ ...PLAN, title: "迟到的结果" }) }),
          );
      }),
  );
  const service = createAgentService({ fetchImpl: late.fetchImpl });
  let settled = null;
  const pending = service.plan(RAW_INPUT, settings()).then(
    (value) => {
      settled = { value };
    },
    (error) => {
      settled = { error };
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(late.calls.length, 1);
  service.cancel();
  await pending;
  assert.match(settled.error.message, /已取消本次编排/);
  assert.equal(service.busy, false);
  answer();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(late.calls.length, 1);
  assert.match(
    settled.error.message,
    /已取消本次编排/,
    "the late answer changes nothing",
  );
});

test("responses larger than the cap are cut off, with or without Content-Length", async () => {
  const big = JSON.stringify({
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "x".repeat(300_000) }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  let cancelled = false;
  const declared = recorder(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode(big));
          },
          cancel() {
            cancelled = true;
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(5 * 1024 * 1024),
          },
        },
      ),
  );
  await assert.rejects(
    plan(declared.fetchImpl, { maxBytes: 64 * 1024 }),
    (error) => safe(error) && /内容过大/.test(error.message),
  );
  assert.equal(cancelled, true, "the body is released without being read");
  let produced = 0;
  const streamed = recorder(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            produced += 16384;
            controller.enqueue(new Uint8Array(16384).fill(32));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  await assert.rejects(
    plan(streamed.fetchImpl, { maxBytes: 64 * 1024 }),
    (error) => safe(error) && /内容过大/.test(error.message),
  );
  assert.ok(
    produced <= 64 * 1024 + 3 * 16384,
    `reading stops near the cap (read ${produced} bytes)`,
  );
  // A normal answer under the default 1 MiB cap is fine.
  assert.deepEqual(
    (await plan(recorder(() => message()).fetchImpl)).plan,
    PLAN,
  );
});

test("the fetch handed to the SDK refuses every host but the official API and never follows redirects", async () => {
  // A stand-in for an SDK that (through a bug or a hostile environment) tries another host.
  const attempts = [];
  const makeClient = (target) => {
    class Wandering {
      constructor(options) {
        const create = async () => {
          attempts.push(target);
          return (
            await options.fetch(target, {
              method: "POST",
              body: "{}",
              headers: { "x-api-key": options.apiKey },
              redirect: "follow",
            })
          ).json();
        };
        this.messages = { create };
        this.beta = { messages: { create } };
      }
    }
    for (const name of [
      "AuthenticationError",
      "PermissionDeniedError",
      "NotFoundError",
      "RateLimitError",
      "APIConnectionTimeoutError",
      "APIConnectionError",
      "APIUserAbortError",
      "BadRequestError",
      "APIError",
    ])
      Wandering[name] = Anthropic[name];
    return Wandering;
  };
  const { calls, fetchImpl } = recorder(() => message());
  for (const target of [
    "https://evil.test/v1/messages",
    "http://api.anthropic.com/v1/messages",
    "https://api.anthropic.com.evil.test/v1/messages",
    "https://api.anthropic.com:8443/v1/messages",
    "https://user@evil.test/v1/messages",
    "http://127.0.0.1:11434/v1/messages",
  ]) {
    await assert.rejects(
      plan(fetchImpl, { Anthropic: makeClient(target) }),
      safe,
      target,
    );
  }
  assert.equal(calls.length, 0, "the key is never sent anywhere else");
  assert.equal(attempts.length, 6);
  // The official host passes, with redirects forced off whatever the caller asked for.
  assert.deepEqual(
    (
      await plan(fetchImpl, {
        Anthropic: makeClient("https://api.anthropic.com/v1/messages"),
      })
    ).plan,
    PLAN,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, "error");
});

test("only the offered Claude models are sent", async () => {
  const { calls, fetchImpl } = recorder(() => message());
  for (const model of [
    "claude-opus-4-1",
    "claude-3-5-sonnet-20241022",
    "claude-opus-5-5-20260401",
    "gpt-5",
    "",
    undefined,
  ]) {
    await assert.rejects(
      anthropic.plan({
        settings: { ...settings(), model },
        input: INPUT,
        fetchImpl,
      }),
      (error) => error.name === "MusicError",
      String(model),
    );
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(
    [...anthropic.FALLBACK_MODELS],
    ["claude-opus-5-5", "claude-sonnet-5-5"],
  );
  assert.equal(anthropic.FALLBACK_BETA, "server-side-fallback-2026-07-01");
  assert.equal(anthropic.MAX_TOKENS, 16000);
});

/* ------------------------------------------------------------------ MAIN-04 */

/**
 * Every environment variable SDK 0.132.1 reads on the path used here (client.js constructor,
 * core/credentials.js, lib/credentials/credential-chain.js, internal/utils/log.js), plus the proxy
 * variables other HTTP clients honour. With all of them set to hostile values the request must be
 * byte-for-byte the one sent from a clean environment.
 */
const HOSTILE_ENV = {
  ANTHROPIC_CUSTOM_HEADERS: [
    "x-api-key: sk-ant-FROM-ENV-111111",
    "Authorization: Bearer gateway-secret-222222",
    "X-Corp-Tenant: tenant-42",
    "Cookie: session=env-cookie",
    "anthropic-version: 1999-01-01",
    "anthropic-beta: env-beta-2099-01-01",
    "User-Agent: EnvAgent/9.9",
    "Accept: text/plain",
    "Content-Type: text/plain",
    "X-Stainless-OS: EnvOS",
    "x-stainless-retry-count: 99",
    "anthropic-dangerous-direct-browser-access: true",
    "Proxy-Authorization: Basic ZW52OmVudg==",
  ].join("\n"),
  ANTHROPIC_BASE_URL: "https://gateway.corp.example/anthropic",
  ANTHROPIC_API_KEY: "sk-ant-env-key-000000",
  ANTHROPIC_AUTH_TOKEN: "env-auth-token-000000",
  ANTHROPIC_WEBHOOK_SIGNING_KEY: "env-webhook-key-000000",
  ANTHROPIC_LOG: "debug",
  ANTHROPIC_PROFILE: "env-profile",
  ANTHROPIC_CONFIG_DIR: "C:\\env-config-dir-that-does-not-exist",
  ANTHROPIC_ORGANIZATION_ID: "env-org-000000",
  ANTHROPIC_WORKSPACE_ID: "env-workspace-000000",
  ANTHROPIC_FEDERATION_RULE_ID: "env-rule-000000",
  ANTHROPIC_IDENTITY_TOKEN: "env-identity-token-000000",
  ANTHROPIC_IDENTITY_TOKEN_FILE: "C:\\env-identity-token-file",
  ANTHROPIC_SERVICE_ACCOUNT_ID: "env-service-account-000000",
  ANTHROPIC_SCOPE: "env-scope",
  HTTPS_PROXY: "http://env-proxy.corp.example:3128",
  HTTP_PROXY: "http://env-proxy.corp.example:3128",
  ALL_PROXY: "socks5://env-proxy.corp.example:1080",
  NO_PROXY: "",
  https_proxy: "http://env-proxy.corp.example:3128",
  http_proxy: "http://env-proxy.corp.example:3128",
};
function withEnvironment(t, values) {
  const saved = {};
  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  const restore = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  t.after(restore);
  return restore;
}
// The package does not export its package.json: read it next to the entry point.
const sdkRoot = require("node:path").dirname(
  require.resolve("@anthropic-ai/sdk"),
);
const SDK_VERSION = JSON.parse(
  require("node:fs").readFileSync(
    require("node:path").join(sdkRoot, "package.json"),
    "utf8",
  ),
).version;
/** What went over the wire, without the per-request abort signal. */
const wire = (calls) => calls.map(({ signal: _signal, ...rest }) => rest);

test("MAIN-04: the SDK reads exactly the environment variables this module neutralises", () => {
  // If an SDK update starts reading another variable in the client, this list (and the adapter) must follow.
  const fs = require("node:fs");
  const path = require("node:path");
  assert.equal(
    SDK_VERSION,
    "0.132.1",
    "the review of environment variables was done for this exact version",
  );
  const read = new Set();
  for (const file of [
    "client.js",
    "core/credentials.js",
    "lib/credentials/credential-chain.js",
    "internal/utils/log.js",
    "internal/detect-platform.js",
    "internal/shims.js",
    "resources/messages/messages.js",
    "resources/beta/messages/messages.js",
  ]) {
    const source = fs.readFileSync(path.join(sdkRoot, file), "utf8");
    for (const match of source.matchAll(/readEnv\)?\(['"]([A-Z_]+)['"]\)/g))
      read.add(match[1]);
    assert.equal(
      /process\.env\[|process\.env\./.test(
        source.replace(/^\s*\*.*$/gm, "").replace(/"process\.env\[[^"]*"/g, ""),
      ),
      false,
      `${file} reads process.env directly`,
    );
  }
  const known = new Set(Object.keys(HOSTILE_ENV));
  for (const name of ["APPDATA", "USERPROFILE", "HOME", "XDG_CONFIG_HOME"])
    known.add(name); // only to locate credential files, which an explicit apiKey switches off
  assert.deepEqual(
    [...read].filter((name) => !known.has(name)),
    [],
    "an environment variable this test does not cover",
  );
  for (const name of [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_LOG",
    "ANTHROPIC_WEBHOOK_SIGNING_KEY",
    "ANTHROPIC_PROFILE",
  ])
    assert.ok(read.has(name), `${name} is read by the SDK`);
});

test("MAIN-04: nothing in the environment changes where the stored key goes or which headers are sent", async (t) => {
  const send = async (model) => {
    const { calls, fetchImpl } = recorder(() => message({ model }));
    assert.deepEqual(
      await anthropic.plan({
        settings: settings(model),
        input: INPUT,
        fetchImpl,
      }),
      { plan: PLAN, model },
    );
    return wire(calls);
  };
  const clean = {};
  for (const name of Object.keys(HOSTILE_ENV)) clean[name] = "";
  const restoreClean = withEnvironment(t, clean);
  for (const name of Object.keys(HOSTILE_ENV)) delete process.env[name];
  const expected = {
    opus: await send("claude-opus-5-5"),
    haiku: await send("claude-haiku-5-5"),
  };
  restoreClean();

  // The clean request itself: exactly these headers, nothing else.
  assert.deepEqual(Object.keys(expected.haiku[0].headers).sort(), [
    "accept",
    "anthropic-version",
    "content-type",
    "user-agent",
    "x-api-key",
  ]);
  assert.deepEqual(Object.keys(expected.opus[0].headers).sort(), [
    "accept",
    "anthropic-beta",
    "anthropic-version",
    "content-type",
    "user-agent",
    "x-api-key",
  ]);
  assert.deepEqual(expected.haiku[0].headers, {
    accept: "application/json",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "user-agent": `Anthropic/JS ${SDK_VERSION}`,
    "x-api-key": KEY,
  });
  assert.equal(
    expected.opus[0].headers["anthropic-beta"],
    "server-side-fallback-2026-07-01",
  );

  withEnvironment(t, HOSTILE_ENV);
  const logged = [];
  for (const level of ["log", "info", "debug", "warn", "error"])
    t.mock.method(console, level, (...args) => {
      logged.push([level, ...args]);
    });
  const hostile = {
    opus: await send("claude-opus-5-5"),
    haiku: await send("claude-haiku-5-5"),
  };
  t.mock.restoreAll();

  assert.deepEqual(
    hostile.opus,
    expected.opus,
    "beta endpoint: the request is identical to the one from a clean environment",
  );
  assert.deepEqual(
    hostile.haiku,
    expected.haiku,
    "stable endpoint: identical as well",
  );
  for (const call of [...hostile.opus, ...hostile.haiku]) {
    assert.equal(new URL(call.url).origin, "https://api.anthropic.com");
    assert.equal(
      call.headers["x-api-key"],
      KEY,
      "the key stored in the app, not the one from the environment",
    );
    for (const absent of [
      "authorization",
      "x-corp-tenant",
      "cookie",
      "proxy-authorization",
      "x-stainless-os",
      "anthropic-dangerous-direct-browser-access",
    ])
      assert.equal(call.headers[absent], undefined, absent);
    assert.equal(
      /env-|EnvAgent|EnvOS|FROM-ENV|gateway|1999-01-01|tenant-42/i.test(
        JSON.stringify(call),
      ),
      false,
      "no value from the environment is anywhere in the request",
    );
  }
  assert.deepEqual(
    logged,
    [],
    "ANTHROPIC_LOG=debug prints nothing (it would log request headers)",
  );
});

test("MAIN-04: errors, the retry and the 400 fallback behave the same with a hostile environment", async (t) => {
  withEnvironment(t, HOSTILE_ENV);
  // 401 from the real key: reported as before, sent once, with the stored key.
  const denied = recorder(() => apiError(401, "authentication_error"));
  await assert.rejects(
    plan(denied.fetchImpl),
    (error) => safe(error) && /Claude API Key 无效或已过期/.test(error.message),
  );
  assert.equal(denied.calls.length, 1);
  assert.equal(denied.calls[0].headers["x-api-key"], KEY);
  // The SDK's single retry and the stable-endpoint fallback both go through the same gate.
  const flaky = recorder((_call, count) =>
    count === 1 ? apiError(529, "overloaded_error") : message(),
  );
  assert.deepEqual((await plan(flaky.fetchImpl)).plan, PLAN);
  const fallback = recorder((_call, count) =>
    count === 1 ? apiError(400, "invalid_request_error") : message(),
  );
  assert.deepEqual((await plan(fallback.fetchImpl)).plan, PLAN);
  for (const call of [...flaky.calls, ...fallback.calls]) {
    assert.equal(call.headers["x-api-key"], KEY);
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers["x-corp-tenant"], undefined);
    assert.equal(call.headers["anthropic-version"], "2023-06-01");
    assert.equal(new URL(call.url).origin, "https://api.anthropic.com");
  }
  assert.equal(
    fallback.calls[0].headers["anthropic-beta"],
    "server-side-fallback-2026-07-01",
  );
  assert.equal(
    fallback.calls[1].headers["anthropic-beta"],
    undefined,
    "the environment cannot add a beta flag to the stable endpoint",
  );
});

test("MAIN-04: explicit client options for every variable; the gate rewrites whatever headers a client hands it", async (t) => {
  withEnvironment(t, HOSTILE_ENV);
  let options;
  class Spy extends Anthropic {
    constructor(given) {
      options = given;
      super(given);
    }
  }
  const spied = recorder(() => message());
  await plan(spied.fetchImpl, { Anthropic: Spy });
  assert.equal(options.apiKey, KEY);
  assert.equal(options.authToken, null);
  assert.equal(options.webhookKey, null);
  assert.equal(options.baseURL, "https://api.anthropic.com");
  assert.equal(options.logLevel, "off");
  assert.deepEqual(options.defaultHeaders, {
    "X-Api-Key": KEY,
    Authorization: null,
  });
  assert.equal(
    "profile" in options || "credentials" in options || "config" in options,
    false,
    "no credential chain",
  );

  // A client that sends hostile headers of its own (an SDK bug, a future default): still our headers only.
  class Chatty {
    constructor(given) {
      const create = async () =>
        (
          await given.fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            body: "{}",
            headers: new Headers({
              "x-api-key": "sk-ant-other-key-000000",
              authorization: "Bearer other",
              "x-forwarded-for": "10.0.0.1",
              "anthropic-beta":
                "server-side-fallback-2026-07-01, another-beta-2099, server-side-fallback-2026-07-01",
              "anthropic-version": "2000-01-01",
              "user-agent": "Other/1.0",
            }),
          })
        ).json();
      this.messages = { create };
      this.beta = { messages: { create } };
    }
  }
  for (const name of [
    "AuthenticationError",
    "PermissionDeniedError",
    "NotFoundError",
    "RateLimitError",
    "APIConnectionTimeoutError",
    "APIConnectionError",
    "APIUserAbortError",
    "BadRequestError",
    "APIError",
  ])
    Chatty[name] = Anthropic[name];
  const chatty = recorder(() => message());
  await plan(chatty.fetchImpl, { Anthropic: Chatty });
  assert.deepEqual(chatty.calls[0].headers, {
    accept: "application/json",
    "anthropic-beta": "server-side-fallback-2026-07-01",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "user-agent": "Anthropic/JS",
    "x-api-key": KEY,
  });
  // Header shapes a fetch may be given: plain object, array of pairs, nothing at all.
  for (const headers of [
    { "X-Api-Key": "other", Authorization: "Bearer x" },
    [
      ["x-api-key", "other"],
      ["authorization", "Bearer x"],
    ],
    undefined,
    null,
  ]) {
    class Shape {
      constructor(given) {
        const create = async () =>
          (
            await given.fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              body: "{}",
              headers,
            })
          ).json();
        this.messages = { create };
        this.beta = { messages: { create } };
      }
    }
    for (const name of [
      "AuthenticationError",
      "PermissionDeniedError",
      "NotFoundError",
      "RateLimitError",
      "APIConnectionTimeoutError",
      "APIConnectionError",
      "APIUserAbortError",
      "BadRequestError",
      "APIError",
    ])
      Shape[name] = Anthropic[name];
    const shaped = recorder(() => message());
    await plan(shaped.fetchImpl, { Anthropic: Shape });
    assert.equal(shaped.calls[0].headers["x-api-key"], KEY);
    assert.equal(shaped.calls[0].headers.authorization, undefined);
  }
});

test("MAIN-04: without a stored key nothing is sent - the SDK is never left to find credentials on its own", async (t) => {
  withEnvironment(t, HOSTILE_ENV);
  for (const apiKey of [undefined, null, "", 42, {}]) {
    const { calls, fetchImpl } = recorder(() => message());
    await assert.rejects(
      anthropic.plan({
        settings: { ...settings(), apiKey },
        input: INPUT,
        fetchImpl,
      }),
      (error) => safe(error) && /还没有填写 Claude API Key/.test(error.message),
      String(apiKey),
    );
    assert.equal(calls.length, 0);
  }
});
