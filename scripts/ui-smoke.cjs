"use strict";

// End-to-end regression of the desktop app's local flows in real Electron:
// compose → listen → refine → mix → export through the native save path →
// library → restart → settings (real Windows safeStorage) → a v0.2 project.
//
//   npm run build && npm run test:ui
//
// Uses a throw-away profile under the OS temp directory, never %APPDATA%\Muse BGM.
// No service is contacted: every Chromium request is cancelled and counted, and
// the run fails if there was one. Writes test-results/ui-smoke-results.json.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ROOT,
  until,
  launchApp,
  removeProfile,
  wavInfo,
  createRun,
  describeFailure,
} = require("../tests/helpers/electron-harness.cjs");

const PREFIX = "muse-ui-smoke-";

/** The v0.2 project kept in examples/ (schema 1, no engine field): whatever it is called today. */
function legacyProject() {
  const directory = path.join(ROOT, "examples");
  for (const name of fs
    .readdirSync(directory)
    .filter((entry) => entry.endsWith(".muse.json"))
    .sort()) {
    const file = path.join(directory, name);
    try {
      const project = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        project.schemaVersion === 1 &&
        project.config &&
        project.config.engine === undefined
      )
        return { file, project };
    } catch {
      /* not a project file */
    }
  }
  throw new Error(
    "examples/ has no v0.2 project (*.muse.json with schemaVersion 1)",
  );
}
const FAKE = {
  tencent: "tokenhub-smoke-only-not-a-real-key",
  anthropic: "sk-ant-smoke-only-not-a-real-key",
  custom: "sk-smoke-only-openai-compatible",
};

async function main() {
  const run = createRun("UI smoke", "ui-smoke-results.json");
  let app;
  let profile;
  let failure = {};
  const facts = {};
  try {
    app = await launchApp({ prefix: PREFIX });
    profile = app.profile;
    let { page, $ } = app;
    const file = (name) => path.join(profile, name);
    const exportTo = (option, name) => app.exportVia(option, file(name));
    const byRevision = async (revision) =>
      (await app.records()).find((record) => record.revision === revision);
    const pressed = (id) => $(id).getAttribute("aria-pressed");
    const position = async () =>
      Number(await $("waveform").getAttribute("aria-valuenow"));
    const windowTitle = () =>
      app.main(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getTitle(),
      );

    await run.step(
      "starts as the desktop app in an isolated profile",
      async () => {
        const settings = await app.settings();
        assert.equal(
          path.resolve(settings.dataPath),
          path.join(profile, "Muse-Data"),
        );
        assert.equal(
          settings.version,
          require(path.join(ROOT, "package.json")).version,
        );
        assert.ok(
          Object.values(settings.providers).every(
            (status) => status.configured === false,
          ),
          "no credentials in the test profile",
        );
        assert.equal(
          await page.locator(".app").getAttribute("data-platform"),
          "desktop",
        );
        assert.equal(await $("studio-empty").count(), 1);
        assert.equal(
          await $("desktop-link").count(),
          0,
          "no download link inside the desktop app",
        );
        const engines = await $("composer-engine")
          .locator("option")
          .allInnerTexts();
        assert.equal(engines.length, 5);
        assert.ok(
          engines.slice(1).every((text) => text.includes("需先在设置中配置")),
          JSON.stringify(engines),
        );
        assert.equal(await $("composer-brain").inputValue(), "rules");
        assert.equal(
          await page.locator('[data-testid^="style-chip-"]').count(),
          23,
        );
        assert.deepEqual(await app.records(), []);
      },
    );

    let first;
    await run.step(
      "new piece with a pinned style and duration → v1 rendered, saved, in view and playing",
      async () => {
        await $("composer-input").fill("安静的夜晚，一个人看书");
        const preview = await until(
          () => $("plan-preview").innerText(),
          (text) => text.startsWith("将创作："),
          "plan preview",
        );
        await $("style-chip-jazz").click();
        await $("composer-duration").selectOption("15");
        await $("composer-structure").selectOption("loop");
        await $("send-button").click();
        await app.loaded(1);
        first = (await app.records())[0];
        assert.equal(first.provider, "local");
        assert.equal(first.config.engine, 2);
        assert.equal(first.config.mood, "jazz", "the pinned style");
        assert.equal(first.config.duration, 15, "the pinned duration");
        assert.equal(first.config.loop, true);
        assert.equal(first.chat.length, 2);
        assert.equal(
          await $("player-card").getAttribute("data-render-path"),
          "worker",
          "composed off the UI thread",
        );
        assert.equal(await page.locator('[data-testid$="-fader"]').count(), 4);
        assert.ok(
          (await page.locator('[data-testid="section-band"]').count()) >= 1,
        );
        assert.ok((await $("chord-strip").locator("span").count()) >= 2);
        const play = await page.evaluate(() => {
          const node = document.querySelector('[data-testid="play-button"]');
          const box = node.getBoundingClientRect();
          return {
            focused: document.activeElement === node,
            visible: box.top >= 0 && box.bottom <= innerHeight,
          };
        });
        assert.deepEqual(play, { focused: true, visible: true });
        await until(
          () => pressed("play-button"),
          (value) => value === "true",
          "autoplay after the click that started it",
        );
        assert.equal(
          await windowTitle(),
          `${first.title} · 音序 Muse`,
          "the window title follows the work",
        );
        assert.equal(await $("composer-input").inputValue(), "");
        facts.first = {
          title: first.title,
          bpm: first.config.bpm,
          key: first.config.key,
          seconds: Number(await $("player-card").getAttribute("data-duration")),
        };
        return { preview, ...facts.first };
      },
    );

    await run.step(
      "transport: pause, keyboard seek, restart, Space and L",
      async () => {
        await until(position, (value) => value >= 1, "the playhead moves");
        await $("play-button").click();
        assert.equal(await pressed("play-button"), "false");
        await $("waveform").focus();
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowRight");
        assert.equal(await position(), 5);
        await $("restart-button").click();
        assert.equal(await position(), 0);
        await $("work-meta").click();
        await page.keyboard.press("Space");
        await until(
          () => pressed("play-button"),
          (value) => value === "true",
          "Space plays",
        );
        await page.keyboard.press("Space");
        await until(
          () => pressed("play-button"),
          (value) => value === "false",
          "Space pauses",
        );
        // a 循环片段 is auditioned as a loop from the start; L switches it off and on again
        assert.equal(await pressed("loop-toggle"), "true");
        await page.keyboard.press("l");
        assert.equal(await pressed("loop-toggle"), "false");
        await page.keyboard.press("l");
        assert.equal(await pressed("loop-toggle"), "true");
      },
    );

    let second;
    await run.step(
      "refine by message → v2 with the same seed; a message that changes nothing generates nothing",
      async () => {
        await $("composer-input").fill("慢一点，换成古筝");
        await $("composer-input").press("Enter");
        await app.loaded(2);
        second = await byRevision(2);
        assert.equal(second.parentId, first.id);
        assert.equal(second.config.seed, first.config.seed);
        assert.ok(
          second.config.bpm < first.config.bpm,
          `${second.config.bpm} < ${first.config.bpm}`,
        );
        assert.equal(second.config.instrument, "guzheng");
        assert.equal(second.title, first.title);
        await $("play-button").click();
        const turns = await page.locator('[data-testid="thread-turn"]').count();
        await $("composer-input").fill("今天天气怎么样");
        await $("send-button").click();
        await until(
          () => page.locator('[data-testid="thread-turn"]').count(),
          (count) => count === turns + 2,
          "the producer answers",
        );
        await app.idle();
        assert.equal((await app.records()).length, 2, "no new version");
        assert.equal(await $("player-card").getAttribute("data-revision"), "2");
        return { bpm: [first.config.bpm, second.config.bpm] };
      },
    );

    let third;
    await run.step(
      "inspector: typing never resets it; 应用调整 → v3 same seed; 换一版旋律 → v4 new seed",
      async () => {
        assert.equal(await $("apply-draft").isDisabled(), true);
        await $("inspector-instrument").selectOption("flute");
        await $("changed-instrument").waitFor();
        await $("composer-input").pressSequentially("复古电子 150 BPM", {
          delay: 5,
        });
        assert.equal(await $("inspector-instrument").inputValue(), "flute");
        await $("composer-input").fill("");
        await $("apply-draft").click();
        await app.loaded(3);
        third = await byRevision(3);
        assert.equal(third.config.instrument, "flute");
        assert.equal(third.config.seed, first.config.seed);
        assert.equal(third.parentId, second.id);
        await $("play-button").click();
        await $("new-melody").click();
        await app.loaded(4);
        const fourth = await byRevision(4);
        assert.notEqual(fourth.config.seed, third.config.seed);
        assert.equal(fourth.config.instrument, "flute");
        assert.equal(fourth.config.bpm, third.config.bpm);
        await $("play-button").click();
        // back to v3 through its tag in the conversation
        await page
          .locator('button[data-testid="turn-version"]', { hasText: /^v3$/ })
          .click();
        await page.waitForSelector(
          `[data-testid="player-card"][data-project="${third.id}"][data-audio="stems"]`,
          { timeout: 60000 },
        );
        await app.idle();
      },
    );

    await run.step(
      "mixer: faders, mute and solo act on the playing audio and only faders are saved",
      async () => {
        const current = async () =>
          (await app.records()).find((record) => record.id === third.id);
        await $("play-button").click();
        await until(
          () => pressed("play-button"),
          (value) => value === "true",
          "playing",
        );
        const fader = $("mixer-melody-fader");
        await fader.focus();
        await page.keyboard.press("Home");
        for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
        assert.equal(await fader.inputValue(), "30");
        await until(
          current,
          (record) => Math.abs(record.config.volumes.melody - 0.3) < 1e-6,
          "the fader is saved",
        );
        await $("mixer-drums-mute").click();
        await until(
          current,
          (record) => record.config.volumes.drums === 0,
          "mute is saved",
        );
        await $("mixer-drums-mute").click();
        await until(
          current,
          (record) => record.config.volumes.drums > 0,
          "unmute is saved",
        );
        const before = await current();
        await $("mixer-bass-solo").click();
        assert.equal(await pressed("mixer-bass-solo"), "true");
        assert.equal(
          await pressed("play-button"),
          "true",
          "mixing does not stop playback",
        );
        await $("play-button").click();
        assert.deepEqual(await current(), before, "solo writes nothing");
        assert.equal(
          (await app.records()).length,
          4,
          "mixing creates no versions",
        );
      },
    );

    await run.step(
      "export through the save dialog: full mix (solo ignored), ×2 loop, a stem, the project JSON",
      async () => {
        const seconds = Number(
          await $("player-card").getAttribute("data-duration"),
        );
        await page.keyboard.press("Control+e");
        await $("export-modal").waitFor();
        const mix = await exportTo("mix", "mix.wav");
        const info = wavInfo(mix);
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
        assert.ok(info.rms > 0.01, `audible: ${info.rms}`);
        const dialog = (await app.state()).dialogs.at(-1);
        assert.equal(
          path.basename(dialog.defaultPath),
          `${third.title} v3.wav`,
        );
        assert.deepEqual(dialog.filters[0].extensions, ["wav"]);
        const stem = await exportTo("stem-bass", "bass.wav");
        const stemInfo = wavInfo(stem);
        assert.equal(stemInfo.dataBytes, info.dataBytes);
        assert.ok(
          !mix.equals(stem),
          "bass is soloed in the player, the file is still the full mix",
        );
        assert.ok(
          info.rms > stemInfo.rms * 1.1,
          `mix ${info.rms} vs bass ${stemInfo.rms}`,
        );
        await $("export-repeats-2").click();
        const twice = await exportTo("mix", "mix-x2.wav");
        assert.equal(wavInfo(twice).dataBytes, info.dataBytes * 2);
        assert.ok(
          twice.subarray(44, 44 + info.dataBytes).equals(mix.subarray(44)),
          "first pass is identical",
        );
        assert.ok(
          twice.subarray(44 + info.dataBytes).equals(mix.subarray(44)),
          "second pass is identical",
        );
        const project = JSON.parse(
          (await exportTo("project", "project.json")).toString("utf8"),
        );
        assert.equal(project.schemaVersion, 2);
        assert.equal(project.revision, 3);
        assert.equal(project.config.seed, first.config.seed);
        assert.equal(project.config.volumes.melody, 0.3);
        assert.equal(project.audioBlob, undefined);
        // a cancelled dialog is not a success
        await app.clearToasts();
        await app.exportVia("mix", null);
        assert.deepEqual(
          (await app.toasts()).filter((text) => text.includes("已导出")),
          [],
        );
        await app.closeModal();
        await $("mixer-bass-solo").click();
        return {
          seconds: info.seconds,
          megabytes: +(info.fileBytes / 1048576).toFixed(2),
        };
      },
    );

    await run.step(
      "library: rename, favourite, search, sort, import of the exported project",
      async () => {
        await $("work-title").fill("Smoke 夜读");
        await page.keyboard.press("Enter");
        await until(
          app.records,
          (list) =>
            list.find((record) => record.id === third.id)?.title ===
            "Smoke 夜读",
          "the new title is saved",
        );
        await $("favourite-button").click();
        await until(
          app.records,
          (list) =>
            list.find((record) => record.id === third.id)?.favorite === true,
          "favourite is saved",
        );
        await $("nav-library").click();
        const cards = page.locator('[data-testid="library-card"]');
        assert.equal(await cards.count(), 4);
        await $("library-search").fill("Smoke");
        assert.equal(await cards.count(), 1);
        await $("library-search").fill("没有这个名字");
        await $("library-no-match").waitFor();
        await $("library-search").fill("");
        await $("library-favourites").click();
        assert.equal(await cards.count(), 1);
        await $("library-favourites").click();
        await $("library-sort-title").click();
        const titles = await page
          .locator('[data-testid="library-open"]')
          .allInnerTexts();
        assert.deepEqual(
          titles,
          [...titles].sort((a, b) => a.localeCompare(b, "zh-CN")),
        );
        await $("library-sort-recent").click();
        await $("import-input").setInputFiles(file("project.json"));
        await page.waitForSelector(
          `[data-testid="player-card"][data-audio="stems"]:not([data-project="${third.id}"])`,
          { timeout: 60000 },
        );
        await app.idle();
        const all = await app.records();
        assert.equal(all.length, 5);
        const imported = all.find(
          (record) =>
            ![first.id, second.id, third.id].includes(record.id) &&
            record.revision === 3,
        );
        assert.ok(imported, "the import is a separate work");
        assert.equal(imported.config.seed, first.config.seed);
        facts.importedId = imported.id;
      },
    );

    await run.step(
      "Ctrl+N starts a new piece; a 120 s render can be cancelled and writes nothing",
      async () => {
        await page.keyboard.press("Control+n");
        await $("studio-empty").waitFor();
        assert.equal(
          await page.locator('[data-testid="mini-transport"]').count(),
          0,
        );
        await $("composer-input").fill("史诗感的管弦乐，气势磅礴");
        await $("composer-duration").selectOption("120");
        await $("composer-input").press("Control+Enter");
        await page.waitForSelector(
          '[data-testid="job-status"][data-stage="rendering"]',
        );
        await $("nav-library").click();
        assert.equal(
          await $("job-status").count(),
          1,
          "the job is shown on every page",
        );
        await $("job-cancel").click();
        await app.idle(15000);
        await app.toast(/已取消本地生成/);
        assert.equal((await app.records()).length, 5);
        await $("nav-studio").click();
        assert.equal(
          await $("composer-input").inputValue(),
          "史诗感的管弦乐，气势磅礴",
          "the description is handed back",
        );
        await $("composer-input").fill("");
      },
    );

    await run.step(
      "delete with undo; a delete followed by quitting is still a delete; the session comes back",
      async () => {
        await $("nav-library").click();
        const card = (id) =>
          page.locator(`[data-testid="library-card"][data-project="${id}"]`);
        await card(first.id).locator('[data-testid="library-delete"]').click();
        assert.equal(
          await page.locator('[data-testid="library-card"]').count(),
          4,
        );
        assert.equal(
          (await app.records()).length,
          5,
          "nothing is deleted inside the undo window",
        );
        await $("toast-action").click();
        assert.equal(
          await page.locator('[data-testid="library-card"]').count(),
          5,
        );
        // open v3, leave a half-written message, delete v1 and quit at once
        await card(third.id).locator('[data-testid="library-open"]').click();
        await page.waitForSelector(
          `[data-testid="player-card"][data-project="${third.id}"][data-audio="stems"]`,
          { timeout: 60000 },
        );
        await app.idle();
        await $("composer-input").fill("下次接着改");
        await $("nav-library").click();
        await card(first.id).locator('[data-testid="library-delete"]').click();
        assert.equal((await app.records()).length, 5);
        await app.close({ keepProfile: true });
        app = await launchApp({ prefix: PREFIX, profile });
        ({ page, $ } = app);
        await page.waitForSelector(
          `[data-testid="player-card"][data-project="${third.id}"][data-audio="stems"]`,
          { timeout: 60000 },
        );
        await app.idle();
        assert.equal(
          await pressed("play-button"),
          "false",
          "restored without playing",
        );
        assert.equal(await $("composer-input").inputValue(), "下次接着改");
        assert.equal(await $("mixer-melody-fader").inputValue(), "30");
        const after = await app.records();
        assert.equal(after.length, 4, "the deleted work did not come back");
        assert.ok(!after.some((record) => record.id === first.id));
        await $("nav-library").click();
        assert.equal(
          await page.locator('[data-testid="library-card"]').count(),
          4,
        );
        await $("nav-studio").click();
        await $("composer-input").fill("");
      },
    );

    await run.step(
      "settings: a music service — errors in Chinese, save (encrypted), damaged entry, remove",
      async () => {
        const credentialFile = path.join(
          profile,
          "Muse-Data",
          "music-credentials.json",
        );
        await $("nav-studio").click();
        await $("new-piece").click();
        await $("studio-empty").waitFor();
        await $("composer-engine").selectOption("tencent");
        await $("settings-modal").waitFor();
        await app.toast(/请先在设置中保存腾讯云 TokenHub 的服务凭据/);
        assert.equal(
          await $("provider-tencent-tab").getAttribute("aria-pressed"),
          "true",
        );
        assert.equal(await $("provider-tencent-save").isDisabled(), true);
        await $("provider-tencent-apiKey").fill("short");
        await $("provider-tencent-save").click();
        const refused = await page
          .locator('[data-testid="provider-tencent"] [role="alert"]')
          .innerText();
        assert.match(refused, /API Key 格式不正确/);
        assert.doesNotMatch(refused, /Error invoking|remote method/);
        await $("provider-tencent-apiKey").fill(FAKE.tencent);
        await $("provider-tencent-model").selectOption("minimax-music-v2.6");
        await $("provider-tencent-save").click();
        await until(
          app.settings,
          (settings) => settings.providers.tencent.configured,
          "saved",
        );
        assert.match(
          await $("provider-tencent-status").innerText(),
          /凭据已保存/,
        );
        assert.equal(await $("provider-tencent-apiKey").inputValue(), "");
        const stored = fs.readFileSync(credentialFile, "utf8");
        assert.ok(
          !stored.includes(FAKE.tencent),
          "the key is encrypted on disk",
        );
        assert.ok(
          !JSON.stringify(await app.settings()).includes(FAKE.tencent),
          "the key is never read back",
        );
        const links = (await app.state()).opened.length;
        await $("provider-tencent-docs").click();
        const opened = await until(
          app.state,
          (state) => state.opened.length === links + 1,
          "the official page is opened outside the app",
        );
        assert.match(opened.opened.at(-1), /^https:\/\/cloud\.tencent\.cn\//);
        await app.closeModal();
        await $("composer-engine").selectOption("tencent");
        assert.equal(
          await $("composer-engine").inputValue(),
          "tencent",
          "the engine can be chosen now",
        );
        // an entry Windows can no longer decrypt
        const damaged = JSON.parse(stored);
        damaged.providers.tencent = {
          encryptedCredentials: "bm90LWEtcmVhbC1jaXBoZXJ0ZXh0",
        };
        fs.writeFileSync(credentialFile, JSON.stringify(damaged));
        await app.openSettings("music");
        await until(
          () => $("provider-tencent-status").innerText(),
          (text) => text.includes("无法读取"),
          "the damaged entry is reported",
        );
        assert.match(
          await page
            .locator('[data-testid="provider-tencent"] .notice-warn')
            .innerText(),
          /请重新保存/,
        );
        await $("provider-tencent-remove").click();
        await until(
          app.settings,
          (settings) =>
            !settings.providers.tencent.configured &&
            !settings.providers.tencent.damaged,
          "removed",
        );
        await app.closeModal();
        assert.equal(
          await $("composer-engine").inputValue(),
          "local",
          "the engine falls back to local",
        );
        assert.deepEqual(
          (await app.state()).requests,
          [],
          "settings never call a service",
        );
      },
    );

    await run.step(
      "settings: the producer model — Claude key form, address errors in Chinese, Ollama, remove",
      async () => {
        await app.openSettings("llm");
        assert.match(await $("llm-status").innerText(), /尚未配置/);
        assert.deepEqual(
          await $("llm-model").locator("option").allInnerTexts(),
          ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
        );
        assert.equal(await $("llm-base-url").count(), 0);
        await $("llm-key").fill(FAKE.anthropic);
        await $("llm-save").click();
        await until(
          app.settings,
          (settings) => settings.llm.configured,
          "Claude saved",
        );
        assert.deepEqual((await app.settings()).llm, {
          configured: true,
          kind: "anthropic",
          preset: "anthropic",
          model: "claude-opus-5-5",
        });
        assert.match(
          await $("llm-status").innerText(),
          /已配置.*Claude.*claude-opus-5-5/s,
        );
        assert.ok(
          !fs
            .readFileSync(
              path.join(profile, "Muse-Data", "music-credentials.json"),
              "utf8",
            )
            .includes(FAKE.anthropic),
        );
        // OpenAI-compatible endpoint: the main process validates the address
        await $("llm-preset").selectOption("custom");
        await $("llm-key").fill(FAKE.custom);
        await $("llm-model").fill("some-model");
        const alert = page.locator('[data-testid="llm-form"] [role="alert"]');
        const errors = {};
        for (const [name, address] of [
          ["http", "http://api.example.com/v1"],
          ["local", "https://127.0.0.1/v1"],
          ["query", "https://api.example.com/v1?key=1"],
        ]) {
          await $("llm-base-url").fill(address);
          await $("llm-save").click();
          await alert.waitFor();
          errors[name] = await alert.innerText();
          assert.match(errors[name], /接口地址/);
          assert.doesNotMatch(
            errors[name],
            /Error invoking|remote method|TypeError/,
          );
        }
        assert.match(errors.http, /必须以 https:\/\/ 开头/);
        assert.match(errors.local, /不能指向本机或内网/);
        assert.equal(
          (await app.settings()).llm.kind,
          "anthropic",
          "a refused save changes nothing",
        );
        await $("llm-base-url").fill("https://api.example.com/v1/");
        await $("llm-save").click();
        await until(
          app.settings,
          (settings) => settings.llm.preset === "custom",
          "custom endpoint saved",
        );
        assert.equal(
          (await app.settings()).llm.baseUrl,
          "https://api.example.com/v1",
        );
        assert.equal(
          await $("llm-base-url").inputValue(),
          "https://api.example.com/v1",
          "the form shows what was stored",
        );
        assert.deepEqual(
          (await app.state()).warmUps,
          [],
          "a hosted model is never called on save",
        );
        // local model: no key
        await $("llm-preset").selectOption("ollama");
        assert.equal(await $("llm-key").count(), 0);
        assert.equal(
          await $("llm-base-url").inputValue(),
          "http://127.0.0.1:11434/v1",
        );
        await $("llm-model").fill("some-local-model");
        await $("llm-base-url").fill("http://localhost:11434/v1");
        await $("llm-save").click();
        await until(
          app.settings,
          (settings) => settings.llm.kind === "ollama",
          "Ollama saved",
        );
        await until(
          () => $("llm-base-url").inputValue(),
          (value) => value === "http://127.0.0.1:11434/v1",
          "the stored address is shown",
        );
        // saving a local model warms it up once, in the background (the harness records and stops the request)
        const warmUps = await until(
          async () => (await app.state()).warmUps,
          (list) => list.length >= 1,
          "the warm-up of the local model",
        );
        assert.deepEqual(warmUps, [
          {
            url: "http://127.0.0.1:11434/v1/chat/completions",
            model: "some-local-model",
            roles: ["system", "user"],
          },
        ]);
        assert.deepEqual(
          await app
            .toasts()
            .then((texts) =>
              texts.filter((text) => /Ollama|大模型.*(失败|无法)/.test(text)),
            ),
          [],
          "a warm-up that fails is silent",
        );
        await app.closeModal();
        assert.equal(await $("composer-brain").inputValue(), "llm");
        assert.match(
          await $("composer-brain").locator("option:checked").innerText(),
          /大模型 some-local-model/,
        );
        await app.openSettings("llm");
        await $("llm-remove").click();
        await until(
          app.settings,
          (settings) => !settings.llm.configured,
          "removed",
        );
        await $("settings-tab-about").click();
        assert.match(await $("about-version").innerText(), /Windows 桌面版/);
        assert.ok(
          (await $("data-path").innerText()).includes(
            path.join(profile, "Muse-Data"),
          ),
        );
        await app.closeModal();
        assert.equal(await $("composer-brain").inputValue(), "rules");
        return errors;
      },
    );

    await run.step(
      "a v0.2 project: opens on the old engine with its badge, plays, exports; a change makes an engine-2 version",
      async () => {
        const source = legacyProject();
        await $("nav-library").click();
        await $("import-input").setInputFiles(source.file);
        await page.waitForSelector(
          '[data-testid="player-card"][data-engine="1"][data-audio="stems"]',
          { timeout: 60000 },
        );
        await app.idle();
        const legacy = (await app.records()).find(
          (record) => record.config.engine === 1,
        );
        assert.equal(legacy.title, source.project.title);
        assert.equal(legacy.config.seed, source.project.config.seed);
        assert.deepEqual(legacy.config.volumes, source.project.config.volumes);
        assert.match(await $("engine-badge").innerText(), /旧版引擎/);
        assert.match(await $("legacy-note").innerText(), /旧版引擎/);
        assert.equal(
          await $("player-card").getAttribute("data-render-path"),
          "legacy",
        );
        assert.equal(
          await page.locator('[data-testid="section-band"]').count(),
          0,
        );
        const seconds = Number(
          await $("player-card").getAttribute("data-duration"),
        );
        await $("play-button").click();
        await until(position, (value) => value >= 1, "the old engine plays");
        await $("play-button").click();
        await $("export-button").click();
        await $("export-modal").waitFor();
        const wav = wavInfo(await exportTo("mix", "legacy.wav"));
        assert.equal(wav.sampleRate, 32000, "the old engine renders at 32 kHz");
        assert.ok(Math.abs(wav.seconds - seconds) < 0.001);
        assert.ok(wav.rms > 0.004);
        await app.closeModal();
        assert.equal(
          await $("apply-draft").isEnabled(),
          true,
          "an old work can always be redone",
        );
        assert.equal(
          await $("inspector-instrument").locator("option").count(),
          14,
        );
        await $("inspector-instrument").selectOption("guitar");
        await $("apply-draft").click();
        await page.waitForSelector(
          '[data-testid="player-card"][data-engine="2"][data-revision="2"][data-audio="stems"]',
          { timeout: 60000 },
        );
        await app.idle();
        const redone = (await app.records()).find(
          (record) => record.parentId === legacy.id,
        );
        assert.equal(redone.config.engine, 2);
        assert.equal(redone.config.instrument, "guitar");
        assert.equal(redone.config.seed, legacy.config.seed);
        assert.doesNotMatch(await $("engine-badge").innerText(), /旧版/);
        assert.ok(
          (await page.locator('[data-testid="section-band"]').count()) >= 1,
        );
        assert.equal(
          (await app.records()).find((record) => record.id === legacy.id).config
            .engine,
          1,
          "the original stays as it was",
        );
        return { file: path.basename(source.file), legacySeconds: seconds };
      },
    );

    await run.step(
      "简单模式 smoke: a scene, 慢一点 in plain words, 下载音乐 through the save dialog, back to 专业模式",
      async () => {
        await app.openSettings("general");
        await $("mode-simple").click();
        await app.closeModal();
        await $("simple-nav-make").waitFor();
        assert.equal(await $("nav-studio").count(), 0);
        // the loaded work is still there; 重新挑 goes to the scenes
        if (await $("simple-restart").count())
          await $("simple-restart").click();
        await $("simple-make").waitFor();
        assert.equal(await $("scene-card").count(), 12);
        await page
          .locator('[data-testid="scene-card"][data-scene="game"]')
          .click();
        await page.waitForSelector(
          '[data-testid="simple-result"][data-revision="1"][data-audio="stems"]',
          { timeout: 120000 },
        );
        await $("simple-progress").waitFor({
          state: "detached",
          timeout: 120000,
        });
        const id = await $("simple-result").getAttribute("data-project");
        const made = (await app.records()).find((record) => record.id === id);
        assert.equal(made.config.mood, "chiptune");
        assert.equal(made.config.loop, true);
        assert.equal(made.config.duration, 30);
        if ((await $("simple-play").getAttribute("aria-pressed")) === "true")
          await $("simple-play").click();
        await $("tweak-slower").click();
        await page.waitForSelector(
          '[data-testid="simple-result"][data-revision="2"][data-audio="stems"]',
          { timeout: 120000 },
        );
        await $("simple-progress").waitFor({
          state: "detached",
          timeout: 120000,
        });
        const change = await $("simple-change").innerText();
        assert.match(change, /^改好了：节奏慢了/);
        if ((await $("simple-play").getAttribute("aria-pressed")) === "true")
          await $("simple-play").click();
        // 下载音乐: straight to the system's save dialog, named by the title
        const title = await $("simple-title").inputValue();
        const target = file("simple-download.wav");
        const dialogs = (await app.state()).dialogs.length;
        await app.saveTo(target);
        await $("simple-download").click();
        const state = await until(
          app.state,
          (value) => value.dialogs.length > dialogs,
          "the save dialog",
          60000,
        );
        assert.equal(
          path.basename(state.dialogs.at(-1).defaultPath),
          `${title}.wav`,
        );
        await page.waitForSelector(
          '[data-testid="simple-download"]:not([disabled])',
          { timeout: 60000 },
        );
        const wav = wavInfo(fs.readFileSync(target));
        assert.equal(wav.sampleRate, 48000);
        assert.equal(wav.channels, 2);
        assert.ok(wav.seconds > 25, `${wav.seconds} s`);
        await app.toast(/^已保存$/);
        // back to 专业模式: the same work, every version
        await $("pro-mode-link").click();
        await $("nav-studio").waitFor();
        await page.waitForSelector(
          `[data-testid="player-card"][data-revision="2"]`,
        );
        return { change, seconds: +wav.seconds.toFixed(2) };
      },
    );

    await run.step(
      "clean: no renderer errors, no request left the machine",
      async () => {
        const state = await app.state();
        assert.deepEqual(app.errors, []);
        assert.deepEqual(state.denied, [], "Chromium requests");
        assert.deepEqual(state.unknown, []);
        assert.deepEqual(state.loopback, []);
        assert.deepEqual(state.requests, []);
        assert.equal(
          state.warmUps.length,
          1,
          "one warm-up, for the one local model that was saved",
        );
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        );
        assert.equal(overflow, false);
      },
    );
  } catch (error) {
    failure = await describeFailure(app, "ui-smoke");
    if (!error?.reported) console.error(error);
    failure.error = String(error?.cause?.message || error?.message || error);
  } finally {
    if (app) await app.close({ keepProfile: true });
    if (profile) removeProfile(profile, PREFIX);
  }
  process.exitCode = run.finish({
    facts,
    ...(failure.error ? { error: failure.error, failure } : {}),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
