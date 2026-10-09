"use strict";

// Tests the DISTRIBUTABLE: release/win-unpacked/Muse BGM.exe (what the
// installer puts on disk) and the portable self-extractor — not `electron .`.
//
//   npm run dist && node scripts/packaged-smoke.cjs
//   node scripts/packaged-smoke.cjs --unpacked     only release/win-unpacked
//   node scripts/packaged-smoke.cjs --portable     only the portable exe
//
// First the archive itself: dist/, electron/ and package.json inside app.asar
// are this tree's, and the dependencies carry nothing that never runs (the
// `files` filter of package.json) while the Claude SDK lacks nothing that does.
//
// Each build is started with a throw-away profile under the OS temp directory
// (never %APPDATA%\Muse BGM) and driven through the real interface: version,
// bridge, the production Content-Security-Policy, a local piece composed in
// the render worker, playback, a refinement, a WAV through the save path,
// credentials through real Windows safeStorage, the bundled Claude SDK inside
// app.asar, and a full process restart.
//
// Nothing leaves the machine. The app is started with MUSE_NETWORK=node — the
// documented troubleshooting switch, honoured by packaged builds too — and the
// main-process fetch is replaced by fixtures (tests/helpers/electron-harness.cjs);
// every request Chromium itself would make is cancelled and counted. The
// installer is only measured and hashed, never run.
// Writes test-results/packaged-smoke-results.json.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  ROOT,
  RESULTS,
  DEFAULT_PLAN,
  until,
  launchApp,
  removeProfile,
  wavInfo,
  createRun,
  describeFailure,
} = require("../tests/helpers/electron-harness.cjs");
const { CONTENT_SECURITY_POLICY } = require("../electron/csp.cjs");

const PREFIX = "muse-packaged-smoke-";
const VERSION = require(path.join(ROOT, "package.json")).version;
const RELEASE = path.join(ROOT, "release");
const UNPACKED = path.join(RELEASE, "win-unpacked", "Muse BGM.exe");
const PORTABLE = path.join(RELEASE, `Muse-BGM-Portable-${VERSION}-x64.exe`);
const INSTALLER = path.join(RELEASE, `Muse-BGM-Setup-${VERSION}-x64.exe`);
const BRIDGE_KEYS = [
  "agentPlan",
  "cancelAgent",
  "cancelGeneration",
  "deleteLlmSettings",
  "deleteProviderCredentials",
  "discardPendingResult",
  "generateMusic",
  "getSettings",
  "openExternal",
  "retryLastDownload",
  "saveAudio",
  "saveLlmSettings",
  "saveProviderCredentials",
  "setUnsavedWork",
];
const FAKE = {
  tencent: "tokenhub-packaged-smoke-not-a-real-key",
  anthropic: "sk-ant-packaged-smoke-not-a-real-key",
};
/** What the console says about the two deliberate policy violations of the CSP step — and nothing else. */
const PROBE_NOISE = /http:\/\/127\.0\.0\.1:9\/|'unsafe-eval'/;

function artifact(file) {
  if (!fs.existsSync(file)) return null;
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
    for (
      let read = fs.readSync(handle, chunk, 0, chunk.length, null);
      read > 0;
      read = fs.readSync(handle, chunk, 0, chunk.length, null)
    )
      hash.update(chunk.subarray(0, read));
  } finally {
    fs.closeSync(handle);
  }
  const bytes = fs.statSync(file).size;
  return {
    file: path.relative(ROOT, file).replace(/\\/g, "/"),
    bytes,
    mebibytes: +(bytes / 1048576).toFixed(2),
    sha256: hash.digest("hex"),
  };
}

/**
 * Files of the app (dist/, electron/, package.json) that differ between the
 * archive and this tree, or exist on one side only. [] when the package is
 * exactly what `npm run dist` would make now.
 */
function packageDrift(archive) {
  const asar = require("@electron/asar");
  const inArchive = new Set(
    asar
      .listPackage(archive)
      .map((entry) => entry.split(path.sep).filter(Boolean).join("/"))
      .filter(
        (entry) =>
          /^(?:dist|electron)\/.+\.[A-Za-z0-9]+$/.test(entry) ||
          entry === "package.json",
      ),
  );
  const inTree = new Set(["package.json"]);
  const walk = (folder) => {
    for (const entry of fs.readdirSync(path.join(ROOT, folder), {
      withFileTypes: true,
    })) {
      const relative = `${folder}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else inTree.add(relative);
    }
  };
  walk("dist");
  walk("electron");
  const differing = [];
  for (const entry of new Set([...inArchive, ...inTree])) {
    if (!inArchive.has(entry) || !inTree.has(entry)) {
      differing.push(entry);
      continue;
    }
    const packed = asar.extractFile(archive, entry.split("/").join(path.sep));
    const own = fs.readFileSync(path.join(ROOT, entry));
    // electron-builder rewrites package.json (it drops scripts and devDependencies): compare what the app reads from it
    if (entry === "package.json") {
      const pick = (text) => {
        const data = JSON.parse(text);
        return JSON.stringify([
          data.name,
          data.version,
          data.main,
          data.dependencies,
        ]);
      };
      if (pick(packed.toString("utf8")) !== pick(own.toString("utf8")))
        differing.push(entry);
    } else if (!packed.equals(own)) differing.push(entry);
  }
  return differing.sort();
}

/**
 * The production dependencies inside the archive. The `files` filter of
 * package.json leaves out what never runs (source maps, TypeScript sources and
 * declarations, READMEs — three quarters of the Claude SDK as published); this
 * checks both halves of that: none of it is shipped, and nothing that does run
 * went with it — every script and manifest of the SDK is there, byte for byte.
 */
function packagedDependencies(archive) {
  const asar = require("@electron/asar");
  const entries = asar
    .listPackage(archive)
    .map((entry) => entry.split(path.sep).filter(Boolean).join("/"));
  const packed = new Set(entries);
  const deadWeight = entries.filter(
    (entry) =>
      entry.startsWith("node_modules/") &&
      /\.map$|\.[cm]?ts$|\/(?:README|readme|Readme)(?:\.[A-Za-z]+)?$/.test(
        entry,
      ),
  );
  const sdk = "node_modules/@anthropic-ai/sdk";
  const missing = [];
  let scripts = 0;
  // electron-builder rewrites the manifest of a dependency too (it drops "scripts"): what Node resolves the package by is unchanged
  const manifest = (buffer) => {
    const data = JSON.parse(buffer.toString("utf8"));
    return JSON.stringify(
      [
        "name",
        "version",
        "type",
        "main",
        "exports",
        "imports",
        "dependencies",
        "peerDependencies",
      ].map((key) => data[key] ?? null),
    );
  };
  const same = (relative, packedFile, own) =>
    relative.endsWith("/package.json")
      ? manifest(packedFile) === manifest(own)
      : packedFile.equals(own);
  const walk = (folder) => {
    for (const entry of fs.readdirSync(path.join(ROOT, folder), {
      withFileTypes: true,
    })) {
      const relative = `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        // src/ is the TypeScript the scripts were compiled from; a nested node_modules is a package of its own
        if (relative !== `${sdk}/src` && entry.name !== "node_modules")
          walk(relative);
      } else if (/\.(?:js|mjs|cjs|json|node)$/.test(entry.name)) {
        scripts += 1;
        if (
          !packed.has(relative) ||
          !same(
            relative,
            asar.extractFile(archive, relative.split("/").join(path.sep)),
            fs.readFileSync(path.join(ROOT, relative)),
          )
        )
          missing.push(relative);
      }
    }
  };
  walk(sdk);
  return {
    bytes: fs.statSync(archive).size,
    entries: entries.length,
    sdkEntries: entries.filter((entry) => entry.startsWith(`${sdk}/`)).length,
    sdkScripts: scripts,
    deadWeight,
    missing,
  };
}

/** The whole check list against one build. `launch` starts it with the given profile. */
async function checkBuild(run, label, launch, shared) {
  const step = (title, fn) => run.step(`${label}: ${title}`, fn);
  const facts = (shared.builds[label] = {});
  let app = await launch();
  shared.app = app;
  shared.profiles.push(app.profile);
  const profile = app.profile;
  let { page, $ } = app;
  // console errors of every launch of this build (the restart starts a new list)
  const seen = [app.errors];
  const errors = () => seen.flat();
  const position = async () =>
    Number(await $("waveform").getAttribute("aria-valuenow"));
  const pressed = (id) => $(id).getAttribute("aria-pressed");
  const dataDirectory = path.join(profile, "Muse-Data");

  await step(
    `a packaged build, version ${VERSION}, in an isolated profile`,
    async () => {
      const main = await app.main(({ app: electronApp }) => ({
        packaged: electronApp.isPackaged,
        version: electronApp.getVersion(),
        appPath: electronApp.getAppPath(),
        network: process.env.MUSE_NETWORK ?? null,
        electron: process.versions.electron,
      }));
      assert.equal(main.packaged, true, "app.isPackaged");
      assert.equal(main.version, VERSION);
      assert.equal(
        path.basename(main.appPath),
        "app.asar",
        `the app runs from the archive: ${main.appPath}`,
      );
      assert.equal(
        main.network,
        "node",
        "MUSE_NETWORK is honoured by a packaged build",
      );
      const settings = await app.settings();
      assert.equal(settings.version, VERSION, "getSettings().version");
      assert.equal(
        path.resolve(settings.dataPath),
        dataDirectory,
        "the data folder is the throw-away profile",
      );
      assert.deepEqual(settings.llm, { configured: false });
      assert.equal(
        settings.pendingResult,
        null,
        "no paid result is waiting in a fresh start",
      );
      assert.deepEqual(settings.providers, {
        elevenlabs: { configured: false },
        tencent: { configured: false },
        volcengine: { configured: false },
        aliyun: { configured: false },
      });
      assert.equal(
        await page.locator(".app").getAttribute("data-platform"),
        "desktop",
      );
      await app.openSettings("about");
      assert.match(
        await $("about-version").innerText(),
        new RegExp(VERSION.replace(/\./g, "\\.")),
      );
      await app.closeModal();
      Object.assign(facts, { electron: main.electron, appPath: main.appPath });
      return main;
    },
  );

  await step(
    "the bridge has exactly its 14 methods and the renderer has no Node",
    async () => {
      const bridge = await page.evaluate(() => ({
        keys: Object.keys(window.museDesktop).sort(),
        functions: Object.values(window.museDesktop).every(
          (value) => typeof value === "function",
        ),
        frozen: Object.isFrozen(window.museDesktop),
        node:
          typeof window.require !== "undefined" ||
          typeof window.process !== "undefined" ||
          typeof window.module !== "undefined",
      }));
      assert.deepEqual(bridge.keys, BRIDGE_KEYS);
      assert.equal(bridge.keys.length, 14);
      assert.deepEqual(
        [bridge.functions, bridge.frozen, bridge.node],
        [true, true, false],
      );
      const preferences = await app.main(({ BrowserWindow }) => {
        const prefs =
          BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
        return {
          contextIsolation: prefs.contextIsolation,
          nodeIntegration: prefs.nodeIntegration,
          sandbox: prefs.sandbox,
          webSecurity: prefs.webSecurity,
        };
      });
      assert.deepEqual(preferences, {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      });
    },
  );

  await step(
    "the production Content-Security-Policy is in the page and enforced",
    async () => {
      const policy = await page.evaluate(async () => {
        const meta = document.querySelector(
          'meta[http-equiv="Content-Security-Policy"]',
        );
        const blocked = [];
        const listener = (event) =>
          blocked.push(event.violatedDirective || event.effectiveDirective);
        document.addEventListener("securitypolicyviolation", listener);
        // From a timer, not from this evaluation: code run through the debugger is exempt from the eval rule.
        const evalRefused = await new Promise((resolve) =>
          setTimeout(() => {
            try {
              // eslint-disable-next-line no-new-func
              new Function("return 1")();
              resolve(false);
            } catch {
              resolve(true);
            }
          }, 0),
        );
        // connect-src 'none': the page itself can reach nothing, not even this computer
        const fetchRefused = await fetch("http://127.0.0.1:9/").then(
          () => false,
          () => true,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        document.removeEventListener("securitypolicyviolation", listener);
        return {
          content: meta?.getAttribute("content") ?? null,
          location: location.href,
          evalRefused,
          fetchRefused,
          blocked,
        };
      });
      assert.equal(policy.content, CONTENT_SECURITY_POLICY);
      assert.match(
        policy.location,
        /^file:\/\/\/.*app\.asar\/dist\/index\.html$/,
      );
      assert.equal(policy.evalRefused, true, "script-src has no unsafe-eval");
      assert.equal(policy.fetchRefused, true, "connect-src 'none'");
      assert.ok(
        policy.blocked.some((directive) => /script-src/.test(directive)) &&
          policy.blocked.some((directive) => /connect-src/.test(directive)),
        JSON.stringify(policy.blocked),
      );
      return { blocked: policy.blocked };
    },
  );

  let first;
  await step(
    "a local piece is composed in the render worker, saved, and plays",
    async () => {
      await $("composer-input").fill("安静的夜晚，一个人看书");
      await $("style-chip-jazz").click();
      await $("composer-duration").selectOption("15");
      await $("composer-structure").selectOption("loop");
      const started = Date.now();
      await $("send-button").click();
      await app.loaded(1);
      const seconds = +((Date.now() - started) / 1000).toFixed(1);
      assert.equal(
        await $("player-card").getAttribute("data-render-path"),
        "worker",
        "diagnostics.path of the render",
      );
      assert.equal(await $("player-card").getAttribute("data-engine"), "2");
      first = (await app.records())[0];
      assert.deepEqual(
        [
          first.provider,
          first.config.engine,
          first.config.mood,
          first.config.duration,
          first.config.loop,
        ],
        ["local", 2, "jazz", 15, true],
      );
      assert.equal(await page.locator('[data-testid$="-fader"]').count(), 4);
      await until(
        () => pressed("play-button"),
        (value) => value === "true",
        "playback starts with the click that asked for the piece",
      );
      await until(position, (value) => value >= 1, "the playhead moves");
      await $("play-button").click();
      assert.equal(await pressed("play-button"), "false");
      const workers = page.workers().map((worker) => worker.url());
      assert.ok(
        workers.some((url) => /app\.asar\/dist\/assets\/.*\.js$/.test(url)),
        `the worker is the app's own bundled chunk: ${JSON.stringify(workers)}`,
      );
      Object.assign(facts, { render15s: seconds, title: first.title });
      return {
        seconds,
        title: first.title,
        bpm: first.config.bpm,
        key: first.config.key,
      };
    },
  );

  let second;
  await step(
    "a refinement by message makes version 2 with the same melody seed",
    async () => {
      await $("composer-input").fill("慢一点，换成古筝");
      await $("composer-input").press("Enter");
      await app.loaded(2);
      assert.equal(
        await $("player-card").getAttribute("data-render-path"),
        "worker",
      );
      second = (await app.records()).find((record) => record.revision === 2);
      assert.equal(second.parentId, first.id);
      assert.equal(second.config.seed, first.config.seed);
      assert.ok(
        second.config.bpm < first.config.bpm,
        `${second.config.bpm} < ${first.config.bpm}`,
      );
      assert.equal(second.config.instrument, "guzheng");
      const reasons = await page
        .locator('[data-testid="thread-turn"][data-role="agent"]')
        .last()
        .locator(".turn-reasons li")
        .allInnerTexts();
      assert.ok(reasons.includes("主奏乐器换成古筝"), JSON.stringify(reasons));
      if ((await pressed("play-button")) === "true")
        await $("play-button").click();
      return { bpm: [first.config.bpm, second.config.bpm], reasons };
    },
  );

  await step(
    "a WAV is exported through the save path: 48 kHz, 16-bit, stereo, the full length, audible",
    async () => {
      const seconds = Number(
        await $("player-card").getAttribute("data-duration"),
      );
      await $("export-button").click();
      await $("export-modal").waitFor();
      const file = path.join(profile, "packaged-mix.wav");
      const wav = await app.exportVia("mix", file);
      const info = wavInfo(wav);
      assert.deepEqual(
        [
          info.riff,
          info.wave,
          info.format,
          info.channels,
          info.sampleRate,
          info.bits,
        ],
        ["RIFF", "WAVE", 1, 2, 48000, 16],
      );
      assert.equal(info.riffSize, info.fileBytes - 8);
      assert.equal(info.dataBytes, info.fileBytes - 44);
      assert.ok(
        Math.abs(info.seconds - seconds) < 0.001,
        `${info.seconds} s vs ${seconds} s`,
      );
      assert.ok(info.rms > 0.01 && info.rms < 0.7, `audible: ${info.rms}`);
      const dialog = (await app.state()).dialogs.at(-1);
      assert.equal(path.basename(dialog.defaultPath), `${second.title} v2.wav`);
      assert.deepEqual(dialog.filters[0].extensions, ["wav"]);
      await app.toast(/已导出到选定位置/);
      const stem = wavInfo(
        await app.exportVia(
          "stem-melody",
          path.join(profile, "packaged-melody.wav"),
        ),
      );
      assert.equal(stem.dataBytes, info.dataBytes);
      await app.closeModal();
      await app.clearToasts();
      Object.assign(facts, {
        wav: {
          bytes: info.fileBytes,
          seconds: info.seconds,
          rms: +info.rms.toFixed(4),
          sha256: crypto.createHash("sha256").update(wav).digest("hex"),
        },
      });
      return facts.wav;
    },
  );

  await step(
    "settings: a music service and the Claude key are saved with Windows safeStorage, never in the clear",
    async () => {
      const credentialFile = path.join(dataDirectory, "music-credentials.json");
      assert.equal(
        await app.main(({ safeStorage }) =>
          safeStorage.isEncryptionAvailable(),
        ),
        true,
        "real safeStorage",
      );
      await app.openSettings("music");
      await $("provider-tencent-tab").click();
      await $("provider-tencent-apiKey").fill(FAKE.tencent);
      await $("provider-tencent-model").selectOption("minimax-music-v2.6");
      await $("provider-tencent-save").click();
      await until(
        app.settings,
        (settings) => settings.providers.tencent.configured === true,
        "the Tencent credential is saved",
      );
      assert.match(
        await $("provider-tencent-status").innerText(),
        /凭据已保存/,
      );
      await $("settings-tab-llm").click();
      await $("llm-key").fill(FAKE.anthropic);
      await $("llm-save").click();
      await until(
        app.settings,
        (settings) => settings.llm.configured === true,
        "the Claude key is saved",
      );
      const settings = await app.settings();
      assert.deepEqual(settings.llm, {
        configured: true,
        kind: "anthropic",
        preset: "anthropic",
        model: "claude-opus-5-5",
      });
      assert.deepEqual(settings.providers.tencent, {
        configured: true,
        model: "minimax-music-v2.6",
      });
      const stored = fs.readFileSync(credentialFile, "utf8");
      for (const secret of Object.values(FAKE)) {
        assert.ok(!stored.includes(secret), "encrypted on disk");
        assert.ok(
          !JSON.stringify(settings).includes(secret),
          "never read back",
        );
      }
      const shape = JSON.parse(stored);
      assert.deepEqual(Object.keys(shape).sort(), [
        "llm",
        "providers",
        "version",
      ]);
      assert.deepEqual(Object.keys(shape.providers), ["tencent"]);
      await app.closeModal();
      assert.deepEqual(
        (await app.state()).requests,
        [],
        "saving credentials calls no service",
      );
      assert.deepEqual(
        (await app.state()).warmUps,
        [],
        "a hosted model is not warmed up",
      );
    },
  );

  await step(
    "the bundled Claude SDK loads from app.asar and plans through the agent service (mocked network)",
    async () => {
      const sdk = await app.main(({ app: electronApp }) => {
        const { createRequire } = process.mainModule.require("node:module");
        const nodePath = process.mainModule.require("node:path");
        const appRequire = createRequire(
          nodePath.join(electronApp.getAppPath(), "package.json"),
        );
        const resolved = appRequire.resolve("@anthropic-ai/sdk");
        // the package exports no "./package.json": read the file next to its entry (through Electron's asar-aware fs)
        const folder = resolved.slice(
          0,
          resolved.lastIndexOf(nodePath.join("@anthropic-ai", "sdk")) +
            nodePath.join("@anthropic-ai", "sdk").length,
        );
        return {
          resolved,
          version: JSON.parse(
            process.mainModule
              .require("node:fs")
              .readFileSync(nodePath.join(folder, "package.json"), "utf8"),
          ).version,
          client: typeof appRequire("@anthropic-ai/sdk").Anthropic,
          inArchive: resolved.split(nodePath.sep).includes("app.asar"),
        };
      });
      assert.equal(sdk.client, "function");
      assert.equal(sdk.inArchive, true, sdk.resolved);
      assert.equal(
        sdk.version,
        require(
          path.join(
            ROOT,
            "node_modules",
            "@anthropic-ai",
            "sdk",
            "package.json",
          ),
        ).version,
      );
      // through the real interface: the producer is the model now
      await app.newPiece();
      assert.equal(await $("composer-brain").inputValue(), "llm");
      await $("composer-input").fill("雨天咖啡馆里的慵懒爵士，不要鼓");
      await $("composer-duration").selectOption("15");
      await $("send-button").click();
      await app.loaded(1);
      const work = (await app.records()).find(
        (record) => record.title === DEFAULT_PLAN.title,
      );
      assert.ok(work, "the piece the model planned");
      assert.deepEqual(
        [
          work.config.mood,
          work.config.instrument,
          work.config.bpm,
          work.config.arrangement?.drums,
        ],
        ["jazz", "vibes", 84, "none"],
      );
      assert.equal(work.chat.at(-1).brain, "llm");
      assert.equal(
        await page.locator('[data-testid="turn-brain"]').last().innerText(),
        "claude-opus-5-5",
      );
      assert.equal(
        await page.locator('[data-testid="turn-fallback"]').count(),
        0,
        "the model answered: no fall-back to the rules",
      );
      const calls = (await app.state()).requests;
      assert.equal(calls.length, 1, "one request, to Claude");
      assert.equal(
        calls[0].url,
        "https://api.anthropic.com/v1/messages?beta=true",
      );
      assert.equal(
        calls[0].headers["x-api-key"],
        FAKE.anthropic,
        "the stored key, decrypted in the main process",
      );
      assert.match(
        calls[0].headers["user-agent"] ?? "",
        /Anthropic/i,
        "sent by the SDK",
      );
      assert.equal(calls[0].body.model, "claude-opus-5-5");
      if ((await pressed("play-button")) === "true")
        await $("play-button").click();
      facts.sdk = { version: sdk.version, resolved: sdk.resolved };
      return facts.sdk;
    },
  );

  await step("removing the credentials leaves nothing behind", async () => {
    await app.openSettings("llm");
    await $("llm-remove").click();
    await until(
      app.settings,
      (settings) => !settings.llm.configured,
      "the Claude key is removed",
    );
    await $("settings-tab-music").click();
    await $("provider-tencent-tab").click();
    await $("provider-tencent-remove").click();
    await until(
      app.settings,
      (settings) => !settings.providers.tencent.configured,
      "the Tencent credential is removed",
    );
    await app.closeModal();
    assert.equal(await $("composer-brain").inputValue(), "rules");
    const stored = JSON.parse(
      fs.readFileSync(
        path.join(dataDirectory, "music-credentials.json"),
        "utf8",
      ),
    );
    assert.equal(stored.llm, undefined);
    assert.deepEqual(stored.providers, {});
  });

  await step(
    "a full process restart keeps the library: three works, reopened and playable",
    async () => {
      const before = (await app.records()).map((record) => record.id).sort();
      assert.equal(before.length, 3);
      await app.close({ keepProfile: true });
      shared.app = null;
      app = await launch(profile);
      shared.app = app;
      seen.push(app.errors);
      ({ page, $ } = app);
      assert.equal(
        await app.main(({ app: electronApp }) => electronApp.isPackaged),
        true,
      );
      assert.deepEqual(
        (await app.records()).map((record) => record.id).sort(),
        before,
      );
      await $("nav-library").click();
      assert.equal(
        await page.locator('[data-testid="library-card"]').count(),
        3,
      );
      await page
        .locator(
          `[data-testid="library-card"][data-project="${second.id}"] [data-testid="library-open"]`,
        )
        .click();
      await page.waitForSelector(
        `[data-testid="player-card"][data-project="${second.id}"][data-audio="stems"]`,
        { timeout: 60000 },
      );
      await app.idle();
      assert.equal(
        await $("player-card").getAttribute("data-render-path"),
        "worker",
        "rebuilt in the worker",
      );
      assert.equal(await $("player-card").getAttribute("data-revision"), "2");
      await $("play-button").click();
      await until(position, (value) => value >= 1, "the reopened work plays");
      await $("play-button").click();
      const settings = await app.settings();
      assert.deepEqual(
        [settings.llm.configured, settings.providers.tencent.configured],
        [false, false],
        "the removed credentials stayed removed",
      );
    },
  );

  await step(
    "clean: no renderer errors, nothing left the machine",
    async () => {
      const state = await app.state();
      assert.deepEqual(
        errors().filter((text) => !PROBE_NOISE.test(text)),
        [],
      );
      assert.deepEqual(state.denied, [], "Chromium requests");
      assert.deepEqual(state.unknown, [], "requests the fixtures did not know");
      assert.deepEqual(state.loopback, []);
      assert.deepEqual(state.warmUps, []);
      assert.deepEqual(
        state.requests,
        [],
        "this launch made no request at all",
      );
    },
  );

  await app.close({ keepProfile: true });
  shared.app = null;
}

async function main() {
  const only = process.argv.includes("--unpacked")
    ? "unpacked"
    : process.argv.includes("--portable")
      ? "portable"
      : null;
  const run = createRun("Packaged smoke", "packaged-smoke-results.json");
  const shared = { app: null, profiles: [], builds: {} };
  let failure = {};
  const artifacts = {
    installer: artifact(INSTALLER),
    portable: artifact(PORTABLE),
  };
  try {
    await run.step("the release folder holds this version", async () => {
      if (only !== "portable")
        assert.ok(
          fs.existsSync(UNPACKED),
          `${path.relative(ROOT, UNPACKED)} is missing. Run \`npm run dist\` first.`,
        );
      if (only !== "unpacked")
        assert.ok(
          artifacts.portable,
          `${path.relative(ROOT, PORTABLE)} is missing. Run \`npm run dist\` first.`,
        );
      // What is inside the archive is what is in this tree: a package built before the last change is not what gets tested.
      const differing =
        only === "portable"
          ? []
          : packageDrift(
              path.join(RELEASE, "win-unpacked", "resources", "app.asar"),
            );
      if (differing.length && !process.argv.includes("--allow-stale"))
        assert.fail(
          `release/win-unpacked was not built from this tree (${differing.slice(0, 5).join(", ")}${differing.length > 5 ? ", …" : ""}). Run \`npm run dist\`, or pass --allow-stale.`,
        );
      // the installer and the portable exe are made from win-unpacked in the same run: never older than it
      const archive = path.join(
        RELEASE,
        "win-unpacked",
        "resources",
        "app.asar",
      );
      const dependencies = fs.existsSync(archive)
        ? packagedDependencies(archive)
        : null;
      if (dependencies) {
        assert.deepEqual(
          dependencies.deadWeight,
          [],
          "source maps, TypeScript and READMEs of the dependencies are not shipped (package.json build.files)",
        );
        assert.deepEqual(
          dependencies.missing,
          [],
          "every script and manifest of the Claude SDK is in the archive, unchanged",
        );
      }
      if (fs.existsSync(archive) && !process.argv.includes("--allow-stale"))
        for (const file of [INSTALLER, PORTABLE].filter((candidate) =>
          fs.existsSync(candidate),
        ))
          assert.ok(
            fs.statSync(file).mtimeMs >= fs.statSync(archive).mtimeMs - 2000,
            `${path.basename(file)} is older than release/win-unpacked. Run \`npm run dist\`.`,
          );
      // The checksums handed out with a release are those of these very files:
      // a rebuild changes both hashes, and a stale list would send people away
      // from a good download.
      const current = [artifacts.installer, artifacts.portable]
        .filter(Boolean)
        .map((item) => `${item.sha256}  ${path.basename(item.file)}`);
      const sums = path.join(RELEASE, "SHA256SUMS.txt");
      const notes = path.join(RELEASE, `RELEASE-NOTES-${VERSION}.md`);
      if (!process.argv.includes("--allow-stale")) {
        if (fs.existsSync(sums))
          assert.deepEqual(
            fs.readFileSync(sums, "utf8").split(/\r?\n/).filter(Boolean).sort(),
            [...current].sort(),
            "release/SHA256SUMS.txt does not match the files in release/. Write it again after `npm run dist`.",
          );
        if (fs.existsSync(notes)) {
          const text = fs.readFileSync(notes, "utf8");
          for (const line of current)
            assert.ok(
              text.includes(line),
              `${path.basename(notes)} lacks the line "${line}"`,
            );
          const known = new Set(current.map((line) => line.slice(0, 64)));
          assert.deepEqual(
            (text.match(/[0-9a-f]{64}/gi) ?? []).filter(
              (hash) => !known.has(hash.toLowerCase()),
            ),
            [],
            `${path.basename(notes)} names a checksum that belongs to no file in release/`,
          );
        }
      }
      return {
        installer: artifacts.installer,
        portable: artifacts.portable,
        checksums: {
          sums: fs.existsSync(sums),
          notes: fs.existsSync(notes),
        },
        differing,
        archive: dependencies && {
          bytes: dependencies.bytes,
          entries: dependencies.entries,
          sdkEntries: dependencies.sdkEntries,
          sdkScripts: dependencies.sdkScripts,
        },
      };
    });
    if (only !== "portable")
      await checkBuild(
        run,
        "win-unpacked",
        (profile) =>
          launchApp({
            prefix: PREFIX,
            profile,
            mock: true,
            executable: UNPACKED,
          }),
        shared,
      );
    if (only !== "unpacked")
      await checkBuild(
        run,
        "portable",
        (profile) =>
          launchApp({
            prefix: PREFIX,
            profile,
            mock: true,
            portable: PORTABLE,
          }),
        shared,
      );
  } catch (error) {
    failure = await describeFailure(shared.app, "packaged-smoke");
    if (!error?.reported) console.error(error);
    failure.error = String(error?.cause?.message || error?.message || error);
  } finally {
    if (shared.app) await shared.app.close({ keepProfile: true });
    for (const profile of shared.profiles) removeProfile(profile, PREFIX);
  }
  fs.mkdirSync(RESULTS, { recursive: true });
  process.exitCode = run.finish({
    version: VERSION,
    mode: "packaged builds, isolated profiles, real safeStorage; network replaced by fixtures (MUSE_NETWORK=node)",
    artifacts,
    builds: shared.builds,
    ...(failure.error ? { error: failure.error, failure } : {}),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
