// The files in examples/ and the demo renderer: the v0.2 project still opens
// (as an engine-1 work), the engine-2 example is exactly what the app exports
// and its WAV is what the engine renders from it.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEMO_SECONDS,
  DEMO_SEED,
  EXAMPLE_TITLE,
  LEGACY_EXAMPLE,
  demoConfig,
  demoFileName,
  exampleProject,
  renderDemo,
} from "../scripts/render-demos";
import { integratedLoudness } from "../src/audio/loudness";
import { CEILING } from "../src/audio/softclip";
import { WAV_HEADER_BYTES } from "../src/audio/wav";
import { STYLE_IDS, styleInfo, styleLabel } from "../src/music/catalog";
import { compose } from "../src/music/compose";
import { SAMPLE_RATE } from "../src/music/score";
import { scoreProblems } from "../src/music/validate";
import { SCHEMA_VERSION, exportProject, importProject } from "../src/storage";

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");

/** 16-bit PCM WAV → format and channels in -1..1. */
function readWav(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  assert.equal(text(0), "RIFF");
  assert.equal(text(8), "WAVE");
  assert.equal(text(12), "fmt ");
  assert.equal(text(36), "data");
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  assert.equal(view.getUint16(20, true), 1, "PCM");
  assert.equal(dataBytes, bytes.byteLength - WAV_HEADER_BYTES);
  const frames = dataBytes / (channels * (bits / 8));
  const data = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++)
    for (let channel = 0; channel < channels; channel++)
      data[channel][i] = view.getInt16(WAV_HEADER_BYTES + (i * channels + channel) * 2, true) / 32768;
  return { channels, sampleRate, bits, frames, data };
}

test("examples: the folder holds the legacy fixture and exactly one engine-2 pair", () => {
  const files = readdirSync(EXAMPLES).sort();
  assert.deepEqual(files, [LEGACY_EXAMPLE, `${EXAMPLE_TITLE}.muse.json`, `${EXAMPLE_TITLE}.wav`].sort());
});

test("examples: the v0.2 project still imports, as an engine-1 work with its recipe intact", () => {
  const text = readFileSync(join(EXAMPLES, LEGACY_EXAMPLE), "utf8");
  const stored = JSON.parse(text);
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.config.engine, undefined, "v0.2 never wrote the engine field");
  const project = importProject(text);
  assert.equal(project.title, "夏日小事");
  assert.equal(project.provider, "local");
  assert.equal(project.config.engine, 1, "an old work stays on the frozen engine");
  for (const field of ["mood", "bpm", "duration", "key", "instrument", "energy", "complexity", "reverb", "seed", "loop"] as const)
    assert.deepEqual(project.config[field], stored.config[field], field);
  assert.deepEqual(project.config.volumes, stored.config.volumes);
  // importing makes a new work, and exporting it again writes the current schema without changing the engine
  assert.notEqual(project.id, stored.id);
  const again = JSON.parse(exportProject(project));
  assert.equal(again.schemaVersion, SCHEMA_VERSION);
  assert.equal(again.config.engine, 1);
});

test("examples: the engine-2 project is exactly what the app exports, and it composes", () => {
  const text = readFileSync(join(EXAMPLES, `${EXAMPLE_TITLE}.muse.json`), "utf8");
  const project = exampleProject();
  assert.equal(text, `${exportProject(project)}\n`, "regenerate with: npx tsx scripts/render-demos.ts --example");
  const stored = JSON.parse(text);
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.config.engine, 2);
  assert.equal(stored.audioBlob, undefined, "portable JSON never holds audio");
  const imported = importProject(text);
  assert.deepEqual(imported.config, project.config);
  assert.equal(imported.title, EXAMPLE_TITLE);
  const score = compose(imported.config);
  assert.deepEqual(scoreProblems(score, imported.config), []);
  assert.equal(score.duration, 30);
  assert.equal(score.loop, false);
});

test("examples: the WAV is 30 s of 48 kHz 16-bit stereo at the target loudness, and the engine still renders it so", async () => {
  const wav = readWav(readFileSync(join(EXAMPLES, `${EXAMPLE_TITLE}.wav`)));
  assert.deepEqual([wav.channels, wav.sampleRate, wav.bits, wav.frames], [2, SAMPLE_RATE, 16, 30 * SAMPLE_RATE]);
  const lufs = integratedLoudness(wav.data[0], wav.data[1], wav.sampleRate);
  assert.ok(Math.abs(lufs - -16) < 0.3, `the file measures ${lufs.toFixed(2)} LUFS`);
  let peak = 0;
  for (const channel of wav.data) for (const value of channel) peak = Math.max(peak, Math.abs(value));
  assert.ok(peak <= CEILING + 1e-3 && peak > 0.3, `peak ${peak}`);
  assert.equal(wav.data[0][wav.frames - 1], 0);
  // A fresh render is the same music: same length, same loudness, and sample
  // for sample close to the file (not bit-equal across JavaScript engines:
  // their sin/exp/pow may differ in the last place).
  const fresh = await renderDemo(exampleProject().config);
  const again = readWav(new Uint8Array(fresh.wav));
  assert.equal(again.frames, wav.frames);
  assert.ok(Math.abs(fresh.lufs - lufs) < 0.1, `a fresh render measures ${fresh.lufs.toFixed(2)} LUFS`);
  let difference = 0;
  let energy = 0;
  for (let i = 0; i < wav.frames; i++) {
    difference += (again.data[0][i] - wav.data[0][i]) ** 2;
    energy += wav.data[0][i] ** 2;
  }
  assert.ok(difference / energy < 1e-4, `a fresh render differs from the file by ${(10 * Math.log10(difference / energy + 1e-30)).toFixed(1)} dB`);
});

test("demos: one piece per style, named <nn>-<id>-<中文名>.wav, that ends and uses the style's own defaults", async () => {
  const names = STYLE_IDS.map(demoFileName);
  assert.equal(new Set(names).size, STYLE_IDS.length);
  STYLE_IDS.forEach((style, index) => {
    const name = names[index];
    assert.match(name, /^\d{2}-[a-z]+-[^\\/:*?"<>|\s]+\.wav$/);
    assert.ok(name.startsWith(`${String(index + 1).padStart(2, "0")}-${style}-`), name);
    assert.ok(name.includes(styleLabel(style).replace(/\s+/g, "")), name);
    const config = demoConfig(style);
    assert.equal(config.loop, false);
    assert.equal(config.duration, DEMO_SECONDS);
    assert.equal(config.seed, DEMO_SEED);
    assert.equal(config.engine, 2);
    assert.equal(config.mood, style);
    assert.equal(config.instrument, styleInfo(style).instrument);
    assert.equal(config.bpm, styleInfo(style).bpm);
  });
  // one of them, rendered short: a WAV of exactly the asked length at the target loudness
  const demo = await renderDemo(demoConfig("chiptune", 15));
  assert.equal(demo.wav.byteLength, WAV_HEADER_BYTES + 15 * SAMPLE_RATE * 4);
  assert.ok(Math.abs(demo.lufs - -16) < 0.3, `${demo.lufs} LUFS`);
  assert.ok(demo.summary.instruments.length >= 3 && demo.summary.notes.length >= 3);
});

test("demos: the output folder is ignored by git", () => {
  const ignore = readFileSync(join(EXAMPLES, "..", ".gitignore"), "utf8").split(/\r?\n/);
  assert.ok(ignore.includes("demos/"));
  assert.ok(existsSync(join(EXAMPLES, "..", "scripts", "render-demos.ts")));
});
