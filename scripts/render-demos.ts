/**
 * render-demos — one representative piece per style, for listening.
 *
 *   npx tsx scripts/render-demos.ts [--out dir] [--seconds n] [--styles a,b] [--seed n]
 *
 *   --out <dir>       where the files go (default: demos/ at the repository root)
 *   --seconds <n>     length of every piece, 15..120 (default 20)
 *   --styles <ids>    comma-separated style ids (default: all 22, in catalogue order)
 *   --seed <n>        the seed every piece is composed from (default 2026)
 *
 * Every piece is a piece that ends (not a loop), played by the style's default
 * lead at the style's default tempo, key and settings. The files are
 *   <nn>-<id>-<中文名>.wav   what the app plays at its default faders:
 *                            softClip(Σ stem × REFERENCE_VOLUMES), 48 kHz 16-bit stereo
 *   index.md                 style, tempo, key, instruments and arrangement notes of each
 *
 *   npx tsx scripts/render-demos.ts --example [dir]
 *
 * writes the example pair kept in examples/: the project JSON exactly as the
 * app exports it (schemaVersion 2, engine 2) and the 30 s WAV the engine
 * renders from it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { integratedLoudness, samplePeak } from "../src/audio/loudness";
import { renderScore } from "../src/audio/render";
import { REFERENCE_VOLUMES } from "../src/audio/render-types";
import type { RenderedAudio, StereoPcm } from "../src/audio/render-types";
import { softClipBuffer } from "../src/audio/softclip";
import { encodeWavFromChannels } from "../src/audio/wav";
import { STYLE_IDS, instrumentLabel, isStyleId, styleInfo, styleLabel } from "../src/music/catalog";
import type { StyleId } from "../src/music/catalog";
import { compose, summarize } from "../src/music/compose";
import { DEFAULT_CONFIG, clampConfig, stylePreset } from "../src/music/defaults";
import { TRACKS } from "../src/music/score";
import type { ArrangementSummary } from "../src/music/score";
import { exportProject } from "../src/storage";
import type { MusicConfig, Project } from "../src/types";

export const DEMO_SEED = 2026;
export const DEMO_SECONDS = 20;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The mix the app plays at its default faders. */
export function demoMix(audio: RenderedAudio): StereoPcm {
  const left = new Float32Array(audio.frames);
  const right = new Float32Array(audio.frames);
  for (const track of TRACKS) {
    const [stemLeft, stemRight] = audio.stems[track];
    const fader = REFERENCE_VOLUMES[track];
    for (let i = 0; i < audio.frames; i++) {
      left[i] += stemLeft[i] * fader;
      right[i] += stemRight[i] * fader;
    }
  }
  softClipBuffer(left);
  softClipBuffer(right);
  return [left, right];
}

/** The demo piece of a style: its preset, a piece that ends, a fixed seed. */
export function demoConfig(style: StyleId, seconds = DEMO_SECONDS, seed = DEMO_SEED): MusicConfig {
  return clampConfig({
    ...DEFAULT_CONFIG,
    ...stylePreset(style),
    prompt: styleInfo(style).description,
    duration: seconds,
    loop: false,
    seed,
    engine: 2,
  });
}

export interface RenderedDemo {
  config: MusicConfig;
  summary: ArrangementSummary;
  wav: ArrayBuffer;
  lufs: number;
  peakDb: number;
  seconds: number;
}

export async function renderDemo(config: MusicConfig): Promise<RenderedDemo> {
  const started = performance.now();
  const score = compose(config);
  const audio = await renderScore(score);
  const [left, right] = demoMix(audio);
  const peak = samplePeak(left, right);
  return {
    config,
    summary: summarize(score),
    wav: encodeWavFromChannels([left, right], audio.sampleRate),
    lufs: integratedLoudness(left, right, audio.sampleRate),
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    seconds: (performance.now() - started) / 1000,
  };
}

/* ------------------------------------------------------------------ */
/* the demo folder                                                     */
/* ------------------------------------------------------------------ */

const fileSafe = (text: string) => text.replace(/[\\/:*?"<>|\s]+/g, "");

export function demoFileName(style: StyleId): string {
  const number = String(STYLE_IDS.indexOf(style) + 1).padStart(2, "0");
  return `${number}-${style}-${fileSafe(styleLabel(style))}.wav`;
}

function indexMarkdown(rows: { style: StyleId; file: string; demo: RenderedDemo }[], seconds: number, seed: number): string {
  const lines: string[] = [
    "# 音序 Muse 风格试听",
    "",
    `每种风格一首约 ${seconds} 秒、有结尾的小曲（非循环），使用该风格的默认主奏乐器、速度与调式，种子 ${seed}。`,
    "文件是应用默认推子下听到的混音（48 kHz / 16 bit 立体声）。重新生成：`npx tsx scripts/render-demos.ts`。",
    "",
    "| 文件 | 风格 | 速度 | 调 | 配器 | 响度 |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const { style, file, demo } of rows)
    lines.push(
      `| [${file}](${encodeURI(file)}) | ${styleLabel(style)}（${style}） | ${Math.round(demo.summary.bpm)} BPM | ${demo.summary.keyLabel} | ${demo.summary.instruments.join("、")} | ${demo.lufs.toFixed(1)} LUFS |`,
    );
  lines.push("", "## 编曲思路", "");
  for (const { style, file, demo } of rows) {
    lines.push(`### ${file.replace(/\.wav$/, "")}`, "");
    lines.push(`主奏：${instrumentLabel(demo.config.instrument)}；能量 ${demo.config.energy}，复杂度 ${demo.config.complexity}，混响 ${demo.config.reverb}。`, "");
    for (const note of demo.summary.notes) lines.push(`- ${note}`);
    lines.push("");
    void style;
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/* ------------------------------------------------------------------ */
/* the example pair                                                    */
/* ------------------------------------------------------------------ */

export const EXAMPLE_TITLE = "晴空漫步";
export const LEGACY_EXAMPLE = "legacy-v0.2-夏日小事.muse.json";

/** The example project: a 30 s piece with an ending in the default style, as the app would have saved it. */
export function exampleProject(): Project {
  const config = clampConfig({
    ...DEFAULT_CONFIG,
    ...stylePreset("bright"),
    prompt: "晴朗的周末早晨出门散步，轻快、明亮，钢琴主旋律，适合日常 Vlog 的片头。",
    duration: 30,
    loop: false,
    seed: 20261009,
    engine: 2,
  });
  return {
    id: "6f1d2c3a-7b4e-4c8d-9a10-2026100900e2",
    title: EXAMPLE_TITLE,
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
    config,
    provider: "local",
    favorite: false,
    revision: 1,
    tags: [styleLabel(config.mood), `${config.bpm} BPM`, instrumentLabel(config.instrument)],
  };
}

async function writeExample(directory: string): Promise<void> {
  mkdirSync(directory, { recursive: true });
  const project = exampleProject();
  const json = exportProject(project);
  const demo = await renderDemo(project.config);
  writeFileSync(join(directory, `${EXAMPLE_TITLE}.muse.json`), `${json}\n`);
  writeFileSync(join(directory, `${EXAMPLE_TITLE}.wav`), new Uint8Array(demo.wav));
  console.log(
    `${EXAMPLE_TITLE}: ${Math.round(demo.summary.bpm)} BPM, ${demo.summary.keyLabel}, ${demo.summary.instruments.join("、")} — ${demo.lufs.toFixed(2)} LUFS, peak ${demo.peakDb.toFixed(1)} dBFS, ${(demo.wav.byteLength / 1e6).toFixed(2)} MB → ${directory}`,
  );
}

/* ------------------------------------------------------------------ */
/* command line                                                        */
/* ------------------------------------------------------------------ */

const USAGE = `npx tsx scripts/render-demos.ts [--out dir] [--seconds n] [--styles a,b] [--seed n]
npx tsx scripts/render-demos.ts --example [dir]

  --out <dir>      output folder (default: demos/ at the repository root)
  --seconds <n>    length of every piece, 15..120 (default ${DEMO_SECONDS})
  --styles <ids>   comma-separated style ids (default: all ${STYLE_IDS.length})
  --seed <n>       seed of every piece (default ${DEMO_SEED})
  --example [dir]  write the example project and its 30 s WAV (default: examples/)`;

async function main(argv: string[]): Promise<void> {
  let out = join(ROOT, "demos");
  let seconds = DEMO_SECONDS;
  let seed = DEMO_SEED;
  let styles: StyleId[] = [...STYLE_IDS];
  let example: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value\n\n${USAGE}`);
      return next;
    };
    if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      return;
    } else if (flag === "--out") out = resolve(value());
    else if (flag === "--seconds") seconds = Number(value());
    else if (flag === "--seed") seed = Number(value());
    else if (flag === "--styles") {
      const ids = value()
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const unknown = ids.filter((id) => !isStyleId(id));
      if (unknown.length) throw new Error(`unknown style: ${unknown.join(", ")} (known: ${STYLE_IDS.join(", ")})`);
      styles = ids as StyleId[];
    } else if (flag === "--example") {
      const next = argv[i + 1];
      example = next !== undefined && !next.startsWith("--") ? resolve(argv[++i]) : join(ROOT, "examples");
    } else throw new Error(`unknown option ${flag}\n\n${USAGE}`);
  }
  if (example) {
    await writeExample(example);
    return;
  }
  if (!(seconds >= 15 && seconds <= 120)) throw new Error("--seconds must be between 15 and 120");
  if (!Number.isFinite(seed)) throw new Error("--seed must be a number");

  mkdirSync(out, { recursive: true });
  const rows: { style: StyleId; file: string; demo: RenderedDemo }[] = [];
  const started = performance.now();
  for (const style of styles) {
    const demo = await renderDemo(demoConfig(style, seconds, seed));
    const file = demoFileName(style);
    writeFileSync(join(out, file), new Uint8Array(demo.wav));
    rows.push({ style, file, demo });
    console.log(
      `${file.padEnd(34)} ${String(Math.round(demo.summary.bpm)).padStart(3)} BPM  ${demo.summary.keyLabel.padEnd(8)} ${demo.lufs.toFixed(2)} LUFS  peak ${demo.peakDb.toFixed(1)} dBFS  ${demo.seconds.toFixed(2)} s`,
    );
  }
  writeFileSync(join(out, "index.md"), indexMarkdown(rows, seconds, seed));
  console.log(`${rows.length} piece(s) and index.md in ${out} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
