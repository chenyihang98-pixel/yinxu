// WAV exports built in the render worker: the same bytes as on the calling
// thread, the same bytes as before the worker path existed, and a clean
// fall-back whenever the worker cannot take the job.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import { Worker as ThreadWorker } from "node:worker_threads";
import {
  configureEngine,
  encodeWav,
  engineStatus,
  mixStems,
  mixdownInWorker,
  prewarm,
  renderMusic,
} from "../src/audio/engine";
import type { MixdownSource, WorkerLike } from "../src/audio/engine";
import { mixdownToWav } from "../src/audio/mixdown";
import type {
  MixdownJob,
  WorkerRequest,
  WorkerResponse,
} from "../src/audio/render-types";
import { attachWorker } from "../src/audio/worker";
import type { WorkerScope } from "../src/audio/worker";
import { DEFAULT_CONFIG } from "../src/music/defaults";
import { TRACKS } from "../src/music/score";
import { buildExport, exportWork } from "../src/services/exporter";
import type { ExportDeps } from "../src/services/exporter";
import { runLocal } from "../src/services/generation";
import type { ExportRequest, LoadedAudio } from "../src/state/types";
import { exportProject } from "../src/storage";
import type { Project, TrackName } from "../src/types";
import { installAudioBuffer, localProject } from "./helpers/app-fakes";

installAudioBuffer();
after(() => configureEngine());

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sha = (data: ArrayBuffer) =>
  createHash("sha256").update(new Uint8Array(data)).digest("hex");

/** Deterministic noise in ±amplitude (xorshift32), different per seed. */
function noise(length: number, seed: number, amplitude: number): Float32Array {
  const out = new Float32Array(length);
  let state = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = ((state / 4294967296) * 2 - 1) * amplitude;
  }
  return out;
}

function noiseBuffer(frames: number, sampleRate: number, seed: number, amplitude: number, channels = 2): AudioBuffer {
  const buffer = new AudioBuffer({ length: frames, numberOfChannels: channels, sampleRate });
  for (let channel = 0; channel < channels; channel++)
    buffer.getChannelData(channel).set(noise(frames, seed * 7 + channel + 1, amplitude));
  return buffer;
}

function noiseStems(frames: number, sampleRate: number, amplitude: number): Record<TrackName, AudioBuffer> {
  return Object.fromEntries(
    TRACKS.map((track, index) => [track, noiseBuffer(frames, sampleRate, 100 + index, amplitude)]),
  ) as Record<TrackName, AudioBuffer>;
}

const VOLUMES = { melody: 0.8, chords: 0.5, bass: 1, drums: 0.25 };

function stemsAudio(engine: 1 | 2, frames: number, amplitude: number): LoadedAudio {
  const sampleRate = engine === 1 ? 32000 : 48000;
  return {
    kind: "stems",
    stems: noiseStems(frames, sampleRate, amplitude),
    engine,
    peaks: [1],
    stemPeaks: { melody: [1], chords: [1], bass: [1], drums: [1] },
    duration: frames / sampleRate,
    sampleRate,
  };
}
function fileAudio(frames: number, channels: number): LoadedAudio {
  return { kind: "mix", buffer: noiseBuffer(frames, 44100, 9, 0.9, channels), peaks: [1], duration: frames / 44100, sampleRate: 44100 };
}
const local = (patch: Partial<Project["config"]>, engine: 1 | 2 = 2): Project => ({
  ...localProject("p"),
  config: { ...DEFAULT_CONFIG, volumes: VOLUMES, engine, ...patch },
});
const cloud = (loop: boolean): Project => ({
  ...localProject("c"),
  provider: "tencent",
  audioBlob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }),
  cloud: { prompt: "纯音乐" },
  config: { ...DEFAULT_CONFIG, loop },
});

interface Case {
  name: string;
  project: Project;
  audio: () => LoadedAudio;
  request: ExportRequest;
  bytes: number;
  /** SHA-256 of the file as the in-thread exporter built it before the worker path existed */
  sha256: string;
}

/**
 * Recorded with .scratch/followups/export-golden.ts on the exporter as it was
 * before this change (mixStems + applyFade + encodeWav on the calling thread).
 * The noise is hot enough to drive the soft clipper and the v0.2 peak scaling.
 */
const CASES: Case[] = [
  { name: "engine 2 mix", project: local({ loop: true }), audio: () => stemsAudio(2, 48000, 0.6), request: { kind: "mix" }, bytes: 192044, sha256: "8c7eead336dd34a1bc1d76901dfdafc39bef90b0c2daa7d20f00296f006bba2a" },
  { name: "engine 2 mix, repeated 4 times", project: local({ loop: true }), audio: () => stemsAudio(2, 4801, 0.6), request: { kind: "mix", repeats: 4 }, bytes: 76860, sha256: "d5ec7364c24ffb128418b0e2e63946b003fd62d4eaadb8979b6d7090ce7fb798" },
  { name: "engine 2 stem", project: local({ loop: true }), audio: () => stemsAudio(2, 48000, 0.95), request: { kind: "stem", track: "bass" }, bytes: 192044, sha256: "b86cd9d9f4eafa280ca321abd8e3635fda8c1ef605de4e67236e127f970e45df" },
  { name: "engine 2 mix with a muted track", project: local({ loop: false, volumes: { ...VOLUMES, chords: 0 } }), audio: () => stemsAudio(2, 12345, 0.6), request: { kind: "mix" }, bytes: 49424, sha256: "c2dd32c26e2df29a74b0cb298980101363863065a843661d0ad1861159ef949b" },
  { name: "engine 1 mix, scaled", project: local({ loop: false }, 1), audio: () => stemsAudio(1, 32000, 0.9), request: { kind: "mix" }, bytes: 128044, sha256: "c1fb41c54ddd310b800869ff47039c21ad542e1fe315003f957f4e172955dce1" },
  { name: "engine 1 mix, quiet, faded", project: local({ loop: false }, 1), audio: () => stemsAudio(1, 64000, 0.2), request: { kind: "mix", fade: true }, bytes: 256044, sha256: "963c961bc1f729a94a70fe24d65f7464522274f1b7f9365d397e777f97e7d8d6" },
  { name: "engine 1 stem", project: local({ loop: false }, 1), audio: () => stemsAudio(1, 32000, 0.9), request: { kind: "stem", track: "melody" }, bytes: 128044, sha256: "61b72b9576444141c3bd56bec82be2c8a983be1bc0f7b4b3d329098f32bf8bea" },
  { name: "decoded stereo file", project: cloud(true), audio: () => fileAudio(44100, 2), request: { kind: "mix" }, bytes: 176444, sha256: "33ca0c3545a6e0359c19340cc9e79992a944d155187406a9c8b832534396ee93" },
  { name: "decoded stereo file, faded", project: cloud(false), audio: () => fileAudio(50000, 2), request: { kind: "mix", fade: true }, bytes: 200044, sha256: "bafa750b78390ce39f63a88395e4ddab06b9412ec14bb72a1c823f2e9817780d" },
  { name: "decoded mono file, faded", project: cloud(false), audio: () => fileAudio(20000, 1), request: { kind: "mix", fade: true }, bytes: 40044, sha256: "b69abd41aef6d28410aec84be5610d4647786e8d851757f07a71fed2a575d6bc" },
];

type Counted = Pick<ExportDeps, "mixStems" | "encodeWav" | "exportProject" | "mixdown"> & {
  calls: { mix: number; encode: number; worker: number; taken: number };
};

/** The real exporter dependencies, counting which path built the file. */
function counted(mixdown?: ExportDeps["mixdown"]): Counted {
  const calls = { mix: 0, encode: 0, worker: 0, taken: 0 };
  return {
    calls,
    exportProject,
    mixStems: (...args) => (calls.mix++, mixStems(...args)),
    encodeWav: (buffer) => (calls.encode++, encodeWav(buffer)),
    ...(mixdown
      ? {
          mixdown: async (source, fade) => {
            calls.worker++;
            const wav = await mixdown(source, fade);
            if (wav) calls.taken++;
            return wav;
          },
        }
      : {}),
  };
}

function hashAudio(audio: LoadedAudio): string {
  const hash = createHash("sha256");
  const buffers = audio.kind === "stems" ? TRACKS.map((track) => audio.stems[track]) : [audio.buffer];
  for (const buffer of buffers)
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      hash.update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
  return hash.digest("hex");
}

/* ------------------------------------------------------------------ */
/* the calling thread                                                  */
/* ------------------------------------------------------------------ */

test("in-thread export: byte for byte what it was before the worker path existed", async () => {
  for (const item of CASES) {
    const deps = counted();
    const file = await buildExport(item.project, item.audio(), item.request, deps);
    assert.equal(file.data.byteLength, item.bytes, item.name);
    assert.equal(sha(file.data), item.sha256, item.name);
    assert.equal(deps.calls.encode, 1, item.name);
  }
});

test("mixdownToWav is encodeWav(mixStems(…)) on plain arrays", () => {
  const stems = noiseStems(9000, 48000, 0.7);
  const copies = (track: TrackName) => [0, 1].map((channel) => stems[track].getChannelData(channel).slice());
  const job = (finish: MixdownJob["finish"], tracks: TrackName[], fade = false): MixdownJob => ({
    sampleRate: 48000,
    frames: 9000,
    sources: tracks.map((track) => ({ channels: copies(track), gain: VOLUMES[track] })),
    finish,
    fade,
  });
  assert.equal(sha(mixdownToWav(job("softclip", [...TRACKS]))), sha(encodeWav(mixStems(stems, VOLUMES, 2))));
  assert.equal(sha(mixdownToWav(job("legacy", [...TRACKS]))), sha(encodeWav(mixStems(stems, VOLUMES, 1))));
  assert.equal(sha(mixdownToWav(job("softclip", ["drums"]))), sha(encodeWav(mixStems(stems, VOLUMES, 2, "drums"))));
  // a stem at fader 0 may be listed or left out: the sum is the same
  const muted = { ...VOLUMES, bass: 0 };
  const listed = job("softclip", [...TRACKS]);
  listed.sources[2].gain = 0;
  assert.equal(sha(mixdownToWav(listed)), sha(encodeWav(mixStems(stems, muted, 2))));
  assert.equal(sha(mixdownToWav(job("softclip", ["melody", "chords", "drums"]))), sha(encodeWav(mixStems(stems, muted, 2))));
  // nothing audible at all is digital silence, at the right length
  const silent = new Int16Array(mixdownToWav({ sampleRate: 48000, frames: 9000, sources: [], finish: "softclip", fade: false }).slice(44));
  assert.equal(silent.length, 18000);
  assert.ok(silent.every((value) => value === 0));
  // a mono stem feeds both sides, as in mixStems
  const mono = { ...stems, melody: noiseBuffer(9000, 48000, 3, 0.5, 1) };
  const monoJob = job("softclip", [...TRACKS]);
  monoJob.sources[0].channels = [mono.melody.getChannelData(0).slice()];
  assert.equal(sha(mixdownToWav(monoJob)), sha(encodeWav(mixStems(mono, VOLUMES, 2))));
  // a decoded file is encoded as it is, with its own channel count
  for (const channels of [1, 2]) {
    const file = noiseBuffer(7000, 44100, 5, 0.9, channels);
    const source = Array.from({ length: channels }, (_unused, channel) => file.getChannelData(channel).slice());
    assert.equal(
      sha(mixdownToWav({ sampleRate: 44100, frames: 7000, sources: [{ channels: source, gain: 1 }], finish: "none", fade: false })),
      sha(encodeWav(file)),
      `${channels} channel(s)`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* the worker                                                          */
/* ------------------------------------------------------------------ */

interface Posted {
  type: WorkerRequest["type"];
  transferred: number;
  /** the copies no longer belong to this thread once the message is on its way */
  detached: boolean;
}

/** src/audio/worker.ts on a real thread, behind the Worker interface the engine uses. */
function threadWorker(): WorkerLike & { thread: ThreadWorker; posted: Posted[] } {
  const thread = new ThreadWorker(new URL("./fixtures/engine-worker.node.ts", import.meta.url));
  const like: WorkerLike & { thread: ThreadWorker; posted: Posted[] } = {
    thread,
    posted: [],
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (message, transfer = []) => {
      thread.postMessage(message, transfer as ArrayBuffer[]);
      like.posted.push({
        type: message.type,
        transferred: transfer.length,
        detached:
          message.type === "mixdown" &&
          message.job.sources.every((entry) => entry.channels.every((data) => data.byteLength === 0)),
      });
    },
    terminate: () => void thread.terminate(),
  };
  thread.on("message", (data: WorkerResponse | { type: "probe" }) => {
    if (data.type !== "probe") like.onmessage?.({ data });
  });
  thread.on("error", (error) => like.onerror?.(error));
  return like;
}

async function ready(): Promise<void> {
  prewarm();
  for (let i = 0; i < 2000 && engineStatus().worker !== "ready"; i++) await sleep(5);
  assert.equal(engineStatus().worker, "ready");
}

test("worker export: the same bytes as in-thread, built on another thread from transferred copies", async () => {
  const made: ReturnType<typeof threadWorker>[] = [];
  configureEngine({ createWorker: () => (made.push(threadWorker()), made[made.length - 1]), startupTimeoutMs: 60_000 });
  await ready();
  for (const item of CASES) {
    const audio = item.audio();
    const before = hashAudio(audio);
    const deps = counted(mixdownInWorker);
    const file = await buildExport(item.project, audio, item.request, deps);
    assert.equal(sha(file.data), item.sha256, item.name);
    assert.equal(file.data.byteLength, item.bytes, item.name);
    assert.deepEqual(deps.calls, { mix: 0, encode: 0, worker: 1, taken: 1 }, `${item.name}: built by the worker alone`);
    assert.equal(hashAudio(audio), before, `${item.name}: the work's own samples are untouched`);
    const sent = made[0].posted[made[0].posted.length - 1];
    assert.equal(sent.type, "mixdown", item.name);
    assert.ok(sent.transferred >= 1 && sent.detached, `${item.name}: ${JSON.stringify(sent)}`);
  }
  assert.equal(made.length, 1, "one warm worker served every export");
  assert.equal(engineStatus().pending, 0);

  // only what is audible is copied: 2 channels for one stem, 6 when one of four faders is at 0, 1 for a mono file
  const transferred = (index: number) => made[0].posted.filter((entry) => entry.type === "mixdown")[index].transferred;
  assert.deepEqual(CASES.map((_item, index) => transferred(index)), [8, 8, 2, 6, 8, 8, 2, 2, 2, 1]);

  // exports and renders share the worker and take turns; neither disturbs the other
  const config = { ...DEFAULT_CONFIG, duration: 15 };
  const reference = await renderMusic(config);
  assert.equal(reference.diagnostics.path, "worker");
  const again = CASES[0];
  const [file, rendered] = await Promise.all([
    buildExport(again.project, again.audio(), again.request, counted(mixdownInWorker)),
    renderMusic(config),
  ]);
  assert.equal(sha(file.data), again.sha256);
  assert.equal(rendered.diagnostics.path, "worker");
  for (const track of TRACKS)
    assert.deepEqual(rendered.stems[track].getChannelData(0), reference.stems[track].getChannelData(0), track);
  assert.equal(made.length, 1);
  configureEngine();
  await sleep(20);
});

test("worker export of a real render: what the app exports is the same file on either path", async () => {
  const made: ReturnType<typeof threadWorker>[] = [];
  configureEngine({ createWorker: () => (made.push(threadWorker()), made[made.length - 1]), startupTimeoutMs: 60_000 });
  const config = { ...DEFAULT_CONFIG, duration: 15, loop: true };
  const audio = await runLocal(config, {});
  assert.equal(audio.renderPath, "worker");
  const project: Project = { ...localProject("real"), config };
  const saved: ArrayBuffer[] = [];
  const save: ExportDeps["saveFile"] = async (file) => (saved.push(file.data), { saved: true });
  for (const request of [{ kind: "mix" }, { kind: "mix", repeats: 2 }, { kind: "stem", track: "melody" }] as ExportRequest[]) {
    const worker = { ...counted(mixdownInWorker), saveFile: save };
    const here = { ...counted(), saveFile: save };
    assert.equal((await exportWork(project, audio, request, worker)).saved, true);
    assert.equal((await exportWork(project, audio, request, here)).saved, true);
    assert.equal(worker.calls.taken, 1, JSON.stringify(request));
    assert.equal(here.calls.encode, 1, JSON.stringify(request));
    const [fromWorker, fromHere] = saved.splice(0);
    assert.ok(fromWorker.byteLength > 44 + 15 * 48000 * 4 - 1);
    assert.equal(sha(fromWorker), sha(fromHere), JSON.stringify(request));
  }
  configureEngine();
  await sleep(20);
});

/* ------------------------------------------------------------------ */
/* falling back                                                        */
/* ------------------------------------------------------------------ */

/** A worker that serves the real protocol on this thread, or misbehaves on a mixdown. */
class ScriptedWorker implements WorkerLike {
  onmessage: ((event: { data: WorkerResponse }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  terminated = false;
  readonly requests: WorkerRequest["type"][] = [];
  private handler: ((event: { data: WorkerRequest }) => void) | null = null;

  constructor(readonly onMixdown: "serve" | "error" | "crash" | "silent" | "throw") {
    const assign = (handler: typeof this.handler) => (this.handler = handler);
    const emit = (message: WorkerResponse) => this.emit(message);
    const scope: WorkerScope = {
      postMessage: emit,
      get onmessage(): WorkerScope["onmessage"] {
        return null;
      },
      set onmessage(handler) {
        assign(handler);
      },
    };
    attachWorker(scope);
  }

  private emit(message: WorkerResponse) {
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: message });
    }, 0);
  }

  postMessage(message: WorkerRequest) {
    this.requests.push(message.type);
    if (this.terminated) return;
    if (message.type !== "mixdown" || this.onMixdown === "serve") {
      setTimeout(() => this.handler?.({ data: message }), 0);
      return;
    }
    if (this.onMixdown === "throw") throw new DOMException("could not be cloned", "DataCloneError");
    if (this.onMixdown === "error") this.emit({ type: "error", id: message.id, message: "内存不足，无法生成这么长的音频" });
    if (this.onMixdown === "crash") setTimeout(() => this.onerror?.({ message: "out of memory" }), 0);
  }

  terminate() {
    this.terminated = true;
  }
}

test("fall-back: without an idle, warm worker the export is built on the calling thread — same bytes, nothing lost", async () => {
  const item = CASES[0];
  const source = (audio: LoadedAudio): MixdownSource =>
    audio.kind === "stems" ? { kind: "stems", stems: audio.stems, volumes: VOLUMES, engine: audio.engine } : { kind: "buffer", buffer: audio.buffer };
  const fallsBack = async (label: string) => {
    const deps = counted(mixdownInWorker);
    const file = await buildExport(item.project, item.audio(), item.request, deps);
    assert.equal(sha(file.data), item.sha256, label);
    assert.deepEqual(deps.calls, { mix: 1, encode: 1, worker: 1, taken: 0 }, label);
  };

  // no worker at all (workers switched off, or none in this environment)
  configureEngine({ worker: false });
  assert.equal(await mixdownInWorker(source(item.audio())), null);
  await fallsBack("worker: false");
  configureEngine({ createWorker: null });
  await fallsBack("no worker factory");

  // a worker that has not started yet is not waited for
  let created = 0;
  configureEngine({ createWorker: () => (created++, new ScriptedWorker("serve")) });
  await fallsBack("no worker started");
  assert.equal(created, 0, "an export does not start a worker");
  prewarm();
  assert.equal(engineStatus().worker, "starting");
  await fallsBack("worker still starting");
  await ready();
  assert.equal(created, 1);

  // … and once it is up, it is used
  const viaWorker = counted(mixdownInWorker);
  assert.equal(sha((await buildExport(item.project, item.audio(), item.request, viaWorker)).data), item.sha256);
  assert.deepEqual(viaWorker.calls, { mix: 0, encode: 0, worker: 1, taken: 1 });

  // a render is running or waiting: the export does not queue behind it
  const rendering = renderMusic({ ...DEFAULT_CONFIG, duration: 15 });
  assert.equal(engineStatus().pending, 1);
  await fallsBack("worker busy with a render");
  await rendering;
  assert.equal(engineStatus().pending, 0);

  // the worker reports an error, dies, cannot take the message, or never answers
  for (const script of ["error", "crash", "throw", "silent"] as const) {
    const workers: ScriptedWorker[] = [];
    configureEngine({ createWorker: () => (workers.push(new ScriptedWorker(script)), workers[workers.length - 1]), mixdownTimeoutMs: 60 });
    await ready();
    await fallsBack(`worker: ${script}`);
    assert.ok(workers[0].requests.includes("mixdown"), script);
    assert.equal(engineStatus().pending, 0, script);
    // the engine still renders afterwards (on a fresh worker where the old one was given up)
    const next = await renderMusic({ ...DEFAULT_CONFIG, duration: 15 });
    assert.ok(next.duration > 0, script);
    assert.equal(workers.length, script === "crash" || script === "silent" ? 2 : 1, script);
  }
  configureEngine();
});

test("fall-back: a mixdown hook that throws or is absent never fails an export", async () => {
  const item = CASES[2];
  const broken = counted(async () => {
    throw new Error("worker gone");
  });
  assert.equal(sha((await buildExport(item.project, item.audio(), item.request, broken)).data), item.sha256);
  assert.deepEqual(broken.calls, { mix: 1, encode: 1, worker: 1, taken: 0 });
  // other kinds of export never ask for a mixdown
  const idle = counted(async () => new ArrayBuffer(8));
  await buildExport(local({}), stemsAudio(2, 100, 0.1), { kind: "project" }, idle);
  await buildExport(cloud(true), fileAudio(100, 2), { kind: "original" }, idle);
  assert.equal(idle.calls.worker, 0);
});
