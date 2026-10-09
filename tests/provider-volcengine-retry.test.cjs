"use strict";

// F02: tolerant QuerySong polling and a TaskID in every failure after submission.
// F04: enumerated vendor error codes and request ids on non-2xx answers.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  generate,
  MAX_POLL_FAILURES,
} = require("../electron/providers/volcengine.cjs");
const { createMusicService } = require("../electron/music-service.cjs");

const INPUT = { prompt: "青春欢快的背景音乐", duration: 30 };
const CREDS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "secret-example-not-real",
};
const TASK = "fixture-task-123";
const audioUrl = "https://v1-default.douyinvod.com/fixture.wav?example=1";
const fixtureWav = (() => {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF");
  bytes.writeUInt32LE(40, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(4, 40);
  bytes.writeInt16LE(1000, 44);
  bytes.writeInt16LE(-1000, 46);
  return bytes;
})();
const json = (data) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
const success = (Result) =>
  json({
    Code: 0,
    Message: "success",
    Result,
    ResponseMetadata: { Error: null },
  });
const submission = () => success({ TaskID: TASK, PredictedWaitTime: 0 });
const complete = (url = audioUrl) =>
  success({ Status: 2, SongDetail: { AudioUrl: url, Duration: 30.02 } });
const wav = () =>
  new Response(fixtureWav, {
    headers: { "content-type": "application/octet-stream" },
  });
const noSleep = { sleep: async () => {} };
const isSubmit = (url) => /Action=GenBGM/.test(url);
const isPoll = (url) => /Action=QuerySong/.test(url);

test("poll survives one transient failure of each kind without resubmitting the paid task", async () => {
  const blips = {
    "HTTP 502": () => new Response("bad gateway", { status: 502 }),
    "HTTP 500": () =>
      new Response('{"ResponseMetadata":{"Error":{"Code":"InternalError"}}}', {
        status: 500,
      }),
    "HTTP 503": () => new Response("", { status: 503 }),
    "HTTP 429": () => new Response("slow down", { status: 429 }),
    "HTTP 408": () => new Response("", { status: 408 }),
    "network error": () => {
      throw new TypeError("fetch failed");
    },
    "truncated JSON": () => new Response('{"Code":0,"Result":{"Sta'),
    "proxy error page": () => new Response("<html>Gateway Timeout</html>"),
  };
  for (const [name, blip] of Object.entries(blips)) {
    const calls = [],
      waits = [];
    const responses = [
      submission,
      blip,
      () => success({ Status: 1 }),
      () => complete(),
      wav,
    ];
    const result = await generate({
      input: INPUT,
      credentials: CREDS,
      helpers: { sleep: async (ms) => waits.push(ms) },
      fetchImpl: async (...args) => {
        calls.push(args);
        return responses.shift()();
      },
    });
    assert.equal(result.mimeType, "audio/wav", name);
    assert.equal(
      calls.filter(([url]) => isSubmit(url)).length,
      1,
      `${name}: submitted exactly once`,
    );
    assert.equal(calls.filter(([url]) => isPoll(url)).length, 3, name);
    assert.deepEqual(
      waits,
      [2000, 2000],
      `${name}: one backoff, then the normal interval`,
    );
  }
});

test("poll backs off (capped) through four consecutive failures and still delivers the result", async () => {
  const calls = [],
    waits = [];
  const responses = [
    submission,
    ...Array.from(
      { length: MAX_POLL_FAILURES - 1 },
      () => () => new Response("", { status: 502 }),
    ),
    () => complete(),
    wav,
  ];
  const result = await generate({
    input: INPUT,
    credentials: CREDS,
    helpers: { sleep: async (ms) => waits.push(ms) },
    fetchImpl: async (...args) => {
      calls.push(args);
      return responses.shift()();
    },
  });
  assert.equal(result.mimeType, "audio/wav");
  assert.deepEqual(waits, [2000, 4000, 8000, 15000]);
  assert.equal(calls.filter(([url]) => isSubmit(url)).length, 1);
  assert.equal(calls.length, 1 + (MAX_POLL_FAILURES - 1) + 1 + 1);
});

test("poll gives up after five consecutive failures, names the task and never resubmits", async () => {
  assert.equal(MAX_POLL_FAILURES, 5);
  for (const blip of [
    () => new Response(CREDS.secretAccessKey, { status: 502 }),
    () => {
      throw new TypeError(`fetch failed ${CREDS.secretAccessKey}`);
    },
  ]) {
    const calls = [],
      waits = [];
    await assert.rejects(
      generate({
        input: INPUT,
        credentials: CREDS,
        helpers: { sleep: async (ms) => waits.push(ms) },
        fetchImpl: async (...args) => {
          calls.push(args);
          return calls.length === 1 ? submission() : blip();
        },
      }),
      (error) => {
        assert.equal(error.name, "MusicError");
        assert.match(error.message, /连续 5 次查询失败/);
        assert.match(error.message, /不要重复提交/);
        assert.ok(error.message.includes(`任务编号 ${TASK}`), error.message);
        assert.equal(error.message.includes(CREDS.secretAccessKey), false);
        return true;
      },
    );
    assert.equal(calls.length, 6, "one submit and exactly five status queries");
    assert.equal(calls.filter(([url]) => isSubmit(url)).length, 1);
    assert.deepEqual(
      waits,
      [2000, 4000, 8000, 15000],
      "no sleep after the last failure",
    );
  }
});

test("failure counter resets after every successful query; failed queries count toward the 150-query budget", async () => {
  // fail, pending, fail x4, pending, fail x4, done: never five in a row.
  const script = [
    "fail",
    "wait",
    "fail",
    "fail",
    "fail",
    "fail",
    "wait",
    "fail",
    "fail",
    "fail",
    "fail",
    "done",
  ];
  const calls = [];
  const result = await generate({
    input: INPUT,
    credentials: CREDS,
    helpers: noSleep,
    fetchImpl: async (url) => {
      calls.push(url);
      if (isSubmit(url)) return submission();
      if (!isPoll(url)) return wav();
      const step = script.shift();
      return step === "fail"
        ? new Response("", { status: 503 })
        : step === "wait"
          ? success({ Status: 1 })
          : complete();
    },
  });
  assert.equal(result.mimeType, "audio/wav");
  assert.equal(calls.filter(isSubmit).length, 1);
  // Alternating failure / pending forever still ends at the budget.
  let polls = 0;
  await assert.rejects(
    generate({
      input: INPUT,
      credentials: CREDS,
      helpers: noSleep,
      fetchImpl: async (url) => {
        if (isSubmit(url)) return submission();
        polls++;
        return polls % 2
          ? new Response("", { status: 502 })
          : success({ Status: 1 });
      },
    }),
    (error) =>
      /超过 5 分钟/.test(error.message) && error.message.includes(TASK),
  );
  assert.equal(polls, 150);
});

test("poll does not retry failures that will not heal (auth, bad request, service error code)", async () => {
  for (const response of [
    () => new Response("", { status: 401 }),
    () => new Response("", { status: 403 }),
    () => new Response("", { status: 400 }),
    () => json({ Code: 50000001, Message: CREDS.secretAccessKey }),
    () =>
      json({
        ResponseMetadata: {
          Error: { Code: "AccessDenied", Message: CREDS.secretAccessKey },
        },
      }),
  ]) {
    let calls = 0;
    await assert.rejects(
      generate({
        input: INPUT,
        credentials: CREDS,
        helpers: noSleep,
        fetchImpl: async () => {
          calls++;
          return calls === 1 ? submission() : response();
        },
      }),
      (error) => {
        assert.equal(error.name, "MusicError");
        assert.ok(error.message.includes(`任务编号 ${TASK}`), error.message);
        assert.equal(error.message.includes(CREDS.secretAccessKey), false);
        return true;
      },
    );
    assert.equal(calls, 2);
  }
});

test("the billable submission is never retried, whatever the failure", async () => {
  for (const response of [
    () => new Response("", { status: 502 }),
    () => new Response("", { status: 429 }),
    () => {
      throw new TypeError("fetch failed");
    },
    () => new Response('{"Code":0,"Result":{"Ta'),
  ]) {
    let calls = 0;
    await assert.rejects(
      generate({
        input: INPUT,
        credentials: CREDS,
        helpers: noSleep,
        fetchImpl: async () => {
          calls++;
          return response();
        },
      }),
      (error) =>
        error.name === "MusicError" && !error.message.includes("任务编号"),
    );
    assert.equal(calls, 1);
  }
});

test("every failure after submission carries the TaskID; long ids are shortened", async () => {
  const afterSubmit = [
    [
      () => success({ Status: 3, FailureReason: { Code: 300061, Msg: "x" } }),
      /版权校验未通过/,
    ],
    [() => success({ Status: 99 }), /未知任务状态/],
    [() => success({ Status: 2, SongDetail: {} }), /没有返回有效音频地址/],
    [() => complete("https://example.com/a.wav"), /白名单/],
  ];
  for (const [poll, expected] of afterSubmit) {
    let calls = 0;
    await assert.rejects(
      generate({
        input: INPUT,
        credentials: CREDS,
        helpers: noSleep,
        fetchImpl: async () => {
          calls++;
          return calls === 1 ? submission() : poll();
        },
      }),
      (error) =>
        expected.test(error.message) &&
        error.message.endsWith(`（任务编号 ${TASK}）`),
      String(expected),
    );
  }
  // Download problems happen after the task succeeded: the id matters most here.
  // MAIN-02: the download is free and repeatable, so a CDN error or a dropped connection is tried
  // four times (it used to be given up after one attempt, which threw a paid result away), and the
  // message then says that the music exists. A file that is too large or not audio is not retried.
  const downloads = [
    [
      () => new Response("", { status: 503 }),
      /^音乐已生成，但下载失败（已尝试 4 次/,
      undefined,
      4,
    ],
    [() => new Response(fixtureWav), /大小限制/, 16, 1],
    [() => new Response("<html>"), /格式不受支持/, undefined, 1],
    [
      () => {
        throw new TypeError("socket hang up");
      },
      /^音乐已生成，但下载失败（已尝试 4 次/,
      undefined,
      4,
    ],
  ];
  for (const [download, expected, maxBytes, attempts] of downloads) {
    let calls = 0;
    await assert.rejects(
      generate({
        input: INPUT,
        credentials: CREDS,
        helpers: noSleep,
        ...(maxBytes ? { maxBytes } : {}),
        fetchImpl: async () => {
          calls++;
          return calls === 1
            ? submission()
            : calls === 2
              ? complete()
              : download();
        },
      }),
      (error) =>
        expected.test(error.message) &&
        error.message.endsWith(`（任务编号 ${TASK}）`),
      String(expected),
    );
    assert.equal(
      calls,
      2 + attempts,
      "one submission, one status query, then only downloads",
    );
  }
  const longId = `${"A".repeat(12)}${"m".repeat(200)}${"Z".repeat(8)}`;
  let seen;
  await assert.rejects(
    generate({
      input: INPUT,
      credentials: CREDS,
      helpers: noSleep,
      onTask: (id) => {
        seen = id;
      },
      fetchImpl: async (url) =>
        isSubmit(url) ? success({ TaskID: longId }) : success({ Status: 3 }),
    }),
    (error) =>
      error.message.includes(`任务编号 ${"A".repeat(12)}…${"Z".repeat(8)}`) &&
      !error.message.includes("m".repeat(20)),
  );
  assert.equal(seen, `${"A".repeat(12)}…${"Z".repeat(8)}`);
});

test("cancellation during a poll backoff stops at once", async () => {
  const controller = new AbortController();
  let calls = 0;
  const started = Date.now();
  await assert.rejects(
    generate({
      input: INPUT,
      credentials: CREDS,
      signal: controller.signal,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return submission();
        setTimeout(() => controller.abort(), 10);
        return new Response("", { status: 502 });
      },
    }),
    /取消/,
  );
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 1500, "did not sit out the 2 s backoff");
});

test("music service quotes the task id when it stops waiting for a Volcengine job", async () => {
  const hangingPoll = (url, { signal }) =>
    isSubmit(url)
      ? Promise.resolve(submission())
      : new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
  const service = createMusicService({ fetchImpl: hangingPoll });
  const pending = service.generate({ ...INPUT, provider: "volcengine" }, CREDS);
  await new Promise((resolve) => setTimeout(resolve, 20));
  service.cancel();
  await assert.rejects(
    pending,
    (error) =>
      /已取消等待生成/.test(error.message) &&
      error.message.endsWith(`（任务编号 ${TASK}）`),
  );
  const timed = createMusicService({ fetchImpl: hangingPoll, timeoutMs: 30 });
  await assert.rejects(
    timed.generate({ ...INPUT, provider: "volcengine" }, CREDS),
    (error) =>
      /超过 5 分钟/.test(error.message) &&
      error.message.endsWith(`（任务编号 ${TASK}）`),
  );
  // Before a task exists there is nothing to quote.
  const early = createMusicService({
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      ),
  });
  const first = early.generate({ ...INPUT, provider: "volcengine" }, CREDS);
  early.cancel();
  await assert.rejects(
    first,
    (error) =>
      /已取消等待生成/.test(error.message) &&
      !error.message.includes("任务编号"),
  );
});

test("F04: enumerated error codes on HTTP errors are mapped and only an id-shaped RequestId is kept", async () => {
  const REQUEST_ID = "20261008123456ABCDEF0123456789";
  const body = (code, requestId = REQUEST_ID) =>
    JSON.stringify({
      ResponseMetadata: {
        RequestId: requestId,
        Action: "GenBGMForTime",
        Error: {
          Code: code,
          CodeN: 100010,
          Message: `raw vendor text ${CREDS.secretAccessKey}`,
        },
      },
    });
  const cases = [
    [401, "SignatureDoesNotMatch", /火山引擎鉴权失败/],
    [403, "AccessDenied", /火山引擎鉴权失败/],
    [401, "InvalidAccessKey", /火山引擎鉴权失败/],
    [400, "InvalidTimestamp", /签名时间无效，请同步电脑时间/], // v0.2 only recognised this on HTTP 200
    [400, "RequestExpired", /签名时间无效/],
    [400, "SomeNewCode", /音乐服务未接受参数/], // unknown codes fall back to the status text
    [401, "SomeNewCode", /API Key 无效或已过期/],
  ];
  for (const [status, code, expected] of cases) {
    let calls = 0;
    await assert.rejects(
      generate({
        input: INPUT,
        credentials: CREDS,
        fetchImpl: async () => {
          calls++;
          return new Response(body(code), {
            status,
            headers: { "content-type": "application/json" },
          });
        },
      }),
      (error) => {
        assert.equal(error.name, "MusicError");
        assert.match(error.message, expected, `${status} ${code}`);
        assert.ok(
          error.message.endsWith(`（请求编号 ${REQUEST_ID}）`),
          error.message,
        );
        assert.equal(error.message.includes(CREDS.secretAccessKey), false);
        assert.equal(error.message.includes("raw vendor text"), false);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
  // A "request id" that is not id-shaped is dropped; so are oversized and non-JSON bodies.
  for (const response of [
    () =>
      new Response(
        body(
          "SignatureDoesNotMatch",
          `<script>${CREDS.secretAccessKey}</script>`,
        ),
        { status: 401 },
      ),
    () => new Response(body("SignatureDoesNotMatch", "short"), { status: 401 }),
    () =>
      new Response(
        `{"ResponseMetadata":{"RequestId":"${REQUEST_ID}","Error":{"Code":"SignatureDoesNotMatch","Message":"${"x".repeat(70000)}"}}}`,
        { status: 401 },
      ),
    () => new Response("<html>401</html>", { status: 401 }),
  ]) {
    await assert.rejects(
      generate({
        input: INPUT,
        credentials: CREDS,
        fetchImpl: async () => response(),
      }),
      (error) =>
        error.name === "MusicError" &&
        !error.message.includes("请求编号") &&
        !error.message.includes("script") &&
        !error.message.includes(CREDS.secretAccessKey),
    );
  }
  // HTTP 200 with an error envelope keeps the request id as well.
  await assert.rejects(
    generate({
      input: INPUT,
      credentials: CREDS,
      fetchImpl: async () =>
        json({
          ResponseMetadata: {
            RequestId: REQUEST_ID,
            Error: { Code: "InvalidTimestamp", Message: "x" },
          },
        }),
    }),
    (error) =>
      /签名时间无效/.test(error.message) && error.message.includes(REQUEST_ID),
  );
});
