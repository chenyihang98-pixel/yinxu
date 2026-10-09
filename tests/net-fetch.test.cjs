"use strict";

// F05: the fetch wrapper around Electron's `net` module. The real Chromium behaviour
// (redirects, abort, body cut-off, proxy) is exercised under Electron by
// scripts/desktop-smoke.cjs; these tests pin the wrapper's own logic against a fake `net`.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { createNetFetch } = require("../electron/net-fetch.cjs");
const shared = require("../electron/providers/shared.cjs");

function fakeNet({
  respond = async () =>
    new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    }),
} = {}) {
  const fetchCalls = [],
    requests = [];
  return {
    fetchCalls,
    requests,
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      return respond(url, init);
    },
    request: (options) => {
      const request = new EventEmitter();
      Object.assign(request, {
        options,
        headers: {},
        aborted: false,
        ended: false,
        setHeader(name, value) {
          this.headers[name] = value;
        },
        abort() {
          this.aborted = true;
        },
        end() {
          this.ended = true;
        },
      });
      requests.push(request);
      return request;
    },
  };
}

test("requires the Electron net module", () => {
  for (const bad of [undefined, null, {}, { fetch() {} }, { request() {} }])
    assert.throws(() => createNetFetch(bad), TypeError);
});

test('standard requests go through net.fetch without cookies or cache, redirect defaults to "error"', async () => {
  const net = fakeNet();
  const netFetch = createNetFetch(net);
  const response = await netFetch("https://api.example-vendor.com/v1/x", {
    method: "POST",
    headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
    body: '{"a":1}',
  });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(net.fetchCalls.length, 1);
  const { url, init } = net.fetchCalls[0];
  assert.equal(url, "https://api.example-vendor.com/v1/x");
  assert.equal(init.method, "POST");
  assert.equal(
    init.redirect,
    "error",
    'a missing redirect option never means "follow"',
  );
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
  assert.equal(init.body, '{"a":1}');
  assert.deepEqual(init.headers, {
    Authorization: "Bearer k",
    "Content-Type": "application/json",
  });
  assert.ok(init.signal instanceof AbortSignal);
  await netFetch("https://api.example-vendor.com/v1/x", { redirect: "error" });
  assert.equal(net.fetchCalls[1].init.method, "GET");
  assert.equal("body" in net.fetchCalls[1].init, false);
  await netFetch("https://api.example-vendor.com/v1/x", { redirect: "follow" });
  assert.equal(
    net.fetchCalls[2].init.redirect,
    "follow",
    "an explicit choice is respected",
  );
  await netFetch(new URL("https://api.example-vendor.com/v1/y"));
  assert.equal(net.fetchCalls[3].url, "https://api.example-vendor.com/v1/y");
});

test("headers Chromium refuses are dropped; a Host header that disagrees with the URL is an error", async () => {
  const net = fakeNet();
  const netFetch = createNetFetch(net);
  // The Volcengine adapter signs and sends a Host header; raw net.fetch fails with ERR_INVALID_ARGUMENT on it.
  await netFetch("https://open.volcengineapi.com/?Action=QuerySong", {
    method: "POST",
    body: "{}",
    headers: {
      Host: "open.volcengineapi.com",
      "Content-Type": "application/json",
      "X-Date": "20261008T000000Z",
      "Content-Length": "2",
      Connection: "keep-alive",
      Cookie: "a=b",
      Authorization: "HMAC-SHA256 Credential=x",
    },
  });
  assert.deepEqual(net.fetchCalls[0].init.headers, {
    "Content-Type": "application/json",
    "X-Date": "20261008T000000Z",
    Authorization: "HMAC-SHA256 Credential=x",
  });
  await netFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: "{}",
    headers: new Headers({
      "x-api-key": "k",
      "anthropic-version": "2023-06-01",
      host: "api.anthropic.com",
    }),
  });
  assert.deepEqual(net.fetchCalls[1].init.headers, {
    "anthropic-version": "2023-06-01",
    "x-api-key": "k",
  });
  await assert.rejects(
    netFetch("https://open.volcengineapi.com/", {
      headers: { Host: "evil.test" },
    }),
    TypeError,
  );
  assert.equal(net.fetchCalls.length, 2);
  await netFetch("https://api.example-vendor.com/", {
    headers: { "X-Skip": undefined, "X-Null": null, "X-Number": 5 },
  });
  assert.deepEqual(net.fetchCalls[2].init.headers, { "X-Number": "5" });
});

test("only http(s) URLs and known redirect modes are accepted", async () => {
  const net = fakeNet();
  const netFetch = createNetFetch(net);
  for (const url of [
    "file:///C:/Windows/win.ini",
    "ftp://example.com/x",
    "data:text/plain,hi",
    "chrome://settings",
    "not a url",
  ])
    await assert.rejects(netFetch(url), TypeError, url);
  await assert.rejects(
    netFetch("https://example.com/", { redirect: "whatever" }),
    TypeError,
  );
  await assert.rejects(
    netFetch("https://example.com/", {
      method: "POST",
      body: "{}",
      redirect: "manual",
    }),
    TypeError,
    "manual redirects are for credential-free GET downloads only",
  );
  assert.equal(net.fetchCalls.length + net.requests.length, 0);
});

test("abort: already aborted sends nothing; an abort in flight reaches the underlying request", async () => {
  const net = fakeNet({
    respond: (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener(
          "abort",
          () =>
            reject(
              new DOMException("This operation was aborted", "AbortError"),
            ),
          { once: true },
        ),
      ),
  });
  const netFetch = createNetFetch(net);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    netFetch("https://example.com/", { signal: aborted.signal }),
    { name: "AbortError" },
  );
  await assert.rejects(
    netFetch("https://example.com/", {
      signal: aborted.signal,
      redirect: "manual",
    }),
    { name: "AbortError" },
  );
  assert.equal(net.fetchCalls.length + net.requests.length, 0);
  const controller = new AbortController();
  const pending = netFetch("https://example.com/", {
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(net.fetchCalls[0].init.signal.aborted, false);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(net.fetchCalls[0].init.signal.aborted, true);
});

test("cancelling or over-running the body aborts the request (raw net.fetch kept downloading)", async () => {
  let pulls = 0,
    cancelled = false;
  const endless = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(65536));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );
  const net = fakeNet({ respond: async () => endless() });
  const netFetch = createNetFetch(net);
  const response = await netFetch("https://cdn.example-vendor.com/big");
  await assert.rejects(shared.readBounded(response, 256 * 1024), /大小限制/);
  assert.equal(
    net.fetchCalls[0].init.signal.aborted,
    true,
    "the size cap ends the transfer, not just the reading",
  );
  assert.equal(cancelled, true);
  assert.ok(pulls <= 8, `stopped pulling near the cap (${pulls} chunks)`);
  // Declared too large: cancelled before any read.
  const declared = fakeNet({
    respond: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(10));
          },
        }),
        { headers: { "content-length": "99999999" } },
      ),
  });
  const second = await createNetFetch(declared)(
    "https://cdn.example-vendor.com/big",
  );
  await assert.rejects(shared.readBounded(second, 1024), /过大/);
  assert.equal(declared.fetchCalls[0].init.signal.aborted, true);
  // A body read to the end does not abort anything, and the caller's abort listener is released.
  const fine = fakeNet();
  const controller = new AbortController();
  const third = await createNetFetch(fine)("https://api.example-vendor.com/", {
    signal: controller.signal,
  });
  assert.deepEqual(await third.json(), { ok: true });
  assert.equal(fine.fetchCalls[0].init.signal.aborted, false);
  controller.abort();
  assert.equal(
    fine.fetchCalls[0].init.signal.aborted,
    false,
    "a finished request is no longer tied to the caller signal",
  );
});

test("status, headers and empty bodies are preserved", async () => {
  const net = fakeNet({
    respond: async (url) =>
      url.endsWith("/401")
        ? new Response('{"error":"denied"}', {
            status: 401,
            statusText: "Unauthorized",
            headers: { "request-id": "req_abc12345" },
          })
        : new Response(null, { status: 204 }),
  });
  const netFetch = createNetFetch(net);
  const denied = await netFetch("https://api.example-vendor.com/401");
  assert.equal(denied.status, 401);
  assert.equal(denied.ok, false);
  assert.equal(denied.headers.get("request-id"), "req_abc12345");
  assert.deepEqual(await denied.json(), { error: "denied" });
  const empty = await netFetch("https://api.example-vendor.com/204");
  assert.equal(empty.status, 204);
  assert.equal(empty.body, null);
});

test('redirect "manual": the redirect is reported, not followed, through net.request', async () => {
  const net = fakeNet();
  const netFetch = createNetFetch(net);
  const pending = netFetch(
    "https://bucket.oss-cn-beijing.aliyuncs.com/a.mp3?sig=1",
    {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "audio/*,application/octet-stream",
        Host: "bucket.oss-cn-beijing.aliyuncs.com",
      },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(net.fetchCalls.length, 0);
  const [request] = net.requests;
  assert.deepEqual(request.options, {
    url: "https://bucket.oss-cn-beijing.aliyuncs.com/a.mp3?sig=1",
    method: "GET",
    redirect: "manual",
    credentials: "omit",
    cache: "no-store",
  });
  assert.deepEqual(request.headers, {
    Accept: "audio/*,application/octet-stream",
  });
  assert.equal(request.ended, true);
  request.emit(
    "redirect",
    302,
    "GET",
    "https://other.oss-cn-beijing.aliyuncs.com/b.mp3",
    { location: ["ignored"] },
  );
  request.emit("error", new Error("Redirect was cancelled")); // Electron reports the unfollowed redirect this way
  const response = await pending;
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://other.oss-cn-beijing.aliyuncs.com/b.mp3",
  );
  assert.equal(response.body, null);
});

test('redirect "manual": a normal answer streams, obeys the size cap and aborts on cancel', async () => {
  const net = fakeNet();
  const netFetch = createNetFetch(net);
  const pending = netFetch("https://v1-default.douyinvod.com/a.wav", {
    redirect: "manual",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const [request] = net.requests;
  const incoming = Readable.from([
    Buffer.from("RIFF"),
    Buffer.alloc(100000),
    Buffer.alloc(100000),
    Buffer.alloc(100000),
  ]);
  Object.assign(incoming, {
    statusCode: 200,
    statusMessage: "OK",
    headers: { "content-type": "audio/wav", "set-cookie": ["a=1", "b=2"] },
  });
  request.emit("response", incoming);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  await assert.rejects(shared.readBounded(response, 150000), /大小限制/);
  assert.equal(request.aborted, true);

  // Small body read completely: no abort.
  const small = netFetch("https://v1-default.douyinvod.com/b.wav", {
    redirect: "manual",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = net.requests[1];
  const body = Readable.from([
    Buffer.from("fLaC"),
    Buffer.from([0x80, 0, 0, 0]),
  ]);
  Object.assign(body, { statusCode: 200, statusMessage: "OK", headers: {} });
  second.emit("response", body);
  assert.equal((await shared.readAudio(await small)).mimeType, "audio/flac");
  assert.equal(second.aborted, false);
});

test('redirect "manual": network errors and aborts reject; late events are ignored', async () => {
  const net = fakeNet();
  const netFetch = createNetFetch(net);
  const failing = netFetch("https://v1-default.douyinvod.com/a.wav", {
    redirect: "manual",
  });
  await new Promise((resolve) => setImmediate(resolve));
  net.requests[0].emit("error", new Error("net::ERR_CONNECTION_RESET"));
  await assert.rejects(failing, /ERR_CONNECTION_RESET/);

  const controller = new AbortController();
  const aborting = netFetch("https://v1-default.douyinvod.com/a.wav", {
    redirect: "manual",
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(aborting, { name: "AbortError" });
  assert.equal(net.requests[1].aborted, true);
  net.requests[1].emit("redirect", 302, "GET", "https://evil.test/", {}); // too late to matter
  net.requests[1].emit("error", new Error("aborted"));
});

test("shared.downloadAudio follows an allowed redirect and refuses a hostile one through the wrapper", async () => {
  const net = fakeNet();
  const netFetch = createNetFetch(net);
  const drive = async (steps) => {
    for (const step of steps) {
      await new Promise((resolve) => setImmediate(resolve));
      step(net.requests.at(-1));
    }
  };
  const wav = Buffer.alloc(48);
  wav.write("RIFF");
  wav.write("WAVEfmt ", 8);
  const download = shared.downloadAudio(
    "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?sig=1",
    { fetchImpl: netFetch, allowedHostSuffixes: ["aliyuncs.com"] },
  );
  await drive([
    (request) =>
      request.emit(
        "redirect",
        302,
        "GET",
        "https://another.oss-cn-beijing.aliyuncs.com/b.wav",
        {},
      ),
    (request) => {
      const body = Readable.from([wav]);
      Object.assign(body, {
        statusCode: 200,
        statusMessage: "OK",
        headers: {},
      });
      request.emit("response", body);
    },
  ]);
  assert.equal((await download).mimeType, "audio/wav");
  assert.deepEqual(
    net.requests.map((request) => request.options.url),
    [
      "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?sig=1",
      "https://another.oss-cn-beijing.aliyuncs.com/b.wav",
    ],
  );
  for (const request of net.requests)
    assert.deepEqual(
      request.headers,
      { Accept: "audio/*,application/octet-stream" },
      "no credentials on download hops",
    );

  const hostile = shared.downloadAudio(
    "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav",
    { fetchImpl: netFetch, allowedHostSuffixes: ["aliyuncs.com"] },
  );
  await drive([
    (request) =>
      request.emit("redirect", 307, "GET", "https://evil.test/steal", {}),
  ]);
  await assert.rejects(hostile, /非官方/);
  assert.equal(net.requests.length, 3, "the hostile hop is never requested");
});

/* ------------------------------------------------------------------ MAIN-01 */
// The billing transport. That Chromium really re-sends on a reused connection, and really does not on
// this path, is proven under Electron by scripts/desktop-smoke.cjs; these tests pin the wrapper's logic.

const {
  createBillingFetch,
  BILLING_PARTITION,
} = require("../electron/net-fetch.cjs");

function fakeSession({
  respond = async () =>
    new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    }),
  closeDelay = 0,
} = {}) {
  const log = [];
  return {
    log,
    closeAllConnections: async () => {
      log.push("close");
      if (closeDelay)
        await new Promise((resolve) => setTimeout(resolve, closeDelay));
      log.push("closed");
    },
    fetch: async (url, init) => {
      log.push({ url, init });
      return respond(url, init);
    },
  };
}
const fetches = (session) =>
  session.log.filter((entry) => typeof entry === "object");
const post = (billingFetch, extra = {}) =>
  billingFetch("https://api.example-vendor.com/v1/music", {
    method: "POST",
    headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
    body: '{"prompt":"paid"}',
    ...extra,
  });

test("MAIN-01: every billable submission closes all connections of its own session first", async () => {
  assert.equal(BILLING_PARTITION, "muse-billing");
  assert.equal(
    BILLING_PARTITION.startsWith("persist:"),
    false,
    "an in-memory partition: nothing of it is written to disk",
  );
  const session = fakeSession();
  let sessions = 0;
  const billingFetch = createBillingFetch(() => {
    sessions++;
    return session;
  });
  assert.equal(
    sessions,
    0,
    "the session is only asked for when a request is made (it does not exist before the app is ready)",
  );
  for (let round = 0; round < 3; round++)
    assert.deepEqual(await (await post(billingFetch)).json(), { ok: true });
  assert.deepEqual(
    session.log.map((entry) => (typeof entry === "string" ? entry : "fetch")),
    [
      "close",
      "closed",
      "fetch",
      "close",
      "closed",
      "fetch",
      "close",
      "closed",
      "fetch",
    ],
    "close completes, then the request goes out - every time",
  );
  const { url, init } = fetches(session)[0];
  assert.equal(url, "https://api.example-vendor.com/v1/music");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
  assert.equal(init.body, '{"prompt":"paid"}');
  assert.deepEqual(init.headers, {
    Authorization: "Bearer k",
    "Content-Type": "application/json",
  });
  assert.ok(init.signal instanceof AbortSignal);
});

test('MAIN-01: only POST with redirect "error" may use the billing path; the same header rules apply', async () => {
  const session = fakeSession();
  const billingFetch = createBillingFetch(() => session);
  assert.throws(() => createBillingFetch(), TypeError);
  assert.throws(
    () => createBillingFetch(session),
    TypeError,
    "a provider function, not a session",
  );
  await assert.rejects(
    billingFetch("https://api.example-vendor.com/v1/music"),
    TypeError,
    "GET",
  );
  await assert.rejects(
    billingFetch("https://api.example-vendor.com/v1/music", {
      method: "PUT",
      body: "{}",
    }),
    TypeError,
  );
  for (const redirect of ["follow", "manual", "whatever"])
    await assert.rejects(post(billingFetch, { redirect }), TypeError, redirect);
  for (const url of [
    "file:///C:/Windows/win.ini",
    "data:text/plain,hi",
    "not a url",
  ])
    await assert.rejects(
      billingFetch(url, { method: "POST", body: "{}" }),
      TypeError,
      url,
    );
  await assert.rejects(
    billingFetch("https://open.volcengineapi.com/", {
      method: "POST",
      body: "{}",
      headers: { Host: "evil.test" },
    }),
    TypeError,
  );
  assert.deepEqual(
    session.log,
    [],
    "a refused call closes nothing and sends nothing",
  );
  await billingFetch("https://open.volcengineapi.com/?Action=GenBGMForTime", {
    method: "post",
    redirect: "error",
    body: "{}",
    headers: {
      Host: "open.volcengineapi.com",
      "Content-Length": "2",
      Cookie: "a=b",
      "X-Date": "20261008T000000Z",
    },
  });
  assert.deepEqual(fetches(session)[0].init.headers, {
    "X-Date": "20261008T000000Z",
  });
});

test("MAIN-01: if the connections cannot be closed, nothing is sent", async () => {
  const failing = {
    closeAllConnections: async () => {
      throw new Error("network service is gone");
    },
    fetch: async () => {
      throw new Error("must not be reached");
    },
  };
  await assert.rejects(
    post(createBillingFetch(() => failing)),
    /network service is gone/,
  );
  for (const broken of [
    null,
    undefined,
    {},
    { fetch: async () => new Response("x") },
    { closeAllConnections: async () => {} },
  ]) {
    await assert.rejects(post(createBillingFetch(() => broken)), TypeError);
  }
  await assert.rejects(
    post(
      createBillingFetch(() => {
        throw new Error("the app is not ready");
      }),
    ),
    /not ready/,
  );
  // The queue is not left blocked by any of these.
  const session = fakeSession();
  const billingFetch = createBillingFetch(() => session);
  await assert.rejects(post(billingFetch, { redirect: "follow" }), TypeError);
  assert.deepEqual(await (await post(billingFetch)).json(), { ok: true });
});

test("MAIN-01: submissions never overlap - the next one waits until the previous has let go of its connection", async () => {
  // First response: a body that is still streaming (ElevenLabs answers with the audio itself).
  let finishBody;
  const streaming = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          finishBody = () => controller.close();
        },
      }),
      { status: 200 },
    );
  let count = 0;
  const session = fakeSession({
    respond: async () => (++count === 1 ? streaming() : new Response("second")),
  });
  const billingFetch = createBillingFetch(() => session);
  const first = await post(billingFetch);
  let secondSettled = false;
  const second = post(billingFetch).then((response) => {
    secondSettled = true;
    return response;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondSettled, false);
  assert.equal(
    session.log.filter((entry) => entry === "close").length,
    1,
    "the connections of a submission in flight are not closed under it",
  );
  const reader = first.body.getReader();
  await reader.read();
  finishBody();
  assert.equal((await reader.read()).done, true);
  assert.equal(await (await second).text(), "second");
  assert.equal(session.log.filter((entry) => entry === "close").length, 2);

  // An aborted submission releases the queue even when nobody reads its body.
  let hung = 0;
  const hanging = fakeSession({
    respond: (_url, init) =>
      ++hung === 1
        ? new Promise((_resolve, reject) =>
            init.signal.addEventListener(
              "abort",
              () =>
                reject(
                  new DOMException("This operation was aborted", "AbortError"),
                ),
              { once: true },
            ),
          )
        : new Response("after abort"),
  });
  const fetchTwo = createBillingFetch(() => hanging);
  const controller = new AbortController();
  const stuck = post(fetchTwo, { signal: controller.signal });
  const next = post(fetchTwo);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetches(hanging).length, 1);
  controller.abort();
  await assert.rejects(stuck, { name: "AbortError" });
  assert.equal(await (await next).text(), "after abort");
  // ... and so does one whose answer arrived but whose body was abandoned by an abort.
  const idle = fakeSession({
    respond: async () =>
      new Response(new ReadableStream({ pull() {} }), { status: 200 }),
  });
  const fetchThree = createBillingFetch(() => idle);
  const abandoned = new AbortController();
  await post(fetchThree, { signal: abandoned.signal });
  const follower = post(fetchThree);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetches(idle).length, 1);
  abandoned.abort();
  await follower;
  assert.equal(fetches(idle).length, 2);
  assert.equal(
    fetches(idle)[0].init.signal.aborted,
    true,
    "the abandoned request itself is aborted",
  );
});

test("MAIN-01: abort before sending, while the connections are being closed, and while waiting in the queue", async () => {
  const session = fakeSession({ closeDelay: 40 });
  const billingFetch = createBillingFetch(() => session);
  const before = new AbortController();
  before.abort();
  await assert.rejects(post(billingFetch, { signal: before.signal }), {
    name: "AbortError",
  });
  assert.deepEqual(session.log, []);

  const during = new AbortController();
  const pending = post(billingFetch, { signal: during.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  during.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(
    fetches(session).length,
    0,
    "aborted while closing: the request is never sent",
  );

  // Queued behind a submission that never finishes: the abort still answers at once.
  const blocked = fakeSession({
    respond: async () =>
      new Response(new ReadableStream({ pull() {} }), { status: 200 }),
  });
  const queued = createBillingFetch(() => blocked);
  await post(queued);
  const waiting = new AbortController();
  const second = post(queued, { signal: waiting.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  waiting.abort();
  await assert.rejects(second, { name: "AbortError" });
  assert.equal(fetches(blocked).length, 1);
  // A request that gave up while waiting must not let the one behind it overtake the submission in flight.
  const third = post(queued);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    fetches(blocked).length,
    1,
    "still waiting for the first submission",
  );
  assert.equal(
    blocked.log.filter((entry) => entry === "close").length,
    1,
    "its connections are not closed under it",
  );
  third.catch(() => {});
});

test("MAIN-01: the body guard works on the billing path too (size cap ends the transfer)", async () => {
  const endless = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(65536));
        },
      }),
      { status: 200 },
    );
  const session = fakeSession({ respond: async () => endless() });
  const billingFetch = createBillingFetch(() => session);
  await assert.rejects(
    shared.readBounded(await post(billingFetch), 256 * 1024),
    /大小限制/,
  );
  assert.equal(fetches(session)[0].init.signal.aborted, true);
  // ... and the queue has been released by it.
  await assert.rejects(
    shared.readBounded(await post(billingFetch), 1024),
    /大小限制/,
  );
  assert.equal(fetches(session).length, 2);
});

test("MAIN-01: main.cjs gives the music service the billing transport, turns QUIC off, and keeps the Node switch for both paths", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "electron", "main.cjs"),
    "utf8",
  );
  const { shape, wires } = require("./helpers/source-shape.cjs");
  const quicOff = shape(`app.commandLine.appendSwitch("disable-quic")`);
  assert.ok(shape(source).includes(quicOff));
  assert.ok(
    shape(source).indexOf(quicOff) < shape(source).indexOf("app.whenReady()"),
    "switches only count before the app is ready",
  );
  assert.ok(
    wires(
      source,
      `createBillingFetch(() => session.fromPartition(BILLING_PARTITION))`,
    ),
  );
  assert.ok(wires(source, `createMusicService({ fetchImpl, submitFetch })`));
  assert.ok(
    wires(
      source,
      `const submitFetch = useNodeNetwork ? nodeFetch : createBillingFetch(`,
    ),
    "MUSE_NETWORK=node replaces the billing path as well, so the mocked suites see every request",
  );
  assert.ok(
    wires(source, `createAgentService({ fetchImpl })`),
    "model calls stay on the ordinary path",
  );
});

/* --------------------------------------------------------------------- ND-1 */
// closeAllConnections() was awaited bare. If it never settled (its reply lost with the network
// service, say) the submission could not be ended by anything: not by cancel, not by the job's
// time limit - the music service stayed busy until the app was restarted.

const { wasNotSent, CLOSE_TIMEOUT_MS } = require("../electron/net-fetch.cjs");

/** A session whose closeAllConnections() behaves as `close` says and whose fetch counts. */
function closingSession(close) {
  const session = {
    closes: 0,
    fetches: 0,
    closeAllConnections: () => {
      session.closes++;
      return close(session);
    },
    fetch: async (_url, init) => {
      session.fetches++;
      return session.respond ? session.respond(init) : new Response("sent");
    },
  };
  return session;
}

test("ND-1: a closeAllConnections() that never settles is given up after the bound; nothing is sent and the queue moves on", async () => {
  assert.equal(CLOSE_TIMEOUT_MS, 5000);
  for (const bound of [0, -1, NaN, Infinity, "5000", null, 2 ** 31])
    assert.throws(
      () => createBillingFetch(() => ({}), { closeTimeoutMs: bound }),
      TypeError,
      String(bound),
    );
  let healthy = false;
  const session = closingSession(() =>
    healthy ? Promise.resolve() : new Promise(() => {}),
  );
  const billingFetch = createBillingFetch(() => session, {
    closeTimeoutMs: 80,
  });
  const started = Date.now();
  const first = post(billingFetch);
  const second = post(billingFetch); // queued behind it
  for (const stuck of [first, second])
    await assert.rejects(stuck, (error) => {
      assert.equal(wasNotSent(error), true, "nothing was sent");
      assert.notEqual(error.name, "AbortError", "nobody cancelled it");
      return true;
    });
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed >= 140 && elapsed < 2000,
    `each waited for its own bound: ${elapsed} ms`,
  );
  assert.equal(session.closes, 2);
  assert.equal(session.fetches, 0, "the request never went out");
  // The session answers again: the next submission goes through, after a close of its own.
  healthy = true;
  assert.equal(await (await post(billingFetch)).text(), "sent");
  assert.equal(session.closes, 3);
  assert.equal(session.fetches, 1);
});

test("ND-1: cancel ends a submission that is stuck closing at once, and one that waits behind it", async () => {
  const session = closingSession(() => new Promise(() => {}));
  // A bound far beyond the test: only the abort can end these. (A timer left behind would keep the test file running.)
  const billingFetch = createBillingFetch(() => session, {
    closeTimeoutMs: 600_000,
  });
  const stuck = new AbortController();
  const queued = new AbortController();
  const first = post(billingFetch, { signal: stuck.signal });
  const second = post(billingFetch, { signal: queued.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const started = Date.now();
  queued.abort();
  await assert.rejects(
    second,
    (error) => error.name === "AbortError" && wasNotSent(error),
  );
  stuck.abort();
  await assert.rejects(
    first,
    (error) => error.name === "AbortError" && wasNotSent(error),
  );
  assert.ok(Date.now() - started < 500);
  assert.equal(session.closes, 1, "the queued one never got as far as closing");
  assert.equal(session.fetches, 0);
});

test("ND-1: a close that fails or answers after it was given up changes nothing later", async () => {
  // Rejects after the bound: no unhandled rejection, the submission was already called off.
  let rejectLate;
  const late = closingSession(
    () =>
      new Promise((_resolve, reject) => {
        rejectLate = reject;
      }),
  );
  const billingFetch = createBillingFetch(() => late, { closeTimeoutMs: 30 });
  await assert.rejects(post(billingFetch), (error) => wasNotSent(error));
  rejectLate(new Error("network service restarted"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(late.fetches, 0);
  // Resolves just inside the bound: the request is sent as usual, once.
  const slow = closingSession(
    () => new Promise((resolve) => setTimeout(resolve, 40)),
  );
  const patient = createBillingFetch(() => slow, { closeTimeoutMs: 2000 });
  assert.equal(await (await post(patient)).text(), "sent");
  assert.equal(slow.fetches, 1);
});

test("ND-1: every rejection from before the request went out is marked not-sent; none from after it is", async () => {
  const ready = closingSession(async () => {});
  const billingFetch = createBillingFetch(() => ready);
  const aborted = new AbortController();
  aborted.abort();
  const unsent = [
    post(billingFetch, { signal: aborted.signal }),
    post(billingFetch, { method: "GET", body: undefined }),
    post(billingFetch, { redirect: "follow" }),
    post(billingFetch, { headers: { Host: "evil.test" } }),
    billingFetch("not a url", { method: "POST", body: "{}" }),
    post(
      createBillingFetch(() =>
        closingSession(async () => {
          throw new Error("network service is gone");
        }),
      ),
    ),
    post(
      createBillingFetch(() =>
        closingSession(() => {
          throw new Error("thrown synchronously");
        }),
      ),
    ),
    post(createBillingFetch(() => null)),
    post(
      createBillingFetch(() => {
        throw new Error("the app is not ready");
      }),
    ),
  ];
  for (const [index, attempt] of unsent.entries())
    await assert.rejects(attempt, (error) => {
      assert.equal(wasNotSent(error), true, `case ${index}: ${error.message}`);
      return true;
    });
  assert.equal(ready.fetches, 0);

  // Handed to the network: whatever happens now, the service may have received it.
  ready.respond = async () => {
    throw new Error("net::ERR_CONNECTION_RESET");
  };
  await assert.rejects(post(billingFetch), (error) => {
    assert.match(error.message, /ERR_CONNECTION_RESET/);
    assert.equal(wasNotSent(error), false);
    return true;
  });
  const inFlight = new AbortController();
  ready.respond = (init) =>
    new Promise((_resolve, reject) =>
      init.signal.addEventListener(
        "abort",
        () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        { once: true },
      ),
    );
  const sent = post(billingFetch, { signal: inFlight.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  inFlight.abort();
  await assert.rejects(
    sent,
    (error) => error.name === "AbortError" && wasNotSent(error) === false,
  );
  assert.equal(ready.fetches, 2);
  // Only errors of the billing path are ever marked.
  for (const other of [new Error("x"), null, undefined, "text", 42, {}])
    assert.equal(wasNotSent(other), false);
});
