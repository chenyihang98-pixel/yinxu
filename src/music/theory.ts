/**
 * Music-theory primitives for the composer: scales and modes, key context,
 * roman-numeral chords, voice leading, and instrument ranges.
 */
import { parseKey, type InstrumentId } from "./catalog";
import type { VoiceId } from "./score";

export const mod = (value: number, modulus: number) =>
  ((value % modulus) + modulus) % modulus;
export const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** 0 below `from`, 1 above `to`, linear in between */
export const ramp = (from: number, to: number, value: number) =>
  clamp((value - from) / (to - from), 0, 1);

/* ------------------------------------------------------------------ */
/* scales and keys                                                     */
/* ------------------------------------------------------------------ */

export type ScaleName =
  | "major"
  | "naturalMinor"
  | "harmonicMinor"
  | "dorian"
  | "mixolydian"
  | "lydian"
  | "phrygian"
  | "majorPentatonic"
  | "minorPentatonic";

export const SCALES: Record<ScaleName, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  naturalMinor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
};

export const SCALE_LABELS: Record<ScaleName, string> = {
  major: "自然大调",
  naturalMinor: "自然小调",
  harmonicMinor: "和声小调",
  dorian: "多利亚调式",
  mixolydian: "混合利底亚调式",
  lydian: "利底亚调式",
  phrygian: "弗里吉亚调式",
  majorPentatonic: "大调五声音阶",
  minorPentatonic: "小调五声音阶",
};

/** The seven-note scale a (possibly pentatonic) melody scale lives in. */
const PARENT_SCALE: Record<ScaleName, ScaleName> = {
  major: "major",
  naturalMinor: "naturalMinor",
  harmonicMinor: "naturalMinor",
  dorian: "dorian",
  mixolydian: "mixolydian",
  lydian: "lydian",
  phrygian: "phrygian",
  majorPentatonic: "major",
  minorPentatonic: "naturalMinor",
};

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const FLAT_MAJOR_TONICS = new Set([5, 10, 3, 8, 1]);
const FLAT_MINOR_TONICS = new Set([2, 7, 0, 5, 10, 3]);

export const pitchName = (pc: number, flat: boolean) =>
  (flat ? FLAT_NAMES : SHARP_NAMES)[mod(Math.round(pc), 12)];

export interface KeyContext {
  /** tonic pitch class 0..11 */
  tonic: number;
  minor: boolean;
  /** tonic spelling from the catalog, e.g. "F#" */
  name: string;
  /** "F# 小调" */
  label: string;
  scaleName: ScaleName;
  /** melody scale as absolute pitch classes, tonic first */
  pcs: number[];
  /** membership table of `pcs` */
  inScale: boolean[];
  /** seven-note parent scale (absolute pitch classes) used for diatonic chord colours */
  parent: boolean[];
  preferFlat: boolean;
}

export function makeKey(keyName: string, scaleName: ScaleName): KeyContext {
  const parsed = parseKey(keyName);
  const pcs = SCALES[scaleName].map((interval) => mod(parsed.tonic + interval, 12));
  const inScale = new Array<boolean>(12).fill(false);
  for (const pc of pcs) inScale[pc] = true;
  const parent = new Array<boolean>(12).fill(false);
  for (const interval of SCALES[PARENT_SCALE[scaleName]])
    parent[mod(parsed.tonic + interval, 12)] = true;
  return {
    tonic: parsed.tonic,
    minor: parsed.minor,
    name: parsed.name,
    label: `${parsed.name} ${parsed.minor ? "小调" : "大调"}`,
    scaleName,
    pcs,
    inScale,
    parent,
    preferFlat: (parsed.minor ? FLAT_MINOR_TONICS : FLAT_MAJOR_TONICS).has(parsed.tonic),
  };
}

/** Every MIDI note of the scale between low and high (inclusive), ascending. */
export function scaleLadder(key: KeyContext, low: number, high: number): number[] {
  const ladder: number[] = [];
  for (let midi = Math.ceil(low); midi <= high; midi++)
    if (key.inScale[mod(midi, 12)]) ladder.push(midi);
  return ladder;
}

/** Index of the ladder note closest to `midi` (ties resolve downwards). */
export function nearestIndex(ladder: readonly number[], midi: number): number {
  let best = 0;
  let distance = Infinity;
  for (let i = 0; i < ladder.length; i++) {
    const d = Math.abs(ladder[i] - midi);
    if (d < distance) {
      distance = d;
      best = i;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* chords from roman numerals                                          */
/* ------------------------------------------------------------------ */

export type HarmonicFunction = "T" | "S" | "D";

export interface Chord {
  /** the roman numeral this chord was parsed from, e.g. "V7/vi" */
  roman: string;
  /** accidental + numeral without suffix or slash, e.g. "bVII", "vi" */
  head: string;
  suffix: string;
  /** root pitch class */
  root: number;
  /** accidental + numeral after the slash ("" when there is none) */
  slash: string;
  /** bass pitch class (differs from root for inversions and slash chords) */
  bass: number;
  /** semitones above the root, ascending, starting with 0; extensions exceed 12 */
  intervals: number[];
  /** sounding pitch classes, root first */
  pitchClasses: number[];
  /** display symbol, e.g. "Am7", "F/A" */
  symbol: string;
  fn: HarmonicFunction;
  /** applied (secondary) dominant such as V7/vi */
  applied: boolean;
  /** has a minor third */
  minor: boolean;
}

const NUMERAL = "(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)";
const SUFFIX =
  "(maj7#11|maj7|maj9|m7b5|dim7|dim|aug|7sus4|sus2|sus4|add9|m11|m9|m7|m6|7b9|69|13|7|9|6|°|ø)";
/** Superset of defaults.ROMAN: also accepts 7sus4, 7b9, 13, 69, m11, maj7#11 for style banks. */
const ROMAN_PATTERN = new RegExp(`^([b#]?)${NUMERAL}${SUFFIX}?(?:/([b#]?)${NUMERAL})?$`);

const MAJOR_DEGREES = [0, 2, 4, 5, 7, 9, 11];
const MINOR_DEGREES = [0, 2, 3, 5, 7, 8, 10];
const NUMERAL_INDEX: Record<string, number> = {
  I: 0,
  II: 1,
  III: 2,
  IV: 3,
  V: 4,
  VI: 5,
  VII: 6,
};

interface Quality {
  upper: number[];
  lower: number[];
  upperSymbol: string;
  lowerSymbol: string;
}
const quality = (
  upper: number[],
  upperSymbol: string,
  lower: number[] = upper,
  lowerSymbol: string = upperSymbol,
): Quality => ({ upper, lower, upperSymbol, lowerSymbol });

const QUALITIES: Record<string, Quality> = {
  "": quality([0, 4, 7], "", [0, 3, 7], "m"),
  maj7: quality([0, 4, 7, 11], "maj7", [0, 3, 7, 11], "m(maj7)"),
  maj9: quality([0, 4, 7, 11, 14], "maj9", [0, 3, 7, 11, 14], "m(maj9)"),
  "maj7#11": quality([0, 4, 7, 11, 18], "maj7#11"),
  "7": quality([0, 4, 7, 10], "7", [0, 3, 7, 10], "m7"),
  "9": quality([0, 4, 7, 10, 14], "9", [0, 3, 7, 10, 14], "m9"),
  "13": quality([0, 4, 7, 10, 14, 21], "13", [0, 3, 7, 10, 14, 21], "m13"),
  "7b9": quality([0, 4, 7, 10, 13], "7b9"),
  "7sus4": quality([0, 5, 7, 10], "7sus4"),
  "6": quality([0, 4, 7, 9], "6", [0, 3, 7, 9], "m6"),
  "69": quality([0, 4, 7, 9, 14], "6/9", [0, 3, 7, 9, 14], "m6/9"),
  m7: quality([0, 3, 7, 10], "m7"),
  m9: quality([0, 3, 7, 10, 14], "m9"),
  m11: quality([0, 3, 7, 10, 14, 17], "m11"),
  m6: quality([0, 3, 7, 9], "m6"),
  m7b5: quality([0, 3, 6, 10], "m7b5"),
  ø: quality([0, 3, 6, 10], "m7b5"),
  dim: quality([0, 3, 6], "dim"),
  "°": quality([0, 3, 6], "dim"),
  dim7: quality([0, 3, 6, 9], "dim7"),
  aug: quality([0, 4, 8], "aug"),
  sus2: quality([0, 2, 7], "sus2"),
  sus4: quality([0, 5, 7], "sus4"),
  add9: quality([0, 4, 7, 14], "add9", [0, 3, 7, 14], "m(add9)"),
};
const DIMINISHED_SUFFIXES = new Set(["dim", "°", "dim7", "m7b5", "ø"]);

/**
 * Semitones above the tonic for a numeral. In a minor key III, VI and VII are
 * the natural-minor degrees whether or not they are written with a flat
 * ("VI" and "bVI" are the same chord), "#VI"/"#VII" are the raised degrees, and
 * a diminished chord on lower-case vi/vii sits on the raised degree (vii°).
 */
function degreeSemitones(
  accidental: string,
  numeral: string,
  keyMinor: boolean,
  diminished: boolean,
): number {
  const index = NUMERAL_INDEX[numeral.toUpperCase()];
  const shift = accidental === "b" ? -1 : accidental === "#" ? 1 : 0;
  if (!keyMinor) return mod(MAJOR_DEGREES[index] + shift, 12);
  const lowered = index === 2 || index === 5 || index === 6;
  if (!lowered) return mod(MINOR_DEGREES[index] + shift, 12);
  if (accidental === "#") return MAJOR_DEGREES[index];
  if (accidental === "b") return MINOR_DEGREES[index];
  const lowerCase = numeral === numeral.toLowerCase();
  if (diminished && lowerCase && index !== 2) return MAJOR_DEGREES[index];
  return MINOR_DEGREES[index];
}

function functionOf(degree: number, applied: boolean): HarmonicFunction {
  if (applied) return "D";
  switch (degree) {
    case 0:
    case 3:
    case 4:
    case 8:
    case 9:
      return "T";
    case 7:
    case 10:
    case 11:
    case 6:
      return "D";
    default:
      return "S";
  }
}

/** Parse a roman numeral in the given key. Returns null when it is not well formed. */
export function parseRoman(roman: string, key: KeyContext): Chord | null {
  const match = ROMAN_PATTERN.exec(roman.trim());
  if (!match) return null;
  const [, accidental, numeral, suffixRaw, slashAccidental, slashNumeral] = match;
  const suffix = suffixRaw ?? "";
  const upperCase = numeral === numeral.toUpperCase();
  const entry = QUALITIES[suffix];
  if (!entry) return null;
  const intervals = (upperCase ? entry.upper : entry.lower).slice();
  const diminished = DIMINISHED_SUFFIXES.has(suffix);
  let degree = degreeSemitones(accidental, numeral, key.minor, diminished);
  let bassDegree = degree;
  let applied = false;
  if (slashNumeral) {
    const target = degreeSemitones(slashAccidental, slashNumeral, key.minor, false);
    const dominantNumeral = numeral === "V" || (numeral === "vii" && diminished);
    // V over the leading tone is the everyday first inversion (G/B in C), not
    // a dominant of the leading tone.
    const firstInversion = numeral === "V" && target === 11;
    if (dominantNumeral && target !== 0 && !firstInversion) {
      applied = true;
      degree = mod(target + (numeral === "V" ? 7 : 11), 12);
      bassDegree = degree;
    } else bassDegree = target;
  }
  const root = mod(key.tonic + degree, 12);
  const bass = mod(key.tonic + bassDegree, 12);
  const pitchClasses: number[] = [];
  for (const interval of intervals) {
    const pc = mod(root + interval, 12);
    if (!pitchClasses.includes(pc)) pitchClasses.push(pc);
  }
  if (!pitchClasses.includes(bass)) pitchClasses.push(bass);
  const flat =
    accidental === "b" ? true : accidental === "#" ? false : key.preferFlat;
  // a bass note written without an accidental is spelled the way the key spells it
  const bassFlat =
    slashAccidental === "b" ? true : slashAccidental === "#" ? false : key.preferFlat;
  let symbol =
    pitchName(root, flat) + (upperCase ? entry.upperSymbol : entry.lowerSymbol);
  if (bass !== root) symbol += `/${pitchName(bass, bassFlat)}`;
  return {
    roman: roman.trim(),
    head: `${accidental}${numeral}`,
    suffix,
    slash: slashNumeral ? `${slashAccidental}${slashNumeral}` : "",
    root,
    bass,
    intervals,
    pitchClasses,
    symbol,
    fn: functionOf(degree, applied),
    applied,
    minor: intervals.includes(3),
  };
}

/** Roman numerals of one bar: "ii7 V7" → ["ii7", "V7"]. */
export const splitBar = (bar: string) => bar.trim().split(/\s+/).filter(Boolean);

/* ------------------------------------------------------------------ */
/* voicing and voice leading                                           */
/* ------------------------------------------------------------------ */

export type VoicingStyle = "close" | "open" | "rootless" | "shell" | "power";

/**
 * Chord members as semitone offsets from the root, most important first. With
 * few voices a seventh chord keeps third, seventh and root (then its ninth);
 * a chord without a seventh stays a plain triad before it adds its colour.
 */
function rankedTones(chord: Chord, rootless: boolean): number[] {
  const tones = chord.intervals;
  const hasThird = tones.some((t) => t === 3 || t === 4);
  const hasSeventh = tones.some((t) => t === 9 || t === 10 || t === 11);
  const score = (interval: number) => {
    const t = interval % 12;
    if (interval >= 12) return hasSeventh || rootless ? 3.5 : 5.5; // 9th, 11th, 13th
    if (t === 3 || t === 4) return 0;
    if ((t === 2 || t === 5) && !hasThird) return 0; // suspension replaces the third
    if (t === 9 || t === 10 || t === 11) return 1;
    if (t === 6 || t === 8) return 2; // altered fifth defines the chord
    if (t === 0) return 3;
    return 5; // perfect fifth is the first note to leave out
  };
  return tones
    .slice()
    .sort((a, b) => score(a) - score(b) || a - b)
    .map((interval) => interval % 12);
}

/** Pitch classes (absolute) a voicing of `voices` notes should contain; doubles allowed. */
export function voicingTones(chord: Chord, style: VoicingStyle, voices: number): number[] {
  const ranked = rankedTones(chord, style === "rootless");
  const fifth = chord.intervals.find((t) => t === 6 || t === 7 || t === 8) ?? 7;
  let offsets: number[];
  if (style === "power") offsets = [0, fifth, 0].slice(0, Math.max(2, voices));
  else if (style === "shell") {
    const guide = ranked.filter((t) => t !== 0 && t !== 7).slice(0, 2);
    offsets = [0, ...(guide.length ? guide : [fifth])];
    if (offsets.length < Math.min(3, voices)) offsets.push(fifth);
  } else {
    let pool = ranked;
    if (style === "rootless" && pool.length >= 4) pool = pool.filter((t) => t !== 0);
    offsets = pool.slice(0, voices);
    if (style !== "rootless") {
      // spare voices double the root, then the fifth
      const doubles = [0, fifth];
      for (let i = 0; offsets.length < voices && i < doubles.length; i++)
        offsets.push(doubles[i]);
    }
  }
  return offsets.map((offset) => mod(chord.root + offset, 12));
}

function stacks(pcs: number[], low: number, high: number, open: boolean): number[][] {
  const unique = [...new Set(pcs)];
  const doubles = pcs.length - unique.length;
  const result: number[][] = [];
  for (const startPc of unique) {
    for (let base = low; base < low + 12; base++) {
      if (mod(base, 12) !== startPc) continue;
      for (let octave = 0; octave < 4; octave++) {
        const notes = [base + octave * 12];
        const remaining = unique.filter((pc) => pc !== startPc);
        while (remaining.length) {
          // next chord tone above the previous note
          let bestIndex = 0;
          let bestGap = 99;
          for (let i = 0; i < remaining.length; i++) {
            const gap = mod(remaining[i] - notes[notes.length - 1], 12) || 12;
            if (gap < bestGap) {
              bestGap = gap;
              bestIndex = i;
            }
          }
          notes.push(notes[notes.length - 1] + bestGap);
          remaining.splice(bestIndex, 1);
        }
        for (let i = 0; i < doubles; i++) notes.push(notes[i] + 12);
        if (open && notes.length >= 3) {
          const dropIndex = notes.length >= 4 ? notes.length - 2 : 1;
          notes[dropIndex] -= 12;
        }
        notes.sort((a, b) => a - b);
        if (notes[0] < low || notes[notes.length - 1] > high) continue;
        result.push(notes);
      }
    }
  }
  return result;
}

function voicingCost(
  notes: number[],
  previous: number[] | undefined,
  centre: number,
  weakBottom: readonly number[] = [],
): number {
  let cost = 0;
  const mean = notes.reduce((sum, note) => sum + note, 0) / notes.length;
  cost += Math.abs(mean - centre) * 0.9;
  // a ninth or thirteenth under the chord blurs what the chord is
  if (weakBottom.includes(mod(notes[0], 12))) cost += 4;
  for (let i = 1; i < notes.length; i++) {
    const gap = notes[i] - notes[i - 1];
    // thirds and seconds low down turn to mud
    if (notes[i - 1] < 55 && gap <= 4) cost += 6;
    else if (notes[i - 1] < 48 && gap <= 6) cost += 4;
    else if (notes[i - 1] < 60 && gap <= 2) cost += 5;
    if (gap > 12) cost += 3;
    if (gap === 1) cost += 1.5;
    // three notes a step apart make a cluster
    if (i >= 2 && gap <= 2 && notes[i - 1] - notes[i - 2] <= 2) cost += 2.5;
  }
  if (!previous || !previous.length) return cost;
  if (previous.length !== notes.length) {
    const previousMean = previous.reduce((sum, note) => sum + note, 0) / previous.length;
    return cost + Math.abs(mean - previousMean) * 1.2;
  }
  let motion = 0;
  for (let i = 0; i < notes.length; i++) motion += Math.abs(notes[i] - previous[i]);
  cost += motion;
  cost += Math.abs(notes[notes.length - 1] - previous[previous.length - 1]) * 0.6;
  for (let i = 0; i < notes.length; i++)
    for (let j = i + 1; j < notes.length; j++) {
      const before = mod(previous[j] - previous[i], 12);
      const after = mod(notes[j] - notes[i], 12);
      const moveLow = notes[i] - previous[i];
      const moveHigh = notes[j] - previous[j];
      if (before !== after || moveLow === 0 || Math.sign(moveLow) !== Math.sign(moveHigh))
        continue;
      if (after === 7) cost += 6; // parallel fifths
      else if (after === 0) cost += 4; // parallel octaves
    }
  return cost;
}

/**
 * Low-interval limit: two notes this close this low blur into mud (a second
 * below E3, a third below C3).
 */
export const lowIntervalClash = (lower: number, upper: number): boolean => {
  const gap = upper - lower;
  if (gap <= 0) return false;
  return (lower < 52 && gap <= 2) || (lower < 48 && gap <= 4);
};

const muddyStack = (notes: readonly number[]): boolean => {
  for (let i = 1; i < notes.length; i++)
    if (lowIntervalClash(notes[i - 1], notes[i])) return true;
  return false;
};

export interface VoicingOptions {
  style: VoicingStyle;
  voices: number;
  /** inclusive MIDI window */
  low: number;
  high: number;
  /** previous voicing (ascending) for voice leading */
  previous?: number[];
}

/** Voice a chord inside the window with minimal motion from the previous voicing. */
export function voiceChord(chord: Chord, options: VoicingOptions): number[] {
  const { style, voices, low, high, previous } = options;
  const centre = (low + high) / 2;
  if (style === "power") {
    const fifth = chord.intervals.find((t) => t === 6 || t === 7 || t === 8) ?? 7;
    let best: number[] = [];
    let bestCost = Infinity;
    for (let root = low; root <= high; root++) {
      if (mod(root, 12) !== chord.root) continue;
      const notes = [root, root + fifth, root + 12].slice(0, Math.max(2, voices));
      if (notes[notes.length - 1] > high + 5) continue;
      const cost = voicingCost(notes, previous, centre);
      if (cost < bestCost) {
        bestCost = cost;
        best = notes;
      }
    }
    if (best.length) return best;
  }
  const weakBottom =
    style === "rootless"
      ? []
      : chord.intervals.filter((interval) => interval >= 12).map((interval) => mod(chord.root + interval, 12));
  const pcs = voicingTones(chord, style, voices);
  let candidates = stacks(pcs, low, high, style === "open");
  if (!candidates.length) candidates = stacks(pcs, low - 5, high + 7, false);
  if (!candidates.length) {
    // degenerate window: stack from the nearest root
    const base = low + mod(chord.root - low, 12);
    return chord.intervals.slice(0, Math.max(2, voices)).map((interval) => base + interval);
  }
  // never a muddy stack while a clean one exists
  const clean = candidates.filter((candidate) => !muddyStack(candidate));
  if (clean.length) candidates = clean;
  let best = candidates[0];
  let bestCost = Infinity;
  for (const candidate of candidates) {
    const cost = voicingCost(candidate, previous, centre, weakBottom);
    if (cost < bestCost) {
      bestCost = cost;
      best = candidate;
    }
  }
  return best;
}

/** Closest MIDI note with the given pitch class to `near`, kept inside [low, high]. */
export function nearestPitch(pc: number, near: number, low: number, high: number): number {
  let note = near + mod(pc - near, 12);
  if (note - near > 6) note -= 12;
  while (note < low) note += 12;
  while (note > high) note -= 12;
  if (note < low) note += 12;
  return note;
}

/* ------------------------------------------------------------------ */
/* instruments                                                         */
/* ------------------------------------------------------------------ */

/** Playable MIDI range of every synthesizer voice (inclusive). */
export const VOICE_RANGES: Record<VoiceId, readonly [number, number]> = {
  piano: [33, 96],
  epiano: [36, 91],
  guitar: [40, 86],
  synth: [36, 96],
  pluck: [36, 96],
  bell: [55, 103],
  musicbox: [60, 103],
  marimba: [45, 91],
  vibes: [48, 91],
  flute: [59, 96],
  strings: [36, 96],
  guzheng: [38, 93],
  dizi: [57, 96],
  chip: [36, 96],
  pad: [33, 91],
  airpad: [45, 96],
  brass: [36, 84],
  choir: [43, 84],
  organ: [33, 91],
  nylon: [38, 86],
  chipPulse: [36, 96],
  subBass: [24, 52],
  fingerBass: [26, 60],
  synthBass: [24, 60],
  uprightBass: [26, 60],
  chipBass: [24, 64],
  bass808: [22, 52],
  pizzicato: [36, 91],
  overdrive: [36, 81],
};

export interface LeadTrait {
  /** comfortable melodic range (inclusive MIDI) */
  low: number;
  high: number;
  /** middle of the sweet spot */
  centre: number;
  /** true for bowed / blown / held timbres that sing through the note length */
  sustain: boolean;
  /** 0..1 how readily the instrument slides into notes (NoteEvent.bend) */
  bend: number;
}

export const LEAD_TRAITS: Record<InstrumentId, LeadTrait> = {
  piano: { low: 57, high: 88, centre: 72, sustain: false, bend: 0 },
  epiano: { low: 55, high: 84, centre: 69, sustain: false, bend: 0 },
  guitar: { low: 52, high: 81, centre: 67, sustain: false, bend: 0 },
  synth: { low: 57, high: 88, centre: 72, sustain: true, bend: 0 },
  pluck: { low: 57, high: 88, centre: 72, sustain: false, bend: 0 },
  bell: { low: 64, high: 96, centre: 79, sustain: false, bend: 0 },
  musicbox: { low: 67, high: 98, centre: 81, sustain: false, bend: 0 },
  marimba: { low: 53, high: 84, centre: 69, sustain: false, bend: 0 },
  vibes: { low: 55, high: 86, centre: 71, sustain: false, bend: 0 },
  flute: { low: 62, high: 91, centre: 76, sustain: true, bend: 0.05 },
  strings: { low: 55, high: 91, centre: 72, sustain: true, bend: 0.08 },
  guzheng: { low: 50, high: 88, centre: 69, sustain: false, bend: 0.22 },
  dizi: { low: 64, high: 93, centre: 78, sustain: true, bend: 0.18 },
  chip: { low: 57, high: 88, centre: 72, sustain: true, bend: 0 },
};

export const VOICE_LABELS: Record<VoiceId, string> = {
  piano: "钢琴",
  epiano: "电钢琴",
  guitar: "木吉他",
  synth: "合成器主音",
  pluck: "电子拨弦",
  bell: "钟琴",
  musicbox: "八音盒",
  marimba: "马林巴",
  vibes: "颤音琴",
  flute: "长笛",
  strings: "弦乐",
  guzheng: "古筝",
  dizi: "竹笛",
  chip: "方波",
  pad: "暖垫",
  airpad: "空气垫音",
  brass: "铜管",
  choir: "人声垫",
  organ: "风琴",
  nylon: "尼龙吉他",
  chipPulse: "脉冲波",
  subBass: "低频贝斯",
  fingerBass: "指弹贝斯",
  synthBass: "合成贝斯",
  uprightBass: "低音提琴",
  chipBass: "三角波贝斯",
  bass808: "808 贝斯",
  pizzicato: "弦乐拨奏",
  overdrive: "失真吉他",
};

/** Fold a note by octaves into [low, high]. */
export function foldIntoRange(midi: number, low: number, high: number): number {
  let note = midi;
  while (note < low) note += 12;
  while (note > high) note -= 12;
  return note < low ? low : note;
}

/** Roman numeral (no suffix) for a pitch class, usable after a slash as a bass note. */
export function numeralForPitch(pc: number, key: KeyContext): string {
  const degree = mod(pc - key.tonic, 12);
  return (
    key.minor
      ? ["I", "bII", "II", "III", "#III", "IV", "#IV", "V", "VI", "#VI", "VII", "#VII"]
      : ["I", "bII", "II", "bIII", "III", "IV", "#IV", "V", "bVI", "VI", "bVII", "VII"]
  )[degree];
}

/* ------------------------------------------------------------------ */
/* step rows ("x...o.g.") shared by drum grooves and comp patterns     */
/* ------------------------------------------------------------------ */

export interface StepHit {
  /** sixteenth-note index from the start of the pattern */
  step: number;
  /** 0..1 */
  vel: number;
  /** two-stroke roll inside the step */
  roll: boolean;
  /** steps until the next hit, note-off or the end of the bar */
  length: number;
}
export interface StepPattern {
  /** total steps: 16 for one bar, 32 for two */
  steps: number;
  hits: StepHit[];
}

const STEP_VELOCITY: Record<string, number> = { g: 0.22, o: 0.45, x: 0.72, X: 0.95, r: 0.6 };
const stepCache = new Map<string, StepPattern>();

/** Parse a step row; malformed rows are padded or cut to whole bars. */
export function parseSteps(row: string): StepPattern {
  const cached = stepCache.get(row);
  if (cached) return cached;
  const raw = row.replace(/[\s|]/g, "");
  const steps = raw.length > 16 ? 32 : 16;
  const text = raw.padEnd(steps, ".").slice(0, steps);
  const hits: StepHit[] = [];
  for (let step = 0; step < steps; step++) {
    const vel = STEP_VELOCITY[text[step]];
    if (vel === undefined) continue;
    let end = step + 1;
    const barEnd = (Math.floor(step / 16) + 1) * 16;
    while (end < barEnd && text[end] === ".") end++;
    hits.push({ step, vel, roll: text[step] === "r", length: end - step });
  }
  const pattern = { steps, hits };
  stepCache.set(row, pattern);
  return pattern;
}

/* ------------------------------------------------------------------ */
/* symbolic events (beats) shared by the part generators               */
/* ------------------------------------------------------------------ */

/** A note on the beat grid, before swing and humanisation turn it into seconds. */
export interface BeatNote {
  /** start in beats from the top of the piece */
  beat: number;
  /** length in beats */
  len: number;
  midi: number;
  /** 0..1 */
  vel: number;
  bend?: number;
  /** extra delay in seconds applied after the grid conversion (strums, rolls) */
  late?: number;
}
