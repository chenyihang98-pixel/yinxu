"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  generate,
  buildRequest,
  ENDPOINT,
  DEFAULT_MODEL,
} = require("../electron/providers/tencent.cjs");

const key = "tokenhub-unit-test-key-only";
const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(61)]);
const input = { prompt: "青春欢快的钢琴，适合校园 Vlog", duration: 30 };
const json = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const complete = (audio = mp3.toString("hex")) => ({
  base_resp: { status_code: 0, status_msg: "success" },
  data: { status: 2, audio },
  extra_info: { music_duration: 60000 },
});
const options = (extra) => ({ input, credentials: { apiKey: key }, ...extra });

test("Tencent payload selects documented music models and explicitly requests instrumental MP3", () => {
  const body = buildRequest(input);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(body.is_instrumental, true);
  assert.equal(body.lyrics_optimizer, false);
  assert.equal(body.output_format, "hex");
  assert.deepEqual(body.audio_setting, {
    sample_rate: 44100,
    bitrate: 256000,
    format: "mp3",
  });
  assert.match(body.prompt, /30 秒/);
  for (const unsupported of [
    "duration",
    "seed",
    "bpm",
    "key",
    "lyrics",
    "stream",
  ])
    assert.equal(Object.hasOwn(body, unsupported), false);
});

test("Tencent request authenticates only at fixed official endpoint and returns decoded MP3 bytes", async () => {
  let requests = 0;
  const controller = new AbortController();
  const result = await generate(
    options({
      input: { ...input, model: "minimax-music-v2.6" },
      signal: controller.signal,
      fetchImpl: async (url, request) => {
        requests++;
        assert.equal(url, ENDPOINT);
        assert.equal(
          url,
          "https://tokenhub.tencentmaas.com/v1/wand/minimax-music/generation",
        );
        assert.equal(request.method, "POST");
        assert.equal(request.redirect, "error");
        assert.equal(request.headers.Authorization, `Bearer ${key}`);
        assert.equal(request.signal, controller.signal);
        assert.equal(JSON.parse(request.body).model, "minimax-music-v2.6");
        return json(complete());
      },
    }),
  );
  assert.equal(requests, 1);
  assert.equal(result.mimeType, "audio/mpeg");
  assert.deepEqual(Buffer.from(result.audio), mp3);
  assert.equal(
    Object.hasOwn(result, "duration"),
    false,
    "requested duration is not falsely returned as actual",
  );
});

test("Tencent rejects unsupported models, invalid prompts and credentials before any request", async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests++;
    return json(complete());
  };
  for (const changedInput of [
    { ...input, model: "music-3.0" },
    { ...input, prompt: "" },
    { ...input, prompt: "a".repeat(2001) },
    { ...input, duration: Infinity },
  ]) {
    await assert.rejects(generate(options({ input: changedInput, fetchImpl })));
  }
  for (const badKey of ["", "short", "key\nInjected: header", 42]) {
    await assert.rejects(
      generate(options({ credentials: { apiKey: badKey }, fetchImpl })),
      /API Key/,
    );
  }
  assert.equal(requests, 0);
});

test("Tencent respects the configured model and permits an explicit per-request override", async () => {
  const selected = [];
  const fetchImpl = async (_, request) => {
    selected.push(JSON.parse(request.body).model);
    return json(complete());
  };
  const credentials = { apiKey: key, model: "minimax-music-v2.6" };
  await generate({ input, credentials, fetchImpl });
  await generate({
    input: { ...input, model: "minimax-music-v3.0" },
    credentials,
    fetchImpl,
  });
  assert.deepEqual(selected, ["minimax-music-v2.6", "minimax-music-v3.0"]);
});

test("Tencent strict hex decoding rejects URL, odd lengths, nonhex and nonaudio", async () => {
  for (const audio of [
    "",
    "494",
    "494433XX",
    "https://example.com/music.mp3",
    Buffer.from("<html>not audio</html>").toString("hex"),
  ]) {
    await assert.rejects(
      generate(options({ fetchImpl: async () => json(complete(audio)) })),
      /音频|文件/,
    );
  }
});

test("Tencent bounds decoded audio before allocation", async () => {
  await assert.rejects(
    generate(
      options({ maxBytes: 32, fetchImpl: async () => json(complete()) }),
    ),
    /过大/,
  );
});

test("Tencent handles service failure, auth, balance and pending result without retries or raw credential disclosure", async () => {
  for (const code of [1004, 1008, 1002, 2013, 987654]) {
    let requests = 0;
    await assert.rejects(
      generate(
        options({
          fetchImpl: async () => {
            requests++;
            return json({
              base_resp: { status_code: code, status_msg: `raw echo ${key}` },
            });
          },
        }),
      ),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(key));
        return true;
      },
    );
    assert.equal(requests, 1);
  }
  let pendingRequests = 0;
  await assert.rejects(
    generate(
      options({
        fetchImpl: async () => {
          pendingRequests++;
          return json({ base_resp: { status_code: 0 }, data: { status: 1 } });
        },
      }),
    ),
    /尚未返回完整音乐/,
  );
  assert.equal(pendingRequests, 1);
});

test("Tencent respects cancellation before submit and after the response", async () => {
  let requests = 0;
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    generate(
      options({
        signal: aborted.signal,
        fetchImpl: async () => {
          requests++;
          return json(complete());
        },
      }),
    ),
    { name: "AbortError" },
  );
  assert.equal(requests, 0);
  const during = new AbortController();
  await assert.rejects(
    generate(
      options({
        signal: during.signal,
        fetchImpl: async () => {
          during.abort();
          return json(complete());
        },
      }),
    ),
    { name: "AbortError" },
  );
});

test("Tencent does not accept malformed JSON or an HTTP error as generated music", async () => {
  await assert.rejects(
    generate(
      options({
        fetchImpl: async () => new Response("not JSON", { status: 200 }),
      }),
    ),
  );
  await assert.rejects(
    generate(
      options({
        fetchImpl: async () =>
          new Response(JSON.stringify(complete()), { status: 401 }),
      }),
    ),
  );
});
