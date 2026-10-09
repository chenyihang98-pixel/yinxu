"use strict";

/**
 * fetch() for the main process on top of Electron's `net` module, so requests
 * use Chromium's network stack and honour the Windows system proxy / PAC
 * (Node's global fetch ignores both).
 *
 * Differences from raw `net.fetch` that this wrapper removes (each measured
 * under Electron 41):
 *  - cookies were stored and replayed            -> credentials: "omit"
 *  - responses were written to the HTTP cache    -> cache: "no-store"
 *  - a `Host` header failed the whole request    -> hop-by-hop headers dropped
 *  - redirect "manual" rejected, hiding Location -> served through net.request
 *  - cancelling the body kept the download alive -> cancel aborts the request
 *
 * Unlike the standard, a missing `redirect` option means "error": every caller
 * that may follow a redirect does so explicitly and revalidates each hop.
 *
 * Billable submissions do not use this path at all: see createBillingFetch below.
 */
const { Readable } = require("node:stream");

/** In-memory session partition that carries nothing but billable submissions. */
const BILLING_PARTITION = "muse-billing";
/** How long closing the pooled connections may take before a submission is called off unsent. */
const CLOSE_TIMEOUT_MS = 5000;

/**
 * Rejections of the billing path that happened before the request was handed to
 * the network: the service received nothing, so nothing can have been billed.
 * Kept beside the errors instead of on them, so an abort stays the caller's own
 * AbortError and a failure keeps its class and message.
 */
const unsent = new WeakSet();
function markNotSent(error) {
  if (error && typeof error === "object") unsent.add(error);
  return error;
}
/** True when `error` came from the billing path and the request never left this computer. */
function wasNotSent(error) {
  return Boolean(error) && typeof error === "object" && unsent.has(error);
}

const DROPPED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "cookie",
  "cookie2",
  "proxy-authorization",
]);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("This operation was aborted", "AbortError");
}

function requestHeaders(input, url) {
  const result = {};
  if (!input) return result;
  const entries =
    typeof input.entries === "function" && typeof input.get === "function"
      ? [...input.entries()]
      : Object.entries(input);
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    const lower = String(name).toLowerCase();
    if (
      lower === "host" &&
      String(value).toLowerCase() !== url.host.toLowerCase()
    )
      throw new TypeError("Host header does not match the request URL");
    if (DROPPED_HEADERS.has(lower)) continue;
    result[name] = String(value);
  }
  return result;
}

/** Re-wrap the body so that cancelling it (or finishing it) releases the underlying request. */
function guardResponse(response, abort, cleanup) {
  const status = response.status;
  if (!response.body || NULL_BODY_STATUS.has(status)) {
    cleanup();
    return new Response(null, {
      status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      cleanup();
    }
  };
  const body = new ReadableStream(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            finish();
            controller.close();
          } else controller.enqueue(value);
        } catch (error) {
          finish();
          abort();
          controller.error(error);
        }
      },
      cancel(reason) {
        finish();
        abort();
        return reader.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function manualGet(net, url, headers, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = net.request({
      url: url.href,
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
    });
    const onAbort = () => {
      try {
        request.abort();
      } catch {
        /* already finished */
      }
      if (!settled) {
        settled = true;
        reject(abortError(signal));
      }
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
    request.on("redirect", (statusCode, _method, redirectUrl) => {
      // followRedirect() is deliberately not called: Electron then cancels the
      // request, and the caller decides whether the next hop is acceptable.
      if (settled) return;
      settled = true;
      cleanup();
      resolve(
        new Response(null, {
          status: statusCode,
          headers: { location: String(redirectUrl) },
        }),
      );
    });
    request.on("response", (incoming) => {
      if (settled) {
        try {
          request.abort();
        } catch {
          /* already finished */
        }
        return;
      }
      settled = true;
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers || {})) {
        try {
          responseHeaders.set(
            name,
            Array.isArray(value) ? value.join(", ") : String(value),
          );
        } catch {
          /* skip malformed header */
        }
      }
      const status = incoming.statusCode;
      const body = NULL_BODY_STATUS.has(status)
        ? null
        : Readable.toWeb(incoming);
      let raw;
      try {
        raw = new Response(body, {
          status,
          statusText: incoming.statusMessage || "",
          headers: responseHeaders,
        });
      } catch (error) {
        cleanup();
        try {
          request.abort();
        } catch {
          /* already finished */
        }
        reject(error);
        return;
      }
      resolve(
        guardResponse(
          raw,
          () => {
            try {
              request.abort();
            } catch {
              /* already finished */
            }
          },
          cleanup,
        ),
      );
    });
    request.on("error", (error) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    for (const [name, value] of Object.entries(headers))
      request.setHeader(name, value);
    request.end();
  });
}

function requestUrl(input) {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : String(input?.url ?? input),
  );
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new TypeError("Only http(s) requests are supported");
  return url;
}

function createNetFetch(net) {
  if (
    !net ||
    typeof net.fetch !== "function" ||
    typeof net.request !== "function"
  )
    throw new TypeError("Electron net module is required");
  return async function netFetch(input, init = {}) {
    const url = requestUrl(input);
    const method = String(init.method || "GET").toUpperCase();
    const redirect = init.redirect ?? "error";
    if (!["error", "manual", "follow"].includes(redirect))
      throw new TypeError("Unsupported redirect mode");
    const signal = init.signal;
    if (signal?.aborted) throw abortError(signal);
    const headers = requestHeaders(init.headers, url);

    if (redirect === "manual") {
      if (method !== "GET" || (init.body !== undefined && init.body !== null))
        throw new TypeError(
          'redirect "manual" is only supported for GET requests without a body',
        );
      return manualGet(net, url, headers, signal);
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(abortError(signal));
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
    let response;
    try {
      response = await net.fetch(url.href, {
        method,
        headers,
        redirect,
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        ...(init.body !== undefined && init.body !== null
          ? { body: init.body }
          : {}),
        ...(init.duplex ? { duplex: init.duplex } : {}),
      });
    } catch (error) {
      cleanup();
      throw error;
    }
    return guardResponse(response, () => controller.abort(), cleanup);
  };
}

/** The promise's outcome, or a rejection as soon as `signal` aborts or `milliseconds` have passed. */
function settledWithin(promise, milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (settle, value) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      settle(value);
    };
    const onAbort = () => finish(reject, signal.reason);
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    timer = setTimeout(
      () =>
        finish(
          reject,
          new Error("The connections could not be closed in time"),
        ),
      milliseconds,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

/**
 * fetch() for a request that costs money every time the server receives it
 * (the generation POST of each music service).
 *
 * Chromium re-sends a request on its own when a connection that has already
 * carried traffic drops before the response headers arrive - a POST included,
 * and the caller only ever sees the second answer. Measured under Electron 41
 * (HTTP/1.1, TLS and HTTP/2; reset and close; scripts/desktop-smoke.cjs repeats
 * it on every run): on the default session the server received the POST twice
 * and fetch resolved. It does not do so on a connection that has carried
 * nothing, so each submission here
 *   - goes through its own session (`getSession()`, the BILLING_PARTITION),
 *     which polls, downloads and model calls never touch;
 *   - is preceded by closeAllConnections(), so no kept-alive or pre-connected
 *     socket of an earlier submission is left to be picked up;
 *   - waits for the previous submission to release its connection first.
 * The main process also starts Chromium with QUIC off (a failed QUIC attempt is
 * retried over TCP even on a new connection).
 *
 * Only POST with redirect "error" is accepted: a billable request is never
 * re-issued for a redirect either. If the connections cannot be closed - the
 * call fails, or has not answered after `closeTimeoutMs` (a promise that never
 * settled was the one stage neither cancel nor the job's time limit could end) -
 * nothing is sent. Every rejection from before the request went out satisfies
 * wasNotSent(), so the caller can say that nothing was billed.
 *
 * A close that was given up on needs no care afterwards: the next submission
 * issues its own closeAllConnections() and waits for it, and one session answers
 * these calls in order, so the earlier one has either landed by then or never
 * will (its network service is gone).
 */
function createBillingFetch(
  getSession,
  { closeTimeoutMs = CLOSE_TIMEOUT_MS } = {},
) {
  if (typeof getSession !== "function")
    throw new TypeError("A session provider is required");
  // setTimeout would turn anything else into "at once" (or never fire).
  if (
    !Number.isFinite(closeTimeoutMs) ||
    closeTimeoutMs <= 0 ||
    closeTimeoutMs > 2 ** 31 - 1
  )
    throw new TypeError("closeTimeoutMs must be a positive number");
  let last = Promise.resolve();
  async function submit(input, init, onSend) {
    const url = requestUrl(input);
    const method = String(init.method || "GET").toUpperCase();
    if (method !== "POST")
      throw new TypeError("The billing path only carries POST submissions");
    if ((init.redirect ?? "error") !== "error")
      throw new TypeError("A billable request never follows a redirect");
    const signal = init.signal;
    if (signal?.aborted) throw abortError(signal);
    const headers = requestHeaders(init.headers, url);

    // One submission at a time: closing the connections must never cut an earlier one off.
    // (The queue passes on only when this one AND everything before it has finished, so a
    // request that gives up while waiting does not let a later one overtake.)
    const previous = last;
    let release;
    const done = new Promise((resolve) => {
      release = resolve;
    });
    last = previous.then(() => done);
    const controller = new AbortController();
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        release();
      }
    };
    // An aborted submission has given its connection up, whether or not anyone reads the body.
    const onAbort = () => {
      controller.abort(abortError(signal));
      finish();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let response;
    try {
      await new Promise((resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          { once: true },
        );
        previous.then(resolve);
      });
      const session = getSession();
      if (
        !session ||
        typeof session.fetch !== "function" ||
        typeof session.closeAllConnections !== "function"
      )
        throw new TypeError("The billing session is not available");
      await settledWithin(
        session.closeAllConnections(),
        closeTimeoutMs,
        controller.signal,
      );
      if (controller.signal.aborted) throw controller.signal.reason;
      onSend();
      response = await session.fetch(url.href, {
        method,
        headers,
        redirect: "error",
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        ...(init.body !== undefined && init.body !== null
          ? { body: init.body }
          : {}),
        ...(init.duplex ? { duplex: init.duplex } : {}),
      });
    } catch (error) {
      finish();
      throw error;
    }
    return guardResponse(response, () => controller.abort(), finish);
  }
  return async function billingFetch(input, init = {}) {
    let sent = false;
    try {
      return await submit(input, init, () => {
        sent = true;
      });
    } catch (error) {
      throw sent ? error : markNotSent(error);
    }
  };
}

module.exports = {
  createNetFetch,
  createBillingFetch,
  wasNotSent,
  BILLING_PARTITION,
  CLOSE_TIMEOUT_MS,
};
