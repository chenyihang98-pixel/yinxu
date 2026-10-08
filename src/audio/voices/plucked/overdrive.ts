/**
 * Overdrive: distorted electric guitar for power chords and riffs.
 */
import type { Voice } from "../types";
import {
  BEND_TIME,
  Biquad,
  biquadChain,
  KarplusString,
  Oversampler2x,
  REFERENCE_RMS,
  bendOffset,
  clamp,
  fastTanh,
  forkRng,
  makePluck,
  midiToHz,
  noteOffFrame,
  pluckLength,
  pluckSpectrum,
  scratch,
  velocityGain,
} from "../../dsp";
import type { PluckOptions, Random } from "../../dsp";
import { LevelTable, mixNote, velocityCeiling } from "../../dsp/extra-keys";

/**
 * A solid-body guitar into a high-gain amplifier, stage by stage:
 *  - STRING: Karplus-Strong steel string picked hard near the bridge. With
 *    no acoustic body to drive it rings long (about 20 s at A2, 16 s at A4);
 *  - PRE-EMPHASIS, what an overdrive pedal does before it clips: low end cut
 *    at 110 Hz so chords stay tight instead of flubby, a mid hump at 1 kHz
 *    (the "honk" that makes the clipper buzz), top rolled off at 6.5 kHz;
 *  - GAIN and CLIPPING: the string is scaled to a known level (predicted
 *    from its harmonics) and driven up to 30 dB into a slightly asymmetric
 *    tanh, run at twice the sample rate so the harmonics it creates fold
 *    back far less. The clipper is also what makes the note SUSTAIN: while
 *    the string fades by 20 dB the output barely moves;
 *  - CABINET: a 12-inch speaker passes little below 90 Hz or above 4.6 kHz
 *    (24 dB/octave), thumps near 120 Hz and has a presence peak that differs
 *    a little left and right (two microphones on the cone): mild stereo.
 *  - note-off: the palm stops the string and the output is faded in 55 ms,
 *    otherwise the clipper would hold the dying string at full level.
 * Velocity picks harder (brighter string), drives the amp further and plays
 * louder. NoteEvent.bend bends the string before the amp, as a player would.
 * Each note is distorted on its own: chord notes do not intermodulate.
 */
const LOWEST_HZ = 30;
const BIAS = 0.3;
const RELEASE = 0.055;
const TAIL = 0.07;

interface AmpRig {
  string: KarplusString;
  pre: Biquad[];
  post: Biquad[];
  presenceLeft: Biquad;
  presenceRight: Biquad;
  oversampler: Oversampler2x;
}

const rigs = new Map<number, AmpRig>();

function ampRig(sampleRate: number): AmpRig {
  let rig = rigs.get(sampleRate);
  if (rig) return rig;
  rig = {
    string: new KarplusString(sampleRate, LOWEST_HZ),
    pre: [
      new Biquad().setHighpass(110, 0.7, sampleRate),
      new Biquad().setPeak(1000, 0.6, 5, sampleRate),
      new Biquad().setLowpass(6500, 0.7, sampleRate),
    ],
    post: [
      new Biquad().setHighpass(90, 0.8, sampleRate),
      new Biquad().setPeak(122, 1.6, 3, sampleRate),
      new Biquad().setLowpass(4600, 0.85, sampleRate),
      new Biquad().setLowpass(5600, 0.6, sampleRate),
    ],
    presenceLeft: new Biquad().setPeak(2350, 1.5, 4, sampleRate),
    presenceRight: new Biquad().setPeak(2900, 1.5, 4, sampleRate),
    oversampler: new Oversampler2x(),
  };
  rigs.set(sampleRate, rig);
  return rig;
}

function overdriveCore(
  l: Float32Array,
  r: Float32Array,
  frames: number,
  hold: number,
  midi: number,
  velocity: number,
  bend: number | undefined,
  sr: number,
  parent: Random,
): void {
  const rig = ampRig(sr);
  const string = rig.string;
  const random = forkRng(parent);
  const vel = clamp(velocity, 0.02, 1);
  const f0 = clamp(midiToHz(midi), LOWEST_HZ * 1.02, sr / 5);

  // --- string ---
  string.reset();
  string.setFrequency(f0);
  string.setDispersion(-0.1, 1);
  const ring = 20 * Math.pow(110 / f0, 0.15);
  string.setDecay(ring, 0.9, 4000);
  const pick: PluckOptions = {
    sampleRate: sr,
    period: string.period,
    // the pick stays where it is while the fretted string gets shorter
    position:
      clamp(0.12 * Math.pow(2, (midi - 40) / 24), 0.12, 0.3) + 0.03 * random(),
    // a magnetic pickup hears string velocity: harmonics fall off as 1/k
    bodyHz: f0 * 1.4 + 200 + 700 * vel * vel,
    hardnessHz: 2400 + 6000 * Math.pow(vel, 1.5),
    noise: 0.05,
  };
  const excitationLength = pluckLength(pick);
  const excitation = scratch(3, excitationLength);
  makePluck(excitation, pick, random);
  string.excite(excitation, excitationLength);

  // --- level of the string after the pre-emphasis, from its harmonics ---
  const period = string.period;
  const harmonics = Math.min(48, Math.floor((sr * 0.45) / f0));
  let power = 0;
  for (let k = 1; k <= harmonics; k++) {
    const hz = k * f0;
    let amp = (2 / period) * pluckSpectrum(hz, pick);
    for (const filter of rig.pre) amp *= filter.magnitude(hz, sr);
    power += 0.5 * amp * amp;
  }
  // clean when brushed, crunch when stroked, full saturation (30 dB) when hit
  const drive = (0.6 + 30 * vel * vel) / Math.sqrt(Math.max(power, 1e-18));

  // --- string, bent before the amplifier ---
  const raw = scratch(2, frames);
  if (bend) {
    const bendFrames = Math.ceil(BEND_TIME * sr);
    for (let i = 0; i < frames; i++) {
      if (i === hold) string.setDecay(0.12, 0.04, 4000);
      raw[i] = string.nextBent(
        i < bendFrames ? Math.pow(2, bendOffset(bend, i / sr) / 12) : 1,
      );
    }
  } else {
    string.process(raw, 0, hold);
    string.setDecay(0.12, 0.04, 4000);
    string.process(raw, hold, frames - hold);
  }
  biquadChain(rig.pre, raw, frames);

  // --- clipper at twice the sample rate ---
  const oversampler = rig.oversampler;
  oversampler.reset();
  const offset = fastTanh(BIAS);
  for (let i = 0; i < frames; i++) {
    oversampler.up(raw[i] * drive);
    raw[i] = oversampler.down(
      fastTanh(oversampler.a + BIAS) - offset,
      fastTanh(oversampler.b + BIAS) - offset,
    );
  }

  // --- cabinet, two microphones ---
  biquadChain(rig.post, raw, frames);
  rig.presenceLeft.reset();
  rig.presenceRight.reset();
  const releaseFrames = Math.max(
    1,
    Math.min(frames - hold, Math.round(RELEASE * sr)),
  );
  for (let i = 0; i < frames; i++) {
    let s = raw[i];
    if (i >= hold) {
      const x = (i - hold + 1) / releaseFrames;
      s *= x >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * x);
    }
    l[i] = rig.presenceLeft.next(s);
    r[i] = rig.presenceRight.next(s);
  }
}

const level = new LevelTable({
  low: 24,
  high: 104,
  step: 2,
  // dense where the amp goes from clean to clipping
  velocities: [0.05, 0.12, 0.2, 0.3, 0.42, 0.55, 0.7, 0.85, 1],
  probe(left, right, frames, midi, vel, sampleRate, random) {
    overdriveCore(
      left,
      right,
      frames,
      frames,
      midi,
      vel,
      undefined,
      sampleRate,
      random,
    );
  },
});

export const overdrive: Voice = {
  id: "overdrive",
  tail: () => TAIL,
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const vel = clamp(note.vel, 0.02, 1);
    const gain =
      (REFERENCE_RMS * velocityGain(vel)) / level.rms(note.midi, vel, sr);
    const l = scratch(0, frames);
    const r = scratch(1, frames);
    overdriveCore(
      l,
      r,
      frames,
      noteOffFrame(note, frames, sr, 0.02),
      note.midi,
      vel,
      note.bend,
      sr,
      ctx.random,
    );
    mixNote(
      left,
      right,
      l,
      r,
      frames,
      gain,
      0,
      0.012 * sr,
      velocityCeiling(vel),
    );
  },
};
