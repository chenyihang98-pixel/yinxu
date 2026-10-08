/**
 * StyleDef — everything that makes a style sound like itself, as data plus a
 * few small hooks. The engine (form / harmony / melody / rhythm / compose)
 * reads a StyleDef and never branches on a style id.
 *
 * STEP ROWS. Rhythms are written as strings on a 16-step grid (one bar of
 * sixteenth notes; 32 characters = a two-bar pattern). Characters:
 *   .  nothing          g  ghost (0.22)      o  soft (0.45)
 *   x  normal (0.72)    X  accent (0.95)
 *   r  drums only: a two-stroke roll inside the step (two 32nd notes)
 *   -  comp rows only: note-off (a hit otherwise rings until the next hit,
 *      the next chord or the end of the bar)
 * Spaces and "|" are ignored, so "x... x... | x... x..." is fine.
 */
import type {
  BassFeel,
  InstrumentId,
  SectionType,
  StyleId,
} from "../catalog";
import type {
  DrumKind,
  DrumKitId,
  MasterSettings,
  PartMix,
  PartRole,
  VoiceId,
} from "../score";
import type { ScaleName, VoicingStyle } from "../theory";

/**
 * Three intensity levels, chosen per section from its energy (low < 0.36 ≤ mid < 0.7 ≤ high).
 * Where a tier lists several patterns, write them from calm to busy: verses
 * draw from the first half of the list, choruses and builds from the second.
 */
export interface Tier<T> {
  low: T;
  mid: T;
  high: T;
}

export type StepRow = string;

/* ---------------------------- harmony ---------------------------- */

/**
 * One bar of harmony as roman numerals relative to the key: "IVmaj7", or two
 * chords sharing the bar separated by a space: "ii7 V7".
 * Grammar: [b|#] numeral [suffix] [/ [b|#] numeral]
 *   - upper case = major triad, lower case = minor triad
 *   - suffixes: maj7 maj9 7 9 13 6 69 m7 m9 m11 m6 m7b5 ø dim ° dim7 aug sus2
 *     sus4 7sus4 add9 7b9 maj7#11 ("vi7" is a minor seventh, "V7" a dominant)
 *   - "V7/vi", "vii°/V" = applied (secondary) dominants; any other slash is a
 *     bass note: "I/III" = first inversion, "IV/V" = F over G in C
 *   - in a minor key III, VI, VII are the natural-minor chords; writing them
 *     as bIII, bVI, bVII means the same thing
 */
export type BarChords = string;
export type Progression = BarChords[];

/** Progressions per section type; `verse` is required, the others fall back sensibly. */
export type ProgressionBank = { verse: Progression[] } & Partial<
  Record<SectionType, Progression[]>
>;

/** One scale + the progression bank written for it. Several per tonality give seed variety. */
export interface ModeDef {
  /** melody scale; for major keys use a major-type scale, for minor keys a minor-type one */
  scale: ScaleName;
  /** relative likelihood among the options (default 1) */
  weight?: number;
  /** weight used instead when the lead is one of these instruments (0 = never with that lead) */
  leads?: Partial<Record<InstrumentId, number>>;
  bank: ProgressionBank;
}

/**
 * How chords gain colour as the colour level rises: [first step, second step]
 * as roman suffixes. "" keeps the chord as written.
 *   major    — major chord whose diatonic seventh is major (I, IV …)
 *   minor    — minor chord (suffixes are applied to the lower-case numeral)
 *   dominant — major chord whose diatonic seventh is minor (V, bVII in minor …)
 */
export interface ExtensionTable {
  major: [string, string];
  minor: [string, string];
  dominant: [string, string];
}

export interface HarmonyDef {
  modes: { major: ModeDef[]; minor: ModeDef[] };
  /** colour level at complexity 0 and 1: 0 = triads, ~0.5 = sevenths, ~0.9 = ninths */
  colour: [number, number];
  extensions?: Partial<ExtensionTable>;
  /** 0..1 appetite for functional substitutions (IV↔ii, inversions that smooth the bass) */
  variation: number;
  /** 0..1 appetite for secondary dominants (scaled by complexity) */
  secondary: number;
  /** 0..1 appetite for borrowed chords such as iv in major (scaled by complexity) */
  borrowed: number;
  /** 0..1 appetite for a suspended dominant resolving inside the bar (Vsus4 V) */
  sus: number;
  /** how the comp instrument stacks chord tones */
  voicing: VoicingStyle;
  voices: 3 | 4 | 5;
  /** MIDI window of the comp voicing */
  register: [number, number];
  /** bars each bank entry lasts; default 1 (2 once the tempo passes ~156 BPM) */
  barsPerChord?: (info: { bpm: number; section: SectionType }) => 1 | 2;
  /**
   * Last bar of a loop when the progression does not already lead home. One
   * option is picked; a single chord takes the second half of the bar, two
   * chords replace the bar. Empty = leave the progression alone (ambient).
   */
  turnaround: { major: BarChords[]; minor: BarChords[] };
  /** bars leading into the final chord of a non-loop piece, right-aligned; one option is picked */
  cadence: { major: Progression[]; minor: Progression[] };
  /** the held last chord of a non-loop piece */
  final: { major: string; minor: string };
}

/* ---------------------------- melody ----------------------------- */

export interface MelodyDef {
  /** 0..1 rhythmic density of the lead (hints.melody.density overrides) */
  density: number;
  /** 0..1 appetite for off-beat and pushed rhythms */
  syncopation: number;
  /** length of the motif the melody is built from */
  motifBars: 1 | 2;
  /** share of stepwise motion aimed for, 0.5..0.8 */
  stepBias: number;
  /** 0..1 chance that a phrase starts with a pickup (anacrusis) */
  pickup: number;
  /** 0..1 ornament appetite (turns, slides on instruments that bend) */
  ornaments: number;
  /** 0..1 how much silence is left: longer phrase endings, units left empty */
  space: number;
  /** semitones added to the lead instrument's natural centre */
  register?: number;
  /** semitones the B section sits above the A section (default 3) */
  chorusLift?: number;
  /** lead already plays (sparsely) in the intro */
  introLead?: boolean;
  /** 0..1 how short notes are held relative to their slot for sustaining leads (default 0.95) */
  gate?: number;
  /**
   * Half-bar rhythm cells typical of the style, 8 sixteenth steps each:
   * x = a note starts, . = it keeps sounding, _ = silence from here. The motif
   * prefers them over the engine's generic cells whenever they suit the
   * wanted density, so every style has a rhythmic accent of its own.
   */
  cells?: string[];
  /** 0..1 notes of a beat or less are held for this share of their slot, on every instrument */
  staccato?: number;
  /** 0..1 appetite for re-striking long notes as a tremolo on plucked and struck leads */
  tremolo?: number;
  /** 0..1 appetite for a chromatic lower-neighbour grace note before an accented note */
  chromatic?: number;
  /** 0..1 chance that a section loops its motif like a sampled riff instead of developing it */
  hook?: number;
}

/* --------------------------- accompaniment ----------------------- */

/** Which notes of the current voicing a comp row plays ("1" = lowest … "5"). */
export type CompRow = "all" | "low" | "upper" | "top" | "mid" | "1" | "2" | "3" | "4" | "5";

export interface CompPattern {
  rows: Partial<Record<CompRow, StepRow>>;
  /** seconds between successive notes of a rolled / strummed chord (0 = together) */
  strum?: number;
  /** alternate down- and up-strokes: hits on off-beat eighths are rolled downwards */
  strumAlternate?: boolean;
  /** hits in the last eighth of the bar already play the next bar's chord */
  push?: boolean;
  /** 0..1 hold time relative to the written length (default 1) */
  gate?: number;
}

interface LayerDef {
  /** the first voice that is not the lead instrument is used */
  voice: VoiceId | VoiceId[];
  /** section energy at which the layer enters; above 1 = only when a hint forces it on */
  from: number;
  /** section types in which the layer never plays */
  mute?: SectionType[];
}

export interface CompDef extends LayerDef {
  patterns: Tier<CompPattern[]>;
}

export interface PadDef extends LayerDef {
  /** MIDI window of the pad voicing (default [48, 76]) */
  register?: [number, number];
  voices?: 3 | 4;
  voicing?: VoicingStyle;
}

export type ArpPattern =
  | "up"
  | "down"
  | "updown"
  | "alberti"
  | "broken"
  | "octaves"
  | "ostinato"
  | "random";

export interface ArpDef extends LayerDef {
  pattern: ArpPattern[];
  /** steps per note per tier: 1 = sixteenths, 2 = eighths, 4 = quarters */
  rate: Tier<1 | 2 | 4 | 8>;
  octaves?: 1 | 2;
  /** 0..1 note length relative to the step (default 0.9) */
  gate?: number;
  /** MIDI window (default [60, 84]) */
  register?: [number, number];
}

export interface CounterDef extends LayerDef {
  /**
   * guide  — slow guide-tone line (3rds / 7ths) with small answers in the lead's rests
   * double — doubles the lead's longer notes an octave below (brass under strings)
   */
  mode: "guide" | "double";
  /**
   * A guide line normally sits under the tune. "above" floats it over the
   * tune as a descant (a flute over a plucked lead); when the lead is itself
   * high the line falls back underneath.
   */
  placement?: "below" | "above";
}

export interface BassDef {
  voice: VoiceId;
  from: number;
  mute?: SectionType[];
  feel: Tier<Exclude<BassFeel, "auto">>;
  /** MIDI window the roots are placed in */
  register: [number, number];
  /** 0..1 chance of an approach tone into a chord change (scaled by complexity) */
  approach: number;
  /** 0..1 hold time relative to the slot (default 0.92) */
  gate?: number;
  /** 0..1 chance that a note slides in from the previous pitch (808 glides) */
  slide?: number;
  /** always play long notes, whatever the energy (drones under ambient textures) */
  calm?: boolean;
  /**
   * Written bass figures per tier (one bar of 16 steps each), used instead of
   * `feel` unless a hint asks for a feel. Characters:
   *   1 root   3 third   5 fifth   7 seventh below the root   8 octave
   *   a approach tone into the next chord   - note-off   . keep sounding / rest
   * A note rings until the next character that is not "."; a chord change
   * inside the bar always restates the new root.
   */
  riffs?: Partial<Tier<StepRow[]>>;
}

/* ------------------------------ drums ---------------------------- */

/** One row per drum kind; rows of 16 steps (one bar) or 32 steps (two bars). */
export type Groove = Partial<Record<DrumKind, StepRow>>;

export interface DrumsDef {
  kit: DrumKitId;
  /** section energy at which the kit enters */
  from: number;
  mute?: SectionType[];
  grooves: Tier<Groove[]>;
  /** fills written on the LAST steps of a bar; `light` ≈ one beat, `full` ≈ half a bar or more */
  fills?: { light: Groove[]; full: Groove[] };
  /** accent on the first beat of a section that arrives with energy (null = none) */
  crash?: DrumKind | null;
  /** extra low impact layered under that accent (cinematic booms) */
  impact?: DrumKind;
  /** riser into sections that lift the energy */
  swell?: boolean;
  /** rename or drop kinds for every hit, including built-in feels and fills (chiptune) */
  remap?: Partial<Record<DrumKind, DrumKind | null>>;
  /** 0..1 appetite for extra ghost notes (scaled by complexity) */
  ghost?: number;
  /** per-kind constant delay in milliseconds for a laid-back backbeat */
  lag?: Partial<Record<DrumKind, number>>;
  /** the drum that rolls faster and louder through a build section, replacing the backbeat */
  buildRoll?: DrumKind;
}

export interface PercDef {
  /** defaults to the drum kit, or "soft" when the style has no kit */
  kit?: DrumKitId;
  from: number;
  mute?: SectionType[];
  grooves: Groove[];
  /** grooves used instead when the lead is one of these instruments */
  byLead?: Partial<Record<InstrumentId, Groove[]>>;
}

/* ------------------------------ form ----------------------------- */

export interface FormDef {
  /** shape of loops: verse/chorus alternation or the 32-bar song form */
  loop: "AB" | "AABA";
  /** intro length relative to the default for the duration (0 = none, 1 = normal) */
  intro: number;
  /** outro length relative to the default */
  outro: number;
  /** seconds reserved after the last note for the natural tail, 1.5..3 (default 2.2) */
  tail?: number;
  /** per-section energy: section = clamp(energy × mul + add); overrides the engine default */
  energy?: Partial<Record<SectionType, [mul: number, add: number]>>;
  /** the main section is always prepared by a build (dance music: build → drop) */
  build?: boolean;
}

/* ------------------------------ sound ---------------------------- */

export interface SpaceDef {
  size: number;
  decay: number;
  damping: number;
  preDelay: number;
  /** wet level at the style's own default reverb amount (catalog `reverb`) */
  level: number;
  /** delay time in beats (0.75 = dotted eighth) */
  delayBeats: number;
  delayFeedback: number;
}

export interface StyleDef {
  id: StyleId;
  /** one short Chinese clause for the arrangement notes, e.g. "Lo-fi 电钢琴与慵懒摇摆的鼓点" */
  summary: string;
  harmony: HarmonyDef;
  melody: MelodyDef;
  /** per-instrument lead mix tweaks on top of mix.lead */
  lead?: Partial<Record<InstrumentId, Partial<PartMix>>>;
  comp?: CompDef;
  pad?: PadDef;
  arp?: ArpDef;
  counter?: CounterDef;
  bass?: BassDef;
  /** omit for styles without a drum kit (ambient) */
  drums?: DrumsDef;
  perc?: PercDef;
  /**
   * 0..0.66 — the off-beat lands at 0.5 + swing / 4 of the pair (0 = straight,
   * 0.66 = triplet swing). One value for every part.
   */
  swing: number;
  /** which subdivision swings: eighths (jazz, shuffle) or sixteenths (lo-fi, hip-hop) */
  swingGrid?: 8 | 16;
  /** 0..1 tempo breathing inside every phrase: lingering at its edges, moving on in the middle (1 ≈ ±7 %) */
  rubato?: number;
  humanize: {
    /** maximum timing deviation in milliseconds */
    timing: number;
    /** maximum relative velocity deviation, 0..0.3 */
    velocity: number;
  };
  form: FormDef;
  /** mix defaults per part role, merged over the engine's defaults */
  mix: Partial<Record<PartRole, Partial<PartMix>>>;
  space: SpaceDef;
  master: MasterSettings;
}
