/**
 * Score IR — the contract between the symbolic composer (src/music/*) and the
 * synthesizer (src/audio/*). The composer decides WHAT is played and when; the
 * renderer only turns events into sound. Everything here is plain data
 * (structured-clone safe) so a Score can be posted to a Web Worker.
 *
 * All times are in SECONDS from the start of the piece, already including
 * swing and humanisation. `vel` is 0..1.
 */
import type { InstrumentId, SectionType, StyleId } from "./catalog";

/** Engine v2 renders and exports at 48 kHz stereo. */
export const SAMPLE_RATE = 48000;

/**
 * A "cymbalSwell" hit is a riser: DrumEvent.t is where it STARTS and it peaks
 * this many seconds later, so the composer places it that long before the
 * downbeat it leads into. Shared by the composer and the drum synthesizer.
 */
export const CYMBAL_SWELL_SECONDS = 1.8;

/** The four mixer groups the user controls. Every part belongs to exactly one. */
export type TrackName = "melody" | "chords" | "bass" | "drums";
export const TRACKS: readonly TrackName[] = [
  "melody",
  "chords",
  "bass",
  "drums",
];

/** Pitched timbres the synthesizer must implement (see src/audio/voices). */
export const VOICE_IDS = [
  // selectable lead instruments — identical to InstrumentId
  "piano",
  "epiano",
  "guitar",
  "synth",
  "pluck",
  "bell",
  "musicbox",
  "marimba",
  "vibes",
  "flute",
  "strings",
  "guzheng",
  "dizi",
  "chip",
  // accompaniment-only voices
  "pad", // warm, slow analog-style pad
  "airpad", // bright, breathy / glassy pad for dreamy & ambient
  "brass", // section brass stabs and swells (epic)
  "choir", // soft "aah" formant pad
  "organ", // soft drawbar organ (jazz / corporate comping)
  "nylon", // nylon-string guitar comping
  "chipPulse", // 25% pulse for chiptune harmony arps
  "subBass", // sine/triangle sub
  "fingerBass", // electric finger bass
  "synthBass", // saw/square filtered bass
  "uprightBass", // jazz double bass pizzicato
  "chipBass", // triangle-wave chip bass
  "bass808", // long sine sub with pitch drop and drive (hip-hop)
  "pizzicato", // plucked strings (cute / cinematic ostinato)
  "overdrive", // distorted electric guitar for power chords (rock)
] as const;
export type VoiceId = (typeof VOICE_IDS)[number];

export const DRUM_KINDS = [
  "kick",
  "snare",
  "rim",
  "clap",
  "hatClosed",
  "hatOpen",
  "ride",
  "crash",
  "tomLow",
  "tomMid",
  "tomHigh",
  "shaker",
  "tambourine",
  "woodblock",
  "brushSnare", // jazz brush stroke
  "taiko", // big cinematic drum
  "cymbalSwell", // reversed/rolled cymbal riser into a section
  "subBoom", // low cinematic impact
  "noiseHit", // chiptune noise-channel snare
  "noiseTick", // chiptune noise-channel hat
  "sleighBell", // festive jingle
  "gong", // low gong / tam-tam accent (guofeng, tension)
  "fingerSnap", // lo-fi / hip-hop backbeat layer
] as const;
export type DrumKind = (typeof DRUM_KINDS)[number];

/** Sonic character of the drum synthesis, chosen by the style. */
export const DRUM_KITS = [
  "pop", // clean, tight acoustic-electronic hybrid
  "lofi", // soft, dusty, low-passed
  "electro", // 80s drum-machine
  "acoustic", // roomy, natural
  "brush", // jazz brushes
  "cinematic", // taiko / booms / swells
  "chip", // noise-channel only
  "soft", // very gentle percussion for focus / ambient
] as const;
export type DrumKitId = (typeof DRUM_KITS)[number];

export interface NoteEvent {
  /** start time, seconds */
  t: number;
  /** held duration in seconds (the voice adds its own release tail) */
  d: number;
  /** MIDI note number, may be fractional for detune/bends */
  midi: number;
  /** 0..1 */
  vel: number;
  /**
   * Optional ornament: the note starts this many semitones away from `midi`
   * and glides onto it within ~70 ms (guzheng/dizi slides, string scoops,
   * 808 glides). Leads use about ±3; basses may use up to ±12.
   */
  bend?: number;
}
export interface DrumEvent {
  t: number;
  kind: DrumKind;
  /** 0..1 */
  vel: number;
}

/** Per-part mix settings applied by the renderer after the notes are summed. */
export interface PartMix {
  /** linear gain before the group bus, typically 0.2..1.5 (at most 3) */
  gain: number;
  /** -1 (left) .. 1 (right) */
  pan: number;
  /** 0 = mono-centred, 1 = natural stereo of the voice, up to 1.5 widened */
  width: number;
  /** 0..1 send into the group's reverb */
  reverb: number;
  /** 0..1 send into the tempo-synced stereo delay */
  delay: number;
  /** 0..1 chorus/ensemble amount */
  chorus: number;
  /** high-pass corner in Hz (0 = off) */
  lowCut: number;
  /** low-pass corner in Hz (0 = off) */
  highCut: number;
  /**
   * 0..1 saturation BEFORE the part gain: tanh((1 + 5·drive)·x), scaled so an
   * amplitude of 0.25 passes unchanged. On the part's own bus a single note
   * peaks at 0.3–1, a four-note stab near 2 and a drum kit near 1, far above
   * that pivot — so on percussive parts this is a clipper more than a colour:
   * 0.05 takes about 3 dB off a kick's peak, 0.12 about 4 dB, 0.3 about 7 dB,
   * while quiet material is lifted slightly. Sustained parts gain harmonics.
   */
  drive: number;
  /** 0..1 how strongly this part ducks under the kick (sidechain feel) */
  duck: number;
}

export type PartRole =
  "lead" | "counter" | "arp" | "comp" | "pad" | "bass" | "kit" | "perc";

export interface NotePart {
  kind: "notes";
  id: string;
  track: TrackName;
  role: PartRole;
  voice: VoiceId;
  mix: PartMix;
  notes: NoteEvent[];
}
export interface DrumPart {
  kind: "drums";
  id: string;
  track: "drums";
  role: "kit" | "perc";
  kit: DrumKitId;
  mix: PartMix;
  hits: DrumEvent[];
}
export type Part = NotePart | DrumPart;

export interface Section {
  type: SectionType;
  /** Chinese label for the UI, e.g. "前奏" "主歌" "副歌" */
  label: string;
  startBar: number;
  bars: number;
  /** seconds */
  start: number;
  /** seconds */
  end: number;
  /** 0..1 arrangement intensity of the section */
  energy: number;
}

export interface ChordSpan {
  /** seconds */
  start: number;
  /** seconds */
  end: number;
  bar: number;
  /** display symbol, e.g. "Am7", "Fmaj7", "G/B" */
  symbol: string;
  /** roman numeral relative to the key, e.g. "vi7" */
  roman: string;
  /** pitch classes 0..11 sounding in the chord, root first */
  pitchClasses: number[];
  /** root pitch class */
  root: number;
}

export interface SpaceSettings {
  /** 0..1 perceived room size */
  size: number;
  /** RT60-like decay in seconds */
  decay: number;
  /** 0..1 high-frequency damping */
  damping: number;
  /** seconds */
  preDelay: number;
  /** overall wet level multiplier 0..1 applied on top of per-part sends */
  level: number;
  /** delay time in seconds (already tempo-synced by the composer) */
  delayTime: number;
  /** 0..0.8 */
  delayFeedback: number;
}

export type MasterCharacter =
  "clean" | "warm" | "lofi" | "wide" | "punchy" | "bitcrush";

export interface MasterSettings {
  /** integrated loudness target for the default mix, LUFS (e.g. -16) */
  targetLufs: number;
  /**
   * Limiter ceiling for the mastered mix in dBFS (e.g. -1). The shared soft
   * clipper (audio/softclip.ts) caps the absolute peak at about -1.1 dBFS
   * regardless; this only lowers the limiter below that.
   */
  ceilingDb: number;
  character: MasterCharacter;
  /** -1 (darker) .. 1 (brighter) spectral tilt */
  tilt: number;
  /**
   * 0..1 how firmly the drum bus is held (a peak compressor on the drums
   * stem whose loss is made up as gain: the kit keeps its loudness and loses
   * peak). 0 leaves the kit's dynamics alone, 1 is a dense club master.
   * Default: by character (see CHARACTER_DENSITY in audio/master.ts).
   */
  density?: number;
}

export interface Score {
  version: 2;
  style: StyleId;
  lead: InstrumentId;
  seed: number;
  sampleRate: number;
  bpm: number;
  beatsPerBar: number;
  bars: number;
  /** exact audio length in seconds; the renderer outputs round(duration * sampleRate) frames */
  duration: number;
  /**
   * When true the audio must loop seamlessly. Held notes are cut at
   * `duration` by the composer (t + d <= duration); the renderer wraps only
   * voice release tails and effect tails to the start.
   */
  loop: boolean;
  /**
   * `label` is the Chinese display name ("F# 小调"); `scale` holds the ABSOLUTE
   * pitch classes of the melody scale, tonic first (5 for pentatonic styles,
   * otherwise 7).
   */
  key: { tonic: number; minor: boolean; label: string; scale: number[] };
  /**
   * 0..0.66, already applied to event times (kept for display). The off-beat
   * of each pair lands at 0.5 + swing/4 of the pair: 0 is straight, 0.66 is
   * roughly triplet swing. The pair is a beat (eighth-note swing) or half a
   * beat (sixteenth-note swing) depending on the style.
   */
  swing: number;
  sections: Section[];
  chords: ChordSpan[];
  parts: Part[];
  space: SpaceSettings;
  master: MasterSettings;
  /** human-readable arrangement notes in Chinese for the "编曲思路" panel */
  notes: string[];
}

/** Light summary the UI keeps next to the audio (no event data). */
export interface ArrangementSummary {
  bpm: number;
  bars: number;
  duration: number;
  keyLabel: string;
  sections: Section[];
  chords: ChordSpan[];
  /** e.g. ["电钢琴", "暖垫", "指弹贝斯", "Lo-fi 鼓组"] */
  instruments: string[];
  notes: string[];
}

export const DEFAULT_PART_MIX: PartMix = {
  gain: 0.6,
  pan: 0,
  width: 1,
  reverb: 0.2,
  delay: 0,
  chorus: 0,
  lowCut: 0,
  highCut: 0,
  drive: 0,
  duck: 0,
};
