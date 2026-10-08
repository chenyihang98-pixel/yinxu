/**
 * Typed view of electron/shared/music-catalog.json — the single list of styles,
 * lead instruments and keys shared by the composer, the UI, storage validation
 * and the desktop producer agent. tests/catalog.test.ts keeps the literal
 * unions below in sync with the JSON file.
 */
import raw from "../../electron/shared/music-catalog.json";

export const STYLE_IDS = [
  "bright",
  "chill",
  "cinematic",
  "dreamy",
  "focus",
  "retro",
  "epic",
  "chiptune",
  "guofeng",
  "jazz",
  "acoustic",
  "tension",
  "cute",
  "battle",
  "ambient",
  "corporate",
  "sad",
  "dance",
  "hiphop",
  "rock",
  "romantic",
  "festive",
] as const;
export type StyleId = (typeof STYLE_IDS)[number];

export const INSTRUMENT_IDS = [
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
] as const;
export type InstrumentId = (typeof INSTRUMENT_IDS)[number];

export const SECTION_TYPES = [
  "intro",
  "verse",
  "chorus",
  "bridge",
  "breakdown",
  "build",
  "outro",
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export const DRUM_FEELS = [
  "auto",
  "none",
  "light",
  "straight",
  "halftime",
  "fourfloor",
  "swing",
  "shuffle",
  "breakbeat",
  "march",
  "cinematic",
] as const;
export type DrumFeel = (typeof DRUM_FEELS)[number];

export const BASS_FEELS = [
  "auto",
  "none",
  "root",
  "octave",
  "walking",
  "arpeggio",
  "syncopated",
  "pedal",
] as const;
export type BassFeel = (typeof BASS_FEELS)[number];

export interface StyleInfo {
  id: StyleId;
  label: string;
  english: string;
  description: string;
  tags: string[];
  titles: string[];
  bpm: number;
  bpmRange: [number, number];
  key: string;
  instrument: InstrumentId;
  energy: number;
  complexity: number;
  reverb: number;
  /** Two cover-art colours, dark-theme friendly. */
  palette: [string, string];
}
export interface InstrumentInfo {
  id: InstrumentId;
  label: string;
  english: string;
}

export const STYLES = raw.styles as StyleInfo[];
export const INSTRUMENT_LIST = raw.instruments as InstrumentInfo[];
/** All 24 selectable keys, e.g. "C major", "F# minor". */
export const KEYS: readonly string[] = raw.keys;
export const LIMITS = {
  bpm: raw.limits.bpm as [number, number],
  duration: raw.limits.duration as [number, number],
  promptChars: raw.limits.promptChars,
};

const styleById = new Map(STYLES.map((s) => [s.id, s]));
const instrumentById = new Map(INSTRUMENT_LIST.map((i) => [i.id, i]));

export const isStyleId = (value: unknown): value is StyleId =>
  typeof value === "string" && styleById.has(value as StyleId);
export const isInstrumentId = (value: unknown): value is InstrumentId =>
  typeof value === "string" && instrumentById.has(value as InstrumentId);
export const isKey = (value: unknown): value is string =>
  typeof value === "string" && KEYS.includes(value);

export function styleInfo(id: StyleId): StyleInfo {
  return styleById.get(id) ?? STYLES[0];
}
export function instrumentInfo(id: InstrumentId): InstrumentInfo {
  return instrumentById.get(id) ?? INSTRUMENT_LIST[0];
}
export const styleLabel = (id: StyleId) => styleInfo(id).label;
export const instrumentLabel = (id: InstrumentId) => instrumentInfo(id).label;

const TONIC_PC: Record<string, number> = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};

/** "F# minor" → { tonic: 6, minor: true, name: "F#" }. Unknown input falls back to C major. */
export function parseKey(key: string): {
  tonic: number;
  minor: boolean;
  name: string;
} {
  const match = /^([A-G](?:#|b)?)\s+(major|minor)$/.exec(key.trim());
  if (!match || !(match[1] in TONIC_PC))
    return { tonic: 0, minor: false, name: "C" };
  return {
    tonic: TONIC_PC[match[1]],
    minor: match[2] === "minor",
    name: match[1],
  };
}
