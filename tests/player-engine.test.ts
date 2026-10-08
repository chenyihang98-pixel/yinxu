// PlayerEngine against a scripted Web Audio: what gets created, scheduled,
// stopped and reported. Real browsers still have to confirm how it sounds.
import assert from "node:assert/strict";
import test from "node:test";
import { CEILING } from "../src/audio/softclip";
import {
  MIX_TIME_CONSTANT,
  RAMP_SECONDS,
  START_LEAD,
  TOP_RAMP_SECONDS,
} from "../src/player/clock";
import {
  PlayerEngine,
  type PlayerEnvironment,
  type PlayerSource,
} from "../src/player/usePlayer";
import type { TrackName } from "../src/types";

/* ---------------- fake Web Audio ---------------- */

interface ParamEvent {
  type: "set" | "ramp" | "target" | "cancel";
  value?: number;
  time: number;
  constant?: number;
}

class FakeParam {
  value: number;
  events: ParamEvent[] = [];
  constructor(value: number) {
    this.value = value;
  }
  setValueAtTime(value: number, time: number) {
    this.events.push({ type: "set", value, time });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ type: "ramp", value, time });
    return this;
  }
  setTargetAtTime(value: number, time: number, constant: number) {
    this.events.push({ type: "target", value, time, constant });
    return this;
  }
  cancelScheduledValues(time: number) {
    this.events = this.events.filter((event) => event.time < time);
    this.events.push({ type: "cancel", time });
    return this;
  }
  last(type: ParamEvent["type"]): ParamEvent | undefined {
    return this.events.filter((event) => event.type === type).at(-1);
  }
}

class FakeNode {
  outputs: FakeNode[] = [];
  disconnected = false;
  connect(destination: FakeNode) {
    this.outputs.push(destination);
    return destination;
  }
  disconnect() {
    this.outputs = [];
    this.disconnected = true;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

class FakeShaper extends FakeNode {
  curve: Float32Array | null = null;
  oversample = "";
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  started: { when: number; offset: number } | null = null;
  stoppedAt: number | null = null;
  start(when: number, offset: number) {
    if (this.started) throw new DOMException("already started", "InvalidStateError");
    this.started = { when, offset };
  }
  stop(when = 0) {
    if (!this.started) throw new DOMException("not started", "InvalidStateError");
    this.stoppedAt = when;
  }
  /** what the browser does when the buffer runs out */
  end() {
    this.onended?.();
  }
}

type ResumeMode = "ok" | "pending" | "reject";

class FakeContext {
  currentTime = 0;
  state: "suspended" | "running" | "closed" = "suspended";
  destination = new FakeNode();
  gains: FakeGain[] = [];
  sources: FakeSource[] = [];
  shapers: FakeShaper[] = [];
  resumes = 0;
  suspends = 0;
  closes = 0;
  resumeMode: ResumeMode;
  /** makes suspend() take a while, like a real output device shutting down */
  slowSuspend: (() => Promise<void>) | null = null;
  private listeners = new Set<() => void>();
  /** control messages reach the audio thread in the order they were sent */
  private queue: Promise<void> = Promise.resolve();
  readonly sampleRate: number;

  constructor(sampleRate: number, resumeMode: ResumeMode) {
    this.sampleRate = sampleRate;
    this.resumeMode = resumeMode;
  }
  createGain() {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }
  createWaveShaper() {
    const node = new FakeShaper();
    this.shapers.push(node);
    return node;
  }
  createBufferSource() {
    const node = new FakeSource();
    this.sources.push(node);
    return node;
  }
  addEventListener(type: string, listener: () => void) {
    assert.equal(type, "statechange");
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: () => void) {
    this.listeners.delete(listener);
  }
  get listenerCount() {
    return this.listeners.size;
  }
  /** the system (or a test) changes the state */
  transition(state: FakeContext["state"]) {
    if (this.state === state) return;
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
  resume(): Promise<void> {
    this.resumes++;
    if (this.resumeMode === "pending") return new Promise(() => {});
    if (this.resumeMode === "reject")
      return Promise.reject(new DOMException("not allowed", "NotAllowedError"));
    return this.enqueue(() => this.transition("running"));
  }
  suspend(): Promise<void> {
    this.suspends++;
    return this.enqueue(async () => {
      await this.slowSuspend?.();
      this.transition("suspended");
    });
  }
  close(): Promise<void> {
    this.closes++;
    return this.enqueue(() => this.transition("closed"));
  }
  private enqueue(step: () => void | Promise<void>): Promise<void> {
    const done = this.queue.then(step);
    this.queue = done.catch(() => {});
    return done;
  }
}

function harness(options: { resume?: ResumeMode; activated?: boolean | undefined } = {}) {
  const contexts: FakeContext[] = [];
  const timers = new Map<number, { at: number; run: () => void }>();
  const frames = new Map<number, (timestamp: number) => void>();
  const errors: string[] = [];
  let clock = 0;
  let ids = 0;
  const settings = {
    resume: options.resume ?? ("ok" as ResumeMode),
    activated: "activated" in options ? options.activated : true,
    failCreate: false,
  };
  const env: PlayerEnvironment = {
    createContext(sampleRate) {
      if (settings.failCreate) throw new Error("no audio device");
      const context = new FakeContext(sampleRate, settings.resume);
      contexts.push(context);
      return context as unknown as AudioContext;
    },
    setTimeout(run, ms) {
      timers.set(++ids, { at: clock + ms, run });
      return ids;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    requestFrame(callback) {
      frames.set(++ids, callback);
      return ids;
    },
    cancelFrame(handle) {
      frames.delete(handle as number);
    },
    now: () => clock,
    userActivated: () => settings.activated,
  };
  const engine = new PlayerEngine((message) => errors.push(message), env);
  let stateChanges = 0;
  let timeChanges = 0;
  engine.subscribeState(() => stateChanges++);
  engine.subscribeTime(() => timeChanges++);
  return {
    engine,
    contexts,
    errors,
    settings,
    get context() {
      const context = contexts.at(-1);
      assert.ok(context, "an AudioContext exists");
      return context;
    },
    get stateChanges() {
      return stateChanges;
    },
    get timeChanges() {
      return timeChanges;
    },
    get pendingFrames() {
      return frames.size;
    },
    get pendingTimers() {
      return timers.size;
    },
    /** wall clock and audio clock move together; due timers fire in order */
    async advance(ms: number) {
      const target = clock + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        const step = Math.max(0, due[1].at - clock);
        for (const context of contexts)
          if (context.state === "running") context.currentTime += step / 1000;
        clock = due[1].at;
        due[1].run();
        await flush();
      }
      for (const context of contexts)
        if (context.state === "running") context.currentTime += (target - clock) / 1000;
      clock = target;
      await flush();
    },
    /** one animation frame */
    frame() {
      const queued = [...frames.entries()];
      frames.clear();
      for (const [, callback] of queued) callback(clock);
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const buffer = (duration: number, sampleRate = 48000) =>
  ({
    duration,
    sampleRate,
    length: Math.round(duration * sampleRate),
    numberOfChannels: 2,
  }) as unknown as AudioBuffer;

type StemSource = Extract<PlayerSource, { kind: "stems" }>;

function stems(duration = 30, engine: 1 | 2 = 2, sampleRate = 48000): StemSource {
  return {
    kind: "stems",
    engine,
    stems: {
      melody: buffer(duration, sampleRate),
      chords: buffer(duration, sampleRate),
      bass: buffer(duration, sampleRate),
      drums: buffer(duration, sampleRate),
    },
  };
}

const MIX = {
  gains: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 } as Record<TrackName, number>,
  solo: null as TrackName | null,
};
const TRACK_ORDER: TrackName[] = ["melody", "chords", "bass", "drums"];

/** The four stem sources of the most recent start, with their gain and fade nodes. */
function voice(context: FakeContext, count = 4) {
  const sources = context.sources.slice(-count);
  const gains = sources.map((source) => source.outputs[0] as FakeGain);
  const fade = (count === 4 ? gains[0].outputs[0] : sources[0].outputs[0]) as FakeGain;
  return { sources, gains, fade };
}

const near = (actual: number, expected: number, message?: string) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${message ?? "value"}: expected ${expected}, got ${actual}`,
  );

/* ---------------- loading and the graph ---------------- */

test("nothing touches Web Audio until the first play", async () => {
  const h = harness();
  assert.deepEqual(h.engine.getState(), {
    ready: false,
    playing: false,
    duration: 0,
    loop: false,
    volume: 0.8,
  });
  h.engine.load(stems(30), MIX);
  h.engine.seek(5);
  h.engine.setMix(MIX.gains, "bass");
  h.engine.setVolume(0.5);
  h.engine.setLoop(true);
  assert.equal(h.contexts.length, 0, "no AudioContext before a user gesture");
  assert.deepEqual(h.engine.getState(), {
    ready: true,
    playing: false,
    duration: 30,
    loop: true,
    volume: 0.5,
  });
  assert.equal(h.engine.getTime(), 5);
  assert.equal(h.pendingFrames, 0, "no animation loop while paused");
});

test("engine-2 stems play through faders, one fade, the soft clipper and the master", async () => {
  const h = harness();
  const source = stems(30, 2, 48000);
  h.engine.load(source, MIX);
  await h.engine.play();
  const context = h.context;
  assert.equal(h.contexts.length, 1);
  assert.equal(context.sampleRate, 48000, "context created at the audio's own rate");
  assert.equal(context.resumes, 1);
  assert.equal(h.engine.getState().playing, true);

  const { sources, gains, fade } = voice(context);
  assert.equal(context.sources.length, 4);
  // sample-synchronous: one start time and one offset for all four stems
  const when = sources[0].started?.when;
  assert.ok(when !== undefined);
  near(when, context.currentTime + START_LEAD);
  for (const node of sources) assert.deepEqual(node.started, { when, offset: 0 });
  for (const [index, track] of TRACK_ORDER.entries())
    assert.equal(sources[index].buffer, source.stems[track], `${track} buffer`);
  // each stem has its own fader, initialised without a ramp
  assert.equal(new Set(gains).size, 4);
  assert.deepEqual(gains.map((gain) => gain.gain.value), [0.8, 0.64, 0.68, 0.56]);
  // faders → fade → shaper → master → destination
  for (const gain of gains) assert.deepEqual(gain.outputs, [fade]);
  const [shaper] = context.shapers;
  assert.deepEqual(fade.outputs, [shaper]);
  const master = shaper.outputs[0] as FakeGain;
  assert.deepEqual(master.outputs, [context.destination]);
  assert.equal(master.gain.value, 0.8);
  // the shaper is the export soft clipper, without oversampling
  assert.equal(shaper.oversample, "none");
  assert.ok(shaper.curve instanceof Float32Array);
  assert.equal(shaper.curve.length % 2, 1);
  near(shaper.curve[shaper.curve.length - 1], CEILING);
  near(shaper.curve[(shaper.curve.length - 1) / 2], 0);
  near(shaper.curve[Math.round((shaper.curve.length - 1) * 0.75)], 0.5, "linear below the knee");
  // from the very top the fade-in is short enough to keep the first transient
  assert.deepEqual(fade.gain.events, [
    { type: "set", value: 0, time: when },
    { type: "ramp", value: 1, time: when + TOP_RAMP_SECONDS },
  ]);
});

test("engine-1 stems and cloud audio bypass the soft clipper", async () => {
  const legacy = harness();
  legacy.engine.load(stems(20, 1, 32000), MIX);
  await legacy.engine.play();
  assert.equal(legacy.context.sampleRate, 32000, "old 32 kHz works get a 32 kHz context");
  const old = voice(legacy.context);
  const legacyMaster = legacy.context.shapers[0].outputs[0];
  assert.deepEqual(old.fade.outputs, [legacyMaster], "summed stems go straight to the master");
  assert.equal(legacy.context.sources.length, 4);

  const cloud = harness();
  const mix = buffer(61.5, 44100);
  cloud.engine.load({ kind: "mix", buffer: mix }, MIX);
  await cloud.engine.play();
  assert.equal(cloud.context.sampleRate, 44100);
  assert.equal(cloud.context.sources.length, 1);
  const [source] = cloud.context.sources;
  assert.equal(source.buffer, mix);
  const fade = source.outputs[0] as FakeGain;
  assert.deepEqual(fade.outputs, [cloud.context.shapers[0].outputs[0]]);
  assert.equal(cloud.engine.getState().duration, 61.5);
  // faders do nothing for a single mixed file, and must not throw
  cloud.engine.setMix(MIX.gains, "drums");
});

test("unusable audio is refused with a message instead of a broken player", () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  const broken = stems(30);
  delete (broken.stems as Partial<typeof broken.stems>).bass;
  h.engine.load(broken, MIX);
  assert.equal(h.engine.getState().ready, false);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /音频数据不完整/);
  h.engine.load({ kind: "mix", buffer: buffer(0) }, MIX);
  h.engine.load({ kind: "stems", engine: 2, stems: { ...stems(30, 2, 48000).stems, drums: buffer(30, 44100) } } as PlayerSource, MIX);
  h.engine.load(null as unknown as PlayerSource, MIX);
  assert.equal(h.errors.length, 4);
  assert.equal(h.engine.getState().ready, false);
});

test("stems of slightly different length loop at one common point", async () => {
  const h = harness();
  const source = stems(30);
  source.stems.drums = buffer(30.02);
  h.engine.load(source, MIX);
  h.engine.setLoop(true);
  assert.equal(h.engine.getState().duration, 30);
  await h.engine.play();
  for (const node of voice(h.context).sources) {
    assert.equal(node.loop, true);
    assert.equal(node.loopStart, 0);
    assert.equal(node.loopEnd, 30);
  }
  // equal stems keep the default (whole buffer) loop
  const even = harness();
  even.engine.load(stems(30), MIX);
  even.engine.setLoop(true);
  await even.engine.play();
  for (const node of voice(even.context).sources) assert.equal(node.loopEnd, 0);
});

/* ---------------- mixing ---------------- */

test("faders, mute and solo are gain ramps: no restart, no re-render, no React state", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  await h.engine.play();
  const context = h.context;
  const { gains } = voice(context);
  const changes = h.stateChanges;
  context.currentTime = 3;

  for (let i = 0; i < 20; i++)
    h.engine.setMix({ ...MIX.gains, melody: i / 20 }, null);
  h.engine.setMix({ ...MIX.gains, melody: 0.3 }, null);
  assert.equal(context.sources.length, 4, "the same four sources keep playing");
  assert.ok(context.sources.every((source) => source.stoppedAt === null));
  assert.equal(h.stateChanges, changes, "no state change, so no re-render");
  assert.deepEqual(gains[0].gain.last("target"), {
    type: "target",
    value: 0.3,
    time: 3,
    constant: MIX_TIME_CONSTANT,
  });

  // solo silences the other stems; un-solo restores the faders
  h.engine.setMix({ ...MIX.gains, melody: 0.3 }, "drums");
  assert.deepEqual(gains.map((gain) => gain.gain.last("target")?.value), [0, 0, 0, 0.56]);
  h.engine.setMix({ ...MIX.gains, melody: 0.3 }, null);
  assert.deepEqual(gains.map((gain) => gain.gain.last("target")?.value), [0.3, 0.64, 0.68, 0.56]);
  // mute is a fader at zero; out-of-range values are clamped
  h.engine.setMix({ melody: 0, chords: 5, bass: Number.NaN, drums: -1 }, null);
  assert.deepEqual(gains.map((gain) => gain.gain.last("target")?.value), [0, 1, 0, 0]);
  assert.equal(context.sources.length, 4);
});

test("a mix set while paused is what the next start uses", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  h.engine.setMix({ melody: 0.1, chords: 0.2, bass: 0.3, drums: 0.4 }, "chords");
  await h.engine.play();
  assert.deepEqual(voice(h.context).gains.map((gain) => gain.gain.value), [0, 0.2, 0, 0]);
  // loading a work with solo already chosen starts soloed, with no audible glide
  const soloed = harness();
  soloed.engine.load(stems(30), { gains: MIX.gains, solo: "bass" });
  await soloed.engine.play();
  const started = voice(soloed.context);
  assert.deepEqual(started.gains.map((gain) => gain.gain.value), [0, 0, 0.68, 0]);
  assert.ok(started.gains.every((gain) => gain.gain.events.length === 0));
});

test("listening volume ramps on the master and never touches the stems", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  await h.engine.play();
  const context = h.context;
  const master = context.shapers[0].outputs[0] as FakeGain;
  context.currentTime = 2;
  h.engine.setVolume(0.25);
  assert.deepEqual(master.gain.last("target"), {
    type: "target",
    value: 0.25,
    time: 2,
    constant: MIX_TIME_CONSTANT,
  });
  assert.equal(h.engine.getState().volume, 0.25);
  h.engine.setVolume(9);
  assert.equal(h.engine.getState().volume, 1);
  h.engine.setVolume(Number.NaN);
  assert.equal(h.engine.getState().volume, 1, "garbage is ignored");
  assert.ok(voice(context).gains.every((gain) => gain.gain.events.length === 0));
  // while the context is not rendering the value is simply set
  h.engine.pause();
  context.transition("suspended");
  h.engine.setVolume(0.6);
  assert.deepEqual(master.gain.events.at(-1), { type: "set", value: 0.6, time: 2 });
});

/* ---------------- transport ---------------- */

test("pause fades out, keeps the position, and play continues from it", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  await h.engine.play();
  const context = h.context;
  const first = voice(context);
  const startedAt = first.sources[0].started!.when;
  context.currentTime = startedAt + 7.5;
  h.engine.pause();
  assert.equal(h.engine.getState().playing, false);
  near(h.engine.getTime(), 7.5);
  // an 8-10 ms ramp to silence, then the sources stop: no click
  const now = context.currentTime;
  assert.deepEqual(first.fade.gain.events.slice(-3), [
    { type: "cancel", time: now },
    { type: "set", value: 1, time: now },
    { type: "ramp", value: 0, time: now + RAMP_SECONDS },
  ]);
  for (const source of first.sources) {
    assert.ok(source.stoppedAt !== null && source.stoppedAt >= now + RAMP_SECONDS);
    assert.equal(source.onended, null, "a stopped voice can no longer end playback");
  }
  assert.equal(h.pendingFrames, 0, "the animation loop stops with the music");

  context.currentTime += 100;
  near(h.engine.getTime(), 7.5, "paused time does not drift");
  await h.engine.play();
  const second = voice(context);
  assert.notEqual(second.sources[0], first.sources[0]);
  for (const source of second.sources) near(source.started!.offset, 7.5);
  // resuming mid-piece uses the full anti-click ramp
  near(second.fade.gain.last("ramp")!.time - second.sources[0].started!.when, RAMP_SECONDS);
  // the retired voice is disconnected once its fade is over
  await h.advance(200);
  assert.ok(first.sources.every((source) => source.disconnected));
  assert.ok(first.fade.disconnected);
  assert.ok(second.sources.every((source) => !source.disconnected));
});

test("playback always starts on a whole sample frame", async () => {
  // A fractional read position makes a source interpolate between samples
  // (audible treble loss), so offsets and start times are rounded to frames.
  for (const rate of [48000, 44100, 32000]) {
    const h = harness();
    h.engine.load(stems(30, 2, rate), MIX);
    await h.engine.play();
    const context = h.context;
    const frames = (seconds: number) => seconds * rate;
    const whole = (value: number) => Math.abs(value - Math.round(value)) < 1e-6;
    context.currentTime += 1.23456789;
    h.engine.pause();
    const paused = h.engine.getTime();
    assert.ok(!whole(frames(paused)), "the pause itself lands between two samples");
    await h.engine.play();
    for (const source of voice(context).sources) {
      assert.ok(whole(frames(source.started!.offset)), `offset ${source.started!.offset} @ ${rate}`);
      assert.ok(whole(frames(source.started!.when)), `when ${source.started!.when} @ ${rate}`);
      assert.ok(Math.abs(source.started!.offset - paused) <= 0.5 / rate + 1e-12, "nearest frame");
    }
    context.currentTime += 0.7654321;
    h.engine.seek(12.3456789);
    for (const source of voice(context).sources) {
      assert.ok(whole(frames(source.started!.offset)));
      assert.ok(whole(frames(source.started!.when)));
    }
    // the clock is anchored on the rounded values, so audio and playhead agree
    context.currentTime = voice(context).sources[0].started!.when + 2;
    h.frame();
    near(h.engine.getTime(), voice(context).sources[0].started!.offset + 2);
  }
});

test("pausing before the scheduled start cuts the voice without a fade", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  await h.engine.play();
  const started = voice(h.context);
  h.engine.pause();
  for (const source of started.sources) {
    assert.equal(source.stoppedAt, 0);
    assert.ok(source.disconnected);
  }
  assert.equal(h.engine.getTime(), 0);
});

test("play and toggle are idempotent: one voice, never two", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  await Promise.all([h.engine.play(), h.engine.play(), h.engine.play()]);
  assert.equal(h.context.sources.length, 4, "three quick clicks start one voice");
  await h.engine.play();
  assert.equal(h.context.sources.length, 4, "play while playing does not restart");
  h.engine.toggle();
  assert.equal(h.engine.getState().playing, false);
  h.engine.toggle();
  await flush();
  assert.equal(h.engine.getState().playing, true);
  assert.equal(h.context.sources.length, 8);
  // nothing loaded: nothing happens
  const empty = harness();
  await empty.engine.play();
  empty.engine.toggle();
  empty.engine.pause();
  empty.engine.seek(3);
  assert.equal(empty.contexts.length, 0);
  assert.deepEqual(empty.errors, []);
});

test("the playhead is published at most ~30 times a second and only while playing", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  await h.engine.play();
  const context = h.context;
  const base = h.timeChanges;
  assert.equal(h.pendingFrames, 1);
  // one second of 60 Hz frames
  for (let i = 0; i < 60; i++) {
    await h.advance(1000 / 60);
    h.frame();
  }
  const published = h.timeChanges - base;
  assert.ok(published >= 28 && published <= 31, `published ${published} times in one second`);
  // tracks the audio clock, never ahead of it and at most one tick behind
  const lag = context.currentTime - START_LEAD - h.engine.getTime();
  assert.ok(lag >= -1e-9 && lag < 0.034, `lag ${lag}`);
  // the snapshot is stable between notifications (useSyncExternalStore contract)
  const snapshot = h.engine.getTime();
  context.currentTime += 0.004;
  assert.equal(h.engine.getTime(), snapshot);

  h.engine.pause();
  const afterPause = h.timeChanges;
  assert.equal(h.pendingFrames, 0);
  await h.advance(500);
  h.frame();
  assert.equal(h.timeChanges, afterPause, "silent while paused");
  // unsubscribing really unsubscribes
  let calls = 0;
  const unsubscribe = h.engine.subscribeTime(() => calls++);
  h.engine.seek(3);
  unsubscribe();
  h.engine.seek(4);
  assert.equal(calls, 1);
});

test("seeking while paused moves the playhead at once", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  h.engine.seek(12.5);
  assert.equal(h.engine.getTime(), 12.5);
  h.engine.seek(-3);
  assert.equal(h.engine.getTime(), 0);
  h.engine.seek(Number.NaN);
  assert.equal(h.engine.getTime(), 0);
  h.engine.seek(1000);
  assert.ok(h.engine.getTime() < 30 && h.engine.getTime() > 29.9, "rests just before the end");
  assert.equal(h.contexts.length, 0);
  // play at the end starts from the top
  await h.engine.play();
  for (const source of voice(h.context).sources) assert.equal(source.started!.offset, 0);
  h.engine.pause();
  h.engine.seek(20);
  await h.engine.play();
  for (const source of voice(h.context).sources) assert.equal(source.started!.offset, 20);
});

test("a single seek while playing is a short crossfade to the new position", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  await h.engine.play();
  const context = h.context;
  const old = voice(context);
  await h.advance(5000);
  const now = context.currentTime;
  h.engine.seek(20);
  assert.equal(h.engine.getState().playing, true);
  assert.equal(h.engine.getTime(), 20, "the target shows immediately: no thumb snap-back");
  const next = voice(context);
  assert.equal(context.sources.length, 8);
  const when = now + START_LEAD;
  for (const source of next.sources) {
    near(source.started!.when, when);
    assert.equal(source.started!.offset, 20);
  }
  // old voice fades out exactly while the new one fades in
  assert.deepEqual(old.fade.gain.events.slice(-4), [
    { type: "cancel", time: now },
    { type: "set", value: 1, time: now },
    { type: "ramp", value: 1, time: when },
    { type: "ramp", value: 0, time: when + RAMP_SECONDS },
  ]);
  assert.deepEqual(next.fade.gain.events, [
    { type: "set", value: 0, time: when },
    { type: "ramp", value: 1, time: when + RAMP_SECONDS },
  ]);
  for (const source of old.sources) assert.ok(source.stoppedAt! >= when + RAMP_SECONDS);
  // the fader positions carry over to the new voice
  assert.deepEqual(next.gains.map((gain) => gain.gain.value), [0.8, 0.64, 0.68, 0.56]);
  await h.advance(1000);
  h.frame();
  near(h.engine.getTime(), 21 - START_LEAD);
});

test("scrubbing does not restart the audio per event: one start when it settles", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  await h.engine.play();
  const context = h.context;
  await h.advance(2000);
  // 30 input events, 16 ms apart, like dragging a range input
  for (let i = 0; i < 30; i++) {
    h.engine.seek(5 + i * 0.5);
    assert.equal(h.engine.getTime(), 5 + i * 0.5, "the playhead follows the pointer");
    await h.advance(16);
  }
  assert.equal(h.engine.getState().playing, true, "still playing as far as the UI is concerned");
  assert.equal(context.sources.length, 8, "only the first event restarted a voice");
  assert.ok(context.sources.every((source) => source.stoppedAt !== null), "silent while dragging");
  assert.equal(h.engine.getTime(), 19.5, "the playhead waits at the target");
  await h.advance(200);
  assert.equal(context.sources.length, 12, "exactly one more start after the drag");
  for (const source of voice(context).sources) {
    assert.equal(source.started!.offset, 19.5);
    assert.equal(source.stoppedAt, null);
  }
  await h.advance(1000);
  h.frame();
  assert.ok(h.engine.getTime() > 20.4 && h.engine.getTime() < 20.8);

  // pausing in the middle of a scrub cancels the pending start
  h.engine.seek(3);
  await h.advance(16);
  h.engine.seek(4);
  h.engine.pause();
  const count = context.sources.length;
  await h.advance(500);
  assert.equal(context.sources.length, count);
  assert.equal(h.engine.getState().playing, false);
  assert.equal(h.engine.getTime(), 4);
});

test("a drag that passes the end only stops playback if it also ends there", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  await h.engine.play();
  const context = h.context;
  await h.advance(1000);
  // drag right to the very end and back to 10 s
  for (const position of [20, 26, 30, 30, 24, 10]) {
    h.engine.seek(position);
    await h.advance(16);
    assert.equal(h.engine.getState().playing, true, `still playing at ${position}`);
  }
  await h.advance(200);
  assert.equal(h.engine.getState().playing, true);
  for (const source of voice(context).sources) assert.equal(source.started!.offset, 10);

  // a drag released at the end stops there, like reaching the end normally
  await h.advance(1000);
  for (const position of [20, 28, 30]) {
    h.engine.seek(position);
    await h.advance(16);
  }
  assert.equal(h.engine.getState().playing, true, "not decided while the pointer is down");
  assert.ok(h.engine.getTime() > 29.9, "the thumb stays where the pointer is");
  const before = context.sources.length;
  await h.advance(200);
  assert.equal(h.engine.getState().playing, false);
  assert.equal(h.engine.getTime(), 0);
  assert.equal(context.sources.length, before, "no wrap-around restart");

  // with the loop switched on while the pointer rests at the end it wraps instead
  await h.engine.play();
  await h.advance(1000);
  for (const position of [20, 30]) {
    h.engine.seek(position);
    await h.advance(16);
  }
  h.engine.setLoop(true);
  await h.advance(200);
  assert.equal(h.engine.getState().playing, true);
  for (const source of voice(context).sources) {
    assert.equal(source.started!.offset, 0);
    assert.equal(source.loop, true);
  }
});

test("seeking to the end stops a one-shot piece and wraps a loop", async () => {
  const once = harness();
  once.engine.load(stems(30), MIX);
  await once.engine.play();
  await once.advance(1000);
  once.engine.seek(30);
  assert.equal(once.engine.getState().playing, false, "does not wrap and keep playing");
  assert.equal(once.engine.getTime(), 0);
  assert.equal(once.context.sources.length, 4, "no new voice");
  assert.ok(once.context.sources.every((source) => source.stoppedAt !== null));
  assert.equal(once.pendingFrames, 0);

  const loop = harness();
  loop.engine.load(stems(30), MIX);
  loop.engine.setLoop(true);
  await loop.engine.play();
  await loop.advance(1000);
  loop.engine.seek(30);
  assert.equal(loop.engine.getState().playing, true);
  assert.equal(loop.engine.getTime(), 0);
  for (const source of voice(loop.context).sources) {
    assert.equal(source.started!.offset, 0);
    assert.equal(source.loop, true);
  }
});

test("natural end returns to the top; ends of replaced voices are ignored", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  await h.engine.play();
  const context = h.context;
  const first = voice(context);
  const staleHandlers = first.sources.map((source) => source.onended);
  await h.advance(4000);
  h.engine.seek(25);
  const second = voice(context);
  // the browser reports the old sources as ended after their scheduled stop
  for (const handler of staleHandlers) handler?.();
  for (const source of first.sources) source.end();
  assert.equal(h.engine.getState().playing, true, "a stale ended event must not stop the new voice");

  await h.advance(5100);
  h.frame();
  near(h.engine.getTime(), 30, "holds at the end until the browser says so");
  // all four stems end; only the first report matters
  for (const source of second.sources) source.end();
  assert.equal(h.engine.getState().playing, false);
  assert.equal(h.engine.getTime(), 0);
  assert.equal(h.pendingFrames, 0);
  // and it can be played again from the top
  await h.engine.play();
  for (const source of voice(context).sources) assert.equal(source.started!.offset, 0);
});

test("toggling the audition loop flips the running sources and re-bases time", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  h.engine.setLoop(true);
  await h.engine.play();
  const context = h.context;
  const { sources } = voice(context);
  assert.ok(sources.every((source) => source.loop));
  const startedAt = sources[0].started!.when;
  // two and a half turns later
  context.currentTime = startedAt + 75;
  h.frame();
  near(h.engine.getTime(), 15);
  h.engine.setLoop(false);
  assert.ok(sources.every((source) => !source.loop), "all four flags change in the same task");
  assert.equal(context.sources.length, 4, "no restart, no click");
  near(h.engine.getTime(), 15, "the audible position, not the accumulated 75 s");
  assert.deepEqual(h.engine.getState().loop, false);
  context.currentTime += 5;
  h.frame();
  await h.advance(40);
  h.frame();
  near(h.engine.getTime(), 20.04);
  // setting the same value again is a no-op
  const changes = h.stateChanges;
  h.engine.setLoop(false);
  assert.equal(h.stateChanges, changes);

  // a loop switched on in the instant the audio ran out carries on from the top
  context.currentTime += 20;
  h.engine.setLoop(true);
  for (const source of sources) source.end();
  assert.equal(h.engine.getState().playing, true);
  const restarted = voice(context);
  assert.notEqual(restarted.sources[0], sources[0]);
  for (const source of restarted.sources) {
    assert.equal(source.started!.offset, 0);
    assert.equal(source.loop, true);
  }
});

/* ---------------- loading while playing ---------------- */

test("load can keep the position and the playing state, or start a new work", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  await h.engine.play();
  const context = h.context;
  await h.advance(6000);
  const position = context.currentTime - START_LEAD;
  const changes = h.stateChanges;
  h.engine.load(stems(30), MIX, { keepPosition: true });
  assert.equal(h.engine.getState().playing, true, "keeps playing");
  assert.equal(h.stateChanges, changes, "no pause/play flicker for the UI");
  for (const source of voice(context).sources) near(source.started!.offset, position);
  assert.equal(context.sources.length, 8);
  assert.ok(context.sources.slice(0, 4).every((source) => source.stoppedAt !== null));

  // a different work: back to the top, paused
  h.engine.load(stems(45), MIX);
  assert.deepEqual(
    { ...h.engine.getState() },
    { ready: true, playing: false, duration: 45, loop: false, volume: 0.8 },
  );
  assert.equal(h.engine.getTime(), 0);
  assert.equal(context.sources.length, 8);
  // autoplay
  h.engine.load(stems(20), MIX, { autoplay: true });
  assert.equal(h.engine.getState().playing, true);
  for (const source of voice(context).sources) assert.equal(source.started!.offset, 0);
  // keepPosition while paused stays paused, at the same place
  h.engine.pause();
  h.engine.seek(11);
  h.engine.load(stems(20), MIX, { keepPosition: true });
  assert.equal(h.engine.getState().playing, false);
  assert.equal(h.engine.getTime(), 11);

  h.engine.unload();
  assert.deepEqual(
    { ...h.engine.getState() },
    { ready: false, playing: false, duration: 0, loop: false, volume: 0.8 },
  );
  assert.equal(h.engine.getTime(), 0);
  await h.engine.play();
  assert.equal(h.engine.getState().playing, false);
});

test("a work at another sample rate gets its own context; the old one is closed", async () => {
  const h = harness();
  h.engine.load(stems(30, 2, 48000), MIX);
  await h.engine.play();
  const first = h.context;
  h.engine.load(stems(20, 1, 32000), MIX, { autoplay: true });
  await flush();
  assert.equal(h.contexts.length, 2);
  const second = h.context;
  assert.equal(second.sampleRate, 32000);
  assert.equal(h.engine.getState().playing, true);
  assert.equal(second.sources.length, 4);
  // the old voice gets its fade-out before the old context goes away
  assert.equal(first.closes, 0);
  assert.ok(first.sources.every((source) => source.stoppedAt !== null));
  await h.advance(500);
  assert.equal(first.closes, 1);
  assert.equal(first.state, "closed");
  assert.equal(first.listenerCount, 0);
  assert.equal(h.engine.getState().playing, true, "closing the old context does not stop the new one");
  // same rate again: the context is reused
  h.engine.load(stems(10, 1, 32000), MIX, { autoplay: true });
  await flush();
  assert.equal(h.contexts.length, 2);
});

/* ---------------- races, autoplay policy, lifecycle ---------------- */

test("a start that waited for resume() never plays stale audio", async () => {
  const h = harness({ resume: "pending" });
  h.engine.load(stems(30), MIX);
  const first = h.engine.play();
  await flush();
  const context = h.context;
  assert.equal(h.engine.getState().playing, false, "not playing until audio really starts");
  // pause arrives while resume() is still pending; then the device wakes up
  h.engine.pause();
  context.transition("running");
  await h.advance(5000);
  await first;
  assert.equal(context.sources.length, 0, "the cancelled request started nothing");
  assert.deepEqual(h.errors, [], "a cancelled request is not an error");

  // loading another work while waiting
  context.transition("suspended");
  const second = h.engine.play();
  await flush();
  h.engine.load(stems(12), MIX);
  context.transition("running");
  await h.advance(5000);
  await second;
  assert.equal(context.sources.length, 0);
  assert.equal(h.engine.getState().playing, false);
  assert.equal(h.engine.getState().duration, 12);
  assert.deepEqual(h.errors, []);

  // seeking while waiting is fine: the start uses the new position
  context.transition("suspended");
  context.resumeMode = "ok";
  const third = h.engine.play();
  h.engine.seek(7);
  await third;
  assert.equal(h.engine.getState().playing, true);
  for (const source of voice(context).sources) assert.equal(source.started!.offset, 7);
});

test("autoplay refused before a user gesture: a clear message and a paused player", async () => {
  const h = harness({ resume: "pending", activated: false });
  h.engine.load(stems(30), MIX, { autoplay: true });
  await flush();
  assert.equal(h.engine.getState().playing, false);
  await h.advance(599);
  assert.deepEqual(h.errors, []);
  await h.advance(2);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /先与页面互动|点击播放按钮/);
  assert.equal(h.engine.getState().playing, false);
  assert.equal(h.engine.getState().ready, true, "the work stays loaded");
  assert.equal(h.context.sources.length, 0);
  assert.equal(h.pendingFrames, 0);

  // the user then clicks play: it works
  h.settings.activated = true;
  h.context.resumeMode = "ok";
  await h.engine.play();
  assert.equal(h.engine.getState().playing, true);
  assert.equal(h.errors.length, 1);
});

test("resume() rejected or stuck after a gesture reports the output problem", async () => {
  const rejected = harness({ resume: "reject" });
  rejected.engine.load(stems(30), MIX);
  await rejected.engine.play();
  assert.equal(rejected.engine.getState().playing, false);
  assert.equal(rejected.errors.length, 1);
  assert.match(rejected.errors[0], /再点一次播放按钮/);
  assert.equal(rejected.context.sources.length, 0);

  const stuck = harness({ resume: "pending", activated: undefined });
  stuck.engine.load(stems(30), MIX);
  const pending = stuck.engine.play();
  await stuck.advance(3900);
  assert.deepEqual(stuck.errors, [], "a slow output device gets a few seconds");
  await stuck.advance(200);
  await pending;
  assert.equal(stuck.errors.length, 1);
  assert.match(stuck.errors[0], /扬声器或耳机/);
  assert.equal(stuck.engine.getState().playing, false);
  // a late wake-up after giving up must not start anything on its own
  stuck.context.transition("running");
  await stuck.advance(1000);
  assert.equal(stuck.context.sources.length, 0);
  assert.equal(stuck.engine.getState().playing, false);

  const none = harness();
  none.settings.failCreate = true;
  none.engine.load(stems(30), MIX);
  await none.engine.play();
  assert.match(none.errors[0], /无法初始化音频输出/);
  assert.equal(none.engine.getState().playing, false);
});

test("the system suspending the context pauses the player where it is", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  await h.engine.play();
  const context = h.context;
  await h.advance(4000);
  const position = context.currentTime - START_LEAD;
  const interrupted = voice(context);
  context.transition("suspended");
  assert.equal(h.engine.getState().playing, false, "the button no longer claims to be playing");
  near(h.engine.getTime(), position);
  assert.ok(interrupted.sources.every((source) => source.stoppedAt !== null));
  assert.equal(h.pendingFrames, 0);
  assert.deepEqual(h.errors, []);
  // the next play resumes the context and continues from there
  await h.engine.play();
  assert.equal(context.resumes, 2);
  assert.equal(h.engine.getState().playing, true);
  for (const source of voice(context).sources) near(source.started!.offset, position);

  // a context closed behind our back is replaced on the next play
  context.transition("closed");
  assert.equal(h.engine.getState().playing, false);
  await h.engine.play();
  assert.equal(h.contexts.length, 2);
  assert.equal(h.engine.getState().playing, true);
});

test("an idle player releases the output device and wakes up on play", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  await h.engine.play();
  const context = h.context;
  await h.advance(60_000);
  assert.equal(context.suspends, 0, "never while playing");
  h.engine.pause();
  await h.advance(7000);
  assert.equal(context.suspends, 0);
  await h.advance(1500);
  assert.equal(context.suspends, 1);
  assert.equal(context.state, "suspended");
  assert.equal(h.engine.getState().playing, false);
  await h.engine.play();
  assert.equal(context.resumes, 2);
  assert.equal(h.engine.getState().playing, true);

  // pressing play in the instant the idle suspend is under way still plays
  h.engine.pause();
  await h.advance(7999);
  context.slowSuspend = () => new Promise((resolve) => setTimeout(resolve, 0));
  await h.advance(1);
  assert.equal(context.suspends, 2);
  assert.equal(context.state, "running", "suspend requested but not yet effective");
  const resumesBefore = context.resumes;
  const playing = h.engine.play();
  await flush();
  assert.equal(h.engine.getState().playing, false, "not started on the strength of a stale state");
  assert.equal(context.sources.length, 8);
  await playing;
  assert.equal(context.resumes, resumesBefore + 1, "play waited for its own resume()");
  assert.equal(h.engine.getState().playing, true);
  assert.equal(context.state, "running");
  assert.equal(context.sources.length, 12);
  assert.ok(voice(context).sources.every((source) => source.stoppedAt === null));
});

test("a context that wakes up with nothing to play is put back to sleep", async () => {
  const h = harness({ resume: "pending", activated: false });
  h.engine.load(stems(30), MIX, { autoplay: true });
  await h.advance(700);
  assert.equal(h.errors.length, 1);
  const context = h.context;
  // the browser lets the context start later (the user finally touched the page)
  context.transition("running");
  assert.equal(h.engine.getState().playing, false, "it must not start playing by itself");
  await h.advance(7000);
  assert.equal(context.suspends, 0);
  await h.advance(1500);
  assert.equal(context.suspends, 1, "the output device is released again");
});

test("unlock prepares the context during a user gesture without playing", async () => {
  const h = harness();
  h.engine.unlock();
  await flush();
  assert.equal(h.contexts.length, 1);
  assert.equal(h.context.sampleRate, 48000);
  assert.equal(h.context.resumes, 1);
  assert.equal(h.context.sources.length, 0);
  assert.equal(h.engine.getState().playing, false);
  // the later autoplay needs no second resume and reuses the context
  h.engine.load(stems(30), MIX, { autoplay: true });
  assert.equal(h.engine.getState().playing, true);
  assert.equal(h.contexts.length, 1);
  assert.equal(h.context.resumes, 1);
  h.engine.unlock();
  assert.equal(h.contexts.length, 1);
});

test("dispose closes the context, drops every reference, and the engine can be reused", async () => {
  const h = harness();
  h.engine.load(stems(30), MIX);
  await h.engine.play();
  const context = h.context;
  await h.advance(3000);
  const position = context.currentTime - START_LEAD;
  h.engine.dispose();
  await flush();
  assert.equal(context.closes, 1);
  assert.equal(context.state, "closed");
  assert.equal(context.listenerCount, 0);
  assert.ok(context.sources.every((source) => source.stoppedAt !== null && source.disconnected));
  assert.equal(h.engine.getState().playing, false);
  assert.equal(h.pendingFrames, 0);
  near(h.engine.getTime(), position);
  await h.advance(60_000);
  assert.equal(context.closes, 1, "no timer touches the closed context again");
  assert.equal(context.suspends, 0);
  // disposing twice is harmless
  h.engine.dispose();
  // StrictMode remount / Fast Refresh: playing again builds a fresh context
  await h.engine.play();
  assert.equal(h.contexts.length, 2);
  assert.equal(h.context.state, "running");
  assert.equal(h.engine.getState().playing, true);
  for (const source of voice(h.context).sources) near(source.started!.offset, position);
  assert.deepEqual(h.errors, []);
});

test("state snapshots only change when something visible changes", async () => {
  const h = harness();
  const initial = h.engine.getState();
  assert.equal(h.engine.getState(), initial, "same object until a change");
  h.engine.load(stems(30), MIX);
  const loadedState = h.engine.getState();
  assert.notEqual(loadedState, initial);
  assert.equal(h.stateChanges, 1);
  h.engine.seek(3);
  h.engine.setMix(MIX.gains, "bass");
  h.engine.setVolume(0.8);
  h.engine.setLoop(false);
  h.engine.pause();
  assert.equal(h.engine.getState(), loadedState);
  assert.equal(h.stateChanges, 1);
  await h.engine.play();
  assert.equal(h.stateChanges, 2);
  // a listener that unsubscribes during notification does not break the others
  let late = 0;
  const off = h.engine.subscribeState(() => {
    off();
  });
  h.engine.subscribeState(() => late++);
  h.engine.pause();
  assert.equal(late, 1);
});
