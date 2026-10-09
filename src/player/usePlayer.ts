/**
 * Playback. A local work plays as four stems through per-track gain nodes, so
 * faders, mute and solo are real-time gain moves: nothing is re-rendered,
 * restarted or remixed offline. A cloud work plays as one buffer.
 *
 *   stems:  4 × AudioBufferSourceNode → 4 × GainNode (faders) → fade
 *             → WaveShaperNode (engine 2 soft clip) → master → destination
 *   mix:    AudioBufferSourceNode → fade → master → destination
 *
 * Each start creates one self-contained "voice" (sources + gains + fade).
 * Stopping a voice fades it out on the audio clock and a new voice may fade in
 * at the same time, so seeking is a short crossfade and nothing clicks.
 *
 * PlayerEngine holds all of it without React; usePlayer only mirrors its
 * state. The transport position is a separate tiny store (subscribeTime /
 * getTime) so that a playing track re-renders nothing but its subscribers.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { makeSoftClipCurve } from "../audio/softclip";
import { SAMPLE_RATE, TRACKS } from "../music/score";
import type { TrackName } from "../types";
import {
  MIX_TIME_CONSTANT,
  RAMP_SECONDS,
  RequestGate,
  START_LEAD,
  TOP_RAMP_SECONDS,
  TransportClock,
  cleanVolume,
  fadeInValue,
  mixTargets,
  resolveSeek,
} from "./clock";

export type PlayerSource =
  | { kind: "stems"; stems: Record<TrackName, AudioBuffer>; engine: 1 | 2 }
  | { kind: "mix"; buffer: AudioBuffer };

export interface PlayerMix {
  /** fader positions 0..1 (project.config.volumes) */
  gains: Record<TrackName, number>;
  /** audition one stem; playback only, never part of the recipe */
  solo: TrackName | null;
}

export interface PlayerState {
  /** audio is loaded */
  readonly ready: boolean;
  readonly playing: boolean;
  /** seconds, 0 when nothing is loaded */
  readonly duration: number;
  /** audition loop (not the recipe's loop flag) */
  readonly loop: boolean;
  /** listening volume 0..1; never affects exported files */
  readonly volume: number;
}

export interface Player extends PlayerState {
  /**
   * Replace the audio. `keepPosition` keeps the playhead and, if it was
   * playing, keeps playing; `autoplay` starts playback.
   */
  load(
    source: PlayerSource,
    mix: PlayerMix,
    options?: { autoplay?: boolean; keepPosition?: boolean },
  ): void;
  unload(): void;
  /** Never rejects: failures go to onError and leave the player paused. */
  play(): Promise<void>;
  pause(): void;
  toggle(): void;
  seek(seconds: number): void;
  setLoop(loop: boolean): void;
  setVolume(volume: number): void;
  /** Faders / mute / solo. Real-time, no React state; call per input event. */
  setMix(gains: Record<TrackName, number>, solo: TrackName | null): void;
  /**
   * Playhead in seconds as of the last notification: exact while paused, at
   * most one tick (~33 ms) old while playing. Stable between notifications,
   * so it is a valid useSyncExternalStore snapshot.
   */
  getTime(): number;
  subscribeTime(listener: () => void): () => void;
  /**
   * Optional: call inside a click/key handler that starts a long job ending
   * in load(…, { autoplay: true }). Browsers that only let audio start during
   * a user gesture (Safari) then allow the later autoplay.
   */
  unlock(): void;
}

/** Everything the engine needs from its host; replaced by fakes in tests. */
export interface PlayerEnvironment {
  createContext(sampleRate: number): AudioContext;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  requestFrame(callback: (timestamp: number) => void): unknown;
  cancelFrame(handle: unknown): void;
  /** monotonic milliseconds */
  now(): number;
  /** false = the page has never been interacted with; undefined = unknown */
  userActivated(): boolean | undefined;
}

const DEFAULT_VOLUME = 0.8;
/** Idle time before the AudioContext is suspended to free the output device. */
const IDLE_SUSPEND_MS = 8000;
/** Closing is delayed so a voice that is still fading out is not cut off. */
const CLOSE_DELAY_MS = 120;
/** Position notifications while playing: at most ~30 per second. */
const TICK_MS = 31;
/** Seeks closer together than this are a scrub: silent until it settles. */
const SEEK_BURST_MS = 140;
const SEEK_SETTLE_MS = 90;
/** How long resume() may take before playback is given up. */
const RESUME_TIMEOUT_MS = 4000;
const RESUME_TIMEOUT_NO_GESTURE_MS = 600;

const MESSAGE_NEEDS_GESTURE =
  "浏览器要求先与页面互动才能播放声音，请点击播放按钮开始试听。";
const MESSAGE_NOT_STARTED =
  "还不能播放声音：请再点一次播放按钮；如果仍然没有声音，请检查扬声器或耳机。";
const MESSAGE_NO_OUTPUT = "无法初始化音频输出，请检查系统的播放设备后重试。";
const MESSAGE_BAD_AUDIO =
  "音频数据不完整，无法播放。请重新生成或重新打开作品。";

function createAudioContext(sampleRate: number): AudioContext {
  const scope = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  const Constructor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Constructor) throw new Error("AudioContext is not available");
  try {
    // Matching the audio's own rate leaves device conversion to the browser's
    // output resampler instead of per-source linear interpolation.
    return new Constructor({ sampleRate, latencyHint: "interactive" });
  } catch {
    return new Constructor();
  }
}

const browserEnvironment: PlayerEnvironment = {
  createContext: createAudioContext,
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  requestFrame: (callback) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(callback)
      : globalThis.setTimeout(() => callback(performance.now()), TICK_MS),
  cancelFrame: (handle) => {
    if (typeof cancelAnimationFrame === "function")
      cancelAnimationFrame(handle as number);
    else globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  now: () => performance.now(),
  userActivated: () =>
    typeof navigator === "undefined"
      ? undefined
      : navigator.userActivation?.hasBeenActive,
};

interface Loaded {
  source: PlayerSource;
  duration: number;
  sampleRate: number;
  /** stems of different lengths need an explicit common loop point */
  uneven: boolean;
}

interface Voice {
  sources: AudioBufferSourceNode[];
  gains: Partial<Record<TrackName, GainNode>>;
  fade: GainNode;
  /** context time at which the sources start */
  startsAt: number;
  /** length of the fade-in */
  ramp: number;
}

function describeSource(source: PlayerSource): Loaded | null {
  const usable = (buffer: AudioBuffer | undefined): buffer is AudioBuffer =>
    !!buffer &&
    Number.isFinite(buffer.duration) &&
    buffer.duration > 0 &&
    buffer.sampleRate > 0;
  if (source?.kind === "mix") {
    return usable(source.buffer)
      ? {
          source,
          duration: source.buffer.duration,
          sampleRate: source.buffer.sampleRate,
          uneven: false,
        }
      : null;
  }
  if (source?.kind !== "stems" || !source.stems) return null;
  const buffers = TRACKS.map((track) => source.stems[track]);
  if (!buffers.every(usable)) return null;
  const sampleRate = buffers[0].sampleRate;
  if (buffers.some((buffer) => buffer.sampleRate !== sampleRate)) return null;
  const durations = buffers.map((buffer) => buffer.duration);
  const duration = Math.min(...durations);
  return {
    source,
    duration,
    sampleRate,
    uneven: Math.max(...durations) !== duration,
  };
}

export class PlayerEngine {
  private readonly env: PlayerEnvironment;
  private readonly onError: (message: string) => void;
  private readonly clock = new TransportClock();
  private readonly gate = new RequestGate();

  private context: AudioContext | null = null;
  /** sample rate the current context was created for */
  private contextRate = 0;
  private shaper: WaveShaperNode | null = null;
  private master: GainNode | null = null;
  private stateListener: (() => void) | null = null;
  /** our own idle suspend() is still in flight */
  private suspending = false;

  private loaded: Loaded | null = null;
  private voice: Voice | null = null;
  private targets = mixTargets(null, null);
  private playing = false;
  private volume = DEFAULT_VOLUME;

  private idleTimer: unknown = null;
  private seekTimer: unknown = null;
  private frame: unknown = null;
  private lastSeekAt = Number.NEGATIVE_INFINITY;

  private state: PlayerState = {
    ready: false,
    playing: false,
    duration: 0,
    loop: false,
    volume: DEFAULT_VOLUME,
  };
  private readonly stateListeners = new Set<() => void>();
  private time = 0;
  private readonly timeListeners = new Set<() => void>();

  constructor(
    onError: (message: string) => void,
    environment: PlayerEnvironment = browserEnvironment,
  ) {
    this.onError = onError;
    this.env = environment;
  }

  /* ---------------- stores ---------------- */

  readonly getState = (): PlayerState => this.state;

  readonly subscribeState = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  };

  readonly getTime = (): number => this.time;

  readonly subscribeTime = (listener: () => void): (() => void) => {
    this.timeListeners.add(listener);
    return () => {
      this.timeListeners.delete(listener);
    };
  };

  /** Publish the React-visible state once, and only if something changed. */
  private commit(): void {
    const next: PlayerState = {
      ready: this.loaded !== null,
      playing: this.playing,
      duration: this.clock.duration,
      loop: this.clock.loop,
      volume: this.volume,
    };
    const previous = this.state;
    if (
      next.ready === previous.ready &&
      next.playing === previous.playing &&
      next.duration === previous.duration &&
      next.loop === previous.loop &&
      next.volume === previous.volume
    )
      return;
    this.state = next;
    for (const listener of [...this.stateListeners]) listener();
  }

  private publishTime(): void {
    const next = this.clock.position(this.contextTime());
    if (next === this.time) return;
    this.time = next;
    for (const listener of [...this.timeListeners]) listener();
  }

  private contextTime(): number {
    return this.context ? this.context.currentTime : 0;
  }

  /* ---------------- public transport ---------------- */

  readonly load = (
    source: PlayerSource,
    mix: PlayerMix,
    options: { autoplay?: boolean; keepPosition?: boolean } = {},
  ): void => {
    const loaded = describeSource(source);
    if (!loaded) {
      this.unload();
      this.onError(MESSAGE_BAD_AUDIO);
      return;
    }
    const keepPosition = options.keepPosition === true;
    const resume = options.autoplay === true || (keepPosition && this.playing);
    this.halt();
    this.clock.load(loaded.duration, this.contextTime(), keepPosition);
    this.loaded = loaded;
    this.targets = mixTargets(mix?.gains, mix?.solo);
    this.playing = false;
    this.publishTime();
    if (resume) void this.play();
    else this.idle();
    this.commit();
  };

  readonly unload = (): void => {
    this.halt();
    this.loaded = null;
    this.clock.load(0, 0, false);
    this.playing = false;
    this.publishTime();
    this.idle();
    this.commit();
  };

  readonly play = async (): Promise<void> => {
    const loaded = this.loaded;
    if (!loaded || this.playing) return;
    // Pause, seek, load or unmount while resume() is pending cancel this start.
    const token = this.gate.begin();
    let context: AudioContext;
    try {
      context = this.ensureContext(loaded.sampleRate);
    } catch {
      this.onError(MESSAGE_NO_OUTPUT);
      return;
    }
    this.cancelIdle();
    if (context.state !== "running" || this.suspending) {
      const running = await this.resume(context);
      if (
        !this.gate.isCurrent(token) ||
        this.loaded !== loaded ||
        this.context !== context
      )
        return;
      if (!running) {
        this.gate.cancel();
        this.idle();
        this.onError(
          this.env.userActivated() === false
            ? MESSAGE_NEEDS_GESTURE
            : MESSAGE_NOT_STARTED,
        );
        return;
      }
    }
    try {
      this.startVoice(context, loaded, this.clock.startOffset());
    } catch {
      this.halt();
      this.idle();
      this.onError(MESSAGE_NO_OUTPUT);
      return;
    }
    this.playing = true;
    this.startTicker();
    this.publishTime();
    this.commit();
  };

  readonly pause = (): void => {
    this.gate.cancel();
    this.clearSeekTimer();
    if (this.playing) {
      this.clock.pause(this.contextTime());
      this.retire();
      this.playing = false;
      this.stopTicker();
      this.publishTime();
    }
    this.idle();
    this.commit();
  };

  readonly toggle = (): void => {
    if (this.playing) this.pause();
    else void this.play();
  };

  readonly seek = (seconds: number): void => {
    const loaded = this.loaded;
    if (!loaded) return;
    const target = resolveSeek(seconds, this.clock.duration, this.clock.loop);
    const context = this.context;
    if (!this.playing || !context) {
      this.clock.park(target.position);
      this.publishTime();
      return;
    }
    const stamp = this.env.now();
    const scrubbing = stamp - this.lastSeekAt < SEEK_BURST_MS;
    this.lastSeekAt = stamp;
    this.clearSeekTimer();
    if (scrubbing) {
      // A drag or key repeat: do not restart a voice per event. Hold the
      // playhead silently and act once the position has settled, so a drag
      // that merely passes the end does not stop playback.
      this.retire();
      this.clock.park(target.position);
      this.seekTimer = this.env.setTimeout(() => {
        this.seekTimer = null;
        if (
          !this.playing ||
          this.voice ||
          this.loaded !== loaded ||
          this.context !== context
        )
          return;
        // The clock is parked, so its position does not depend on the time.
        const settled = resolveSeek(
          this.clock.position(0),
          this.clock.duration,
          this.clock.loop,
        );
        if (settled.ended) this.finish();
        else this.restart(context, loaded, settled.position);
      }, SEEK_SETTLE_MS);
    } else if (target.ended) {
      this.finish();
      return;
    } else {
      this.restart(context, loaded, target.position);
    }
    this.publishTime();
  };

  readonly setLoop = (loop: boolean): void => {
    const next = loop === true;
    if (next === this.clock.loop) return;
    this.clock.setLoop(next, this.contextTime());
    // Same task for every stem, so they keep or leave the loop together.
    if (this.voice) for (const node of this.voice.sources) node.loop = next;
    this.publishTime();
    this.commit();
  };

  readonly setVolume = (volume: number): void => {
    this.volume = cleanVolume(volume, this.volume);
    const context = this.context;
    if (context && this.master) {
      const gain = this.master.gain;
      if (context.state === "running")
        gain.setTargetAtTime(
          this.volume,
          context.currentTime,
          MIX_TIME_CONSTANT,
        );
      else {
        gain.cancelScheduledValues(context.currentTime);
        gain.setValueAtTime(this.volume, context.currentTime);
      }
    }
    this.commit();
  };

  readonly setMix = (
    gains: Record<TrackName, number>,
    solo: TrackName | null,
  ): void => {
    this.targets = mixTargets(gains, solo);
    const context = this.context;
    const voice = this.voice;
    if (!context || !voice) return;
    for (const track of TRACKS)
      voice.gains[track]?.gain.setTargetAtTime(
        this.targets[track],
        context.currentTime,
        MIX_TIME_CONSTANT,
      );
  };

  readonly unlock = (): void => {
    if (this.playing) return;
    const rate = this.loaded?.sampleRate ?? (this.contextRate || SAMPLE_RATE);
    try {
      const context = this.ensureContext(rate);
      if (context.state !== "running") void context.resume().catch(() => {});
      this.idle();
    } catch {
      /* play() reports a missing output device when it matters */
    }
  };

  /** Unmount: stop everything and free the output device. Reusable afterwards. */
  readonly dispose = (): void => {
    if (this.playing) this.clock.pause(this.contextTime());
    this.gate.cancel();
    this.clearSeekTimer();
    this.cancelIdle();
    this.stopTicker();
    this.playing = false;
    this.dropContext(true);
    this.publishTime();
    this.commit();
  };

  /* ---------------- internals ---------------- */

  /** Cancel pending starts and silence the voice; the clock is the caller's job. */
  private halt(): void {
    this.gate.cancel();
    this.clearSeekTimer();
    this.stopTicker();
    this.retire();
  }

  private ensureContext(sampleRate: number): AudioContext {
    const current = this.context;
    if (
      current &&
      current.state !== "closed" &&
      this.contextRate === sampleRate
    )
      return current;
    this.dropContext(false);
    const context = this.env.createContext(sampleRate);
    try {
      const master = context.createGain();
      master.gain.value = this.volume;
      master.connect(context.destination);
      const shaper = context.createWaveShaper();
      // The exact curve export uses; no oversampling, so no added latency and
      // what is heard is what softClip() writes to the file.
      shaper.curve = makeSoftClipCurve();
      shaper.oversample = "none";
      shaper.connect(master);
      this.master = master;
      this.shaper = shaper;
    } catch (error) {
      void context.close().catch(() => {});
      throw error;
    }
    const listener = () => this.contextStateChanged(context);
    context.addEventListener("statechange", listener);
    this.stateListener = listener;
    this.context = context;
    this.contextRate = sampleRate;
    return context;
  }

  private dropContext(immediately: boolean): void {
    const context = this.context;
    const voice = this.voice;
    this.voice = null;
    if (voice && (immediately || !context)) this.silence(voice);
    else if (voice) this.fadeOut(context!, voice, context!.currentTime);
    if (!context) return;
    if (this.stateListener)
      context.removeEventListener("statechange", this.stateListener);
    this.stateListener = null;
    this.context = null;
    this.contextRate = 0;
    this.master = null;
    this.shaper = null;
    this.suspending = false;
    const close = () => {
      if (context.state !== "closed") void context.close().catch(() => {});
    };
    if (immediately) close();
    else this.env.setTimeout(close, CLOSE_DELAY_MS);
  }

  private contextStateChanged(context: AudioContext): void {
    if (context !== this.context) return;
    if (context.state === "running") {
      // Started without a voice (unlock, or a late resume after a refused
      // autoplay): do not keep the output device open for nothing.
      if (!this.playing) this.idle();
      return;
    }
    // Suspended or interrupted by the system (or closed) while we believed we
    // were playing: stay where we are and wait for the next play.
    if (this.playing) {
      this.clock.pause(context.currentTime);
      this.gate.cancel();
      this.clearSeekTimer();
      this.stopTicker();
      const voice = this.voice;
      this.voice = null;
      if (voice) this.silence(voice);
      this.playing = false;
      this.publishTime();
      this.commit();
    }
    if (context.state === "closed") this.dropContext(true);
  }

  /** resume() can stay pending for ever without a gesture or output device. */
  private async resume(context: AudioContext): Promise<boolean> {
    const limit =
      this.env.userActivated() === false
        ? RESUME_TIMEOUT_NO_GESTURE_MS
        : RESUME_TIMEOUT_MS;
    let timer: unknown;
    const timeout = new Promise<void>((resolve) => {
      timer = this.env.setTimeout(resolve, limit);
    });
    try {
      await Promise.race([context.resume(), timeout]);
    } catch {
      /* rejected by the autoplay policy: the state check below reports it */
    } finally {
      this.env.clearTimeout(timer);
    }
    return context.state === "running";
  }

  private startVoice(
    context: AudioContext,
    loaded: Loaded,
    from: number,
    at = context.currentTime + START_LEAD,
  ): void {
    const { source } = loaded;
    const output =
      source.kind === "stems" && source.engine === 2
        ? this.shaper
        : this.master;
    if (!output) throw new Error("audio graph is missing");
    // Whole sample frames only: a fractional read position makes a source
    // interpolate between samples, which dulls the high frequencies.
    const offset = Math.round(from * loaded.sampleRate) / loaded.sampleRate;
    const when = Math.round(at * context.sampleRate) / context.sampleRate;
    const loop = this.clock.loop;
    const ramp = offset < 0.001 ? TOP_RAMP_SECONDS : RAMP_SECONDS;
    const fade = context.createGain();
    fade.gain.value = 0;
    fade.gain.setValueAtTime(0, when);
    fade.gain.linearRampToValueAtTime(1, when + ramp);
    fade.connect(output);
    const voice: Voice = { sources: [], gains: {}, fade, startsAt: when, ramp };
    const add = (buffer: AudioBuffer, destination: AudioNode) => {
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.loop = loop;
      if (loaded.uneven) {
        node.loopStart = 0;
        node.loopEnd = loaded.duration;
      }
      node.connect(destination);
      node.onended = () => this.sourceEnded(voice);
      voice.sources.push(node);
    };
    if (source.kind === "stems") {
      for (const track of TRACKS) {
        const gain = context.createGain();
        gain.gain.value = this.targets[track];
        gain.connect(fade);
        voice.gains[track] = gain;
        add(source.stems[track], gain);
      }
    } else add(source.buffer, fade);
    // One `when` and one offset for every stem: sample-accurate alignment.
    for (const node of voice.sources) node.start(when, offset);
    this.voice = voice;
    this.clock.start(when, offset);
  }

  /** Crossfade from the sounding voice to a new one at `offset`. */
  private restart(context: AudioContext, loaded: Loaded, offset: number): void {
    const when = context.currentTime + START_LEAD;
    this.retire(when);
    try {
      this.startVoice(context, loaded, offset, when);
    } catch {
      this.clock.park(offset);
      this.playing = false;
      this.stopTicker();
      this.commit();
      this.onError(MESSAGE_NO_OUTPUT);
    }
  }

  /** Fade the current voice out (from context time `at`, default now). */
  private retire(at?: number): void {
    const voice = this.voice;
    const context = this.context;
    this.voice = null;
    if (!voice) return;
    if (!context || context.state !== "running") this.silence(voice);
    else this.fadeOut(context, voice, Math.max(at ?? 0, context.currentTime));
  }

  private fadeOut(context: AudioContext, voice: Voice, at: number): void {
    // From here on its "ended" events are stale and must not end playback.
    for (const node of voice.sources) node.onended = null;
    const now = context.currentTime;
    if (at <= voice.startsAt) {
      this.silence(voice);
      return;
    }
    try {
      const gain = voice.fade.gain;
      // The fade-in is known analytically, so no cancelAndHoldAtTime is needed.
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(fadeInValue(voice.startsAt, voice.ramp, now), now);
      if (at > now)
        gain.linearRampToValueAtTime(
          fadeInValue(voice.startsAt, voice.ramp, at),
          at,
        );
      gain.linearRampToValueAtTime(0, at + RAMP_SECONDS);
      for (const node of voice.sources) node.stop(at + RAMP_SECONDS + 0.005);
    } catch {
      this.silence(voice);
      return;
    }
    this.env.setTimeout(
      () => this.disconnect(voice),
      (at - now + RAMP_SECONDS) * 1000 + 100,
    );
  }

  /** Stop a voice at once (nothing audible, or the context is not running). */
  private silence(voice: Voice): void {
    for (const node of voice.sources) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        /* never started or already stopped */
      }
    }
    this.disconnect(voice);
  }

  private disconnect(voice: Voice): void {
    const nodes: AudioNode[] = [
      ...voice.sources,
      ...TRACKS.flatMap((track) => voice.gains[track] ?? []),
      voice.fade,
    ];
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        /* context already closed */
      }
    }
  }

  /** A source of `voice` reached the end of its buffer. */
  private sourceEnded(voice: Voice): void {
    if (voice !== this.voice || !this.playing) return;
    const context = this.context;
    const loaded = this.loaded;
    if (this.clock.loop && context && loaded && context.state === "running") {
      // Looping sources do not end, unless the loop was switched on in the
      // instant the audio ran out. Carry on from the top, all stems together.
      this.voice = null;
      this.silence(voice);
      this.restart(context, loaded, 0);
      this.publishTime();
      return;
    }
    this.finish();
  }

  /** A one-shot piece reached its end (by itself or by a seek): back to the top. */
  private finish(): void {
    this.halt();
    this.clock.finish();
    this.playing = false;
    this.publishTime();
    this.idle();
    this.commit();
  }

  private startTicker(): void {
    if (this.frame !== null) return;
    let last = Number.NEGATIVE_INFINITY;
    const tick = (timestamp: number) => {
      this.frame = this.playing ? this.env.requestFrame(tick) : null;
      if (timestamp - last < TICK_MS) return;
      last = timestamp;
      this.publishTime();
    };
    this.frame = this.env.requestFrame(tick);
  }

  private stopTicker(): void {
    if (this.frame === null) return;
    this.env.cancelFrame(this.frame);
    this.frame = null;
  }

  private clearSeekTimer(): void {
    if (this.seekTimer === null) return;
    this.env.clearTimeout(this.seekTimer);
    this.seekTimer = null;
  }

  private cancelIdle(): void {
    if (this.idleTimer === null) return;
    this.env.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Not playing: release the output device after a while. */
  private idle(): void {
    this.cancelIdle();
    if (this.playing || !this.context) return;
    this.idleTimer = this.env.setTimeout(() => {
      this.idleTimer = null;
      const context = this.context;
      if (!context || this.playing || context.state !== "running") return;
      this.suspending = true;
      void context
        .suspend()
        .catch(() => {})
        .finally(() => {
          if (this.context === context) this.suspending = false;
        });
    }, IDLE_SUSPEND_MS);
  }
}

/**
 * The app's single player. `onError` receives ready-to-show Chinese messages
 * (autoplay refused, no output device, unusable audio).
 */
export function usePlayer(onError: (message: string) => void): Player {
  const report = useRef(onError);
  useEffect(() => {
    report.current = onError;
  });
  const [engine] = useState(
    () => new PlayerEngine((message) => report.current(message)),
  );
  // Closes the AudioContext and drops every node reference on unmount; the
  // engine creates a fresh context if it is used again (StrictMode remount).
  useEffect(() => engine.dispose, [engine]);
  const state = useSyncExternalStore(
    engine.subscribeState,
    engine.getState,
    engine.getState,
  );
  return useMemo(
    () => ({
      ...state,
      load: engine.load,
      unload: engine.unload,
      play: engine.play,
      pause: engine.pause,
      toggle: engine.toggle,
      seek: engine.seek,
      setLoop: engine.setLoop,
      setVolume: engine.setVolume,
      setMix: engine.setMix,
      getTime: engine.getTime,
      subscribeTime: engine.subscribeTime,
      unlock: engine.unlock,
    }),
    [engine, state],
  );
}
