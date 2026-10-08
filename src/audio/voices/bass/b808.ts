/**
 * bass808 — the long sub of a TR-808 kick used as a bass.
 *
 * A sine whose pitch starts 5 to 14 semitones above the note (more with
 * velocity) and drops onto it within about 40 ms: the thump that lets every
 * note speak. The sine is then driven into a slightly asymmetric soft
 * clipper, which adds the 2nd and 3rd harmonics a phone or laptop speaker
 * needs to imply the fundamental; harder notes are driven harder. It holds
 * (sagging slowly towards 70 %) for as long as the note is held and lets go
 * over 260 ms. Mono. NoteEvent.bend is the trap-style glide into the note.
 * The waveshape is static per note, so its DC and RMS are measured over one
 * cycle up front: no DC, exact level.
 */
import type { Voice } from "../types";
import {
  Adsr,
  REFERENCE_RMS,
  bendOffset,
  clamp,
  fastTanh,
  midiToHz,
  noteOffFrame,
  scratch,
  sinPhase,
  velocityGain,
} from "../../dsp";
import { SEMITONE } from "../../dsp/extra-sustained";

const SHAPE_POINTS = 256;
/** offset into the clipper: makes it asymmetric (even harmonics) */
const BIAS = 0.6;
/** time constant of the pitch drop, seconds */
const DROP = 0.011;
const RELEASE = 0.26;
const CONTROL = 4;
const MAX_INC = 0.24;
/** amplitude envelope: sags from 1 towards SUSTAIN (a full fall would take DECAY seconds) */
const SUSTAIN = 0.7;
const DECAY = 6;

export const bass808: Voice = {
  id: "bass808",
  tail: () => RELEASE + 0.02,
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const vel = clamp(note.vel, 0.02, 1);
    const f0 = clamp(midiToHz(note.midi), 10, sr * 0.2);
    const drive = 1.1 + 3.1 * Math.pow(vel, 1.2);
    const sweep = 5 + 9 * vel;

    // --- measure the static waveshape: remove its DC, normalise its RMS ---
    let mean = 0;
    let square = 0;
    for (let i = 0; i < SHAPE_POINTS; i++) {
      const v = fastTanh(drive * sinPhase(i / SHAPE_POINTS) + BIAS);
      mean += v;
      square += v * v;
    }
    mean /= SHAPE_POINTS;
    const rms = Math.sqrt(Math.max(1e-12, square / SHAPE_POINTS - mean * mean));
    // the loudest 400 ms start right after the attack, where the envelope has sagged a little
    const gain = (REFERENCE_RMS * velocityGain(vel) * 1.066) / rms;

    const env = scratch(0, frames);
    new Adsr(sr, {
      attack: 0.003,
      decay: DECAY,
      sustain: SUSTAIN,
      release: RELEASE,
      attackShape: "cos",
    }).render(env, frames, noteOffFrame(note, frames, sr, 0.01));

    // the drop is over (below a tenth of a cent) after 12 time constants
    const settle = Math.ceil(Math.max(12 * DROP, note.bend ? 0.08 : 0) * sr);
    const baseInc = Math.min(MAX_INC, f0 / sr);
    let inc = baseInc;
    let phase = 0;
    for (let i = 0; i < frames; i++) {
      if (i < settle) {
        if ((i & (CONTROL - 1)) === 0) {
          const t = i / sr;
          inc = Math.min(
            MAX_INC,
            baseInc *
              Math.exp(
                (sweep * Math.exp(-t / DROP) + bendOffset(note.bend, t)) *
                  SEMITONE,
              ),
          );
        }
      } else inc = baseInc;
      const v =
        (fastTanh(drive * sinPhase(phase) + BIAS) - mean) * gain * env[i];
      left[i] += v;
      right[i] += v;
      phase += inc;
      if (phase >= 1) phase -= 1;
    }
  },
};
