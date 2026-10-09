/** Default configuration, per-style presets and the one place numeric ranges are clamped. */
import type { ArrangementHints, MusicConfig, TrackName } from "../types";
import {
  BASS_FEELS,
  DRUM_FEELS,
  LIMITS,
  SECTION_TYPES,
  isInstrumentId,
  isKey,
  isStyleId,
  styleInfo,
  type StyleId,
} from "./catalog";

export const DEFAULT_VOLUMES: Record<TrackName, number> = {
  melody: 0.8,
  chords: 0.64,
  bass: 0.68,
  drums: 0.56,
};

export const DEFAULT_CONFIG: MusicConfig = {
  prompt: "青春欢快，像晴天散步一样轻松，适合日常 Vlog",
  mood: "bright",
  bpm: 112,
  duration: 30,
  key: "C major",
  instrument: "piano",
  energy: 0.62,
  complexity: 0.5,
  reverb: 0.25,
  seed: 42017,
  loop: true,
  volumes: { ...DEFAULT_VOLUMES },
  engine: 2,
};

export const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));
const unit = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? clamp(value, 0, 1)
    : fallback;

/** The musical parameters a style suggests (tempo, key, lead, energy…). */
export function stylePreset(
  style: StyleId,
): Pick<
  MusicConfig,
  "mood" | "bpm" | "key" | "instrument" | "energy" | "complexity" | "reverb"
> {
  const info = styleInfo(style);
  return {
    mood: info.id,
    bpm: info.bpm,
    key: info.key,
    instrument: info.instrument,
    energy: info.energy,
    complexity: info.complexity,
    reverb: info.reverb,
  };
}

/** Stable text seed: the same description starts from the same musical material. */
export function promptSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}

export function randomSeed(): number {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return values[0];
}

const NUMERAL = "(?:VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)";
/** e.g. "I", "vi7", "IVmaj7", "bVII", "V7/vi", "ii°" */
export const ROMAN = new RegExp(
  `^[b#]?${NUMERAL}(?:maj7|maj9|m7b5|dim7|dim|aug|sus2|sus4|add9|m9|m7|m6|7|9|6|°|ø)?(?:/[b#]?${NUMERAL})?$`,
);

/** Keep only well-formed hints; returns undefined when nothing usable remains. */
export function cleanArrangement(input: unknown): ArrangementHints | undefined {
  if (!input || typeof input !== "object") return undefined;
  const source = input as Record<string, unknown>;
  const hints: ArrangementHints = {};
  if (Array.isArray(source.progression)) {
    const progression = source.progression
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length <= 12 && ROMAN.test(item))
      .slice(0, 16);
    if (progression.length >= 2) hints.progression = progression;
  }
  if (Array.isArray(source.form)) {
    const form = source.form
      .filter(
        (item): item is { type: string; bars: number; energy: number } =>
          !!item && typeof item === "object",
      )
      .filter((item) =>
        (SECTION_TYPES as readonly string[]).includes(item.type),
      )
      .map((item) => ({
        type: item.type as (typeof SECTION_TYPES)[number],
        bars: clamp(Math.round(Number(item.bars) || 4), 1, 32),
        energy: unit(item.energy, 0.5),
      }))
      .slice(0, 12);
    if (form.length) hints.form = form;
  }
  if (
    typeof source.drums === "string" &&
    (DRUM_FEELS as readonly string[]).includes(source.drums) &&
    source.drums !== "auto"
  )
    hints.drums = source.drums as ArrangementHints["drums"];
  if (
    typeof source.bass === "string" &&
    (BASS_FEELS as readonly string[]).includes(source.bass) &&
    source.bass !== "auto"
  )
    hints.bass = source.bass as ArrangementHints["bass"];
  if (
    typeof source.swing === "number" &&
    Number.isFinite(source.swing) &&
    source.swing >= 0
  )
    hints.swing = clamp(source.swing, 0, 0.66);
  if (source.layers && typeof source.layers === "object") {
    const raw = source.layers as Record<string, unknown>;
    const layers: NonNullable<ArrangementHints["layers"]> = {};
    for (const name of ["pad", "arp", "counter", "perc"] as const)
      if (typeof raw[name] === "boolean") layers[name] = raw[name];
    if (Object.keys(layers).length) hints.layers = layers;
  }
  if (source.melody && typeof source.melody === "object") {
    const raw = source.melody as Record<string, unknown>;
    const melody: NonNullable<ArrangementHints["melody"]> = {};
    if (
      typeof raw.density === "number" &&
      Number.isFinite(raw.density) &&
      raw.density >= 0
    )
      melody.density = clamp(raw.density, 0, 1);
    if (
      raw.register === "low" ||
      raw.register === "mid" ||
      raw.register === "high"
    )
      melody.register = raw.register;
    if (
      raw.motion === "stepwise" ||
      raw.motion === "leaps" ||
      raw.motion === "arpeggio"
    )
      melody.motion = raw.motion;
    if (Object.keys(melody).length) hints.melody = melody;
  }
  return Object.keys(hints).length ? hints : undefined;
}

/**
 * Coerce any config-shaped value into a valid engine-2 MusicConfig. Unknown
 * enums fall back to `base`; numbers are clamped. Used for brain output — not
 * for untrusted storage (storage.ts validates strictly and reports errors).
 */
export function clampConfig(
  input: Partial<MusicConfig>,
  base: MusicConfig = DEFAULT_CONFIG,
): MusicConfig {
  const number = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const volumes = { ...base.volumes };
  for (const track of Object.keys(volumes) as TrackName[])
    volumes[track] = unit(input.volumes?.[track], volumes[track]);
  const arrangement = cleanArrangement(input.arrangement);
  return {
    prompt: (typeof input.prompt === "string"
      ? input.prompt
      : base.prompt
    ).slice(0, 2000),
    mood: isStyleId(input.mood) ? input.mood : base.mood,
    bpm: Math.round(clamp(number(input.bpm, base.bpm), ...LIMITS.bpm)),
    duration: Math.round(
      clamp(number(input.duration, base.duration), ...LIMITS.duration),
    ),
    key: isKey(input.key) ? input.key : base.key,
    instrument: isInstrumentId(input.instrument)
      ? input.instrument
      : base.instrument,
    energy: unit(input.energy, base.energy),
    complexity: unit(input.complexity, base.complexity),
    reverb: unit(input.reverb, base.reverb),
    seed: number(input.seed, base.seed) >>> 0,
    loop: typeof input.loop === "boolean" ? input.loop : base.loop,
    volumes,
    engine: 2,
    ...(arrangement ? { arrangement } : {}),
  };
}
