// Engine facade (src/audio/engine.ts) under Node: an AudioBuffer stand-in is
// installed on globalThis, there is no Worker global, so renders take the
// in-thread path unless a test hands the engine a worker of its own — a
// scripted double for the failure modes, and a real node:worker_threads
// thread running src/audio/worker.ts for the protocol, transfer and abort.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Worker as ThreadWorker } from "node:worker_threads";
import { compose } from "../src/music/compose";
import { DEFAULT_CONFIG, stylePreset } from "../src/music/defaults";
import { TRACKS } from "../src/music/score";
import { CEILING, KNEE, softClip } from "../src/audio/softclip";
import {
  REFERENCE_VOLUMES,
  computePeaks,
  configureEngine,
  encodeWav,
  engineStatus,
  mixStems,
  prewarm,
  renderMusic,
} from "../src/audio/engine";
import type { EngineRenderResult, WorkerLike } from "../src/audio/engine";
import { integratedLoudness } from "../src/audio/loudness";
import type { WorkerRequest, WorkerResponse } from "../src/audio/render-types";
import { PROGRESS_INTERVAL_MS, attachWorker } from "../src/audio/worker";
import type { WorkerScope } from "../src/audio/worker";
import type { MusicConfig, TrackName } from "../src/types";

class TestAudioBuffer {
  readonly length: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly duration: number;
  private readonly channels: Float32Array[];
  constructor(options: { length: number; sampleRate: number; numberOfChannels: number }) {
    this.length = options.length;
    this.sampleRate = options.sampleRate;
    this.numberOfChannels = options.numberOfChannels;
    this.duration = options.length / options.sampleRate;
    this.channels = Array.from({ length: options.numberOfChannels }, () => new Float32Array(options.length));
  }
  getChannelData(channel: number) {
    return this.channels[channel];
  }
}
Object.defineProperty(globalThis, "AudioBuffer", { value: TestAudioBuffer, configurable: true });

after(() => configureEngine());

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

type Stems = Record<TrackName, AudioBuffer>;

const LOOP: MusicConfig = { ...DEFAULT_CONFIG, duration: 15, loop: true };
const SONG: MusicConfig = { ...DEFAULT_CONFIG, ...stylePreset("chill"), duration: 15, loop: false, seed: 99 };

function hashBuffers(buffers: AudioBuffer[]): string {
  const hash = createHash("sha256");
  for (const buffer of buffers)
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      hash.update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
  return hash.digest("hex");
}
const hashStems = (stems: Stems) => hashBuffers(TRACKS.map((track) => stems[track]));

function isAbortError(error: unknown): boolean {
  assert.ok(error instanceof DOMException, `expected a DOMException, got ${String(error)}`);
  assert.equal(error.name, "AbortError");
  assert.equal(error.message, "已取消生成");
  return true;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function bufferOf(left: ArrayLike<number>, right: ArrayLike<number> = left, sampleRate = 48000): AudioBuffer {
  const buffer = new AudioBuffer({ length: left.length, numberOfChannels: 2, sampleRate });
  buffer.getChannelData(0).set(left);
  buffer.getChannelData(1).set(right);
  return buffer;
}

function assertProgress(values: number[], label: string) {
  assert.ok(values.length >= 2, `${label}: only ${values.length} progress calls`);
  for (let i = 0; i < values.length; i++) {
    assert.ok(values[i] >= 0 && values[i] <= 1, `${label}: progress ${values[i]}`);
    if (i) assert.ok(values[i] > values[i - 1], `${label}: progress went ${values[i - 1]} → ${values[i]}`);
  }
  assert.equal(values[values.length - 1], 1, `${label}: progress must end with 1`);
}

/** Reference renders on the plain in-thread path, made once and reused. */
const references = new Map<MusicConfig, Promise<EngineRenderResult>>();
function reference(config: MusicConfig): Promise<EngineRenderResult> {
  let pending = references.get(config);
  if (!pending) {
    configureEngine({ worker: false });
    pending = renderMusic(config);
    references.set(config, pending);
  }
  return pending;
}

/* ------------------------------------------------------------------ */
/* engine 2, in-thread path                                            */
/* ------------------------------------------------------------------ */

test("engine 2: four finished stems, waveform outlines, the Score's exact length, an arrangement summary and diagnostics", async () => {
  configureEngine();
  assert.equal(engineStatus().worker, "idle");
  const progress: number[] = [];
  const result = await renderMusic(LOOP, { onProgress: (value) => progress.push(value) });
  const score = compose(LOOP);

  assert.deepEqual(Object.keys(result.stems).sort(), [...TRACKS].sort());
  assert.equal(result.sampleRate, 48000);
  // the Score's length, to the sample: `duration` is what the buffers really hold
  const frames = Math.round(score.duration * 48000);
  assert.equal(result.duration, frames / 48000);
  assert.ok(Math.abs(result.duration - score.duration) <= 0.5 / 48000);
  assert.equal(result.duration, result.stems.melody.duration);
  for (const track of TRACKS) {
    const stem = result.stems[track];
    assert.ok(stem instanceof AudioBuffer);
    assert.equal(stem.numberOfChannels, 2);
    assert.equal(stem.length, frames);
    assert.equal(stem.sampleRate, 48000);
    let power = 0;
    for (let channel = 0; channel < 2; channel++)
      for (const sample of stem.getChannelData(channel)) {
        if (!Number.isFinite(sample)) assert.fail(`${track} has a non-finite sample`);
        power += sample * sample;
      }
    assert.ok(power > 1, `${track} is silent`);
  }

  assert.equal(result.peaks.length, 140);
  assert.ok(result.peaks.every((value) => value >= 0 && value <= 1));
  assert.equal(Math.max(...result.peaks), 1);
  assert.ok(result.peaks.filter((value) => value > 0.05).length > 100, "the outline of a full mix is mostly empty");
  for (const track of TRACKS) {
    assert.equal(result.stemPeaks[track].length, 48);
    assert.ok(result.stemPeaks[track].every((value) => value >= 0 && value <= 1));
    assert.ok(Math.max(...result.stemPeaks[track]) > 0.02, `${track} outline is flat`);
  }
  assert.equal(Math.max(...TRACKS.flatMap((track) => result.stemPeaks[track])), 1, "stem outlines are relative to the loudest stem");

  const arrangement = result.arrangement;
  assert.ok(arrangement);
  assert.equal(arrangement.bars, score.bars);
  assert.equal(arrangement.bpm, score.bpm);
  assert.equal(arrangement.duration, score.duration);
  assert.deepEqual(arrangement.sections, score.sections);
  assert.ok(arrangement.chords.length >= 4 && arrangement.instruments.length >= 3 && arrangement.notes.length >= 3);

  // without a Worker global the job ran here, and the engine remembers that
  const diagnostics = result.diagnostics;
  assert.equal(diagnostics.path, "main");
  assert.equal(engineStatus().worker, "unavailable");
  assert.equal(engineStatus().pending, 0);
  assert.ok(diagnostics.notes > 50 && diagnostics.hits > 20 && diagnostics.renderMs > 0);
  assert.equal(diagnostics.bufferBytes % (frames * 4), 0);
  assert.ok(diagnostics.master);
  assert.equal(diagnostics.master.targetLufs, -16);
  assert.ok(Math.abs(diagnostics.master.lufs + 16) < 0.7, `mix at ${diagnostics.master.lufs} LUFS`);
  assert.ok(diagnostics.master.shortfallLu >= 0 && diagnostics.master.shortfallLu <= 0.5);
  assert.ok(diagnostics.master.peak > 0.1 && diagnostics.master.peak <= 1);
  assert.ok(diagnostics.master.limiter.activeRatio >= 0 && diagnostics.master.limiter.activeRatio <= 1);
  // the diagnostics describe the audio that was returned
  const mix = mixStems(result.stems, REFERENCE_VOLUMES, 2);
  const measured = integratedLoudness(mix.getChannelData(0), mix.getChannelData(1), 48000);
  assert.ok(Math.abs(measured - diagnostics.master.lufs) < 0.05, `diagnostics say ${diagnostics.master.lufs}, the mix measures ${measured}`);

  assertProgress(progress, "in-thread");
});

test("engine 2 is deterministic: the same config gives the same samples, another seed gives other music", async () => {
  const first = await reference(LOOP);
  configureEngine({ worker: false });
  const again = await renderMusic({ ...LOOP, volumes: { ...LOOP.volumes } });
  assert.equal(hashStems(again.stems), hashStems(first.stems));
  assert.deepEqual(again.peaks, first.peaks);
  assert.deepEqual(again.stemPeaks, first.stemPeaks);
  // faders are not part of the audio: stems are the same, only the outline of the mix moves
  const quiet = await renderMusic({ ...LOOP, volumes: { melody: 0.2, chords: 1, bass: 0, drums: 1 } });
  assert.equal(hashStems(quiet.stems), hashStems(first.stems));
  assert.notDeepEqual(quiet.peaks, first.peaks);

  const varied = await renderMusic({ ...LOOP, seed: LOOP.seed + 1 });
  assert.equal(varied.duration, first.duration);
  assert.notEqual(hashStems(varied.stems), hashStems(first.stems));
  assert.notEqual(hashBuffers([varied.stems.melody]), hashBuffers([first.stems.melody]));
});

test("loop and non-loop lengths: a loop is whole bars and closes on itself, a piece that ends has the requested length and dies away", async () => {
  const loop = await reference(LOOP);
  const loopScore = compose(LOOP);
  assert.ok(loopScore.loop);
  assert.ok(Math.abs(loop.duration - (loopScore.bars * 240) / loopScore.bpm) <= 0.5 / 48000);
  assert.equal(loopScore.bars % 2, 0);
  for (const track of TRACKS) {
    const data = loop.stems[track].getChannelData(0);
    assert.ok(Math.abs(data[0] - data[data.length - 1]) < 0.05, `${track}: the loop seam jumps`);
  }
  // the reverb tail of the end is already sounding at the start
  const head = loop.stems.melody.getChannelData(0).subarray(0, 480);
  assert.ok(head.some((sample) => sample !== 0));

  const song = await reference(SONG);
  assert.equal(song.duration, 15);
  assert.equal(song.stems.melody.length, 15 * 48000);
  const energy = (stems: Stems, from: number, to: number) => {
    let sum = 0;
    for (const track of TRACKS)
      for (let channel = 0; channel < 2; channel++) {
        const data = stems[track].getChannelData(channel);
        for (let i = Math.round(from * 48000); i < Math.round(to * 48000); i++) sum += data[i] * data[i];
      }
    return sum;
  };
  assert.ok(energy(song.stems, 14.9, 15) < energy(song.stems, 5, 5.1) * 1e-4, "the piece does not die away");
  for (const track of TRACKS) assert.equal(song.stems[track].getChannelData(0)[15 * 48000 - 1], 0, `${track} ends off zero`);
  // other requested lengths
  configureEngine({ worker: false });
  const longer = await renderMusic({ ...SONG, duration: 23 });
  assert.equal(longer.duration, 23);
  assert.equal(longer.stems.drums.length, 23 * 48000);
});

test("rendering on the calling thread keeps giving the event loop its turn", async () => {
  configureEngine({ worker: false });
  let ticks = 0;
  let longest = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const time = performance.now();
    longest = Math.max(longest, time - last);
    last = time;
    ticks++;
  }, 1);
  const started = performance.now();
  const result = await renderMusic({ ...LOOP, duration: 30 });
  const elapsed = performance.now() - started;
  clearInterval(timer);
  assert.equal(result.diagnostics.path, "main");
  assert.ok(ticks >= Math.min(20, elapsed / 40), `only ${ticks} timer ticks in ${elapsed.toFixed(0)} ms`);
  assert.ok(longest < 250, `the event loop was held for ${longest.toFixed(0)} ms`);
});

test("abort: before the render, while it waits in the queue and in the middle of it — always an AbortError, and the next render is clean", async () => {
  const clean = await reference(LOOP);
  configureEngine({ worker: false });

  // before
  const already = new AbortController();
  already.abort();
  let called = 0;
  await assert.rejects(renderMusic(LOOP, { signal: already.signal, onProgress: () => called++ }), isAbortError);
  assert.equal(called, 0);
  assert.equal(engineStatus().pending, 0);

  // during
  const during = new AbortController();
  const seen: number[] = [];
  const started = performance.now();
  const interrupted = renderMusic(LOOP, {
    signal: during.signal,
    onProgress: (value) => {
      seen.push(value);
      if (value > 0.25) during.abort();
    },
  });
  await assert.rejects(interrupted, isAbortError);
  const stoppedAfter = performance.now() - started;
  const count = seen.length;
  assert.ok(count >= 1 && seen[count - 1] < 1, "the render finished before it could be cancelled");
  await sleep(30);
  assert.equal(seen.length, count, "progress kept coming after the cancel");
  assert.equal(engineStatus().pending, 0);

  // the interrupted job left voices, effects and the master mid-note: the next render must not hear that
  const next = await renderMusic(LOOP);
  assert.equal(hashStems(next.stems), hashStems(clean.stems));
  assert.ok(stoppedAfter < next.diagnostics.renderMs + 400, `cancel took ${stoppedAfter.toFixed(0)} ms`);

  // while waiting behind another render: dropped at once, never started, the running one unharmed
  const queued = new AbortController();
  let queuedProgress = 0;
  const running = renderMusic(SONG);
  const waiting = renderMusic(LOOP, { signal: queued.signal, onProgress: () => queuedProgress++ });
  assert.equal(engineStatus().pending, 2);
  queued.abort();
  await assert.rejects(waiting, isAbortError);
  assert.equal(engineStatus().pending, 1);
  const finished = await running;
  assert.equal(hashStems(finished.stems), hashStems((await reference(SONG)).stems));
  assert.equal(queuedProgress, 0);
  assert.equal(engineStatus().pending, 0);
});

test("a progress handler that throws stops the render with its own error", async () => {
  configureEngine({ worker: false });
  await assert.rejects(
    renderMusic(LOOP, {
      onProgress: () => {
        throw new Error("handler failed");
      },
    }),
    /handler failed/,
  );
  const next = await renderMusic(LOOP);
  assert.equal(hashStems(next.stems), hashStems((await reference(LOOP)).stems));
});

test("overlapping renders are queued: each resolves with its own music, one after the other", async () => {
  const [loop, song] = [await reference(LOOP), await reference(SONG)];
  configureEngine({ worker: false });
  const order: string[] = [];
  const a = renderMusic(LOOP, { onProgress: (value) => order.push(`a${value === 1 ? "!" : ""}`) });
  const b = renderMusic(SONG, { onProgress: (value) => order.push(`b${value === 1 ? "!" : ""}`) });
  const c = renderMusic({ ...LOOP, seed: 5 }, { onProgress: (value) => order.push(`c${value === 1 ? "!" : ""}`) });
  assert.equal(engineStatus().pending, 3);
  const [first, second, third] = await Promise.all([a, b, c]);
  assert.equal(hashStems(first.stems), hashStems(loop.stems));
  assert.equal(hashStems(second.stems), hashStems(song.stems));
  assert.notEqual(hashStems(third.stems), hashStems(loop.stems));
  assert.equal(second.duration, 15);
  // strictly one after another: all of a, then all of b, then all of c
  const joined = order.join(" ");
  assert.match(joined, /^(a )+a! (b )+b! (c )+c!$/, joined);
  assert.equal(engineStatus().pending, 0);
});

/* ------------------------------------------------------------------ */
/* worker path                                                         */
/* ------------------------------------------------------------------ */

interface TransferProbe {
  type: "probe";
  transferred: number;
  detached: boolean;
}

/** src/audio/worker.ts on a real thread, behind the Worker interface the engine uses. */
function threadWorker(): WorkerLike & { thread: ThreadWorker; probes: TransferProbe[] } {
  const thread = new ThreadWorker(new URL("./fixtures/engine-worker.node.ts", import.meta.url));
  const like: WorkerLike & { thread: ThreadWorker; probes: TransferProbe[] } = {
    thread,
    probes: [],
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (message) => thread.postMessage(message),
    terminate: () => void thread.terminate(),
  };
  thread.on("message", (data: WorkerResponse | TransferProbe) => {
    if (data.type === "probe") like.probes.push(data);
    else like.onmessage?.({ data });
  });
  thread.on("error", (error) => like.onerror?.(error));
  return like;
}

test("worker: the job runs on another thread with the same samples, progress at 20 Hz at most, and one warm worker is reused", async () => {
  const [loop, song] = [await reference(LOOP), await reference(SONG)];
  const made: ReturnType<typeof threadWorker>[] = [];
  configureEngine({
    createWorker: () => {
      made.push(threadWorker());
      return made[made.length - 1];
    },
    startupTimeoutMs: 60_000,
  });
  assert.equal(engineStatus().worker, "idle");

  const progress: { value: number; at: number }[] = [];
  let ticks = 0;
  const timer = setInterval(() => ticks++, 2);
  const started = performance.now();
  const first = await renderMusic(LOOP, { onProgress: (value) => progress.push({ value, at: performance.now() }) });
  const elapsed = performance.now() - started;
  clearInterval(timer);
  assert.equal(first.diagnostics.path, "worker");
  assert.equal(engineStatus().worker, "ready");
  assert.equal(made.length, 1);
  assert.equal(hashStems(first.stems), hashStems(loop.stems));
  assert.deepEqual(first.peaks, loop.peaks);
  assert.deepEqual(first.arrangement, loop.arrangement);
  assert.deepEqual(first.diagnostics.master, loop.diagnostics.master);
  assert.equal(first.diagnostics.notes, loop.diagnostics.notes);
  assertProgress(progress.map((entry) => entry.value), "worker");
  for (let i = 1; i < progress.length - 1; i++)
    assert.ok(progress[i].at - progress[i - 1].at >= PROGRESS_INTERVAL_MS - 8, `progress ${i} came ${(progress[i].at - progress[i - 1].at).toFixed(1)} ms after the one before`);
  // this thread was free the whole time
  assert.ok(ticks > elapsed / 20, `${ticks} timer ticks in ${elapsed.toFixed(0)} ms`);
  // the eight stem channels crossed the thread boundary by transfer: the worker no longer has them
  await sleep(20);
  assert.deepEqual(made[0].probes, [{ type: "probe", transferred: 8, detached: true }]);

  // the same worker serves the next renders — also when they overlap
  const [second, third] = await Promise.all([renderMusic(SONG), renderMusic(LOOP)]);
  assert.equal(made.length, 1);
  assert.equal(second.diagnostics.path, "worker");
  assert.equal(hashStems(second.stems), hashStems(song.stems));
  assert.equal(hashStems(third.stems), hashStems(loop.stems));
  // warm: nothing had to be compiled again
  assert.ok(third.diagnostics.renderMs < first.diagnostics.renderMs * 1.5 + 100);

  // prewarm on a running worker is harmless, and a render right behind it is still right
  prewarm();
  const fourth = await renderMusic(SONG);
  assert.equal(hashStems(fourth.stems), hashStems(song.stems));
  assert.equal(made.length, 1);
  configureEngine();
  await sleep(20);
});

test("worker: cancelling mid-render terminates the worker at once; the next render starts a fresh one and is clean", async () => {
  const loop = await reference(LOOP);
  const made: ReturnType<typeof threadWorker>[] = [];
  configureEngine({
    createWorker: () => {
      made.push(threadWorker());
      return made[made.length - 1];
    },
    startupTimeoutMs: 60_000,
  });
  // a long job, so it is certainly still running when the cancel arrives
  const controller = new AbortController();
  let abortedAt = 0;
  const seen: number[] = [];
  const cancelled = renderMusic({ ...LOOP, duration: 120 }, {
    signal: controller.signal,
    onProgress: (value) => {
      seen.push(value);
      if (!abortedAt && value > 0.05) {
        abortedAt = performance.now();
        controller.abort();
      }
    },
  });
  // a second render queued behind it must survive the terminate
  const behind = renderMusic(LOOP);
  await assert.rejects(cancelled, isAbortError);
  const latency = performance.now() - abortedAt;
  assert.ok(abortedAt > 0 && latency < 50, `the cancel took ${latency.toFixed(1)} ms to reject`);
  assert.ok(seen[seen.length - 1] < 0.9);
  const exit = await new Promise<number>((resolve) => made[0].thread.once("exit", resolve));
  assert.equal(typeof exit, "number");

  const next = await behind;
  assert.equal(made.length, 2, "a fresh worker is started lazily for the next render");
  assert.equal(next.diagnostics.path, "worker");
  assert.equal(hashStems(next.stems), hashStems(loop.stems));
  assert.equal(engineStatus().worker, "ready");

  // cancelling a render that is still queued does not touch the worker
  const queued = new AbortController();
  const running = renderMusic(LOOP);
  const waiting = renderMusic(SONG, { signal: queued.signal });
  queued.abort();
  await assert.rejects(waiting, isAbortError);
  assert.equal(hashStems((await running).stems), hashStems(loop.stems));
  assert.equal(made.length, 2);
  configureEngine();
  await sleep(20);
});

/** A scripted stand-in for the failure modes a real worker cannot be asked to produce. */
class ScriptedWorker implements WorkerLike {
  onmessage: ((event: { data: WorkerResponse }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  terminated = false;
  readonly requests: WorkerRequest[] = [];
  private handler: ((event: { data: WorkerRequest }) => void) | null = null;

  /**
   * "serve": the real protocol, run on this thread · "mute": never says a
   * word · "refused": fires an error before any message (what a CSP or
   * file:// refusal looks like) · "stall": says it is ready, reports some
   * progress and then hangs · "crash": ready, then an error mid-render
   */
  constructor(readonly script: "serve" | "mute" | "refused" | "stall" | "crash") {
    if (script === "refused") setTimeout(() => this.onerror?.({ message: "Refused to create a worker" }), 0);
    else if (script === "serve") {
      const emit = (message: WorkerResponse) => this.emit(message);
      const assign = (handler: typeof this.handler) => (this.handler = handler);
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
    } else if (script !== "mute") this.emit({ type: "ready" });
  }

  private emit(message: WorkerResponse) {
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: message });
    }, 0);
  }

  postMessage(message: WorkerRequest) {
    this.requests.push(message);
    if (this.terminated) return;
    if (this.script === "serve") setTimeout(() => this.handler?.({ data: structuredClone(message) }), 0);
    else if (this.script === "stall") this.emit({ type: "progress", id: message.id, fraction: 0.3 });
    else if (this.script === "crash") setTimeout(() => this.onerror?.({ message: "out of memory" }), 5);
  }

  terminate() {
    this.terminated = true;
  }
}

test("worker unavailable: a constructor that throws, an error before the first message or a worker that never starts all fall back to this thread — and it is remembered", async () => {
  const loop = await reference(LOOP);

  // the constructor throws (a CSP that forbids workers)
  let attempts = 0;
  configureEngine({
    createWorker: () => {
      attempts++;
      throw new DOMException("Refused to create a worker", "SecurityError");
    },
  });
  const afterThrow = await renderMusic(LOOP);
  assert.equal(afterThrow.diagnostics.path, "main");
  assert.equal(hashStems(afterThrow.stems), hashStems(loop.stems));
  assert.equal(engineStatus().worker, "unavailable");
  await renderMusic(LOOP);
  prewarm();
  assert.equal(attempts, 1, "the engine keeps trying to start a worker that cannot exist");

  // an error event before any message (a file:// or CSP refusal reported asynchronously)
  const refused: ScriptedWorker[] = [];
  configureEngine({
    createWorker: () => {
      refused.push(new ScriptedWorker("refused"));
      return refused[refused.length - 1];
    },
  });
  const progress: number[] = [];
  const afterRefusal = await renderMusic(LOOP, { onProgress: (value) => progress.push(value) });
  assert.equal(afterRefusal.diagnostics.path, "main");
  assert.equal(hashStems(afterRefusal.stems), hashStems(loop.stems));
  assertProgress(progress, "after a refusal");
  assert.ok(refused[0].terminated);
  assert.equal(engineStatus().worker, "unavailable");
  assert.equal((await renderMusic(LOOP)).diagnostics.path, "main");
  assert.equal(refused.length, 1);

  // a worker that never posts anything: given up on after the start-up time
  const mute: ScriptedWorker[] = [];
  configureEngine({
    createWorker: () => {
      mute.push(new ScriptedWorker("mute"));
      return mute[mute.length - 1];
    },
    startupTimeoutMs: 40,
  });
  const started = performance.now();
  const afterSilence = await renderMusic(LOOP);
  assert.equal(afterSilence.diagnostics.path, "main");
  assert.ok(performance.now() - started >= 35);
  assert.equal(hashStems(afterSilence.stems), hashStems(loop.stems));
  assert.ok(mute[0].terminated);
  assert.deepEqual(mute[0].requests.map((request) => request.type), ["render"]);
  assert.equal((await renderMusic(LOOP)).diagnostics.path, "main");
  assert.equal(mute.length, 1);

  // worker: false never asks for one
  let asked = 0;
  configureEngine({ worker: false, createWorker: () => (asked++, new ScriptedWorker("serve")) });
  assert.equal((await renderMusic(LOOP)).diagnostics.path, "main");
  assert.equal(asked, 0);
});

test("worker protocol: served renders, a worker that hangs is terminated on cancel, one that dies mid-render is replaced and then given up on", async () => {
  const loop = await reference(LOOP);

  // the real protocol through the double: prewarm first, then renders, on one worker
  const serving: ScriptedWorker[] = [];
  configureEngine({
    createWorker: () => {
      serving.push(new ScriptedWorker("serve"));
      return serving[serving.length - 1];
    },
  });
  prewarm();
  assert.equal(engineStatus().worker, "starting");
  const progress: number[] = [];
  const served = await renderMusic(LOOP, { onProgress: (value) => progress.push(value) });
  assert.equal(served.diagnostics.path, "worker");
  assert.equal(hashStems(served.stems), hashStems(loop.stems));
  assert.equal(progress[progress.length - 1], 1);
  assert.deepEqual(serving[0].requests.map((request) => request.type), ["warm", "render"]);
  assert.equal(engineStatus().worker, "ready");
  assert.equal(serving.length, 1);

  // a worker that hangs: cancel terminates it, and the next render gets a new one
  const scripts: ("stall" | "serve")[] = ["stall", "serve"];
  const sequence: ScriptedWorker[] = [];
  configureEngine({
    createWorker: () => {
      sequence.push(new ScriptedWorker(scripts[Math.min(sequence.length, scripts.length - 1)]));
      return sequence[sequence.length - 1];
    },
  });
  const controller = new AbortController();
  const hanging = renderMusic(LOOP, { signal: controller.signal, onProgress: () => controller.abort() });
  await assert.rejects(hanging, isAbortError);
  assert.ok(sequence[0].terminated);
  assert.equal(engineStatus().worker, "idle");
  const recovered = await renderMusic(LOOP);
  assert.equal(recovered.diagnostics.path, "worker");
  assert.equal(sequence.length, 2);
  assert.equal(hashStems(recovered.stems), hashStems(loop.stems));

  // a worker that dies after it had started: that render fails with an error, the next one tries a new worker,
  // and after two deaths in a row the engine stays on this thread
  const crashing: ScriptedWorker[] = [];
  configureEngine({
    createWorker: () => {
      crashing.push(new ScriptedWorker("crash"));
      return crashing[crashing.length - 1];
    },
  });
  await assert.rejects(renderMusic(LOOP), /本地引擎出错：out of memory/);
  assert.equal(engineStatus().worker, "idle");
  await assert.rejects(renderMusic(LOOP), /本地引擎出错/);
  assert.equal(crashing.length, 2);
  assert.equal(engineStatus().worker, "unavailable");
  const afterCrashes = await renderMusic(LOOP);
  assert.equal(afterCrashes.diagnostics.path, "main");
  assert.equal(hashStems(afterCrashes.stems), hashStems(loop.stems));
  assert.equal(crashing.length, 2);
});

/* ------------------------------------------------------------------ */
/* mixing, outlines, export                                            */
/* ------------------------------------------------------------------ */

test("mixStems: engine 2 is softClip(Σ stem × fader) and never passes the ceiling; `only` isolates a stem; faders at 0 are silent", async () => {
  const n = 4800;
  const tone = (hz: number, level: number) => Float32Array.from({ length: n }, (_, i) => level * Math.sin((2 * Math.PI * hz * i) / 48000));
  const stems: Stems = {
    melody: bufferOf(tone(440, 0.9), tone(441, 0.9)),
    chords: bufferOf(tone(220, 0.9), tone(221, 0.8)),
    bass: bufferOf(tone(55, 0.95)),
    drums: bufferOf(tone(1000, 0.9), tone(900, 0.9)),
  };
  const volumes = { melody: 1, chords: 0.5, bass: 0.9, drums: 0.7 };
  const mix = mixStems(stems, volumes, 2);
  assert.equal(mix.length, n);
  assert.equal(mix.sampleRate, 48000);
  let peak = 0;
  let past = 0;
  for (let channel = 0; channel < 2; channel++) {
    const data = mix.getChannelData(channel);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const track of TRACKS) sum += stems[track].getChannelData(channel)[i] * volumes[track];
      assert.ok(Math.abs(data[i] - softClip(Math.fround(sum))) < 2e-6, `sample ${i}`);
      peak = Math.max(peak, Math.abs(data[i]));
      if (Math.abs(sum) > 1) past++;
    }
  }
  assert.ok(past > 100, "the test mix never overloads the clipper");
  assert.ok(peak <= CEILING + 1e-7 && peak > CEILING - 0.01, `peak ${peak} against a ceiling of ${CEILING}`);
  assert.ok(CEILING < 0.9 && CEILING > KNEE);
  // far past full scale still ends at the ceiling
  const hot = mixStems({ ...stems, melody: bufferOf(tone(440, 30)) }, { melody: 1, chords: 1, bass: 1, drums: 1 }, 2);
  assert.ok(hot.getChannelData(0).every((value) => Math.abs(value) <= CEILING + 1e-7));

  // only: one stem at its fader, through the same clipper
  const solo = mixStems(stems, volumes, 2, "chords");
  for (let channel = 0; channel < 2; channel++) {
    const source = stems.chords.getChannelData(channel);
    const data = solo.getChannelData(channel);
    for (let i = 0; i < n; i++) assert.ok(Math.abs(data[i] - softClip(Math.fround(source[i] * 0.5))) < 1e-6);
  }
  assert.notDeepEqual(solo.getChannelData(0), solo.getChannelData(1));

  // faders: 0 is silence, and anything outside 0..1 is clamped
  const silent = mixStems(stems, { melody: 0, chords: 0, bass: 0, drums: 0 }, 2);
  assert.ok(silent.getChannelData(0).every((value) => value === 0) && silent.getChannelData(1).every((value) => value === 0));
  assert.ok(mixStems(stems, volumes, 2, "bass").getChannelData(0).some((value) => value !== 0));
  assert.ok(mixStems(stems, { ...volumes, bass: 0 }, 2, "bass").getChannelData(0).every((value) => value === 0));
  assert.deepEqual(
    mixStems(stems, { melody: 5, chords: -3, bass: 0, drums: 0 }, 2).getChannelData(0),
    mixStems(stems, { melody: 1, chords: 0, bass: 0, drums: 0 }, 2).getChannelData(0),
  );
  // the result is a new buffer; the stems are untouched
  assert.ok(Math.abs(stems.melody.getChannelData(0)[25] - tone(440, 0.9)[25]) < 1e-7);

  // engine 1 keeps the v0.2 rule: a plain sum, scaled down as a whole only when it would clip
  const gentle = { melody: 0.2, chords: 0.2, bass: 0.2, drums: 0.2 };
  const plain = mixStems(stems, gentle, 1);
  for (let i = 0; i < n; i += 7) {
    let sum = 0;
    for (const track of TRACKS) sum += stems[track].getChannelData(0)[i] * 0.2;
    assert.ok(Math.abs(plain.getChannelData(0)[i] - sum) < 1e-6);
  }
  const loud = mixStems(stems, { melody: 1, chords: 1, bass: 1, drums: 1 }, 1);
  let loudPeak = 0;
  for (let channel = 0; channel < 2; channel++) for (const value of loud.getChannelData(channel)) loudPeak = Math.max(loudPeak, Math.abs(value));
  assert.ok(Math.abs(loudPeak - 0.96) < 1e-6, `legacy mix peaks at ${loudPeak}`);
});

test("a rendered mix stays under the soft clipper's ceiling and exports as 16-bit stereo WAV of the exact length", async () => {
  const result = await reference(LOOP);
  const full = { melody: 1, chords: 1, bass: 1, drums: 1 };
  for (const volumes of [REFERENCE_VOLUMES, full]) {
    const mix = mixStems(result.stems, volumes, 2);
    let peak = 0;
    for (let channel = 0; channel < 2; channel++) for (const value of mix.getChannelData(channel)) peak = Math.max(peak, Math.abs(value));
    assert.ok(peak <= CEILING + 1e-7 && peak > 0.2, `mix peaks at ${peak}`);
  }
  const mix = mixStems(result.stems, REFERENCE_VOLUMES, 2);
  const wav = encodeWav(mix);
  const frames = result.stems.melody.length;
  assert.equal(wav.byteLength, 44 + frames * 2 * 2);
  const view = new DataView(wav);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(wav.slice(8, 12)), "WAVE");
  assert.equal(view.getUint32(4, true), wav.byteLength - 8);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(28, true), 48000 * 4);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), frames * 4);
  // a stem on its own exports to the same length
  assert.equal(encodeWav(mixStems(result.stems, REFERENCE_VOLUMES, 2, "drums")).byteLength, wav.byteLength);
});

test("computePeaks: one value per bin, the largest sample of the weighted sum, silent or muted buffers stay flat", () => {
  const ramp = Float32Array.from({ length: 1000 }, (_, i) => i / 1000);
  const buffer = bufferOf(ramp, ramp.map((value) => -value * 0.5));
  const peaks = computePeaks([{ buffer, gain: 1 }], 10);
  assert.equal(peaks.length, 10);
  for (let bin = 1; bin < 10; bin++) assert.ok(peaks[bin] > peaks[bin - 1]);
  assert.ok(Math.abs(peaks[9] - 0.999) < 0.02);
  assert.deepEqual(computePeaks([{ buffer, gain: 0.5 }], 10), peaks.map((value) => value * 0.5));
  assert.deepEqual(computePeaks([{ buffer, gain: 0 }], 4), [0, 0, 0, 0]);
  assert.equal(computePeaks([{ buffer, gain: 1 }]).length, 140);
  assert.equal(computePeaks([], 3).length, 3);
  // two buffers are summed before the peak is taken
  const inverse = bufferOf(ramp.map((value) => -value), ramp.map((value) => value * 0.5));
  assert.ok(computePeaks([{ buffer, gain: 1 }, { buffer: inverse, gain: 1 }], 5).every((value) => value < 1e-6));
});

/* ------------------------------------------------------------------ */
/* engine 1                                                            */
/* ------------------------------------------------------------------ */

// SHA-256 of the v0.2 output, made from the baseline commit itself:
//   git show 634c650:src/audio/engine.ts > .scratch/engine-int/v02/audio/engine.ts   (and src/types.ts next to it)
//   npx tsx .scratch/engine-int/v02/hash.ts
// "stems" hashes the eight stem channels (melody, chords, bass, drums; left then right), "mix" the two
// channels of RenderResult.buffer, which v0.2 made with mixStems(stems, config.volumes).
const LEGACY: Record<string, { config: MusicConfig; frames: number; stems: string; mix: string }> = {
  loop: {
    config: {
      prompt: "青春欢快，像晴天散步一样轻松，适合日常 Vlog",
      mood: "bright", bpm: 112, duration: 15, key: "C major", instrument: "piano",
      energy: 0.62, complexity: 0.5, reverb: 0.25, seed: 42017, loop: true,
      volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 },
      engine: 1,
    },
    frames: 480000,
    stems: "6791760dc213cc7ec78a7c72c7a3c314facbd2bb52c1b25669a67d2c752e4628",
    mix: "ec44666ce916e0ebfaf37edb11990c8940d89cb6af8195a174cf81216331d39d",
  },
  song: {
    config: {
      prompt: "复古电子，夜晚的霓虹街道",
      mood: "retro", bpm: 128, duration: 17, key: "A minor", instrument: "synth",
      energy: 0.8, complexity: 0.7, reverb: 0.5, seed: 7, loop: false,
      volumes: { melody: 1, chords: 0.5, bass: 0.9, drums: 0.3 },
      engine: 1,
    },
    frames: 544000,
    stems: "71ea7e790e579b410706bbe067f205a6654ef5d056698c504c73316fdde4929f",
    mix: "d682c10fd0b812d98f5993535f60ff45a4478389f3bdc4a90bf3c42e07d89a29",
  },
};

test("engine 1: old works render through the frozen v0.2 synthesizer, bit for bit", async () => {
  // a worker is on offer and must not be used: the legacy engine stays on this thread
  let asked = 0;
  configureEngine({ createWorker: () => (asked++, new ScriptedWorker("serve")) });
  for (const [name, expected] of Object.entries(LEGACY)) {
    const progress: number[] = [];
    const result = await renderMusic(expected.config, { onProgress: (value) => progress.push(value) });
    assert.equal(result.sampleRate, 32000, name);
    assert.equal(result.duration, expected.config.duration, name);
    for (const track of TRACKS) assert.equal(result.stems[track].length, expected.frames, name);
    assert.equal(hashStems(result.stems), expected.stems, `${name}: the stems differ from v0.2`);
    assert.equal(hashBuffers([mixStems(result.stems, expected.config.volumes, 1)]), expected.mix, `${name}: the mix differs from v0.2`);
    assert.equal(result.arrangement, undefined);
    assert.equal(result.diagnostics.path, "legacy");
    assert.equal(result.diagnostics.master, undefined);
    assert.equal(result.peaks.length, 140);
    assert.equal(Math.max(...result.peaks), 1);
    for (const track of TRACKS) assert.equal(result.stemPeaks[track].length, 48);
    assertProgress(progress, `legacy ${name}`);
  }
  assert.equal(asked, 0);

  // styles and instruments v0.2 did not have fall back the way the frozen engine always did
  const foreign = await renderMusic({ ...LEGACY.loop.config, mood: "jazz", instrument: "vibes" });
  assert.equal(hashStems(foreign.stems), hashStems((await renderMusic({ ...LEGACY.loop.config, mood: "bright", instrument: "piano" })).stems));
});

test("engine 1 shares the queue and the cancel behaviour of engine 2", async () => {
  configureEngine({ worker: false });
  const loop = await reference(LOOP);
  const order: string[] = [];
  const modern = renderMusic(LOOP, { onProgress: (value) => order.push(value === 1 ? "2!" : "2") });
  const legacy = renderMusic(LEGACY.loop.config, { onProgress: (value) => order.push(value === 1 ? "1!" : "1") });
  const [a, b] = await Promise.all([modern, legacy]);
  assert.equal(hashStems(a.stems), hashStems(loop.stems));
  assert.equal(hashStems(b.stems), LEGACY.loop.stems);
  assert.match(order.join(" "), /^(2 )+2! (1 )+1!$/);

  const before = new AbortController();
  before.abort();
  await assert.rejects(renderMusic(LEGACY.song.config, { signal: before.signal }), isAbortError);
  const during = new AbortController();
  await assert.rejects(
    renderMusic(LEGACY.song.config, { signal: during.signal, onProgress: (value) => value > 0.2 && during.abort() }),
    isAbortError,
  );
  const next = await renderMusic(LEGACY.song.config);
  assert.equal(hashStems(next.stems), LEGACY.song.stems);
});
