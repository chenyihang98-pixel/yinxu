'use strict';

/**
 * The renderer's Content-Security-Policy. This string must stay literally
 * identical to CONTENT_SECURITY_POLICY in vite.config.ts, which writes it into
 * the built index.html as a <meta> tag (the policy that is actually enforced for
 * file:// pages); tests/csp.test.cjs reads both files and compares them.
 * `connect-src 'none'`: the renderer never talks to the network - cloud music
 * and the LLM are reached from the main process only.
 */
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";

module.exports = { CONTENT_SECURITY_POLICY };
