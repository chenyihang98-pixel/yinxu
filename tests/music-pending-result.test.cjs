"use strict";

// FQ-01 (main half): a paid result the main process still holds is never dropped
//        silently - a new generation is refused until the caller says the result
//        may be given up, and the service tells what it holds.
// FQ-03: a Volcengine task that was accepted but had not finished when the wait
//        ended is kept, and retryLastDownload() resumes the wait and downloads -
//        no new submission.
// ND-1:  (service side) a billable request that never left this computer ends
//        every time, and is reported as not sent.
const test = require("node:test");
const assert = require("node:assert/strict");
const volcengine = require("../electron/providers/volcengine.cjs");
const aliyun = require("../electron/providers/aliyun.cjs");
const {
  createMusicService,
  PENDING_RESULT,
  PENDING_RESULT_PREFIX,
} = require("../electron/music-service.cjs");
const { createBillingFetch } = require("../electron/net-fetch.cjs");
const { TASK_RUNNING_ADVICE } = require("../electron/providers/shared.cjs");
const { PROVIDERS } = require("../electron/credentials.cjs");

const INPUT = { prompt: "青春欢快的校园钢琴背景音乐", duration: 30 };
const KEYS = {
  elevenlabs: { apiKey: "fake-elevenlabs-key-only" },
  tencent: { apiKey: "fake-tokenhub-key-only" },
  volcengine: {
    accessKeyId: "AKIDEXAMPLEFAKE",
    secretAccessKey: "fake-volcengine-secret-only",
    billingMode: "postpaid",
  },
  aliyun: {
    apiKey: "fake-bailian-key-only",
    workspaceId: "workspace-test-123",
    model: "fun-music-v1",
  },
};
const MP3 = Buffer.from([
  0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x00,
]);
const REQUEST_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const TASK = "fixture-task-123";
const OSS_URL =
  "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/pre/fun-music/a.mp3?Signature=secret-signature";
const CDN_URL =
  "https://v3-default.douyinvod.com/fixture.mp3?token=secret-token";
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const audio = () =>
  new Response(MP3, { headers: { "Content-Type": "audio/mpeg" } });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isPost = (options) => options?.method === "POST";
/** Rejects when the request is aborted, never answers otherwise. */
const hang = (_url, options) =>
  new Promise((_resolve, reject) =>
    options.signal.addEventListener(
      "abort",
      () => reject(new Error("aborted")),
      { once: true },
    ),
  );

/** The adapters wait 1 - 15 s between attempts; the tests do not. Restored after each test. */
function withoutWaiting(t) {
  for (const adapter of [volcengine, aliyun]) {
    const original = adapter.generate;
    adapter.generate = (options) =>
      original({ ...options, helpers: { sleep: async () => {} } });
    t.after(() => {
      adapter.generate = original;
    });
  }
}

/**
 * A stand-in for the four services with every request recorded as
 * "PAID …" (through submitFetch) or "FREE …" (through fetchImpl).
 * `script.download(url, options)` and `script.poll(count, options)` decide the
 * free answers; `script.submit(provider, options)` may replace a submission's answer.
 */
function world(script = {}) {
  const log = [];
  let polls = 0;
  const answer = async (via, url, options) => {
    const target = new URL(url);
    const action = target.searchParams.get("Action");
    log.push(`${via} ${options.method} ${action ?? target.hostname}`);
    if (action === "QuerySong") {
      polls++;
      return script.poll
        ? script.poll(polls, options)
        : json({
            Code: 0,
            Result: {
              Status: 2,
              SongDetail: { AudioUrl: CDN_URL, Duration: 30.5 },
            },
          });
    }
    if (!isPost(options))
      return script.download ? script.download(url, options) : audio();
    const provider =
      action !== null
        ? "volcengine"
        : target.hostname === "api.elevenlabs.io"
          ? "elevenlabs"
          : target.hostname === "tokenhub.tencentmaas.com"
            ? "tencent"
            : "aliyun";
    const custom = script.submit
      ? await script.submit(provider, options)
      : null;
    if (custom) return custom;
    if (provider === "volcengine")
      return json({ Code: 0, Result: { TaskID: TASK } });
    if (provider === "elevenlabs") return audio();
    if (provider === "tencent")
      return json({
        base_resp: { status_code: 0 },
        data: { status: 2, audio: MP3.toString("hex") },
      });
    return json({
      request_id: REQUEST_ID,
      output: { finish_reason: "stop", audio: { url: OSS_URL } },
    });
  };
  return {
    log,
    paid: () => log.filter((entry) => entry.startsWith("PAID")),
    count: (pattern) => log.filter((entry) => pattern.test(entry)).length,
    fetchImpl: (url, options) => answer("FREE", url, options),
    submitFetch: (url, options) => answer("PAID", url, options),
  };
}
const serviceIn = (place, options = {}) =>
  createMusicService({
    fetchImpl: place.fetchImpl,
    submitFetch: place.submitFetch,
    ...options,
  });
const generate = (service, provider, extra = {}) =>
  service.generate({ ...INPUT, provider, ...extra }, KEYS[provider]);

/* -------------------------------------------------------------------- FQ-01 */

test("FQ-01: the service says what it holds, and refuses a new paid generation over it", async (t) => {
  withoutWaiting(t);
  const place = world({ download: () => new Response("", { status: 403 }) });
  const service = serviceIn(place);
  assert.equal(service.pendingResult, null);
  await assert.rejects(generate(service, "aliyun"), (error) =>
    /^音乐已生成，但下载失败/.test(error.message),
  );
  assert.deepEqual(service.pendingResult, {
    provider: "aliyun",
    kind: "download",
  });
  assert.equal(service.pendingDownload, "aliyun");

  const before = place.log.length;
  // For the same service and for every other one; a flag that is not the boolean true does not count.
  for (const provider of PROVIDERS)
    for (const extra of [
      {},
      { discardPending: false },
      { discardPending: "true" },
      { discardPending: 1 },
      { discardPending: {} },
      { discardPending: null },
    ])
      await assert.rejects(generate(service, provider, extra), (error) => {
        assert.equal(error.name, "MusicError", "it reaches the renderer");
        assert.equal(error.code, PENDING_RESULT);
        assert.equal(error.code, "PENDING_RESULT");
        assert.equal(error.provider, "aliyun");
        assert.ok(error.message.startsWith(PENDING_RESULT_PREFIX));
        assert.equal(
          error.message,
          "还有一首已经付费的音乐没有取回，这次没有发出新的生成请求。请先点「重新下载」把它取回；确认不要它之后，才能开始新的生成。",
        );
        return true;
      });
  assert.equal(place.log.length, before, "a refused generation sends nothing");
  assert.equal(service.busy, false);
  assert.deepEqual(
    service.pendingResult,
    { provider: "aliyun", kind: "download" },
    "and takes nothing away",
  );
  // Whoever reads the credentials is not even asked.
  let reads = 0;
  await assert.rejects(
    service.generate({ ...INPUT, provider: "tencent" }, () => {
      reads++;
      return KEYS.tencent;
    }),
    { code: PENDING_RESULT },
  );
  assert.equal(reads, 0);
  // An invalid request is still told what is wrong with it.
  await assert.rejects(
    generate(service, "tencent", { duration: 1 }),
    /描述或时长无效/,
  );
  await assert.rejects(generate(service, "../main"), /不支持/);
});

test("FQ-01: with discardPending the waiting result goes when the new paid request goes out - not before", async (t) => {
  withoutWaiting(t);
  let failDownloads = true;
  const place = world({
    download: () =>
      failDownloads ? new Response("", { status: 403 }) : audio(),
  });
  const service = serviceIn(place);
  await assert.rejects(generate(service, "aliyun"), /下载失败/);
  assert.equal(service.pendingDownload, "aliyun");

  // While the key store is still being read nothing has replaced it.
  let finishRead;
  const next = service.generate(
    { ...INPUT, provider: "tencent", discardPending: true },
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
  );
  await pause(10);
  assert.equal(service.busy, true);
  assert.equal(service.pendingDownload, "aliyun");
  finishRead(KEYS.tencent);
  assert.equal((await next).mimeType, "audio/mpeg");
  assert.equal(service.pendingResult, null, "given up for the new one");
  assert.deepEqual(place.paid(), [
    "PAID POST workspace-test-123.cn-beijing.maas.aliyuncs.com",
    "PAID POST tokenhub.tencentmaas.com",
  ]);
  await assert.rejects(
    service.retryLastDownload("aliyun"),
    /没有等待重新下载的音乐/,
  );
  // With nothing waiting the flag changes nothing.
  assert.equal(
    (await generate(service, "tencent", { discardPending: true })).mimeType,
    "audio/mpeg",
  );
  // A new result that cannot be fetched takes the place of the one given up.
  await assert.rejects(generate(service, "aliyun"), /下载失败/);
  await assert.rejects(
    generate(service, "volcengine", { discardPending: true }),
    (error) =>
      /下载失败/.test(error.message) &&
      error.message.endsWith(`（任务编号 ${TASK}）`),
  );
  assert.deepEqual(service.pendingResult, {
    provider: "volcengine",
    kind: "download",
  });
  failDownloads = false;
  assert.equal(
    (await service.retryLastDownload("volcengine")).requestedDuration,
    30,
  );
});

test("FQ-01: a generation that sends nothing takes nothing away, even when it was allowed to", async (t) => {
  withoutWaiting(t);
  let failDownloads = true;
  const closing = { fail: false };
  const session = {
    closeAllConnections: async () => {
      if (closing.fail) throw new Error("network service is gone");
    },
    fetch: (url, options) => place.submitFetch(url, options),
  };
  const place = world({
    download: () =>
      failDownloads ? new Response("", { status: 403 }) : audio(),
  });
  const service = createMusicService({
    fetchImpl: place.fetchImpl,
    submitFetch: createBillingFetch(() => session, { closeTimeoutMs: 50 }),
  });
  await assert.rejects(generate(service, "aliyun"), /下载失败/);
  const held = { provider: "aliyun", kind: "download" };
  const paidBefore = place.paid().length;
  const allowed = { ...INPUT, discardPending: true };

  // No credentials, a key that cannot be one, a parameter the service does not take.
  await assert.rejects(
    service.generate({ ...allowed, provider: "tencent" }, async () => {
      throw new (require("../electron/providers/shared.cjs").MusicError)(
        "请先在设置中填写所选音乐服务的凭据。",
      );
    }),
    /请先在设置中填写/,
  );
  await assert.rejects(
    service.generate({ ...allowed, provider: "tencent" }, { apiKey: "short" }),
    /TokenHub API Key/,
  );
  await assert.rejects(
    service.generate(
      { ...allowed, provider: "volcengine", duration: 15 },
      KEYS.volcengine,
    ),
    /30–120 秒/,
  );
  assert.deepEqual(service.pendingResult, held);
  // Cancelled while the key store was being read.
  const reading = service.generate(
    { ...allowed, provider: "tencent" },
    () => new Promise(() => {}),
  );
  service.cancel();
  await assert.rejects(reading, /这次请求还没有发出，不会计费/);
  assert.deepEqual(service.pendingResult, held);
  // The transport could not send it (ND-1).
  closing.fail = true;
  for (const provider of PROVIDERS)
    await assert.rejects(
      service.generate({ ...allowed, provider }, KEYS[provider]),
      (error) => /^没有发出请求，不会计费/.test(error.message),
      provider,
    );
  closing.fail = false;
  assert.deepEqual(service.pendingResult, held);
  assert.equal(place.paid().length, paidBefore, "nothing billable was sent");
  // ... so the music that was paid for is still there to fetch.
  failDownloads = false;
  assert.equal(
    (await service.retryLastDownload("aliyun")).mimeType,
    "audio/mpeg",
  );
  assert.equal(place.paid().length, paidBefore);
});

test("FQ-01: once the new paid request has gone out the old result is gone, whatever the answer", async (t) => {
  withoutWaiting(t);
  const place = world({
    download: () => new Response("", { status: 403 }),
    submit: (provider) =>
      provider === "tencent" ? json({ error: "x" }, 401) : null,
  });
  const service = serviceIn(place);
  await assert.rejects(generate(service, "aliyun"), /下载失败/);
  await assert.rejects(
    generate(service, "tencent", { discardPending: true }),
    /API Key 无效或已过期/,
  );
  assert.equal(
    service.pendingResult,
    null,
    "the user was asked and a new request was paid for: the service holds one result, the last",
  );
});

test("FQ-01: discardPending(provider) gives the result up explicitly; a wrong or missing id gives up nothing", async (t) => {
  withoutWaiting(t);
  let mode = "fail";
  const place = world({
    download: (url, options) =>
      mode === "hang" ? hang(url, options) : new Response("", { status: 403 }),
  });
  const service = serviceIn(place);
  assert.equal(service.discardPending("aliyun"), false, "nothing to give up");
  await assert.rejects(generate(service, "aliyun"), /下载失败/);
  for (const other of PROVIDERS.filter((id) => id !== "aliyun"))
    assert.equal(service.discardPending(other), false, other);
  for (const invalid of [
    undefined,
    null,
    "",
    "../main",
    { provider: "aliyun" },
  ])
    assert.throws(
      () => service.discardPending(invalid),
      { name: "MusicError" },
      String(invalid),
    );
  assert.equal(service.pendingDownload, "aliyun");
  // Not while that result is being fetched.
  mode = "hang";
  const fetching = service.retryLastDownload("aliyun");
  assert.throws(() => service.discardPending("aliyun"), /正在生成/);
  service.cancel();
  await assert.rejects(fetching, /已取消下载/);
  assert.equal(service.pendingDownload, "aliyun");

  const sent = place.log.length;
  assert.equal(service.discardPending("aliyun"), true);
  assert.equal(service.pendingResult, null);
  assert.equal(place.log.length, sent, "giving up requests nothing");
  assert.equal(service.discardPending("aliyun"), false, "only once");
  await assert.rejects(
    service.retryLastDownload("aliyun"),
    /没有等待重新下载的音乐/,
  );
  // The next generation needs no flag.
  mode = "fail";
  assert.equal((await generate(service, "tencent")).mimeType, "audio/mpeg");
});

/* -------------------------------------------------------------------- FQ-03 */

const running = () => json({ Code: 0, Result: { Status: 1 } });
const finished = () =>
  json({
    Code: 0,
    Result: { Status: 2, SongDetail: { AudioUrl: CDN_URL, Duration: 30.5 } },
  });
const RESUMABLE = `${TASK_RUNNING_ADVICE}（任务编号 ${TASK}）`;

test("FQ-03: five failed status queries no longer abandon the paid task - it is kept, and 重新下载 resumes the wait", async (t) => {
  withoutWaiting(t);
  let outage = true;
  const place = world({
    poll: (count) =>
      outage
        ? new Response("bad gateway", { status: 502 })
        : count % 2
          ? running()
          : finished(),
  });
  const service = serviceIn(place);
  await assert.rejects(generate(service, "volcengine"), (error) => {
    assert.equal(error.name, "MusicError");
    assert.equal(
      error.message,
      `火山引擎任务状态连续 5 次查询失败，已停止等待。${RESUMABLE}`,
    );
    assert.match(error.message, /仍在服务商那边运行/);
    assert.match(error.message, /「重新下载」/);
    assert.match(error.message, /不会再次提交，也不会再次计费/);
    return true;
  });
  assert.deepEqual(place.log, [
    "PAID POST GenBGMForTime",
    ...Array(volcengine.MAX_POLL_FAILURES).fill("FREE POST QuerySong"),
  ]);
  assert.deepEqual(service.pendingResult, {
    provider: "volcengine",
    kind: "task",
  });
  assert.equal(service.busy, false);

  // Still down: the wait gives up the same way, and the task is still kept.
  await assert.rejects(
    service.retryLastDownload("volcengine"),
    (error) =>
      error.message ===
      `火山引擎任务状态连续 5 次查询失败，已停止等待。${RESUMABLE}`,
  );
  assert.deepEqual(service.pendingResult, {
    provider: "volcengine",
    kind: "task",
  });
  assert.equal(place.count(/QuerySong/), 10);

  // The network is back: it goes on querying the same task, then downloads.
  outage = false;
  const mark = place.log.length;
  const result = await service.retryLastDownload("volcengine");
  assert.equal(result.mimeType, "audio/mpeg");
  assert.deepEqual(Buffer.from(result.audio), MP3);
  assert.equal(result.requestedDuration, 30);
  assert.equal(result.providerDuration, 30.5);
  assert.deepEqual(place.log.slice(mark), [
    "FREE POST QuerySong",
    "FREE POST QuerySong",
    "FREE GET v3-default.douyinvod.com",
  ]);
  assert.deepEqual(
    place.paid(),
    ["PAID POST GenBGMForTime"],
    "one billable request in all: the resume submits nothing",
  );
  assert.equal(service.pendingResult, null);
  assert.equal(service.busy, false);
  await assert.rejects(
    service.retryLastDownload("volcengine"),
    /没有等待重新下载的音乐/,
  );
});

test("FQ-03: the job's time limit and a cancel during the wait keep the task too, and say so", async (t) => {
  withoutWaiting(t);
  let mode = "hang";
  const place = world({
    poll: (_count, options) =>
      mode === "hang" ? hang(null, options) : finished(),
  });
  const timed = serviceIn(place, { timeoutMs: 40 });
  await assert.rejects(
    generate(timed, "volcengine"),
    (error) =>
      error.message === `AI 生成等待超过 5 分钟，已停止等待。${RESUMABLE}`,
  );
  assert.deepEqual(timed.pendingResult, {
    provider: "volcengine",
    kind: "task",
  });
  assert.equal(timed.busy, false);
  // A resume is under the same limit ...
  await assert.rejects(
    timed.retryLastDownload("volcengine"),
    (error) =>
      error.message === `AI 生成等待超过 5 分钟，已停止等待。${RESUMABLE}`,
  );
  assert.deepEqual(timed.pendingResult, {
    provider: "volcengine",
    kind: "task",
  });
  // ... and then collects.
  mode = "done";
  assert.equal(
    (await timed.retryLastDownload("volcengine")).mimeType,
    "audio/mpeg",
  );
  assert.equal(timed.pendingResult, null);

  mode = "hang";
  const patient = serviceIn(place);
  const waiting = generate(patient, "volcengine");
  await pause(20);
  patient.cancel();
  await assert.rejects(
    waiting,
    (error) => error.message === `已取消等待生成。${RESUMABLE}`,
  );
  assert.deepEqual(patient.pendingResult, {
    provider: "volcengine",
    kind: "task",
  });
  // Cancel ends a resume at once as well, and keeps the task.
  const resumed = patient.retryLastDownload("volcengine");
  assert.equal(patient.busy, true);
  await assert.rejects(generate(patient, "tencent"), /正在生成/);
  await pause(20);
  const cancelledAt = Date.now();
  patient.cancel();
  await assert.rejects(
    resumed,
    (error) => error.message === `已取消等待生成。${RESUMABLE}`,
  );
  assert.ok(Date.now() - cancelledAt < 500);
  assert.equal(patient.busy, false);
  assert.equal(patient.pendingDownload, "volcengine");
  assert.equal(
    place.count(/^PAID/),
    2,
    "two generations, two submissions - no resume ever submitted",
  );
  // A new generation is refused over it like over any other paid result (FQ-01).
  await assert.rejects(generate(patient, "tencent"), { code: PENDING_RESULT });
});

test("FQ-03: every resume is bounded - 150 queries, five failures in a row - and a task that never finishes stays collectable", async (t) => {
  withoutWaiting(t);
  const place = world({ poll: () => running() });
  const service = serviceIn(place);
  await assert.rejects(
    generate(service, "volcengine"),
    (error) =>
      error.message ===
      `火山引擎音乐任务等待超过 5 分钟，已停止等待。${RESUMABLE}`,
  );
  assert.equal(place.count(/QuerySong/), 150);
  for (let round = 2; round <= 3; round++) {
    await assert.rejects(
      service.retryLastDownload("volcengine"),
      /超过 5 分钟/,
    );
    assert.equal(place.count(/QuerySong/), 150 * round);
    assert.deepEqual(service.pendingResult, {
      provider: "volcengine",
      kind: "task",
    });
  }
  assert.equal(place.count(/^PAID/), 1);
});

test("FQ-03: a resumed task that finishes but cannot be downloaded becomes a download to retry; one that failed is final", async (t) => {
  withoutWaiting(t);
  let pollAnswer = () => new Response("", { status: 503 });
  let downloadAnswer = () => new Response("", { status: 503 });
  const place = world({
    poll: () => pollAnswer(),
    download: () => downloadAnswer(),
  });
  const service = serviceIn(place);
  await assert.rejects(generate(service, "volcengine"), /连续 5 次查询失败/);
  // The task finishes; the CDN is down.
  pollAnswer = finished;
  await assert.rejects(
    service.retryLastDownload("volcengine"),
    (error) =>
      /^音乐已生成，但下载失败（已尝试 4 次/.test(error.message) &&
      error.message.endsWith(`（任务编号 ${TASK}）`),
  );
  assert.deepEqual(service.pendingResult, {
    provider: "volcengine",
    kind: "download",
  });
  const queries = place.count(/QuerySong/);
  // From here on only the file is fetched: no further status query.
  downloadAnswer = audio;
  assert.equal(
    (await service.retryLastDownload("volcengine")).mimeType,
    "audio/mpeg",
  );
  assert.equal(place.count(/QuerySong/), queries);
  assert.equal(service.pendingResult, null);

  // Another task: the service reports that it failed. Nothing is left to collect.
  pollAnswer = () => new Response("", { status: 503 });
  await assert.rejects(generate(service, "volcengine"), /连续 5 次查询失败/);
  pollAnswer = () =>
    json({
      Code: 0,
      Result: { Status: 3, FailureReason: { Code: 300061, Msg: "x" } },
    });
  await assert.rejects(
    service.retryLastDownload("volcengine"),
    (error) =>
      /版权校验未通过/.test(error.message) &&
      error.message.endsWith(`（任务编号 ${TASK}）`) &&
      !error.message.includes("重新下载"),
  );
  assert.equal(service.pendingResult, null);
  await assert.rejects(
    service.retryLastDownload("volcengine"),
    /没有等待重新下载的音乐/,
  );
  // A finished task whose address cannot be used is final as well - on the first wait and on a resume.
  pollAnswer = () =>
    json({
      Code: 0,
      Result: {
        Status: 2,
        SongDetail: { AudioUrl: "https://example.com/a.mp3" },
      },
    });
  await assert.rejects(generate(service, "volcengine"), /白名单/);
  assert.equal(service.pendingResult, null);
  assert.equal(place.count(/^PAID/), 3, "three generations, three submissions");
});

test("FQ-03: a refused query or an unknown status ends the wait, not the task", async (t) => {
  withoutWaiting(t);
  for (const [answer, expected] of [
    [() => new Response("", { status: 401 }), /API Key 无效或已过期/],
    [
      () =>
        new Response(
          JSON.stringify({
            ResponseMetadata: { Error: { Code: "RequestExpired" } },
          }),
          { status: 400 },
        ),
      /签名时间无效，请同步电脑时间/,
    ],
    [() => json({ Code: 0, Result: { Status: 99 } }), /未知任务状态/],
  ]) {
    let pollAnswer = answer;
    const place = world({ poll: () => pollAnswer() });
    const service = serviceIn(place);
    await assert.rejects(generate(service, "volcengine"), (error) => {
      assert.match(error.message, expected);
      assert.ok(error.message.endsWith(RESUMABLE), error.message);
      assert.equal(
        error.message.includes(KEYS.volcengine.secretAccessKey),
        false,
      );
      return true;
    });
    assert.equal(place.count(/QuerySong/), 1, "not retried: it would not heal");
    assert.deepEqual(service.pendingResult, {
      provider: "volcengine",
      kind: "task",
    });
    // Once the cause is fixed (the clock, the permission) the same task is collected.
    pollAnswer = finished;
    assert.equal(
      (await service.retryLastDownload("volcengine")).mimeType,
      "audio/mpeg",
    );
    assert.equal(place.count(/^PAID/), 1);
  }
});

test("FQ-03: before the service has accepted a task there is nothing to keep", async (t) => {
  withoutWaiting(t);
  for (const submit of [
    () => new Response("", { status: 502 }),
    () => json({ Code: 0, Result: {} }),
    () => {
      throw new TypeError("fetch failed");
    },
  ]) {
    const place = world({ submit });
    const service = serviceIn(place);
    await assert.rejects(generate(service, "volcengine"), {
      name: "MusicError",
    });
    assert.equal(service.pendingResult, null);
    assert.equal(place.count(/QuerySong/), 0);
  }
  // Called on its own (no one to resume), the adapter points to the console instead of a button.
  await assert.rejects(
    volcengine.generate({
      input: INPUT,
      credentials: KEYS.volcengine,
      fetchImpl: world({ poll: () => new Response("", { status: 502 }) })
        .fetchImpl,
    }),
    (error) =>
      /到控制台按任务编号查看，不要重复提交/.test(error.message) &&
      !error.message.includes("重新下载"),
  );
});

/* --------------------------------------------------------------------- ND-1 */

/** The billing transport over a session whose closeAllConnections() does as told. */
function billingWorld(close, options) {
  const place = world();
  const session = {
    closes: 0,
    closeAllConnections: () => {
      session.closes++;
      return close();
    },
    fetch: (url, init) => place.submitFetch(url, init),
  };
  return {
    place,
    session,
    submitFetch: createBillingFetch(() => session, options),
  };
}

test("ND-1: a submission stuck before sending cannot hold the service - cancel, the time limit and the bound each end it, as not sent", async (t) => {
  withoutWaiting(t);
  const never = () => new Promise(() => {});
  for (const provider of PROVIDERS) {
    // Cancel (the transport's own bound is far away).
    const stuck = billingWorld(never, { closeTimeoutMs: 600_000 });
    const service = createMusicService({
      fetchImpl: stuck.place.fetchImpl,
      submitFetch: stuck.submitFetch,
    });
    const pending = generate(service, provider);
    await pause(20);
    assert.equal(service.busy, true);
    const cancelledAt = Date.now();
    service.cancel();
    await assert.rejects(
      pending,
      (error) =>
        error.name === "MusicError" &&
        error.message === "已取消等待生成。这次请求还没有发出，不会计费。",
      provider,
    );
    assert.ok(Date.now() - cancelledAt < 500, provider);
    assert.equal(service.busy, false, `${provider}: the lock is released`);
    assert.deepEqual(stuck.place.log, [], `${provider}: nothing was sent`);
    assert.equal(service.pendingResult, null);

    // The job's overall limit.
    const limited = billingWorld(never, { closeTimeoutMs: 600_000 });
    const timed = createMusicService({
      fetchImpl: limited.place.fetchImpl,
      submitFetch: limited.submitFetch,
      timeoutMs: 40,
    });
    await assert.rejects(
      generate(timed, provider),
      (error) =>
        error.message ===
        "AI 生成等待超过 5 分钟，已停止等待。这次请求还没有发出，不会计费。",
      provider,
    );
    assert.equal(timed.busy, false);
    assert.deepEqual(limited.place.log, []);

    // Neither: the transport gives up by itself.
    const bounded = billingWorld(never, { closeTimeoutMs: 40 });
    const alone = createMusicService({
      fetchImpl: bounded.place.fetchImpl,
      submitFetch: bounded.submitFetch,
    });
    const started = Date.now();
    await assert.rejects(
      generate(alone, provider),
      (error) =>
        error.name === "MusicError" &&
        error.message ===
          "没有发出请求，不会计费：应用没能为这次付费请求准备好独立的网络连接。请稍后重试；如果反复出现，请重启应用。",
      provider,
    );
    assert.ok(Date.now() - started < 2000);
    assert.equal(alone.busy, false);
    assert.deepEqual(bounded.place.log, []);
  }
});

test("ND-1: 'not sent' is said only when it is true; the service works again once the transport does", async (t) => {
  withoutWaiting(t);
  let broken = true;
  const flaky = billingWorld(async () => {
    if (broken) throw new Error("network service is gone");
  });
  const service = createMusicService({
    fetchImpl: flaky.place.fetchImpl,
    submitFetch: flaky.submitFetch,
  });
  for (const provider of PROVIDERS)
    await assert.rejects(
      generate(service, provider),
      (error) =>
        /^没有发出请求，不会计费/.test(error.message) &&
        !/未确认|控制台|账户记录/.test(error.message),
      `${provider}: used to read "请求结果未确认，先查看服务控制台记录"`,
    );
  assert.deepEqual(flaky.place.log, []);
  broken = false;
  for (const provider of PROVIDERS)
    assert.equal((await generate(service, provider)).mimeType, "audio/mpeg");
  assert.equal(flaky.place.paid().length, 4);

  // Sent and then lost: the result really is unknown, and the message still says so.
  const lost = createMusicService({
    fetchImpl: async () => audio(),
    submitFetch: createBillingFetch(() => ({
      closeAllConnections: async () => {},
      fetch: async () => {
        throw new Error("net::ERR_CONNECTION_RESET");
      },
    })),
  });
  for (const provider of PROVIDERS)
    await assert.rejects(
      generate(lost, provider),
      (error) =>
        /未确认|未自动重试/.test(error.message) &&
        !error.message.includes("没有发出"),
      provider,
    );
  // Cancelled after it was sent: it may be billed.
  const sent = createMusicService({ fetchImpl: hang });
  const waiting = generate(sent, "tencent");
  await pause(10);
  sent.cancel();
  await assert.rejects(
    waiting,
    (error) =>
      error.message ===
      "已取消等待生成。服务端可能仍会完成并计费，请先检查账户记录再重试。",
  );
  // A failure inside the app before anything is sent is not blamed on the network or the account.
  const internal = createMusicService({ fetchImpl: async () => audio() });
  await assert.rejects(
    internal.generate({ ...INPUT, provider: "tencent" }, async () => {
      throw new Error("EPERM: operation not permitted");
    }),
    (error) =>
      error.message ===
      "没有发出请求，不会计费：应用在发送之前出了问题。请稍后重试；如果反复出现，请重启应用。",
  );
});
