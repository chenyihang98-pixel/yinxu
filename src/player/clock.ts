/**
 * Player arithmetic without Web Audio, so it runs (and is tested) under Node.
 * All times are seconds; `now` is always the AudioContext's currentTime.
 */
import { TRACKS, type TrackName } from "../music/score";

/** Fade applied when a voice stops, or starts in the middle of the audio. */
export const RAMP_SECONDS = 0.01;
/** Fade-in at the very top of a piece: short, to keep the first transient. */
export const TOP_RAMP_SECONDS = 0.002;
/** Time constant of fader / mute / solo / volume moves (~45 ms to settle). */
export const MIX_TIME_CONSTANT = 0.015;
/**
 * Sources are scheduled this far ahead so that all stems share one exact
 * start time even when the audio thread runs while they are being started.
 */
export const START_LEAD = 0.03;
/** Pressing play, or seeking, this close to the end counts as "at the end". */
export const END_ZONE = 0.01;

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

export interface SeekTarget {
  /** where the playhead lands, always inside [0, duration) */
  position: number;
  /** a one-shot piece was sought to its end: playback stops there */
  ended: boolean;
}

/**
 * Clamp a requested position into the audio. At the end a looping piece wraps
 * to the top; a one-shot piece reports `ended` (stop if playing; if paused the
 * playhead rests just before the end and the next play starts from the top).
 */
export function resolveSeek(
  seconds: number,
  duration: number,
  loop: boolean,
): SeekTarget {
  if (!(duration > 0) || !Number.isFinite(duration))
    return { position: 0, ended: false };
  // Anything past the end (including +Infinity) means "the end"; NaN and
  // negative values mean the top.
  const wanted = seconds > 0 ? Math.min(seconds, duration) : 0;
  if (wanted < Math.max(0, duration - END_ZONE))
    return { position: wanted, ended: false };
  return loop
    ? { position: 0, ended: false }
    : { position: Math.max(0, duration - END_ZONE / 2), ended: true };
}

/**
 * Where the playhead is. While running, position = offset + (now − anchor),
 * folded by the loop length or held at the end; while stopped it is `offset`.
 */
export class TransportClock {
  private length = 0;
  private looping = false;
  private advancing = false;
  /** position at `anchor`, or the resting position */
  private offset = 0;
  /** context time at which the sources start (may be slightly in the future) */
  private anchor = 0;

  get duration(): number {
    return this.length;
  }
  get loop(): boolean {
    return this.looping;
  }
  /** true while time advances */
  get running(): boolean {
    return this.advancing;
  }

  position(now: number): number {
    if (!(this.length > 0)) return 0;
    if (!this.advancing) return clamp(this.offset, 0, this.length);
    const raw = this.offset + Math.max(0, now - this.anchor);
    return this.looping ? raw % this.length : Math.min(raw, this.length);
  }

  /** New audio: stop the clock, optionally keeping the (clamped) position. */
  load(duration: number, now: number, keepPosition: boolean): void {
    const kept = keepPosition ? this.position(now) : 0;
    this.length = Number.isFinite(duration) && duration > 0 ? duration : 0;
    this.advancing = false;
    this.offset = Math.min(kept, this.length);
  }

  /** Buffer offset to start from when play is pressed at the resting place. */
  startOffset(): number {
    const position = clamp(this.offset, 0, this.length);
    return position >= this.length - END_ZONE ? 0 : position;
  }

  /** Sources begin at context time `when`, reading the audio from `from`. */
  start(when: number, from: number): void {
    this.offset = clamp(from, 0, this.length);
    this.anchor = when;
    this.advancing = true;
  }

  /** Freeze at the audible position and return it. */
  pause(now: number): number {
    this.offset = this.position(now);
    this.advancing = false;
    return this.offset;
  }

  /** Rest at a position without advancing (a seek while paused, or a scrub). */
  park(position: number): void {
    const wanted = Number.isFinite(position) ? position : 0;
    this.offset = clamp(wanted, 0, this.length);
    this.advancing = false;
  }

  /**
   * Elapsed time may already span several loop turns. Fold it into the
   * audible position before the arithmetic switches between wrap and hold,
   * otherwise turning the loop off would jump to the end.
   */
  setLoop(loop: boolean, now: number): void {
    if (this.advancing && now > this.anchor) {
      this.offset = this.position(now);
      this.anchor = now;
    }
    this.looping = loop;
  }

  /** A one-shot piece played to its end: back to the top, stopped. */
  finish(): void {
    this.offset = 0;
    this.advancing = false;
  }
}

/**
 * Generation counter for asynchronous starts. A step that had to wait (for
 * AudioContext.resume) may only continue while its token is still current;
 * pause, seek, load and unmount cancel whatever is in flight.
 */
export class RequestGate {
  private generation = 0;

  begin(): number {
    return ++this.generation;
  }
  cancel(): void {
    this.generation++;
  }
  isCurrent(token: number): boolean {
    return token === this.generation;
  }
}

/** Gain per stem for the current faders: solo silences every other stem. */
export function mixTargets(
  gains: Partial<Record<TrackName, number>> | null | undefined,
  solo: TrackName | null | undefined,
): Record<TrackName, number> {
  const targets = {} as Record<TrackName, number>;
  for (const track of TRACKS) {
    const value = gains?.[track];
    targets[track] =
      (solo && solo !== track) ||
      typeof value !== "number" ||
      !Number.isFinite(value)
        ? 0
        : clamp(value, 0, 1);
  }
  return targets;
}

/** Value at time `at` of a linear fade-in that starts at `startsAt`. */
export function fadeInValue(
  startsAt: number,
  ramp: number,
  at: number,
): number {
  if (!(ramp > 0)) return at >= startsAt ? 1 : 0;
  return clamp((at - startsAt) / ramp, 0, 1);
}

/** Listening volume: finite and within 0..1, else the fallback. */
export function cleanVolume(value: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(value, 0, 1)
    : fallback;
}
