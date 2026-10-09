/**
 * Engine v1 — the v0.2 synthesizer, frozen. It only exists so works saved
 * before v0.3 (config.engine === 1) rebuild sample-for-sample the same.
 * Do not improve it; new music is rendered by engine v2 (render.ts).
 */
import type { MusicConfig, TrackName } from "../types";

export type LegacyMood =
  "bright" | "chill" | "cinematic" | "dreamy" | "focus" | "retro";
export type LegacyInstrument = "piano" | "guitar" | "synth" | "bell";
export const LEGACY_MOODS: readonly LegacyMood[] = [
  "bright",
  "chill",
  "cinematic",
  "dreamy",
  "focus",
  "retro",
];
export const LEGACY_INSTRUMENTS: readonly LegacyInstrument[] = [
  "piano",
  "guitar",
  "synth",
  "bell",
];
export const LEGACY_KEYS: readonly string[] = [
  "C major",
  "D major",
  "G major",
  "A minor",
  "D minor",
];
type Instrument = LegacyInstrument;
export interface LegacyRenderResult {
  buffer: AudioBuffer;
  stems: Record<TrackName, AudioBuffer>;
  peaks: number[];
}
type RenderResult = LegacyRenderResult;

const RATE = 32000;
const TRACKS: TrackName[] = ["melody", "chords", "bass", "drums"];
const TABLE_SIZE = 4096;
const SIN = Float32Array.from({ length: TABLE_SIZE + 1 }, (_, i) =>
  Math.sin((i * Math.PI * 2) / TABLE_SIZE),
);
const TAU = Math.PI * 2;
const yieldToBrowser = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
const clamp = (n: number, low: number, high: number) =>
  Math.max(low, Math.min(high, n));

/** Mulberry32 permits repeatable variations, exports, and regression checks. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function oscillator(phase: number): number {
  const p = phase % TABLE_SIZE;
  const i = p | 0;
  return SIN[i] + (SIN[i + 1] - SIN[i]) * (p - i);
}

type Stereo = [Float32Array, Float32Array];
type Voice = Instrument | "pad" | "bass";
interface Note {
  track: TrackName;
  midi: number;
  time: number;
  duration: number;
  gain: number;
  voice: Voice;
  pan: number;
}
const tones = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

function addNote(channels: Stereo, note: Note, loop: boolean) {
  const frequency = tones(note.midi);
  const phaseStep = (frequency * TABLE_SIZE) / RATE;
  const attack =
    note.voice === "pad"
      ? 0.14
      : note.voice === "synth"
        ? 0.025
        : note.voice === "bass"
          ? 0.012
          : 0.004;
  const release =
    note.voice === "pad"
      ? 0.7
      : note.voice === "bell"
        ? 1.0
        : note.voice === "guitar"
          ? 0.18
          : 0.28;
  const start = Math.round(note.time * RATE);
  const length = Math.ceil((note.duration + release) * RATE);
  const noteEnd = note.duration * RATE;
  const aSamples = attack * RATE;
  const rSamples = release * RATE;
  const left = Math.sqrt((1 - note.pan) / 2) * note.gain;
  const right = Math.sqrt((1 + note.pan) / 2) * note.gain;
  const decayRate =
    note.voice === "guitar"
      ? 2.6
      : note.voice === "bell"
        ? 1.55
        : note.voice === "piano"
          ? 1.2
          : 0.06;
  const decayStep = Math.exp(-decayRate / RATE);
  const brightStep = Math.exp(-7 / RATE);
  const subStep = phaseStep * 0.5;
  const total = channels[0].length;
  let phase = 0;
  let subPhase = 0;
  let decay = 1;
  let brightness = 1;
  for (let i = 0; i < length; i++) {
    let index = start + i;
    if (index >= total) {
      if (!loop) break;
      index %= total;
    }
    let envelope = Math.min(1, i / aSamples);
    if (i > noteEnd) {
      const tail = (i - noteEnd) / rSamples;
      envelope *= (1 - tail) ** 2;
    }
    envelope *= decay;
    const fundamental = oscillator(phase);
    let sample: number;
    if (note.voice === "piano")
      sample =
        fundamental +
        (0.3 + brightness * 0.15) * oscillator(phase * 2) +
        0.16 * brightness * oscillator(phase * 3) +
        0.07 * brightness * oscillator(phase * 7.003);
    else if (note.voice === "guitar")
      sample =
        fundamental +
        0.42 * brightness * oscillator(phase * 2) -
        0.24 * brightness * oscillator(phase * 3) +
        0.09 * brightness * oscillator(phase * 5);
    else if (note.voice === "bell")
      sample =
        fundamental +
        0.35 * brightness * oscillator(phase * 2.756) +
        0.17 * brightness * oscillator(phase * 5.404);
    else if (note.voice === "synth")
      sample =
        0.7 * fundamental +
        0.22 * oscillator(phase * 2) +
        0.12 * oscillator(phase * 3) +
        0.11 * oscillator(phase * 1.004);
    else if (note.voice === "pad")
      sample =
        0.65 * fundamental +
        0.18 * oscillator(phase * 1.002) +
        0.08 * oscillator(phase * 2);
    else
      sample =
        0.85 * fundamental +
        0.2 * oscillator(phase * 2) +
        0.08 * oscillator(subPhase);
    channels[0][index] += sample * envelope * left;
    channels[1][index] += sample * envelope * right;
    // Retain absolute phase for inharmonic partials; wrapping each partial independently avoids resets.
    phase += phaseStep;
    subPhase += subStep;
    decay *= decayStep;
    brightness *= brightStep;
  }
}

function addDrum(
  channels: Stereo,
  kind: "kick" | "snare" | "hat" | "shaker",
  time: number,
  gain: number,
  loop: boolean,
  random: () => number,
) {
  const duration =
    kind === "kick"
      ? 0.35
      : kind === "snare"
        ? 0.2
        : kind === "hat"
          ? 0.065
          : 0.11;
  const start = Math.round(time * RATE),
    length = Math.ceil(duration * RATE),
    total = channels[0].length;
  let phase = 0,
    previousNoise = 0;
  for (let i = 0; i < length; i++) {
    let index = start + i;
    if (index >= total) {
      if (!loop) break;
      index %= total;
    }
    const t = i / RATE;
    const noise = random() * 2 - 1;
    const high = noise - previousNoise * 0.85;
    previousNoise = noise;
    let sample: number;
    if (kind === "kick") {
      phase += (TAU * (48 + 85 * Math.exp(-t * 38))) / RATE;
      sample =
        Math.sin(phase) * Math.exp(-t * 13) + noise * Math.exp(-t * 180) * 0.1;
    } else if (kind === "snare")
      sample =
        (0.62 * high + 0.38 * Math.sin(TAU * 174 * t)) * Math.exp(-t * 24);
    else sample = high * Math.exp(-t * (kind === "hat" ? 75 : 42)) * 0.5;
    const edge = Math.min(1, i / 24) * Math.min(1, (length - i) / 100);
    channels[0][index] +=
      sample * gain * edge * (kind === "hat" ? 0.65 : 0.707);
    channels[1][index] +=
      sample * gain * edge * (kind === "hat" ? 0.76 : 0.707);
  }
}

const moodHarmony = {
  bright: [
    [0, 4, 5, 3],
    [0, 3, 4, 0],
  ],
  chill: [
    [0, 5, 1, 4],
    [3, 2, 1, 4],
  ],
  cinematic: [
    [0, 5, 2, 6],
    [0, 3, 5, 4],
  ],
  dreamy: [
    [3, 0, 5, 4],
    [0, 2, 3, 0],
  ],
  focus: [
    [0, 3, 0, 4],
    [0, 5, 3, 4],
  ],
  retro: [
    [0, 5, 3, 6],
    [0, 2, 5, 4],
  ],
};

function degreeToMidi(degree: number, scale: number[], root: number): number {
  return root + scale[((degree % 7) + 7) % 7] + Math.floor(degree / 7) * 12;
}

async function addSpace(
  channels: Stereo,
  amount: number,
  loop: boolean,
  progress: () => void,
) {
  if (!amount) return;
  const dryLeft = channels[0].slice(),
    dryRight = channels[1].slice();
  const taps = [
    [0.071, 0.17],
    [0.127, 0.135],
    [0.211, 0.1],
    [0.331, 0.075],
    [0.487, 0.045],
  ];
  const length = channels[0].length;
  for (let tap = 0; tap < taps.length; tap++) {
    const [delay, strength] = taps[tap];
    const offsetL = Math.round(delay * RATE),
      offsetR = Math.round((delay + 0.013) * RATE);
    const gain = strength * amount;
    for (let i = 0; i < length; i++) {
      const l = i - offsetL,
        r = i - offsetR;
      if (l >= 0 || loop)
        channels[0][i] +=
          (tap % 2 ? dryRight : dryLeft)[(l + length) % length] * gain;
      if (r >= 0 || loop)
        channels[1][i] +=
          (tap % 2 ? dryLeft : dryRight)[(r + length) % length] * gain;
    }
    progress();
    await yieldToBrowser();
  }
}

function makeBuffer(length: number, sampleRate = RATE) {
  return new AudioBuffer({ length, numberOfChannels: 2, sampleRate });
}

/** Offline deterministic score + instrument synthesis, no network or audio permission required. */
export async function renderMusic(
  input: MusicConfig,
  onProgress?: (progress: number) => void,
): Promise<RenderResult> {
  const config = {
    ...input,
    mood: (LEGACY_MOODS as readonly string[]).includes(input.mood)
      ? (input.mood as LegacyMood)
      : "bright",
    instrument: (LEGACY_INSTRUMENTS as readonly string[]).includes(
      input.instrument,
    )
      ? (input.instrument as LegacyInstrument)
      : "piano",
    bpm: clamp(input.bpm, 60, 160),
    duration: clamp(input.duration, 15, 120),
    energy: clamp(input.energy, 0, 1),
    complexity: clamp(input.complexity, 0, 1),
  };
  const length = Math.round(config.duration * RATE);
  const stems = Object.fromEntries(
    TRACKS.map((track) => [track, makeBuffer(length)]),
  ) as Record<TrackName, AudioBuffer>;
  const channels = Object.fromEntries(
    TRACKS.map((track) => [
      track,
      [stems[track].getChannelData(0), stems[track].getChannelData(1)],
    ]),
  ) as Record<TrackName, Stereo>;
  const random = seededRandom(config.seed);
  const percussionRandom = seededRandom(config.seed ^ 0xabc123);
  const minor = config.key.includes("minor");
  const scale = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const root =
    ({ C: 48, D: 50, G: 43, A: 45 } as Record<string, number>)[config.key[0]] ??
    48;
  const beat = 60 / config.bpm,
    barDuration = beat * 4;
  const bars = Math.ceil(config.duration / barDuration);
  const progressions = moodHarmony[config.mood];
  const progression = progressions[Math.floor(random() * progressions.length)];
  const motif = Array.from({ length: 8 }, (_, i) =>
    i === 0 || i === 4 ? 0 : Math.floor(random() * 5),
  );
  const density =
    config.mood === "focus" ? 0.55 : config.mood === "cinematic" ? 0.6 : 1;
  onProgress?.(0.01);
  await yieldToBrowser();
  for (let bar = 0; bar < bars; bar++) {
    const time = bar * barDuration;
    const degree = progression[bar % progression.length];
    const chordDegrees = [degree, degree + 2, degree + 4];
    if (config.complexity > 0.55 || config.mood === "chill")
      chordDegrees.push(degree + 6);
    const phraseStrength = config.loop
      ? 1
      : bar === 0
        ? 0.82
        : bar === bars - 1
          ? 0.7
          : 1;
    const force = (0.65 + config.energy * 0.55) * phraseStrength;
    const notes: Note[] = [];
    const voice = config.instrument;
    // Spread the harmony across the stereo field with close, gentle voice leading.
    chordDegrees.forEach((d, j) => {
      let midi = degreeToMidi(d, scale, root);
      while (midi > 67) midi -= 12;
      notes.push({
        track: "chords",
        midi,
        time: time + j * 0.017,
        duration: barDuration * 0.88,
        gain: 0.078 * force,
        voice: config.mood === "retro" ? "synth" : "pad",
        pan: [-0.48, 0.1, 0.5, -0.2][j],
      });
    });
    const bassBeats =
      config.mood === "retro"
        ? [0, 1, 2, 2.5, 3]
        : config.energy > 0.62
          ? [0, 1.5, 2, 3]
          : [0, 2];
    bassBeats.forEach((b, j) =>
      notes.push({
        track: "bass",
        midi:
          degreeToMidi(
            degree + (j % 2 && config.mood === "bright" ? 4 : 0),
            scale,
            root,
          ) - 12,
        time: time + b * beat,
        duration: beat * (config.mood === "retro" ? 0.65 : 1.35),
        gain: 0.2 * force,
        voice: "bass",
        pan: 0,
      }),
    );
    const steps = config.complexity > 0.55 || config.mood === "retro" ? 8 : 4;
    for (let step = 0; step < steps; step++) {
      if (step !== 0 && random() > (0.6 + config.complexity * 0.38) * density)
        continue;
      const position = (step * 4) / steps;
      const chordTone =
        chordDegrees[motif[(step + (bar % 2) * 4) % 8] % chordDegrees.length];
      const passing =
        step % 2 && config.complexity > 0.55 && random() > 0.55 ? 1 : 0;
      let midi = degreeToMidi(chordTone + passing, scale, root) + 12;
      while (midi > 83) midi -= 12;
      while (midi < 64) midi += 12;
      // Answer the repeating motif on every fourth bar.
      if (bar % 4 === 3 && step === steps - 1)
        midi = degreeToMidi(degree, scale, root) + 12;
      const swing = config.mood === "chill" && step % 2 ? beat * 0.1 : 0;
      notes.push({
        track: "melody",
        midi,
        time: time + position * beat + swing,
        duration: beat * (4 / steps) * (voice === "bell" ? 0.65 : 0.83),
        gain: 0.2 * force * (0.83 + random() * 0.17),
        voice,
        pan: config.mood === "dreamy" ? (step % 2 ? -0.2 : 0.2) : 0.08,
      });
    }
    for (const note of notes) {
      if (note.time < config.duration)
        addNote(channels[note.track], note, config.loop);
    }
    if (config.mood !== "dreamy" || config.energy > 0.4) {
      const drumScale =
        config.mood === "focus" ? 0.45 : config.mood === "cinematic" ? 0.72 : 1;
      const drum = (
        kind: "kick" | "snare" | "hat" | "shaker",
        b: number,
        gain: number,
      ) => {
        const start = time + b * beat;
        if (start < config.duration)
          addDrum(
            channels.drums,
            kind,
            start,
            gain * force * drumScale,
            config.loop,
            percussionRandom,
          );
      };
      [0, 2].forEach((b) => drum("kick", b, 0.38));
      if (config.energy > 0.65) drum("kick", 3.5, 0.22);
      if (config.mood !== "cinematic")
        [1, 3].forEach((b) =>
          drum("snare", b, config.mood === "chill" ? 0.12 : 0.18),
        );
      const subdivisions = config.energy > 0.35 ? 8 : 4;
      for (let h = 0; h < subdivisions; h++)
        drum(
          config.mood === "chill" ? "shaker" : "hat",
          (h * 4) / subdivisions +
            (config.mood === "chill" && h % 2 ? 0.09 : 0),
          h % 2 ? 0.065 : 0.085,
        );
    }
    onProgress?.(0.02 + ((bar + 1) / bars) * 0.68);
    await yieldToBrowser();
  }
  let effectStep = 0;
  for (const track of TRACKS) {
    await addSpace(
      channels[track],
      clamp(config.reverb, 0, 1) *
        (track === "bass" ? 0.12 : track === "drums" ? 0.3 : 1),
      config.loop,
      () => onProgress?.(0.7 + (++effectStep / 20) * 0.23),
    );
    if (!config.loop) {
      const fadeIn = RATE * 0.018,
        fadeOut = Math.min(RATE * 1.2, length * 0.1);
      for (let i = 0; i < length; i++) {
        const envelope = Math.min(1, i / fadeIn, (length - 1 - i) / fadeOut);
        channels[track][0][i] *= envelope;
        channels[track][1][i] *= envelope;
      }
    }
    await yieldToBrowser();
  }
  onProgress?.(0.95);
  await yieldToBrowser();
  const buffer = mixStems(stems, config.volumes);
  const peaks = computePeaks(buffer);
  onProgress?.(1);
  return { buffer, stems, peaks };
}

export function mixStems(
  stems: Record<TrackName, AudioBuffer>,
  volumes: Record<TrackName, number>,
): AudioBuffer {
  const first = stems.melody;
  const result = makeBuffer(first.length, first.sampleRate);
  let peak = 0;
  for (let channel = 0; channel < 2; channel++) {
    const destination = result.getChannelData(channel);
    for (const track of TRACKS) {
      const gain = clamp(volumes[track], 0, 1);
      if (!gain) continue;
      const source = stems[track].getChannelData(
        Math.min(channel, stems[track].numberOfChannels - 1),
      );
      for (let i = 0; i < destination.length; i++)
        destination[i] += source[i] * gain;
    }
    for (let i = 0; i < destination.length; i++)
      peak = Math.max(peak, Math.abs(destination[i]));
  }
  if (peak > 0.96) {
    const scale = 0.96 / peak;
    for (let channel = 0; channel < 2; channel++) {
      const data = result.getChannelData(channel);
      for (let i = 0; i < data.length; i++) data[i] *= scale;
    }
  }
  return result;
}

export function computePeaks(buffer: AudioBuffer, count = 140): number[] {
  const bins = Math.max(1, Math.floor(count));
  const result = new Array<number>(bins).fill(0);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let bin = 0; bin < bins; bin++) {
      const start = Math.floor((bin * data.length) / bins),
        end = Math.floor(((bin + 1) * data.length) / bins);
      for (
        let i = start;
        i < end;
        i += Math.max(1, Math.floor((end - start) / 100))
      )
        result[bin] = Math.max(result[bin], Math.abs(data[i]));
    }
  }
  const max = Math.max(...result, 0.001);
  return result.map((value) => value / max);
}

/** Interleaved little-endian PCM, with standard RIFF headers for any audio editor. */
export function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const channelCount = buffer.numberOfChannels;
  const dataSize = buffer.length * channelCount * 2;
  const result = new ArrayBuffer(44 + dataSize),
    view = new DataView(result);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  const channels = Array.from({ length: channelCount }, (_, i) =>
    buffer.getChannelData(i),
  );
  for (let i = 0; i < buffer.length; i++)
    for (let ch = 0; ch < channelCount; ch++) {
      const sample = clamp(channels[ch][i], -1, 1);
      view.setInt16(
        44 + (i * channelCount + ch) * 2,
        Math.round(sample * (sample < 0 ? 32768 : 32767)),
        true,
      );
    }
  return result;
}
