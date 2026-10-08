// services/generation.ts and services/exporter.ts with a fake engine, bridge and decoder.
import assert from "node:assert/strict";
import test from "node:test";
import { encodeWav, mixStems } from "../src/audio/engine";
import { softClip } from "../src/audio/softclip";
import { DEFAULT_CONFIG } from "../src/music/defaults";
import {
  applyFade,
  buildExport,
  exportChoices,
  exportName,
  exportWork,
  repeatWav,
} from "../src/services/exporter";
import type { ExportDeps } from "../src/services/exporter";
import {
  decodeBlob,
  describeMix,
  normalisePeaks,
  runCloud,
  runLocal,
} from "../src/services/generation";
import type { MixAudio, StemsAudio } from "../src/state/types";
import { exportProject, importProject } from "../src/storage";
import type { MusicConfig, Project } from "../src/types";
import {
  MP3_BYTES,
  STEM_LEVELS,
  buffer,
  installAudioBuffer,
  localProject,
  renderResult,
  stems,
} from "./helpers/app-fakes";
import type { SavedFile } from "./helpers/app-fakes";

installAudioBuffer();

const VOLUMES = { melody: 0.8, chords: 0.5, bass: 1, drums: 0.25 };

function stemsAudio(engine: 1 | 2 = 2, seconds = 0.01): StemsAudio {
  return {
    kind: "stems",
    stems: stems(seconds, engine === 1 ? 32000 : 48000),
    engine,
    peaks: [1],
    stemPeaks: { melody: [1], chords: [1], bass: [1], drums: [1] },
    duration: seconds,
    sampleRate: engine === 1 ? 32000 : 48000,
  };
}

function mixAudio(seconds = 0.5): MixAudio {
  return {
    kind: "mix",
    buffer: buffer(seconds, 0.5),
    peaks: [1],
    duration: seconds,
    sampleRate: 48000,
  };
}

function deps(files: SavedFile[] = []): ExportDeps {
  return {
    mixStems,
    encodeWav,
    exportProject,
    saveFile: async (file) => {
      files.push(file);
      return { saved: true, path: "C:\\out" };
    },
  };
}

const samples = (wav: ArrayBuffer) => new Int16Array(wav.slice(44));
const header = (wav: ArrayBuffer) => {
  const view = new DataView(wav);
  const text = (offset: number) =>
    String.fromCharCode(...new Uint8Array(wav, offset, 4));
  return {
    riff: text(0),
    wave: text(8),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bits: view.getUint16(34, true),
    dataBytes: view.getUint32(40, true),
    riffSize: view.getUint32(4, true),
  };
};
/** 16-bit value of a constant level, within dither. */
const near = (actual: number, level: number) =>
  Math.abs(actual - level * 32768) <= 2;

const cloudProject = (patch: Partial<Project> = {}): Project => ({
  ...localProject("cloud"),
  provider: "tencent",
  audioBlob: new Blob([MP3_BYTES], { type: "audio/mpeg" }),
  cloud: { prompt: "纯音乐" },
  ...patch,
});

/* ---------------- generation ---------------- */

test("runLocal: renders through the injected engine and keeps the engine of the config", async () => {
  const seen: MusicConfig[] = [];
  const progress: number[] = [];
  const render = async (config: MusicConfig, options?: { onProgress?: (value: number) => void }) => {
    seen.push(config);
    options?.onProgress?.(0.25);
    options?.onProgress?.(7);
    return renderResult(config, 0.02);
  };
  const audio = await runLocal(DEFAULT_CONFIG, { onProgress: (value) => progress.push(value) }, { renderMusic: render });
  assert.equal(audio.kind, "stems");
  assert.equal(audio.engine, 2);
  assert.equal(audio.duration, 0.02);
  assert.equal(audio.sampleRate, 48000);
  assert.ok(audio.arrangement);
  assert.deepEqual(progress, [0.25, 1]);
  assert.equal(seen[0], DEFAULT_CONFIG);
  // A v0.2 work goes to the engine untouched (engine 1) and is described as such.
  const legacy = { ...DEFAULT_CONFIG, engine: 1 as const };
  const old = await runLocal(legacy, {}, { renderMusic: render });
  assert.equal(seen[1].engine, 1);
  assert.equal(old.engine, 1);
  assert.equal(old.sampleRate, 32000);
  assert.equal(old.arrangement, undefined);
  // Where the engine says the samples were computed is kept (the player card shows it as data-render-path).
  assert.equal(audio.renderPath, undefined, "a stand-in engine says nothing");
  for (const path of ["worker", "main", "legacy"] as const) {
    const told = await runLocal(DEFAULT_CONFIG, {}, { renderMusic: async (config) => ({ ...renderResult(config, 0.02), diagnostics: { path } }) });
    assert.equal(told.renderPath, path);
  }
  const odd = await runLocal(DEFAULT_CONFIG, {}, { renderMusic: async (config) => ({ ...renderResult(config, 0.02), diagnostics: { path: "gpu" } }) });
  assert.equal("renderPath" in odd, false);
});

test("runLocal: an aborted signal rejects with AbortError and reports no more progress", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    runLocal(DEFAULT_CONFIG, { signal: controller.signal }, { renderMusic: async (config) => ((called = true), renderResult(config)) }),
    { name: "AbortError" },
  );
  assert.equal(called, false);
  // Aborted while rendering: the result is not handed out.
  const second = new AbortController();
  const progress: number[] = [];
  await assert.rejects(
    runLocal(
      DEFAULT_CONFIG,
      { signal: second.signal, onProgress: (value) => progress.push(value) },
      {
        renderMusic: async (config, options) => {
          second.abort();
          options?.onProgress?.(0.9);
          return renderResult(config);
        },
      },
    ),
    { name: "AbortError" },
  );
  assert.deepEqual(progress, []);
  await assert.rejects(
    runLocal(DEFAULT_CONFIG, {}, { renderMusic: async () => ({ ...renderResult(DEFAULT_CONFIG), duration: 0 }) }),
    /没有生成可用的音频/,
  );
});

test("runCloud: the paid bytes are stored before anything is decoded", async () => {
  const order: string[] = [];
  let stored: Blob | undefined;
  const result = await runCloud(
    { provider: "tencent", prompt: "纯音乐，无人声", duration: 30 },
    {
      onReceived: () => order.push("received"),
      persist: async ({ blob, mimeType, format }) => {
        order.push(`persist:${mimeType}:${format}`);
        stored = blob;
        return true;
      },
      onDecoding: () => order.push("decoding"),
    },
    {
      generateMusic: async (input) => {
        order.push(`generate:${input.provider}:${input.duration}:${input.prompt}`);
        return { audio: MP3_BYTES.slice().buffer, mimeType: "audio/mpeg" };
      },
      decode: async (data) => {
        order.push(`decode:${data.byteLength}`);
        return buffer(1.5, 0.5);
      },
      mixPeaks: () => [0.2, 0.4],
    },
  );
  assert.deepEqual(order, [
    "generate:tencent:30:纯音乐，无人声",
    "received",
    "persist:audio/mpeg:mp3",
    "decoding",
    `decode:${MP3_BYTES.length}`,
  ]);
  assert.equal(result.saved, true);
  assert.equal(result.format, "mp3");
  assert.equal(result.audio?.duration, 1.5, "the actual duration, not the requested one");
  assert.deepEqual(result.audio?.peaks, [0.5, 1]);
  assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), MP3_BYTES);
  assert.equal(stored, result.blob);
  assert.equal(result.blob.type, "audio/mpeg");
});

test("runCloud: undecodable audio is still returned, saved and exportable (APP-05)", async () => {
  let persisted = 0;
  const result = await runCloud(
    { provider: "aliyun", prompt: "x", duration: 30 },
    { persist: async () => (persisted++, true) },
    {
      generateMusic: async () => ({ audio: MP3_BYTES.slice().buffer, mimeType: "audio/x-unknown" }),
      decode: async () => {
        throw new DOMException("Unable to decode audio data", "EncodingError");
      },
    },
  );
  assert.equal(persisted, 1);
  assert.equal(result.saved, true);
  assert.equal(result.audio, null);
  assert.ok(result.decodeError);
  assert.equal(result.format, null, "an unknown MIME type is not an exception");
  assert.equal(result.blob.size, MP3_BYTES.length);
});

test("runCloud: a failed save does not lose the audio; a cancelled job skips decoding", async () => {
  let decodes = 0;
  const base = {
    generateMusic: async () => ({ audio: MP3_BYTES.slice().buffer, mimeType: "audio/mpeg" }),
    decode: async () => (decodes++, buffer(1, 0.1)),
  };
  const unsaved = await runCloud(
    { provider: "tencent", prompt: "x", duration: 30 },
    {
      persist: async () => {
        throw new Error("QuotaExceededError");
      },
    },
    base,
  );
  assert.equal(unsaved.saved, false);
  assert.ok(unsaved.audio, "still decoded and playable");
  const refused = await runCloud({ provider: "tencent", prompt: "x", duration: 30 }, { persist: async () => false }, base);
  assert.equal(refused.saved, false);

  decodes = 0;
  const order: string[] = [];
  const late = await runCloud(
    { provider: "tencent", prompt: "x", duration: 30 },
    { persist: async () => (order.push("persist"), true), wanted: () => false, onDecoding: () => order.push("decoding") },
    base,
  );
  assert.deepEqual(order, ["persist"], "kept, but not decoded");
  assert.equal(decodes, 0);
  assert.equal(late.saved, true);
  assert.equal(late.audio, null);
  assert.equal(late.decodeError, null);
});

test("runCloud: no audio from the service is an error and nothing is stored", async () => {
  let persisted = 0;
  const hooks = { persist: async () => (persisted++, true) };
  const decode = async () => buffer(1, 0.1);
  await assert.rejects(
    runCloud({ provider: "tencent", prompt: "x", duration: 30 }, hooks, {
      generateMusic: async () => ({ audio: new ArrayBuffer(0), mimeType: "audio/mpeg" }),
      decode,
    }),
    /没有返回音频/,
  );
  await assert.rejects(
    runCloud({ provider: "tencent", prompt: "x", duration: 30 }, hooks, {
      generateMusic: async () => {
        throw new Error("API Key 无效或已过期，请在设置中更新密钥。");
      },
      decode,
    }),
    /API Key 无效/,
  );
  assert.equal(persisted, 0);
});

test("decodeBlob and describeMix", async () => {
  const blob = new Blob([MP3_BYTES], { type: "audio/mpeg" });
  let received = 0;
  const audio = await decodeBlob(blob, {
    decode: async (data) => ((received = data.byteLength), buffer(2, 0.3)),
    mixPeaks: () => [0, 0.3, 0.15],
  });
  assert.equal(received, MP3_BYTES.length);
  assert.equal(audio.duration, 2);
  assert.deepEqual(audio.peaks, [0, 1, 0.5]);
  await assert.rejects(decodeBlob(new Blob([]), { decode: async () => buffer(1, 0) }), /空的/);
  assert.throws(() => describeMix(buffer(0, 0), () => []), /音频内容为空/);
  assert.deepEqual(normalisePeaks([0, 0]), [0, 0]);
});

/* ---------------- export ---------------- */

test("full mix = softClip(Σ stem × committed fader), at the audio's own rate", async () => {
  const project = localProject("p1", {}, { volumes: VOLUMES, loop: false });
  const file = await buildExport(project, stemsAudio(), { kind: "mix" }, deps());
  assert.equal(file.format, "wav");
  assert.equal(file.name, "夏日小事");
  const info = header(file.data);
  assert.deepEqual([info.riff, info.wave, info.channels, info.sampleRate, info.bits], ["RIFF", "WAVE", 2, 48000, 16]);
  assert.equal(info.dataBytes, 480 * 2 * 2);
  const expected = softClip(
    STEM_LEVELS.melody * 0.8 + STEM_LEVELS.chords * 0.5 + STEM_LEVELS.bass * 1 + STEM_LEVELS.drums * 0.25,
  );
  const pcm = samples(file.data);
  assert.ok(near(pcm[0], expected) && near(pcm[1], -expected), `${pcm[0]} vs ${expected * 32768}`);
  assert.ok(near(pcm[pcm.length - 2], expected));
});

test("export ignores everything about playback — there is no solo parameter (APP-01)", async () => {
  const project = localProject("p1", {}, { volumes: VOLUMES });
  const audio = stemsAudio();
  const full = await buildExport(project, audio, { kind: "mix" }, deps());
  const again = await buildExport(project, audio, { kind: "mix" }, deps());
  assert.deepEqual(new Uint8Array(full.data), new Uint8Array(again.data), "reproducible");
  const drums = await buildExport(project, audio, { kind: "stem", track: "drums" }, deps());
  assert.equal(drums.name, "夏日小事-鼓组");
  const pcm = samples(drums.data);
  assert.ok(near(pcm[0], softClip(STEM_LEVELS.drums * 0.25)), "one stem at its fader");
  assert.notDeepEqual(new Uint8Array(full.data), new Uint8Array(drums.data));
  // A muted stem exports as digital silence rather than as the full mix.
  const muted = localProject("p1", {}, { volumes: { ...VOLUMES, drums: 0 } });
  const silent = samples((await buildExport(muted, audio, { kind: "stem", track: "drums" }, deps())).data);
  assert.ok(silent.every((value) => value === 0));
  await assert.rejects(buildExport(project, audio, { kind: "stem", track: "vocals" as never }, deps()), /没有这条音轨/);
});

test("loop works: 循环次数 repeats the audio sample-exactly, without gaps", async () => {
  const loop = localProject("p1", { revision: 3 }, { loop: true, volumes: VOLUMES });
  const audio = stemsAudio(2, 0.005);
  // Give the loop a recognisable shape: a ramp in the melody stem.
  const melody = audio.stems.melody.getChannelData(0);
  for (let i = 0; i < melody.length; i++) melody[i] = (i / melody.length) * 0.5;
  const once = await buildExport(loop, audio, { kind: "mix", repeats: 1 }, deps());
  const four = await buildExport(loop, audio, { kind: "mix", repeats: 4 }, deps());
  assert.equal(once.name, "夏日小事 v3");
  assert.equal(four.name, "夏日小事 v3-循环x4");
  const single = new Uint8Array(once.data.slice(44));
  const repeated = new Uint8Array(four.data.slice(44));
  assert.equal(repeated.length, single.length * 4);
  for (let part = 0; part < 4; part++)
    assert.deepEqual(repeated.slice(part * single.length, (part + 1) * single.length), single, `repeat ${part}`);
  const info = header(four.data);
  assert.equal(info.dataBytes, single.length * 4);
  assert.equal(info.riffSize, 36 + single.length * 4);
  assert.equal(info.sampleRate, 48000);
  // Non-loop works do not repeat, whatever is asked; invalid counts fall back to 1.
  const ending = localProject("p1", {}, { loop: false, volumes: VOLUMES });
  const plain = await buildExport(ending, audio, { kind: "mix", repeats: 4 }, deps());
  assert.equal(plain.data.byteLength, once.data.byteLength);
  assert.equal(plain.name, "夏日小事");
  const odd = await buildExport(loop, audio, { kind: "mix", repeats: 3 as never }, deps());
  assert.equal(odd.data.byteLength, once.data.byteLength);
  assert.equal(repeatWav(once.data, 1), once.data);
  assert.throws(() => repeatWav(new ArrayBuffer(44 + 100 * 1024 * 1024), 4), /文件过大/);
});

test("a WAV export pauses for the interface before each heavy step, and gives the same bytes", async () => {
  const loop = localProject("p1", {}, { loop: true, volumes: VOLUMES });
  const audio = stemsAudio(2, 0.005);
  const log: string[] = [];
  const traced: ExportDeps = {
    ...deps(),
    mixStems: (...args) => {
      log.push("mix");
      return mixStems(...args);
    },
    encodeWav: (buffer) => {
      log.push("encode");
      return encodeWav(buffer);
    },
    breathe: async () => {
      log.push("breathe");
    },
  };
  const once = await buildExport(loop, audio, { kind: "mix" }, traced);
  assert.deepEqual(log, ["breathe", "mix", "breathe", "encode"]);
  log.length = 0;
  const four = await buildExport(loop, audio, { kind: "mix", repeats: 4 }, traced);
  assert.deepEqual(log, ["breathe", "mix", "breathe", "encode", "breathe"]);
  log.length = 0;
  const stem = await buildExport(loop, audio, { kind: "stem", track: "bass" }, traced);
  assert.deepEqual(log, ["breathe", "mix", "breathe", "encode"]);
  log.length = 0;
  await buildExport(loop, audio, { kind: "project" }, traced);
  await buildExport(cloudProject(), mixAudio(), { kind: "original" }, traced);
  assert.deepEqual(log, [], "nothing heavy in a recipe or in stored bytes");
  // Pausing changes nothing in the file.
  assert.deepEqual(new Uint8Array(once.data), new Uint8Array((await buildExport(loop, audio, { kind: "mix" }, deps())).data));
  assert.equal(four.data.byteLength, 44 + (once.data.byteLength - 44) * 4);
  assert.deepEqual(new Uint8Array(stem.data), new Uint8Array((await buildExport(loop, audio, { kind: "stem", track: "bass" }, deps())).data));
  // A pause that fails stops the export instead of handing over half a file.
  await assert.rejects(
    buildExport(loop, audio, { kind: "mix" }, { ...traced, breathe: async () => { throw new Error("页面已关闭"); } }),
    /页面已关闭/,
  );
});

test("the v0.2 fade is offered only for engine-1 and cloud works that do not loop", async () => {
  const local = localProject("p1", {}, { loop: false });
  assert.equal(exportChoices(local, stemsAudio(2)).canFade, false, "engine 2 writes its own ending");
  assert.equal(exportChoices(local, stemsAudio(1)).canFade, true);
  assert.equal(exportChoices(localProject("p", {}, { loop: true }), stemsAudio(1)).canFade, false);
  assert.equal(exportChoices(cloudProject({ config: { ...DEFAULT_CONFIG, loop: false } }), mixAudio()).canFade, true);
  assert.equal(exportChoices(localProject("p", {}, { loop: true }), stemsAudio(2)).canRepeat, true);
  assert.equal(exportChoices(local, stemsAudio(2)).canRepeat, false);
  assert.equal(exportChoices(cloudProject(), mixAudio()).canRepeat, false);

  const legacy = localProject("old", {}, { engine: 1, loop: false, volumes: VOLUMES });
  const audio = stemsAudio(1, 0.3);
  const faded = samples((await buildExport(legacy, audio, { kind: "mix", fade: true }, deps())).data);
  const plain = samples((await buildExport(legacy, audio, { kind: "mix" }, deps())).data);
  assert.equal(header((await buildExport(legacy, audio, { kind: "mix" }, deps())).data).sampleRate, 32000);
  assert.equal(faded[0], 0);
  assert.equal(faded[faded.length - 2], 0);
  const middle = Math.floor(faded.length / 4) * 2;
  assert.ok(Math.abs(faded[middle] - plain[middle]) <= 2, "untouched in the middle");
  assert.ok(Math.abs(plain[0]) > 1000);
  // Ignored where it does not apply.
  const modern = localProject("new", {}, { loop: false, volumes: VOLUMES });
  const kept = samples((await buildExport(modern, stemsAudio(2), { kind: "mix", fade: true }, deps())).data);
  assert.ok(Math.abs(kept[0]) > 1000);
  // The decoded cloud buffer itself is never modified by an export.
  const mix = mixAudio(0.3);
  await buildExport(cloudProject({ config: { ...DEFAULT_CONFIG, loop: false } }), mix, { kind: "mix", fade: true }, deps());
  assert.equal(mix.buffer.getChannelData(0)[0], 0.5);
  const tiny = buffer(0.0001, 0.5);
  applyFade(tiny);
  assert.ok(tiny.getChannelData(0).every(Number.isFinite));
});

test("cloud works: original bytes exactly, no stems, no project JSON", async () => {
  const project = cloudProject({ title: "云端 / 作品" });
  const choices = exportChoices(project, mixAudio());
  assert.deepEqual(choices.options.map((option) => option.id), ["mix", "original"]);
  const original = await buildExport(project, mixAudio(), { kind: "original" }, deps());
  assert.equal(original.format, "mp3");
  assert.deepEqual(new Uint8Array(original.data), MP3_BYTES);
  assert.equal(original.name, "云端 / 作品", "sanitising is saveFile's job");
  await assert.rejects(buildExport(project, mixAudio(), { kind: "stem", track: "drums" }, deps()), /没有分轨/);
  await assert.rejects(buildExport(project, mixAudio(), { kind: "project" }, deps()), /不包含音频/);
  // Decoding failed: the original file is still there, a WAV is not.
  const undecoded = exportChoices(project, null);
  assert.deepEqual(undecoded.options.map((option) => option.id), ["original"]);
  assert.equal((await buildExport(project, null, { kind: "original" }, deps())).data.byteLength, MP3_BYTES.length);
  await assert.rejects(buildExport(project, null, { kind: "mix" }, deps()), /还没有准备好/);
  // A Blob with a type this build cannot name does not break the dialog.
  const odd = cloudProject({ audioBlob: new Blob([MP3_BYTES], { type: "audio/ogg" }) });
  assert.match(exportChoices(odd, mixAudio()).options[1].detail, /未知格式/);
  await assert.rejects(buildExport(odd, mixAudio(), { kind: "original" }, deps()), /请改为导出 WAV/);
  await assert.rejects(buildExport(localProject("p"), stemsAudio(), { kind: "original" }, deps()), /没有可导出的原始音频/);
});

test("local works: options in order, and the project JSON can be imported again", async () => {
  const project = localProject("p1", { chat: [{ id: "u1", role: "user", text: "夏日", at: "2026-10-01T08:00:00.000Z" }] });
  const choices = exportChoices(project, stemsAudio());
  assert.deepEqual(
    choices.options.map((option) => option.id),
    ["mix", "stem-melody", "stem-chords", "stem-bass", "stem-drums", "project"],
  );
  assert.deepEqual(exportChoices(null, null).options, []);
  const files: SavedFile[] = [];
  const result = await exportWork(project, stemsAudio(), { kind: "project" }, deps(files));
  assert.deepEqual(result, { saved: true, path: "C:\\out", name: "夏日小事" });
  assert.equal(files[0].format, "json");
  const text = new TextDecoder().decode(files[0].data);
  const parsed = JSON.parse(text) as { schemaVersion: number; audioBlob?: unknown };
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.audioBlob, undefined);
  const back = importProject(text);
  assert.deepEqual(back.config, project.config);
  assert.equal(back.chat?.length, 1);
  assert.notEqual(back.id, project.id);
  assert.equal(exportName(localProject("p", { revision: 2 }), { kind: "stem", track: "bass" }), "夏日小事 v2-贝斯");
});
