"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateBaseUrl,
  assertPublicHost,
  isPrivateAddress,
  OLLAMA_DEFAULT_BASE_URL,
} = require("../electron/agent/base-url.cjs");

const accepted = (kind, input, expected) => [kind, input, expected];
const rejected = (kind, input, reason) => [kind, input, null, reason];

const TABLE = [
  // --- kind "openai": public HTTPS, normalised without a trailing slash, nothing appended
  accepted("openai", "https://api.deepseek.com", "https://api.deepseek.com"),
  accepted("openai", "https://api.deepseek.com/", "https://api.deepseek.com"),
  accepted("openai", "https://api.openai.com/v1", "https://api.openai.com/v1"),
  accepted(
    "openai",
    "https://api.openai.com/v1///",
    "https://api.openai.com/v1",
  ),
  accepted(
    "openai",
    "  https://dashscope.aliyuncs.com/compatible-mode/v1  ",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  ),
  accepted(
    "openai",
    "https://ark.cn-beijing.volces.com/api/v3",
    "https://ark.cn-beijing.volces.com/api/v3",
  ),
  accepted(
    "openai",
    "https://open.bigmodel.cn/api/paas/v4",
    "https://open.bigmodel.cn/api/paas/v4",
  ),
  accepted(
    "openai",
    "HTTPS://API.Moonshot.CN/v1",
    "https://api.moonshot.cn/v1",
  ),
  accepted(
    "openai",
    "https://gateway.example-llm.com:8443/v1",
    "https://gateway.example-llm.com:8443/v1",
  ),
  accepted(
    "openai",
    "https://gateway.example-llm.com:443/v1",
    "https://gateway.example-llm.com/v1",
  ),
  accepted(
    "openai",
    "https://my-res.openai.azure.com/openai/deployments/gpt-5.1_prod",
    "https://my-res.openai.azure.com/openai/deployments/gpt-5.1_prod",
  ),
  accepted(
    "openai",
    "https://xn--fsqu00a.xn--3lr804guic",
    "https://xn--fsqu00a.xn--3lr804guic",
  ),
  accepted("openai", "https://8.8.8.8/v1", "https://8.8.8.8/v1"),
  accepted("openai", "https://198.18.0.1/v1", "https://198.18.0.1/v1"),

  rejected("openai", "http://api.deepseek.com/v1", "plain http"),
  rejected("openai", "ftp://api.deepseek.com/v1", "scheme"),
  rejected("openai", "file:///C:/v1", "scheme"),
  rejected("openai", "javascript:alert(1)", "scheme"),
  rejected("openai", "api.deepseek.com/v1", "no scheme"),
  rejected("openai", "//api.deepseek.com/v1", "no scheme"),
  rejected("openai", "", "empty"),
  rejected("openai", "   ", "blank"),
  rejected("openai", undefined, "missing"),
  rejected("openai", null, "missing"),
  rejected("openai", 42, "not a string"),
  rejected("openai", { href: "https://api.deepseek.com" }, "not a string"),
  rejected("openai", "https://user:pass@api.deepseek.com/v1", "userinfo"),
  rejected("openai", "https://user@api.deepseek.com/v1", "userinfo"),
  rejected("openai", "https://api.deepseek.com@evil.test/v1", "userinfo trick"),
  rejected("openai", "https://api.deepseek.com/v1?key=1", "query"),
  rejected("openai", "https://api.deepseek.com/v1?", "empty query"),
  rejected("openai", "https://api.deepseek.com/v1#frag", "hash"),
  rejected("openai", "https://api.deepseek.com/v1#", "empty hash"),
  rejected("openai", "https://api.deepseek.com\\@evil.test/v1", "backslash"),
  rejected("openai", "https://api.deepseek.com/v1 /x", "space"),
  accepted(
    "openai",
    "https://api.deepseek.com/v1\n",
    "https://api.deepseek.com/v1",
  ), // surrounding whitespace is trimmed…
  rejected(
    "openai",
    "https://api.deep\tseek.com/v1",
    "…but a control character inside is not repaired",
  ),
  rejected(
    "openai",
    "https://api.deep\nseek.com/v1",
    "the URL parser would silently drop the newline",
  ),
  rejected(
    "openai",
    "https://api.deepseek.com/v1/%2e%2e/admin",
    "percent-encoded dot segments",
  ),
  rejected("openai", "https://api.deepseek.com/v1/../admin", "dot segments"),
  rejected("openai", "https://api.deepseek.com/v1/./x", "dot segments"),
  rejected("openai", "https://api.deepseek.com/v1/..", "dot segments"),
  rejected("openai", "https://api.deepseek.com/%76%31", "percent-encoding"),
  rejected("openai", "https://%61pi.deepseek.com/v1", "percent-encoded host"),
  rejected("openai", "https://api.deepseek.com/v1;param", "path characters"),
  rejected("openai", `https://api.deepseek.com/${"a".repeat(300)}`, "too long"),
  rejected("openai", "https://api.deepseek.com:80/v1", "privileged port"),
  rejected("openai", "https://api.deepseek.com:22/v1", "privileged port"),
  rejected("openai", "https://api.deepseek.com:1023/v1", "privileged port"),
  rejected("openai", "https://api.deepseek.com:99999/v1", "invalid port"),
  // not a dotted public name
  rejected("openai", "https://localhost/v1", "localhost"),
  rejected("openai", "https://localhost:8443/v1", "localhost"),
  rejected("openai", "https://LOCALHOST/v1", "localhost"),
  rejected("openai", "https://localhost./v1", "trailing dot"),
  rejected("openai", "https://api.deepseek.com./v1", "trailing dot"),
  rejected("openai", "https://foo.localhost/v1", ".localhost"),
  rejected("openai", "https://printer.local/v1", ".local"),
  rejected("openai", "https://llm.corp.internal/v1", ".internal"),
  rejected("openai", "https://gateway.lan/v1", ".lan"),
  rejected("openai", "https://router.home.arpa/v1", ".home.arpa"),
  rejected("openai", "https://gateway/v1", "single label"),
  rejected("openai", "https://intranet/v1", "single label"),
  rejected("openai", "https://-bad-.example-llm.com/v1", "bad label"),
  rejected("openai", "https://under_score.example-llm.com/v1", "bad label"),
  // IPv4 literals, including the numeric spellings the URL parser canonicalises (audit F09)
  rejected("openai", "https://127.0.0.1/v1", "loopback"),
  rejected("openai", "https://127.1/v1", "short loopback"),
  rejected("openai", "https://0x7f.1/v1", "hex loopback"),
  rejected("openai", "https://0x7f000001/v1", "hex integer loopback"),
  rejected("openai", "https://2130706433/v1", "integer loopback"),
  rejected("openai", "https://017700000001/v1", "octal loopback"),
  rejected("openai", "https://0177.0.0.1/v1", "octal loopback"),
  rejected("openai", "https://0.0.0.0/v1", "unspecified"),
  rejected("openai", "https://0/v1", "unspecified"),
  rejected("openai", "https://10.0.0.5/v1", "private 10/8"),
  rejected("openai", "https://172.16.0.1/v1", "private 172.16/12"),
  rejected("openai", "https://172.31.255.254/v1", "private 172.16/12"),
  rejected("openai", "https://192.168.1.10:8443/v1", "private 192.168/16"),
  rejected("openai", "https://3232235786/v1", "integer 192.168.1.10"),
  rejected("openai", "https://169.254.169.254/latest", "link-local metadata"),
  rejected("openai", "https://100.64.0.1/v1", "CGNAT"),
  rejected("openai", "https://100.127.255.254/v1", "CGNAT"),
  rejected("openai", "https://224.0.0.1/v1", "multicast"),
  rejected("openai", "https://255.255.255.255/v1", "broadcast"),
  // IPv6 literals are not accepted at all for a public endpoint
  rejected("openai", "https://[::1]/v1", "v6 loopback"),
  rejected("openai", "https://[::]/v1", "v6 unspecified"),
  rejected("openai", "https://[::ffff:127.0.0.1]/v1", "v4-mapped loopback"),
  rejected("openai", "https://[::ffff:7f00:1]/v1", "v4-mapped loopback"),
  rejected("openai", "https://[fe80::1]/v1", "link-local"),
  rejected("openai", "https://[fd00::1]/v1", "unique local"),
  rejected("openai", "https://[2606:4700:4700::1111]/v1", "public v6 literal"),

  // --- kind "ollama": http on this computer only
  accepted("ollama", undefined, "http://127.0.0.1:11434/v1"),
  accepted("ollama", "", "http://127.0.0.1:11434/v1"),
  accepted("ollama", null, "http://127.0.0.1:11434/v1"),
  accepted("ollama", "http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1"),
  accepted("ollama", "http://127.0.0.1:11434/v1/", "http://127.0.0.1:11434/v1"),
  accepted("ollama", "http://localhost:11434/v1", "http://127.0.0.1:11434/v1"),
  accepted("ollama", "http://LOCALHOST:8080", "http://127.0.0.1:8080"),
  accepted("ollama", "http://[::1]:11434/v1", "http://[::1]:11434/v1"),
  accepted("ollama", "http://127.1:11434/v1", "http://127.0.0.1:11434/v1"),
  rejected(
    "ollama",
    "https://127.0.0.1:11434/v1",
    "https is not what Ollama serves",
  ),
  rejected("ollama", "http://127.0.0.2:11434/v1", "another loopback address"),
  rejected("ollama", "http://0.0.0.0:11434/v1", "unspecified"),
  rejected("ollama", "http://192.168.1.20:11434/v1", "LAN"),
  rejected("ollama", "http://my-pc:11434/v1", "host name"),
  rejected("ollama", "http://localhost.evil.test:11434/v1", "look-alike"),
  rejected("ollama", "http://api.deepseek.com/v1", "public host over http"),
  rejected("ollama", "http://user:pass@127.0.0.1:11434/v1", "userinfo"),
  rejected("ollama", "http://127.0.0.1:11434/v1?x=1", "query"),
  rejected("ollama", "http://127.0.0.1:11434/v1#x", "hash"),
  rejected("ollama", "http://[::ffff:127.0.0.1]:11434/v1", "mapped form"),

  // --- other kinds have no base URL
  rejected("anthropic", "https://api.anthropic.com", "not configurable"),
  rejected("tencent", "https://api.deepseek.com", "unknown kind"),
];

test("base URL validator table", () => {
  assert.equal(OLLAMA_DEFAULT_BASE_URL, "http://127.0.0.1:11434/v1");
  for (const [kind, input, expected, reason] of TABLE) {
    const label = `${kind} ${JSON.stringify(input)}${reason ? ` (${reason})` : ""}`;
    if (expected === null)
      assert.throws(
        () => validateBaseUrl(kind, input),
        (error) =>
          error.name === "MusicError" &&
          !/Invalid URL|TypeError/.test(error.message),
        label,
      );
    else assert.equal(validateBaseUrl(kind, input), expected, label);
  }
});

test("the validator never appends /v1 and its result is stable", () => {
  for (const [kind, input, expected] of TABLE.filter(
    (row) => row[2] !== null && row[1],
  )) {
    assert.equal(
      validateBaseUrl(kind, expected),
      expected,
      `idempotent: ${input}`,
    );
    assert.equal(expected.endsWith("/"), false);
  }
  assert.equal(
    `${validateBaseUrl("openai", "https://api.deepseek.com")}/chat/completions`,
    "https://api.deepseek.com/chat/completions",
  );
});

test("private address classifier covers IPv4, IPv6 and embedded forms", () => {
  const table = [
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["172.31.0.1", true],
    ["172.32.0.1", false],
    ["172.15.0.1", false],
    ["192.168.0.1", true],
    ["192.169.0.1", false],
    ["169.254.169.254", true],
    ["100.64.0.1", true],
    ["100.63.255.255", false],
    ["100.128.0.1", false],
    ["0.0.0.0", true],
    ["0.1.2.3", true],
    ["192.0.0.8", true],
    ["224.0.0.251", true],
    ["240.0.0.1", true],
    ["255.255.255.255", true],
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["203.0.113.7", false],
    ["198.18.0.1", false],
    ["::1", true],
    ["::", true],
    ["fe80::1", true],
    ["febf::1", true],
    ["fc00::1", true],
    ["fdff::1", true],
    ["fec0::1", true],
    ["ff02::1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["::ffff:10.0.0.1", true],
    ["::ffff:8.8.8.8", false],
    ["::127.0.0.1", true],
    ["64:ff9b::7f00:1", true],
    ["64:ff9b::808:808", false],
    ["64:ff9b:1::1", true],
    ["2002:7f00:1::1", true],
    ["2002:808:808::1", false],
    ["2606:4700:4700::1111", false],
    ["2001:4860:4860::8888", false],
    ["[::1]", true],
    ["[2606:4700:4700::1111]", false],
    ["fe80::1%eth0", true],
    ["not-an-ip", true],
    ["", true],
    ["999.1.1.1", true],
    [undefined, true],
    [null, true],
    [2130706433, true],
  ];
  for (const [address, expected] of table)
    assert.equal(isPrivateAddress(address), expected, String(address));
});

test("call-time check resolves the host and refuses when ANY address is private", async () => {
  const lookups = [];
  const answer = (records) => async (host, options) => {
    lookups.push([host, options]);
    return records;
  };
  await assertPublicHost("https://api.deepseek.com/v1", {
    lookup: answer([
      { address: "116.205.40.1", family: 4 },
      { address: "2606:4700::6810:1", family: 6 },
    ]),
  });
  assert.deepEqual(lookups, [["api.deepseek.com", { all: true }]]);
  // "fake-ip" proxies (Clash and friends) answer from 198.18.0.0/15: that must keep working.
  await assertPublicHost("https://api.openai.com/v1", {
    lookup: answer([{ address: "198.18.0.42", family: 4 }]),
  });
  for (const records of [
    [{ address: "127.0.0.1", family: 4 }],
    [
      { address: "116.205.40.1", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ], // DNS rebinding style: one public, one private
    [{ address: "::1", family: 6 }],
    [{ address: "::ffff:192.168.1.1", family: 6 }],
    [{ address: "fd12:3456::1", family: 6 }],
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "garbage", family: 4 }],
    [{}],
  ]) {
    await assert.rejects(
      assertPublicHost("https://localtest-like.example-llm.com/v1", {
        lookup: answer(records),
      }),
      (error) =>
        error.name === "MusicError" && /本机或内网/.test(error.message),
      JSON.stringify(records),
    );
  }
  // Literal addresses are judged without a lookup.
  let called = 0;
  await assertPublicHost("https://8.8.8.8/v1", {
    lookup: async () => {
      called++;
      return [];
    },
  });
  await assert.rejects(
    assertPublicHost("https://127.0.0.1/v1", {
      lookup: async () => {
        called++;
        return [];
      },
    }),
    /本机或内网/,
  );
  assert.equal(called, 0);
});

test("call-time check lets an unresolvable name through, and honours cancellation and a slow resolver", async () => {
  // Behind a corporate proxy only the proxy can resolve public names: the request itself decides.
  await assertPublicHost("https://api.deepseek.com/v1", {
    lookup: async () => {
      const error = new Error("getaddrinfo ENOTFOUND");
      error.code = "ENOTFOUND";
      throw error;
    },
  });
  await assertPublicHost("https://api.deepseek.com/v1", {
    lookup: async () => [],
  });
  await assertPublicHost("https://api.deepseek.com/v1", {
    lookup: () => {
      throw new Error("sync failure");
    },
  });
  const started = Date.now();
  await assertPublicHost("https://api.deepseek.com/v1", {
    lookup: () => new Promise(() => {}),
    timeoutMs: 30,
  });
  assert.ok(
    Date.now() - started < 1000,
    "a resolver that never answers does not block the request",
  );

  const aborted = new AbortController();
  aborted.abort();
  let called = 0;
  await assert.rejects(
    assertPublicHost("https://api.deepseek.com/v1", {
      lookup: async () => {
        called++;
        return [];
      },
      signal: aborted.signal,
    }),
  );
  assert.equal(called, 0);
  const during = new AbortController();
  const pending = assertPublicHost("https://api.deepseek.com/v1", {
    lookup: () => new Promise(() => {}),
    signal: during.signal,
    timeoutMs: 60000,
  });
  setTimeout(() => during.abort(), 10);
  await assert.rejects(pending);
});

/* ------------------------------------------------------------------ MAIN-08 */

const { RESTRICTED_PORTS } = require("../electron/agent/base-url.cjs");
/**
 * Every port the bundled Chromium refuses with net::ERR_UNSAFE_PORT: measured on Electron 41.10.7
 * (Chromium 146) by requesting all 65536 ports of an unresolvable host name, so that no connection
 * was ever attempted. Kept here as a second copy on purpose.
 */
const CHROMIUM_146_REFUSED = [
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
];
/** Refused in addition by Node's own fetch ("bad port"), which MUSE_NETWORK=node uses. */
const NODE_ONLY_REFUSED = [4190, 6679];

test("MAIN-08: the restricted-port list is exactly what the two network stacks refuse", () => {
  assert.deepEqual(
    [...RESTRICTED_PORTS].sort((a, b) => a - b),
    [...CHROMIUM_146_REFUSED, ...NODE_ONLY_REFUSED].sort((a, b) => a - b),
  );
  assert.equal(RESTRICTED_PORTS.size, 83);
  for (const usable of [
    80, 443, 1024, 3000, 5000, 8000, 8080, 8443, 11434, 1234, 4000, 6001, 6670,
    10081, 65535,
  ])
    assert.equal(RESTRICTED_PORTS.has(usable), false, String(usable));
});

test("MAIN-08: an address on a port no request can be sent to is refused when it is saved, with the reason", () => {
  const message = (port) =>
    new RegExp(`^接口地址的端口 ${port} 是受限端口，应用无法向它发送请求。`);
  // A local model: every refused port, whatever its number.
  for (const port of RESTRICTED_PORTS) {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      assert.throws(
        () => validateBaseUrl("ollama", `http://${host}:${port}/v1`),
        (error) =>
          error.name === "MusicError" && message(port).test(error.message),
        `${host}:${port}`,
      );
    }
  }
  // A hosted service: ports below 1024 keep their own (older) rule, the rest name the port.
  for (const port of [...RESTRICTED_PORTS].filter((value) => value >= 1024)) {
    assert.throws(
      () =>
        validateBaseUrl("openai", `https://llm.example-vendor.com:${port}/v1`),
      (error) =>
        error.name === "MusicError" && message(port).test(error.message),
      String(port),
    );
  }
  assert.throws(
    () => validateBaseUrl("openai", "https://llm.example-vendor.com:22/v1"),
    /端口需要是 443，或 1024 以上/,
  );
  // The message tells the user what to do, and is not the "check your network" text.
  assert.throws(
    () => validateBaseUrl("ollama", "http://127.0.0.1:6000/v1"),
    /请让服务改用其他端口/,
  );
});

test("MAIN-08: ordinary ports, the default port and the neighbours of refused ports still pass", () => {
  for (const port of [
    80, 443, 1024, 1234, 3000, 5000, 6001, 6664, 6670, 8000, 8080, 10081, 11434,
    65535,
  ]) {
    assert.equal(
      validateBaseUrl("ollama", `http://127.0.0.1:${port}/v1`),
      port === 80 ? "http://127.0.0.1/v1" : `http://127.0.0.1:${port}/v1`,
      String(port),
    );
  }
  for (const port of [1024, 1234, 3000, 6001, 6670, 8000, 8443, 10081, 65535]) {
    assert.equal(
      validateBaseUrl("openai", `https://llm.example-vendor.com:${port}/v1`),
      `https://llm.example-vendor.com:${port}/v1`,
      String(port),
    );
  }
  assert.equal(
    validateBaseUrl("openai", "https://llm.example-vendor.com:443/v1"),
    "https://llm.example-vendor.com/v1",
  );
  assert.equal(validateBaseUrl("ollama", ""), OLLAMA_DEFAULT_BASE_URL);
  // Leading zeros are the same port to a URL parser, and are judged as such.
  assert.throws(
    () => validateBaseUrl("ollama", "http://127.0.0.1:06000/v1"),
    /端口 6000 是受限端口/,
  );
});
