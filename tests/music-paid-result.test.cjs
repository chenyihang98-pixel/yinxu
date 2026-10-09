"use strict";

// MAIN-01: the one billable request of every service travels through `submitFetch`
//          (the transport that cannot re-send); polls and downloads never do.
// MAIN-02: a finished, paid result survives a failing download: the download is
//          retried, the final message says the music exists and names the
//          request / task, and the result can be fetched again without a new submission.
const test = require("node:test");
const assert = require("node:assert/strict");
const shared = require("../electron/providers/shared.cjs");
const aliyun = require("../electron/providers/aliyun.cjs");
const volcengine = require("../electron/providers/volcengine.cjs");
const { createMusicService } = require("../electron/music-service.cjs");
const { PROVIDERS } = require("../electron/credentials.cjs");

const { MusicError, DOWNLOAD_ATTEMPTS } = shared;
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
const noSleep = { sleep: async () => {} };
const isPost = (options) => options?.method === "POST";
const policy = {
  allowedHostSuffixes: ["aliyuncs.com"],
  hostAllowed: aliyun.isOssHost,
};

/** Answers of the four services, good enough for a whole generation; `download()` supplies the file. */
function vendor(provider, download = audio) {
  return async (url, options) => {
    const target = new URL(url);
    if (provider === "elevenlabs") return audio();
    if (provider === "tencent")
      return json({
        base_resp: { status_code: 0 },
        data: { status: 2, audio: MP3.toString("hex") },
      });
    if (provider === "aliyun")
      return isPost(options)
        ? json({
            request_id: REQUEST_ID,
            output: { finish_reason: "stop", audio: { url: OSS_URL } },
          })
        : download(url, options);
    if (/Action=GenBGM/.test(target.search))
      return json({ Code: 0, Result: { TaskID: TASK } });
    if (/Action=QuerySong/.test(target.search))
      return json({
        Code: 0,
        Result: { Status: 2, SongDetail: { AudioUrl: CDN_URL, Duration: 30 } },
      });
    return download(url, options);
  };
}

/* ------------------------------------------------------------------ MAIN-01 */

test("MAIN-01: every service sends exactly its billable POST through submitFetch and nothing else", async () => {
  const billable = {
    elevenlabs: (url) =>
      url === "https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128",
    tencent: (url) =>
      url ===
      "https://tokenhub.tencentmaas.com/v1/wand/minimax-music/generation",
    aliyun: (url) =>
      url ===
      "https://workspace-test-123.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/music/generation",
    volcengine: (url) =>
      /^https:\/\/open\.volcengineapi\.com\/\?Action=GenBGMForTime&/.test(url),
  };
  assert.deepEqual(
    Object.keys(billable).sort(),
    [...PROVIDERS].sort(),
    "every service is covered",
  );
  for (const provider of PROVIDERS) {
    const submitted = [],
      free = [];
    const answer = vendor(provider);
    const service = createMusicService({
      submitFetch: async (url, options) => {
        submitted.push([String(url), options]);
        return answer(url, options);
      },
      fetchImpl: async (url, options) => {
        free.push([String(url), options]);
        return answer(url, options);
      },
    });
    const result = await service.generate(
      { ...INPUT, provider },
      KEYS[provider],
    );
    assert.ok(result.audio instanceof ArrayBuffer, provider);
    assert.equal(submitted.length, 1, `${provider}: one billable request`);
    assert.ok(
      billable[provider](submitted[0][0]),
      `${provider}: ${submitted[0][0]}`,
    );
    assert.equal(submitted[0][1].method, "POST");
    assert.equal(
      submitted[0][1].redirect,
      "error",
      'the billing transport only accepts redirect "error"',
    );
    for (const [url] of free)
      assert.equal(
        billable[provider](url),
        false,
        `${provider}: ${url} must not use the ordinary path`,
      );
    const expectedFree = {
      elevenlabs: 0,
      tencent: 0,
      aliyun: 1,
      volcengine: 2,
    }[provider]; // download; status query + download
    assert.equal(free.length, expectedFree, `${provider}: free requests`);
    for (const [, options] of free)
      if (provider === "aliyun") assert.equal(options.method, "GET");
  }
});

test("MAIN-01: a submission that fails is never sent again, on either path, and is reported as unconfirmed", async () => {
  for (const provider of PROVIDERS) {
    let submitted = 0,
      free = 0;
    const service = createMusicService({
      submitFetch: async () => {
        submitted++;
        throw new Error("net::ERR_CONNECTION_RESET");
      },
      fetchImpl: async () => {
        free++;
        return audio();
      },
    });
    await assert.rejects(
      service.generate({ ...INPUT, provider }, KEYS[provider]),
      (error) => {
        assert.equal(error.name, "MusicError");
        assert.equal(/ERR_CONNECTION_RESET/.test(error.message), false);
        if (provider !== "volcengine")
          assert.equal(
            error.message,
            "无法连接音乐服务，请检查网络。请求结果未确认，先查看服务控制台记录，再决定是否手动重试。",
          );
        else assert.match(error.message, /任务未自动重试/);
        return true;
      },
    );
    assert.equal(submitted, 1, provider);
    assert.equal(free, 0, `${provider}: nothing else is tried`);
    assert.equal(service.pendingDownload, null);
  }
});

test("MAIN-01: without a separate transport the injected fetch carries everything (unit-test seam)", async () => {
  for (const provider of PROVIDERS) {
    const calls = [];
    const answer = vendor(provider);
    const service = createMusicService({
      fetchImpl: async (url, options) => {
        calls.push(String(url));
        return answer(url, options);
      },
    });
    await service.generate({ ...INPUT, provider }, KEYS[provider]);
    assert.equal(
      calls.length,
      { elevenlabs: 1, tencent: 1, aliyun: 2, volcengine: 3 }[provider],
      provider,
    );
  }
});

/* ------------------------------------------------------------------ MAIN-02 */

test("MAIN-02: downloadAudio retries network errors and 408 / 429 / 5xx with backoff, then succeeds", async () => {
  const blips = {
    "network error": () => {
      throw new TypeError("fetch failed: read ECONNRESET");
    },
    "HTTP 500": () => new Response("", { status: 500 }),
    "HTTP 502": () => new Response("bad gateway", { status: 502 }),
    "HTTP 503": () => new Response("", { status: 503 }),
    "HTTP 429": () => new Response("", { status: 429 }),
    "HTTP 408": () => new Response("", { status: 408 }),
    "body cut off": () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new TypeError("terminated"));
          },
        }),
        { headers: { "content-type": "audio/mpeg" } },
      ),
  };
  for (const [name, blip] of Object.entries(blips)) {
    for (const failures of [1, DOWNLOAD_ATTEMPTS - 1]) {
      const calls = [],
        waits = [];
      const result = await shared.downloadAudio(OSS_URL, {
        ...policy,
        sleep: async (ms) => {
          waits.push(ms);
        },
        fetchImpl: async (url, options) => {
          calls.push([url, options]);
          return calls.length <= failures ? blip() : audio();
        },
      });
      assert.equal(result.mimeType, "audio/mpeg", name);
      assert.equal(calls.length, failures + 1, name);
      assert.deepEqual(
        waits,
        [1000, 2000, 4000].slice(0, failures),
        `${name}: backoff`,
      );
      for (const [url, options] of calls) {
        assert.equal(
          url,
          OSS_URL,
          "every attempt starts again at the result address",
        );
        assert.deepEqual(
          options.headers,
          { Accept: "audio/*,application/octet-stream" },
          "never any credentials",
        );
        assert.equal(options.redirect, "manual");
      }
    }
  }
  assert.equal(DOWNLOAD_ATTEMPTS, 4);
});

test("MAIN-02: after the last attempt the message says the music exists; nothing upstream leaks", async () => {
  for (const blip of [
    () => {
      throw new TypeError(`fetch failed ${KEYS.aliyun.apiKey} ${OSS_URL}`);
    },
    () => new Response(`secret ${KEYS.aliyun.apiKey}`, { status: 503 }),
  ]) {
    let calls = 0;
    await assert.rejects(
      shared.downloadAudio(OSS_URL, {
        ...policy,
        ...noSleep,
        fetchImpl: async () => {
          calls++;
          return blip();
        },
      }),
      (error) => {
        assert.equal(error.name, "MusicError");
        assert.equal(error.downloadFailed, true);
        assert.match(error.message, /^音乐已生成，但下载失败（已尝试 4 次/);
        assert.match(error.message, /重新生成会再次计费/);
        assert.equal(
          /secret|Signature|oss-cn|fetch failed/.test(error.message),
          false,
          error.message,
        );
        return true;
      },
    );
    assert.equal(calls, DOWNLOAD_ATTEMPTS);
  }
});

test("MAIN-02: failures another attempt cannot heal are not retried", async () => {
  const cases = [
    [
      () => new Response("", { status: 403 }),
      /^音乐已生成，但下载失败（文件服务器返回了 403，下载链接可能已过期）/,
    ],
    [
      () => new Response("", { status: 404 }),
      /^音乐已生成，但下载失败（文件服务器返回了 404/,
    ],
    [() => new Response("<html>not audio</html>"), /格式不受支持/],
    [
      () => new Response(MP3, { headers: { "content-length": "999999999" } }),
      /过大/,
    ],
    [
      () =>
        new Response("", {
          status: 302,
          headers: { location: "https://evil.test/a.mp3" },
        }),
      /非官方/,
    ],
    [() => new Response("", { status: 302 }), /重定向无效/],
    [
      () =>
        new Response("", { status: 302, headers: { location: "http://[bad" } }),
      /重定向无效/,
    ],
  ];
  for (const [respond, expected] of cases) {
    let calls = 0;
    await assert.rejects(
      shared.downloadAudio(OSS_URL, {
        ...policy,
        ...noSleep,
        fetchImpl: async () => {
          calls++;
          return respond();
        },
      }),
      (error) => error instanceof MusicError && expected.test(error.message),
      String(expected),
    );
    assert.equal(calls, 1, String(expected));
  }
});

test("MAIN-02: the address is checked again on every attempt and every hop", async () => {
  // First attempt: allowed redirect, then a 503. Second attempt: the same first URL redirects to a refused host.
  const seen = [];
  const script = [
    () =>
      new Response("", {
        status: 302,
        headers: {
          location: "https://another-result.oss-cn-beijing.aliyuncs.com/b.mp3",
        },
      }),
    () => new Response("", { status: 503 }),
    () =>
      new Response("", {
        status: 307,
        headers: {
          location: "https://attacker.cn-shanghai.fc.aliyuncs.com/b.mp3",
        },
      }),
    () => audio(),
  ];
  await assert.rejects(
    shared.downloadAudio(OSS_URL, {
      ...policy,
      ...noSleep,
      fetchImpl: async (url) => {
        seen.push(url);
        return script.shift()();
      },
    }),
    /非官方/,
  );
  assert.deepEqual(
    seen,
    [
      OSS_URL,
      "https://another-result.oss-cn-beijing.aliyuncs.com/b.mp3",
      OSS_URL,
    ],
    "the refused hop is never requested",
  );
  // A predicate that changes its mind between attempts is honoured as well.
  let allowed = true,
    calls = 0;
  await assert.rejects(
    shared.downloadAudio(OSS_URL, {
      allowedHostSuffixes: ["aliyuncs.com"],
      hostAllowed: () => allowed,
      ...noSleep,
      fetchImpl: async () => {
        calls++;
        allowed = false;
        return new Response("", { status: 500 });
      },
    }),
    /非官方/,
  );
  assert.equal(calls, 1);
});

test("MAIN-02: cancel and the time limit stop the retries at once, also during a backoff", async () => {
  const before = new AbortController();
  before.abort();
  let calls = 0;
  await assert.rejects(
    shared.downloadAudio(OSS_URL, {
      ...policy,
      signal: before.signal,
      fetchImpl: async () => {
        calls++;
        return audio();
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(calls, 0);

  const during = new AbortController();
  const started = Date.now();
  await assert.rejects(
    shared.downloadAudio(OSS_URL, {
      ...policy,
      signal: during.signal,
      fetchImpl: async () => {
        calls++;
        setTimeout(() => during.abort(), 20);
        return new Response("", { status: 502 });
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(calls, 1, "no further attempt after the abort");
  assert.ok(Date.now() - started < 900, "did not sit out the 1 s backoff");

  // A failure caused by the abort itself is reported as the abort, not as a download failure.
  const inFlight = new AbortController();
  await assert.rejects(
    shared.downloadAudio(OSS_URL, {
      ...policy,
      signal: inFlight.signal,
      ...noSleep,
      fetchImpl: () =>
        new Promise((_resolve, reject) => {
          inFlight.signal.addEventListener("abort", () =>
            reject(new TypeError("aborted by caller")),
          );
          setTimeout(() => inFlight.abort(), 10);
        }),
    }),
    { name: "AbortError" },
  );
});

test("MAIN-02 Aliyun: one dropped download no longer loses the song; the POST is sent once", async () => {
  let downloads = 0;
  const calls = [];
  const result = await aliyun.generate({
    input: INPUT,
    credentials: KEYS.aliyun,
    helpers: noSleep,
    fetchImpl: async (url, options) => {
      calls.push(options.method);
      if (isPost(options))
        return json({
          request_id: REQUEST_ID,
          output: { finish_reason: "stop", audio: { url: OSS_URL } },
        });
      downloads++;
      if (downloads === 1) throw new TypeError("fetch failed");
      return audio();
    },
  });
  assert.equal(result.mimeType, "audio/mpeg");
  assert.deepEqual(calls, ["POST", "GET", "GET"]);
});

test("MAIN-02 Aliyun: every failure after the result names the request id", async () => {
  const cases = [
    [
      () => {
        throw new TypeError("fetch failed");
      },
      /^音乐已生成，但下载失败（已尝试 4 次/,
      DOWNLOAD_ATTEMPTS,
    ],
    [
      () => new Response("", { status: 502 }),
      /^音乐已生成，但下载失败（已尝试 4 次/,
      DOWNLOAD_ATTEMPTS,
    ],
    [
      () => new Response("", { status: 403 }),
      /^音乐已生成，但下载失败（文件服务器返回了 403/,
      1,
    ],
    [() => new Response("<html>"), /格式不受支持/, 1],
  ];
  for (const [download, expected, attempts] of cases) {
    let posts = 0,
      gets = 0;
    await assert.rejects(
      aliyun.generate({
        input: INPUT,
        credentials: KEYS.aliyun,
        helpers: noSleep,
        fetchImpl: async (_url, options) => {
          if (isPost(options)) {
            posts++;
            return json({
              request_id: REQUEST_ID,
              output: { finish_reason: "stop", audio: { url: OSS_URL } },
            });
          }
          gets++;
          return download();
        },
      }),
      (error) => {
        assert.match(error.message, expected);
        assert.ok(
          error.message.endsWith(`（请求编号 ${REQUEST_ID}）`),
          error.message,
        );
        assert.equal(error.message.includes(KEYS.aliyun.apiKey), false);
        assert.equal(
          /Signature|oss-cn/.test(error.message),
          false,
          "the result address is never shown",
        );
        return true;
      },
    );
    assert.equal(posts, 1, "the billable request is never repeated");
    assert.equal(gets, attempts);
  }
  // A refused address is named too, and is not something that can be fetched again.
  const reported = [];
  await assert.rejects(
    aliyun.generate({
      input: INPUT,
      credentials: KEYS.aliyun,
      onResult: (fetchAgain) => reported.push(fetchAgain),
      fetchImpl: async () =>
        json({
          request_id: REQUEST_ID,
          output: {
            finish_reason: "stop",
            audio: {
              url: "https://attacker.cn-shanghai.fc.aliyuncs.com/a.mp3",
            },
          },
        }),
    }),
    (error) =>
      /非官方/.test(error.message) &&
      error.message.endsWith(`（请求编号 ${REQUEST_ID}）`),
  );
  assert.deepEqual(reported, []);
});

test("MAIN-02 Volcengine: a CDN hiccup is retried; the task is submitted and queried no more than before", async () => {
  for (const blip of [
    () => new Response("bad gateway", { status: 502 }),
    () => {
      throw new TypeError("socket hang up");
    },
  ]) {
    const seen = [];
    let downloads = 0;
    const result = await volcengine.generate({
      input: INPUT,
      credentials: KEYS.volcengine,
      helpers: noSleep,
      fetchImpl: async (url, options) => {
        const target = new URL(url);
        seen.push(
          target.searchParams.get("Action") ?? `GET ${target.hostname}`,
        );
        if (/GenBGM/.test(target.search))
          return json({ Code: 0, Result: { TaskID: TASK } });
        if (/QuerySong/.test(target.search))
          return json({
            Code: 0,
            Result: {
              Status: 2,
              SongDetail: { AudioUrl: CDN_URL, Duration: 30.5 },
            },
          });
        assert.equal(options.method, "GET");
        downloads++;
        return downloads === 1 ? blip() : audio();
      },
    });
    assert.equal(result.mimeType, "audio/mpeg");
    assert.equal(result.requestedDuration, 30);
    assert.equal(result.providerDuration, 30.5);
    assert.deepEqual(seen, [
      "GenBGMForTime",
      "QuerySong",
      "GET v3-default.douyinvod.com",
      "GET v3-default.douyinvod.com",
    ]);
  }
});

test("MAIN-02 service: a failed download keeps the result, and retryLastDownload fetches it without a new submission", async () => {
  for (const provider of ["aliyun", "volcengine"]) {
    const submitted = [],
      free = [];
    let healthy = false;
    const answer = vendor(provider, () =>
      healthy ? audio() : new Response("", { status: 503 }),
    );
    const service = createMusicService({
      submitFetch: async (url, options) => {
        submitted.push(String(url));
        return answer(url, options);
      },
      fetchImpl: async (url, options) => {
        free.push([String(url), options]);
        return answer(url, options);
      },
    });
    const original = {
      aliyun: require("../electron/providers/aliyun.cjs"),
      volcengine: require("../electron/providers/volcengine.cjs"),
    }[provider].generate;
    const adapter = require(`../electron/providers/${provider}.cjs`);
    adapter.generate = (options) => original({ ...options, helpers: noSleep });
    try {
      assert.equal(service.pendingDownload, null);
      await assert.rejects(
        service.generate({ ...INPUT, provider }, KEYS[provider]),
        (error) => {
          assert.match(error.message, /^音乐已生成，但下载失败（已尝试 4 次/);
          assert.ok(
            error.message.endsWith(
              provider === "aliyun"
                ? `（请求编号 ${REQUEST_ID}）`
                : `（任务编号 ${TASK}）`,
            ),
            error.message,
          );
          return true;
        },
      );
      assert.equal(service.busy, false);
      assert.equal(service.pendingDownload, provider);
      assert.equal(submitted.length, 1);
      const downloadsBefore = free.filter(
        ([, options]) => options.method === "GET",
      ).length;
      assert.equal(downloadsBefore, DOWNLOAD_ATTEMPTS);

      // Guarded by the service id: nothing can be fetched for another service, or without one.
      for (const other of [
        ...PROVIDERS.filter((id) => id !== provider),
        undefined,
        null,
        "",
        "../main",
        { provider },
        OSS_URL,
      ]) {
        await assert.rejects(
          service.retryLastDownload(other),
          (error) => error.name === "MusicError",
          String(other),
        );
      }
      assert.equal(
        free.filter(([, options]) => options.method === "GET").length,
        downloadsBefore,
        "a refused retry requests nothing",
      );

      // Still failing: the result stays available.
      await assert.rejects(service.retryLastDownload(provider), (error) =>
        /^音乐已生成，但下载失败/.test(error.message),
      );
      assert.equal(service.pendingDownload, provider);

      healthy = true;
      const result = await service.retryLastDownload(provider);
      assert.equal(result.mimeType, "audio/mpeg");
      assert.deepEqual(Buffer.from(result.audio), MP3);
      if (provider === "volcengine") assert.equal(result.requestedDuration, 30);
      assert.equal(submitted.length, 1, "no second paid submission");
      assert.equal(
        free.filter(([url]) => /QuerySong/.test(url)).length,
        provider === "volcengine" ? 1 : 0,
        "no new status query either",
      );
      assert.equal(service.pendingDownload, null);
      assert.equal(service.busy, false);
      await assert.rejects(
        service.retryLastDownload(provider),
        /没有等待重新下载的音乐/,
      );
    } finally {
      adapter.generate = original;
    }
  }
});

test("MAIN-02 service: retryLastDownload shares the single-flight lock, cancel and the time limit with generate", async () => {
  let mode = "fail";
  const hang = (_url, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      }),
    );
  const answer = vendor("aliyun", (url, options) =>
    mode === "hang" ? hang(url, options) : new Response("", { status: 403 }),
  );
  const service = createMusicService({ fetchImpl: answer, timeoutMs: 400 });
  await assert.rejects(
    service.generate({ ...INPUT, provider: "aliyun" }, KEYS.aliyun),
    /文件服务器返回了 403/,
  );
  assert.equal(service.pendingDownload, "aliyun");

  mode = "hang";
  const retry = service.retryLastDownload("aliyun");
  assert.equal(service.busy, true);
  await assert.rejects(
    service.generate({ ...INPUT, provider: "tencent" }, KEYS.tencent),
    /正在生成/,
  );
  await assert.rejects(service.retryLastDownload("aliyun"), /正在生成/);
  service.cancel();
  await assert.rejects(
    retry,
    (error) =>
      /^已取消下载。音乐已经生成/.test(error.message) &&
      error.message.endsWith(`（请求编号 ${REQUEST_ID}）`),
  );
  assert.equal(service.busy, false);
  assert.equal(
    service.pendingDownload,
    "aliyun",
    "a cancelled retry can be asked for again",
  );

  await assert.rejects(
    service.retryLastDownload("aliyun"),
    (error) =>
      /^下载等待超过 5 分钟，已停止。音乐已经生成/.test(error.message) &&
      error.message.includes(REQUEST_ID),
  );
  assert.equal(service.busy, false);
  assert.equal(service.pendingDownload, "aliyun");
});

test("MAIN-02 service: cancelling during the download says the music exists and keeps it; a new generation replaces it", async () => {
  let mode = "hang";
  const hang = (_url, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      }),
    );
  const answer = vendor("volcengine", (url, options) =>
    mode === "hang" ? hang(url, options) : audio(),
  );
  const service = createMusicService({ fetchImpl: answer });
  const pending = service.generate(
    { ...INPUT, provider: "volcengine" },
    KEYS.volcengine,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  service.cancel();
  await assert.rejects(
    pending,
    (error) =>
      /^已取消下载。音乐已经生成，重新生成会再次计费/.test(error.message) &&
      error.message.endsWith(`（任务编号 ${TASK}）`),
  );
  assert.equal(service.pendingDownload, "volcengine");

  mode = "ok";
  assert.equal(
    (await service.retryLastDownload("volcengine")).mimeType,
    "audio/mpeg",
  );
  assert.equal(service.pendingDownload, null);

  // A failed download followed by a new generation: the old result is no longer "the last one".
  mode = "hang";
  const again = service.generate(
    { ...INPUT, provider: "volcengine" },
    KEYS.volcengine,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  service.cancel();
  await assert.rejects(again, /已取消下载/);
  assert.equal(service.pendingDownload, "volcengine");
  const next = createMusicService({ fetchImpl: vendor("tencent") });
  assert.equal(
    next.pendingDownload,
    null,
    "kept per service instance, in memory only",
  );
  await assert.rejects(
    service.generate({ ...INPUT, provider: "tencent" }, { apiKey: "short" }),
  );
  assert.equal(
    service.pendingDownload,
    null,
    "replaced as soon as another generation starts",
  );
});

test("MAIN-02 service: results that arrive inside the answer (ElevenLabs, Tencent) have nothing to fetch again", async () => {
  for (const provider of ["elevenlabs", "tencent"]) {
    const service = createMusicService({
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await assert.rejects(
      service.generate({ ...INPUT, provider }, KEYS[provider]),
      /请求结果未确认/,
    );
    assert.equal(service.pendingDownload, null);
    await assert.rejects(
      service.retryLastDownload(provider),
      /没有等待重新下载的音乐/,
    );
  }
});
