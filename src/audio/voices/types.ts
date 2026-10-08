/**
 * Synthesizer voice contract. A voice renders ONE note (or one drum hit) into
 * caller-provided stereo scratch buffers starting at index 0. The renderer
 * owns placement in time, wrap-around for loops, panning, part effects and
 * mixing, so voices stay small, pure and unit-testable.
 */
import type { DrumKind, DrumKitId, VoiceId } from "../../music/score";

export interface VoiceNote {
  /** MIDI note number (may be fractional) */
  midi: number;
  /** 0..1 */
  vel: number;
  /** held time in seconds */
  duration: number;
  /** optional glide-in offset in semitones (see NoteEvent.bend) */
  bend?: number;
}

export interface VoiceContext {
  sampleRate: number;
  /** deterministic 0..1 stream owned by the part; never use Math.random */
  random: () => number;
}

export interface Voice {
  id: VoiceId;
  /**
   * Seconds of sound after note-off for this note (release / ring-out).
   * The renderer allocates ceil((duration + tail) * sampleRate) frames.
   */
  tail(note: VoiceNote): number;
  /**
   * ADD the note into left/right[0 .. frames) — strictly additive, never use
   * the buffers as scratch (the renderer passes zeroed buffers today, but a
   * voice must not rely on that). Start and end at (near) zero — no clicks.
   *
   * Level convention (so parts are comparable and pads do not swamp plucks):
   * a 1-second A3..A4 note at vel 0.8 has a short-term RMS of about -18 dBFS
   * (±2 dB) over its loudest 400 ms, and never exceeds |1.0|. Bass voices
   * meet the same level at A1..A2. Velocity should change timbre (brightness
   * / attack) as well as level, roughly vel^1.5. A single plucked or struck
   * note at that RMS peaks around 0.45–0.6, so chords exceed 1.0 before the
   * part gain: the renderer keeps headroom, voices do not limit themselves.
   * Glides use the shared 70 ms curve in dsp/voice.ts (bendOffset).
   */
  render(
    left: Float32Array,
    right: Float32Array,
    frames: number,
    note: VoiceNote,
    ctx: VoiceContext,
  ): void;
}

/**
 * Drum level convention at vel 0.8 (peak): kick ≈ 0.8–0.9, snare ≈ 0.6–0.7,
 * hats ≈ 0.25–0.35; softer kits (lofi, brush, soft) sit proportionally lower
 * and the chip kit uses console levels. Velocity changes tone as well as
 * level. A buffer shorter than length() is faded out, which is how the
 * renderer chokes an open hat with the next hat.
 */
export interface DrumVoice {
  /** total length of the hit in seconds for this kit */
  length(kind: DrumKind, kit: DrumKitId): number;
  /** ADD one hit into left/right[0 .. frames); same rules as Voice.render */
  render(
    left: Float32Array,
    right: Float32Array,
    frames: number,
    kind: DrumKind,
    kit: DrumKitId,
    vel: number,
    ctx: VoiceContext,
  ): void;
}

export type VoiceBank = Record<VoiceId, Voice>;
