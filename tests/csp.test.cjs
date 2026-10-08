'use strict';

// F18: one Content-Security-Policy for the Vite build (<meta>) and the main process (header).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CONTENT_SECURITY_POLICY } = require('../electron/csp.cjs');

const root = path.join(__dirname, '..');
const literal = (file, name) => {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const match = new RegExp(`${name}\\s*=\\s*\\n?\\s*"([^"\\n]+)"`).exec(source);
  assert.ok(match, `${name} string literal found in ${file}`);
  return match[1];
};

test('electron/csp.cjs and vite.config.ts hold literally the same policy', () => {
  const vite = literal('vite.config.ts', 'CONTENT_SECURITY_POLICY');
  const main = literal(path.join('electron', 'csp.cjs'), 'CONTENT_SECURITY_POLICY');
  assert.equal(main, vite);
  assert.equal(CONTENT_SECURITY_POLICY, vite);
});

test('main.cjs uses the shared policy and no second copy of it', () => {
  const source = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
  assert.match(source, /require\('\.\/csp\.cjs'\)/);
  assert.match(source, /'Content-Security-Policy': \[CONTENT_SECURITY_POLICY\]/);
  assert.equal(/default-src|connect-src/.test(source), false, 'no policy text inlined in main.cjs');
});

test('the policy keeps the renderer offline and script sources local', () => {
  const directives = Object.fromEntries(CONTENT_SECURITY_POLICY.split(';').map(part => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(directives['connect-src'], ["'none'"], 'cloud music and the LLM are reached from the main process only');
  assert.deepEqual(directives['default-src'], ["'self'"]);
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.deepEqual(directives['worker-src'], ["'self'"]);
  assert.deepEqual(directives['object-src'], ["'none'"]);
  assert.deepEqual(directives['base-uri'], ["'none'"]);
  assert.deepEqual(directives['frame-src'], ["'none'"]);
  assert.deepEqual(directives['form-action'], ["'none'"]);
  assert.equal(/unsafe-eval|https?:|\*/.test(CONTENT_SECURITY_POLICY), false);
});
