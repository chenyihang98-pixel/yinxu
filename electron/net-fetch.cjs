'use strict';

/**
 * fetch() for the main process on top of Electron's `net` module, so requests
 * use Chromium's network stack and honour the Windows system proxy / PAC
 * (Node's global fetch ignores both).
 *
 * Differences from raw `net.fetch` that this wrapper removes (each measured by
 * .scratch/desktop-main/net-probe.cjs under Electron 41):
 *  - cookies were stored and replayed            -> credentials: "omit"
 *  - responses were written to the HTTP cache    -> cache: "no-store"
 *  - a `Host` header failed the whole request    -> hop-by-hop headers dropped
 *  - redirect "manual" rejected, hiding Location -> served through net.request
 *  - cancelling the body kept the download alive -> cancel aborts the request
 *
 * Unlike the standard, a missing `redirect` option means "error": every caller
 * that may follow a redirect does so explicitly and revalidates each hop.
 */
const { Readable } = require('node:stream');

const DROPPED_HEADERS = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'cookie', 'cookie2', 'proxy-authorization']);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('This operation was aborted', 'AbortError');
}

function requestHeaders(input, url) {
  const result = {};
  if (!input) return result;
  const entries = typeof input.entries === 'function' && typeof input.get === 'function' ? [...input.entries()] : Object.entries(input);
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    const lower = String(name).toLowerCase();
    if (lower === 'host' && String(value).toLowerCase() !== url.host.toLowerCase()) throw new TypeError('Host header does not match the request URL');
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
    return new Response(null, { status, statusText: response.statusText, headers: response.headers });
  }
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => { if (!finished) { finished = true; cleanup(); } };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { finish(); controller.close(); } else controller.enqueue(value);
      } catch (error) { finish(); abort(); controller.error(error); }
    },
    cancel(reason) {
      finish(); abort();
      return reader.cancel(reason).catch(() => {});
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status, statusText: response.statusText, headers: response.headers });
}

function manualGet(net, url, headers, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = net.request({ url: url.href, method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store' });
    const onAbort = () => {
      try { request.abort(); } catch { /* already finished */ }
      if (!settled) { settled = true; reject(abortError(signal)); }
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    request.on('redirect', (statusCode, _method, redirectUrl) => {
      // followRedirect() is deliberately not called: Electron then cancels the
      // request, and the caller decides whether the next hop is acceptable.
      if (settled) return;
      settled = true; cleanup();
      resolve(new Response(null, { status: statusCode, headers: { location: String(redirectUrl) } }));
    });
    request.on('response', incoming => {
      if (settled) { try { request.abort(); } catch { /* already finished */ } return; }
      settled = true;
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers || {})) {
        try { responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value)); } catch { /* skip malformed header */ }
      }
      const status = incoming.statusCode;
      const body = NULL_BODY_STATUS.has(status) ? null : Readable.toWeb(incoming);
      let raw;
      try { raw = new Response(body, { status, statusText: incoming.statusMessage || '', headers: responseHeaders }); }
      catch (error) { cleanup(); try { request.abort(); } catch { /* already finished */ } reject(error); return; }
      resolve(guardResponse(raw, () => { try { request.abort(); } catch { /* already finished */ } }, cleanup));
    });
    request.on('error', error => {
      cleanup();
      if (!settled) { settled = true; reject(error); }
    });
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
    request.end();
  });
}

function createNetFetch(net) {
  if (!net || typeof net.fetch !== 'function' || typeof net.request !== 'function') throw new TypeError('Electron net module is required');
  return async function netFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? input));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('Only http(s) requests are supported');
    const method = String(init.method || 'GET').toUpperCase();
    const redirect = init.redirect ?? 'error';
    if (!['error', 'manual', 'follow'].includes(redirect)) throw new TypeError('Unsupported redirect mode');
    const signal = init.signal;
    if (signal?.aborted) throw abortError(signal);
    const headers = requestHeaders(init.headers, url);

    if (redirect === 'manual') {
      if (method !== 'GET' || (init.body !== undefined && init.body !== null)) throw new TypeError('redirect "manual" is only supported for GET requests without a body');
      return manualGet(net, url, headers, signal);
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(abortError(signal));
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    let response;
    try {
      response = await net.fetch(url.href, {
        method, headers, redirect, signal: controller.signal, credentials: 'omit', cache: 'no-store',
        ...(init.body !== undefined && init.body !== null ? { body: init.body } : {}),
        ...(init.duplex ? { duplex: init.duplex } : {}),
      });
    } catch (error) { cleanup(); throw error; }
    return guardResponse(response, () => controller.abort(), cleanup);
  };
}

module.exports = { createNetFetch };
