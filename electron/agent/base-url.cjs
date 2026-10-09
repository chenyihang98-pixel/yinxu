"use strict";

/**
 * Base-URL policy for the user's own large language model endpoint.
 *
 *  - kind "openai": public HTTPS only. The URL is checked when it is saved and
 *    again before every call, and the host is resolved right before the request:
 *    any loopback / private / link-local / CGNAT / ULA address refuses the call.
 *  - kind "ollama": plain HTTP on this computer only (127.0.0.1, localhost, [::1]).
 *
 * The validator works on the parsed URL, so numeric host spellings such as
 * 0x7f.1, 2130706433 or 017700000001 are judged as the address they denote.
 */
const dns = require("node:dns");
const net = require("node:net");
const { MusicError } = require("../providers/shared.cjs");

const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const MAX_URL_LENGTH = 300;
const PATH_PATTERN = /^(?:\/[A-Za-z0-9._~-]+)*$/;
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Names that never denote a public internet host.
const PRIVATE_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "home.arpa",
  "test",
  "invalid",
  "example",
  "onion",
];
/**
 * Ports no request can be sent to, whatever is listening there: the network
 * stack refuses them before connecting (net::ERR_UNSAFE_PORT). The first line
 * is the complete list of the bundled Chromium (Electron 41 / Chromium 146,
 * measured by trying all 65536 ports against an unresolvable name); 4190 and
 * 6679 are refused in addition by Node's fetch, the MUSE_NETWORK=node path.
 * An address on one of them saved fine and then failed on every call with a
 * message that blamed the user's network or Ollama.
 */
const RESTRICTED_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080, 4190, 6679,
]);

/** `url.port` is empty for the scheme's default port, which is always allowed. */
function assertUsablePort(url) {
  if (url.port !== "" && RESTRICTED_PORTS.has(Number(url.port))) {
    throw new MusicError(
      `接口地址的端口 ${url.port} 是受限端口，应用无法向它发送请求。请让服务改用其他端口，再填写新的地址。`,
    );
  }
}

function ipv4Bytes(text) {
  if (!net.isIPv4(text)) return null;
  return text.split(".").map(Number);
}

function isPrivateIPv4(bytes) {
  const [a, b, c] = bytes;
  return (
    a === 0 || // "this network", includes 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    a >= 224
  ); // multicast, reserved, broadcast
  // 198.18.0.0/15 is deliberately not listed: "fake-ip" proxies answer DNS from it.
}

/** Eight 16-bit groups, or null. Zone ids are rejected. */
function ipv6Groups(text) {
  if (!net.isIPv6(text) || text.includes("%")) return null;
  let source = text.toLowerCase();
  const tail = source.slice(source.lastIndexOf(":") + 1);
  if (tail.includes(".")) {
    const bytes = ipv4Bytes(tail);
    if (!bytes) return null;
    source = `${source.slice(0, source.lastIndexOf(":") + 1)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = source.split("::");
  const parse = (part) =>
    part ? part.split(":").map((group) => parseInt(group, 16)) : [];
  const head = parse(halves[0]);
  const rest = halves.length > 1 ? parse(halves[1]) : [];
  const groups =
    halves.length > 1
      ? [...head, ...new Array(8 - head.length - rest.length).fill(0), ...rest]
      : head;
  return groups.length === 8 &&
    groups.every(
      (group) => Number.isInteger(group) && group >= 0 && group <= 0xffff,
    )
    ? groups
    : null;
}

function isPrivateIPv6(groups) {
  const embedded = (high, low) =>
    isPrivateIPv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (groups.slice(0, 7).every((group) => group === 0)) return true; // :: and ::1
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    (g5 === 0xffff || g5 === 0)
  )
    return embedded(g6, g7); // v4-mapped / v4-compatible
  if (g0 === 0x64 && g1 === 0xff9b)
    return g2 !== 0 || g3 !== 0 || g4 !== 0 || g5 !== 0 || embedded(g6, g7); // NAT64; 64:ff9b:1::/48 is local-use
  if (g0 === 0x2002) return embedded(g1, g2); // 6to4
  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g0 & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g0 & 0xffc0) === 0xfec0 || // site-local (deprecated)
    (g0 & 0xff00) === 0xff00
  ); // multicast
}

/** True for anything that is not clearly a public unicast address (unknown input included). */
function isPrivateAddress(address) {
  if (typeof address !== "string") return true;
  const text = address.replace(/^\[|\]$/g, "");
  const v4 = ipv4Bytes(text);
  if (v4) return isPrivateIPv4(v4);
  const v6 = ipv6Groups(text);
  return v6 ? isPrivateIPv6(v6) : true;
}

function parse(raw) {
  if (typeof raw !== "string") throw new MusicError("请填写大模型的接口地址。");
  const text = raw.trim();
  if (!text) throw new MusicError("请填写大模型的接口地址。");
  // Reject anything a URL parser would silently repair or reinterpret (whitespace,
  // backslashes, userinfo, percent-encoding, "." and ".." path segments).
  if (
    text.length > MAX_URL_LENGTH ||
    /[\s\\@?#%\x00-\x1f\x7f]/.test(text) ||
    /\/\.\.?(?:\/|$)/.test(text)
  )
    throw new MusicError(
      "接口地址格式不正确：不能包含空格、账号信息、查询参数、% 编码或 # 片段。",
    );
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new MusicError(
      "接口地址格式不正确，请填写完整地址，例如 https://api.example.com/v1。",
    );
  }
  if (url.username || url.password || url.search || url.hash)
    throw new MusicError(
      "接口地址格式不正确：不能包含空格、账号信息、查询参数、% 编码或 # 片段。",
    );
  const path = url.pathname.replace(/\/+$/, "");
  if (!PATH_PATTERN.test(path))
    throw new MusicError(
      "接口地址的路径只能包含字母、数字和 . _ ~ - 这些字符。",
    );
  return { url, path };
}

function validatePublicUrl(raw) {
  const { url, path } = parse(raw);
  if (url.protocol !== "https:")
    throw new MusicError(
      "接口地址必须以 https:// 开头。本机模型请选择「本机 Ollama」。",
    );
  const host = url.hostname.toLowerCase();
  if (host.startsWith("["))
    throw new MusicError("接口地址需要使用域名，不支持 IPv6 地址。");
  if (net.isIPv4(host)) {
    if (isPrivateAddress(host))
      throw new MusicError(
        "接口地址不能指向本机或内网。本机模型请选择「本机 Ollama」。",
      );
  } else {
    const labels = host.split(".");
    const privateName = PRIVATE_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
    if (
      host.endsWith(".") ||
      host.length > 253 ||
      labels.length < 2 ||
      privateName ||
      !labels.every((label) => LABEL_PATTERN.test(label)) ||
      /^\d+$/.test(labels[labels.length - 1])
    ) {
      throw new MusicError(
        "接口地址需要是公网域名，不能是 localhost、内网名称或单个主机名。",
      );
    }
  }
  if (url.port && url.port !== "443" && Number(url.port) < 1024)
    throw new MusicError("接口地址的端口需要是 443，或 1024 以上。");
  assertUsablePort(url);
  return `https://${url.host.toLowerCase()}${path}`;
}

function validateLoopbackUrl(raw) {
  const { url, path } = parse(raw);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(host)
  ) {
    throw new MusicError(
      "Ollama 地址只能是本机，例如 http://127.0.0.1:11434/v1。",
    );
  }
  assertUsablePort(url);
  // "localhost" is pinned to the loopback address so a hosts-file entry cannot redirect it.
  return `http://${host === "localhost" ? "127.0.0.1" : host}${url.port ? `:${url.port}` : ""}${path}`;
}

/** Normalised base URL (no trailing slash, nothing appended) or a MusicError. */
function validateBaseUrl(kind, raw) {
  if (kind === "ollama")
    return validateLoopbackUrl(
      raw === undefined ||
        raw === null ||
        (typeof raw === "string" && !raw.trim())
        ? OLLAMA_DEFAULT_BASE_URL
        : raw,
    );
  if (kind === "openai") return validatePublicUrl(raw);
  throw new MusicError("这种大模型不使用自定义接口地址。");
}

/**
 * Call-time check for kind "openai": resolve the host and refuse when any
 * address is private. A name that cannot be resolved here is let through - behind
 * a corporate proxy only the proxy can resolve it, and a request that really has
 * no route fails on its own with a connection error.
 */
async function assertPublicHost(
  baseUrl,
  { lookup = dns.promises.lookup, signal, timeoutMs = 5000 } = {},
) {
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  const refuse = () =>
    new MusicError(
      "接口地址解析到了本机或内网地址，已拒绝连接。本机模型请选择「本机 Ollama」。",
    );
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw refuse();
    return;
  }
  signal?.throwIfAborted();
  let timer, onAbort;
  const interrupted = new Promise((resolve, reject) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    onAbort = () =>
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("aborted"),
      );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  let records;
  try {
    records = await Promise.race([
      Promise.resolve()
        .then(() => lookup(host, { all: true }))
        .catch(() => null),
      interrupted,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!Array.isArray(records)) return;
  if (records.some((record) => isPrivateAddress(record?.address)))
    throw refuse();
}

module.exports = {
  OLLAMA_DEFAULT_BASE_URL,
  RESTRICTED_PORTS,
  validateBaseUrl,
  assertPublicHost,
  isPrivateAddress,
};
