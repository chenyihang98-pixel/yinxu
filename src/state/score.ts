/**
 * What the composer writes for a configuration, read without rendering any
 * audio: the tempo and length the piece really has (a loop is fitted to whole
 * bars, so both can differ from what was asked), and which parts play in
 * which mixer group. Pure and deterministic; runs under Node.
 *
 * Everything the interface says about a local work — its tempo, its length,
 * who plays, which suggestions would change it — is derived from here, so it
 * describes the audio and not the request.
 */
import { compose } from "../music/compose";
import { clampConfig } from "../music/defaults";
import { planTiming } from "../music/form";
import { TRACKS } from "../music/score";
import { getStyle } from "../music/styles";
import type { MusicConfig, TrackName } from "../types";

export interface FittedTiming {
  /** beats per minute of the audio; not always a whole number */
  bpm: number;
  /** seconds of audio */
  duration: number;
  bars: number;
  /** what a loop changed to close on a bar line */
  adjusted: "tempo" | "duration" | "none";
}

/**
 * The tempo and length the current engine gives this configuration — the
 * composer's own planning step, so it always equals `compose(config)`.
 */
export function fittedTiming(config: MusicConfig): FittedTiming {
  const cfg = clampConfig(config);
  const timing = planTiming(cfg, getStyle(cfg.mood));
  return {
    bpm: timing.bpm,
    duration: timing.duration,
    bars: timing.bars,
    adjusted: timing.adjusted,
  };
}

export interface ScorePart {
  kind: "notes" | "drums";
  role: string;
  track: TrackName;
  /** note parts: the voice that plays them */
  voice?: string;
}

export interface ScoreFacts {
  /** the parts that really have notes or hits */
  parts: ScorePart[];
  /** per mixer group: something plays in it */
  playing: Record<TrackName, boolean>;
  /** what is common to every group: tempo, length, room, mastering */
  frame: string;
  /** per mixer group: changes whenever its notes, hits or part settings do */
  content: Record<TrackName, string>;
  /** the chord symbols in order ("C G/B Am7 …"): the harmony as the strip names it */
  harmony: string;
}

/** FNV-1a over a string: a short stand-in for a long score dump. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(36);
}

const CACHE_SIZE = 12;
const cache = new Map<string, ScoreFacts>();

/**
 * The composed score of an engine-2 configuration, reduced to what the
 * interface needs. Composing takes a few milliseconds and the answer only
 * depends on the configuration (never on the faders), so the last few are
 * kept. null for a v0.2 (engine 1) configuration and when composing fails.
 */
export function scoreFacts(config: MusicConfig): ScoreFacts | null {
  if (config.engine !== 2) return null;
  const { volumes: _faders, prompt: _words, ...musical } = config;
  const key = JSON.stringify(musical);
  const known = cache.get(key);
  if (known) return known;
  let facts: ScoreFacts;
  try {
    const score = compose(config);
    const sounding = score.parts.filter(
      (part) => (part.kind === "notes" ? part.notes : part.hits).length > 0,
    );
    const sounds = (track: TrackName) =>
      sounding.filter((part) => part.track === track);
    facts = {
      parts: sounding.map((part) => ({
        kind: part.kind,
        role: part.role,
        track: part.track,
        ...(part.kind === "notes" ? { voice: part.voice } : {}),
      })),
      playing: Object.fromEntries(
        TRACKS.map((track) => [track, sounds(track).length > 0]),
      ) as Record<TrackName, boolean>,
      frame: hash(
        JSON.stringify([
          score.bpm,
          score.duration,
          score.loop,
          score.swing,
          score.space,
          score.master,
        ]),
      ),
      content: Object.fromEntries(
        TRACKS.map((track) => [track, hash(JSON.stringify(sounds(track)))]),
      ) as Record<TrackName, string>,
      harmony: score.chords.map((chord) => chord.symbol).join(" "),
    };
  } catch {
    return null;
  }
  if (cache.size >= CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, facts);
  return facts;
}

/**
 * Everything that can be heard of a configuration, as one comparable string:
 * two configurations sound different exactly when their keys differ. A group
 * with nothing written for it, or with its fader at zero, is silence — so a
 * fader moved on an empty group, or a layer added to a muted one, changes
 * nothing. null when the score is not known (engine 1).
 */
export function audibleKey(config: MusicConfig): string | null {
  const facts = scoreFacts(config);
  if (!facts) return null;
  return [
    facts.frame,
    ...TRACKS.map((track) =>
      facts.playing[track] && config.volumes[track] > 0
        ? `${facts.content[track]}@${config.volumes[track].toFixed(4)}`
        : "-",
    ),
  ].join("|");
}

/** A stem whose outline never leaves the floor: nothing was written for it. */
export function silentStem(peaks: readonly number[] | undefined): boolean {
  return !peaks || peaks.every((value) => !(value > 0.002));
}
