/**
 * chip and chipPulse — the two pulse channels of an 8-bit console.
 *
 * A band-limited (PolyBLEP) pulse and nothing else: no filter, no detune,
 * mono. What a console could do, the voices do, on its 60 Hz frame grid:
 * pitch bends and the vibrato of long notes move in frame steps, and
 * accented notes use the classic tricks — a volume envelope that starts
 * above the sustain level and falls back within a few frames, and (chip) a
 * first frame or two at a narrower duty before the square takes over.
 *
 * chip: 50 % square lead, full and hollow.
 * chipPulse: thin pulse for arpeggios and harmony, 25 % duty on soft notes
 *   narrowing to 12.5 % on hard ones (narrower = buzzier and thinner).
 */
import type { VoiceId } from "../../../music/score";
import type { Voice } from "../types";
import {
  Adsr,
  LEVEL_WINDOW,
  MIN_RAMP,
  REFERENCE_RMS,
  bendOffset,
  clamp,
  clamp01,
  midiToHz,
  noteOffFrame,
  polyBlep,
  scratch,
  sinTurns,
  smoothstep,
  velocityGain,
} from "../../dsp";
import { CENT, SEMITONE, onset } from "../../dsp/extra-sustained";

interface PulseConfig {
  id: VoiceId;
  /** duty cycle the note settles on */
  width(vel: number): number;
  /** duty of the opening frames of an accented note (0 = no duty change) */
  blipWidth: number;
  /** how far above the sustain level an accent starts, and its time constant */
  accent: number;
  accentTime: number;
  release: number;
  /** vibrato of long notes: delay (s), rate (Hz), depth (cents) */
  vibrato: [delay: number, rate: number, cents: number];
}

const CHIP: PulseConfig = {
  id: "chip",
  width: () => 0.5,
  blipWidth: 0.25,
  accent: 0.25,
  accentTime: 0.05,
  release: 0.012,
  vibrato: [0.28, 6.2, 7],
};

const CHIP_PULSE: PulseConfig = {
  id: "chipPulse",
  width: (vel) => 0.25 - 0.125 * smoothstep((vel - 0.35) / 0.6),
  blipWidth: 0,
  accent: 0.3,
  accentTime: 0.06,
  release: 0.008,
  vibrato: [0.32, 6.2, 5],
};

/** frames per second of the console the voices imitate */
const FRAME_RATE = 60;
const MAX_INC = 0.24;

function pulseVoice(config: PulseConfig): Voice {
  return {
    id: config.id,
    tail: () => config.release + 0.004,
    render(left, right, frames, note, ctx) {
      const sr = ctx.sampleRate;
      const vel = clamp(note.vel, 0.02, 1);
      const f0 = clamp(midiToHz(note.midi), 12, sr * 0.2);
      const width = config.width(vel);
      const strength = clamp01((vel - 0.3) / 0.6);

      // --- accent: starts above the sustain level and falls back ---
      const accent = config.accent * strength;
      const tau = config.accentTime;
      const window = LEVEL_WINDOW;
      const accentPower =
        1 +
        (2 * accent * tau * (1 - Math.exp(-window / tau))) / window +
        (accent * accent * tau * (1 - Math.exp((-2 * window) / tau))) /
          (2 * window);
      // mean square of the zero-mean pulse is 4w(1 - w)
      const gain =
        (REFERENCE_RMS * velocityGain(vel)) /
        Math.sqrt(4 * width * (1 - width) * accentPower);
      const accentCoef = Math.exp(-1 / (tau * sr));

      // --- duty blip: one frame on firm notes, two on the hardest ---
      const frameLength = sr / FRAME_RATE;
      const blipFrames =
        config.blipWidth > 0 ? (vel >= 0.9 ? 2 : vel >= 0.7 ? 1 : 0) : 0;
      let blipEnd = blipFrames * frameLength;

      const env = scratch(0, frames);
      new Adsr(sr, {
        attack: MIN_RAMP,
        decay: 0.1,
        sustain: 1,
        release: config.release,
        attackShape: "lin",
      }).render(env, frames, noteOffFrame(note, frames, sr, 0.004));

      const [vibDelay, vibRate, vibCents] = config.vibrato;
      const baseInc = f0 / sr;
      let inc = Math.min(MAX_INC, baseInc);
      let duty = blipFrames > 0 ? config.blipWidth : width;
      let phase = 0;
      let boost = accent;
      let nextFrame = 0;
      for (let i = 0; i < frames; i++) {
        if (i >= nextFrame) {
          // pitch moves on the frame grid, like a console's period register
          const t = i / sr;
          const semis = bendOffset(note.bend, t);
          const vibrato =
            onset(t, vibDelay, 0.12) *
            vibCents *
            CENT *
            sinTurns(vibRate * (t - vibDelay));
          inc = Math.min(
            MAX_INC,
            baseInc *
              (semis !== 0 ? Math.exp(semis * SEMITONE) : 1) *
              (1 + vibrato),
          );
          nextFrame += frameLength;
        }
        let shifted = phase + 1 - duty;
        if (shifted >= 1) shifted -= 1;
        const v =
          (phase < duty ? 2 : 0) -
          2 * duty +
          polyBlep(phase, inc) -
          polyBlep(shifted, inc);
        phase += inc;
        if (phase >= 1) {
          phase -= 1;
          // the duty register changes between two cycles
          if (blipEnd > 0 && i >= blipEnd) {
            duty = width;
            blipEnd = 0;
          }
        }
        const a = v * env[i] * gain * (1 + boost);
        boost *= accentCoef;
        left[i] += a;
        right[i] += a;
      }
    },
  };
}

export const chip = pulseVoice(CHIP);
export const chipPulse = pulseVoice(CHIP_PULSE);
