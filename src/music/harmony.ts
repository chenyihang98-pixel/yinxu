/**
 * Harmony: choose a progression per section from the style's roman-numeral
 * bank, vary it functionally, colour it with the complexity control, add the
 * loop turnaround or the final cadence, and realise the chordal parts (comp
 * and pad) with voice leading.
 */
import type { MusicConfig } from "../types";
import {
  parseKey,
  styleInfo,
  type InstrumentId,
  type SectionType,
} from "./catalog";
import {
  energyAtBar,
  isFastTempo,
  type SectionPlan,
  type Timing,
} from "./form";
import { hashUnit, type Rng } from "./random";
import type { ChordSpan, PartRole, VoiceId } from "./score";
import type {
  CompDef,
  CompPattern,
  CompRow,
  ExtensionTable,
  ModeDef,
  PadDef,
  Progression,
  StyleDef,
  Tier,
} from "./styles/types";
import {
  LEAD_TRAITS,
  SCALES,
  VOICE_RANGES,
  clamp,
  lerp,
  mod,
  numeralForPitch,
  parseRoman,
  parseSteps,
  ramp,
  splitBar,
  voiceChord,
  type BeatNote,
  type Chord,
  type KeyContext,
  type ScaleName,
  type VoicingStyle,
} from "./theory";

export interface ChordSlot {
  index: number;
  /** bar in which the chord starts */
  bar: number;
  /** start in beats from the top of the piece */
  beat: number;
  beats: number;
  chord: Chord;
  /**
   * The chord as the progression has it, before the complexity control adds
   * sevenths and ninths. The tune rests on these notes, so colouring the
   * harmony never moves the melody.
   */
  plain: Chord;
  /** index of the section the chord belongs to */
  section: number;
}

export interface HarmonyPlan {
  slots: ChordSlot[];
  /** chord sounding at a beat (wraps in loops, clamps otherwise) */
  at(beat: number): ChordSlot;
  /** the chord that follows; wraps in loops, the last chord repeats otherwise */
  after(slot: ChordSlot): ChordSlot;
  /** the progression each section type ended up with, for the arrangement notes */
  outline: Partial<Record<SectionType, string[]>>;
  /** true when config.arrangement.progression replaced the style bank */
  overridden: boolean;
  /** true when the last bar of a loop was rewritten to lead back into bar 1 */
  turnaround: boolean;
}

/** Everything a part generator needs to know about the piece. */
export interface Ctx {
  config: MusicConfig;
  style: StyleDef;
  key: KeyContext;
  timing: Timing;
  sections: SectionPlan[];
  harmony: HarmonyPlan;
  rng: Rng;
  /** which sections each layer plays in (indexed by section) */
  plays: Record<PartRole, boolean[]>;
  /** the swing every part shares, and the subdivision it applies to */
  feel: { swing: number; grid: 8 | 16 };
}

export const tierOf = (energy: number): keyof Tier<unknown> =>
  energy < 0.36 ? "low" : energy < 0.7 ? "mid" : "high";

/** Sections that sit above the verse: they take the busier half of a pattern list. */
export const isLifted = (type: SectionType) =>
  type === "chorus" || type === "build";

/**
 * Pick from a list written from calm to busy: verses draw from the first half,
 * lifted sections from the second, so two sections in the same tier contrast.
 */
export function pickRanked<T>(
  list: readonly T[],
  lifted: boolean,
  rng: Rng,
): T {
  if (list.length <= 1) return list[0];
  const half = Math.ceil(list.length / 2);
  return rng.pick(lifted ? list.slice(half) : list.slice(0, half));
}

/** The instrument's sweet spot, lifted by the style as far as the instrument has room above it. */
function naturalCentre(instrument: InstrumentId, style: StyleDef): number {
  const trait = LEAD_TRAITS[instrument];
  // a style lifts its tune to clear the accompaniment; instruments that
  // already sing high (flute, bells, music box) need little or none of it
  const wanted = style.melody.register ?? 0;
  const lift =
    wanted > 0 ? wanted * clamp((78 - trait.centre) / 9, 0, 1) : wanted;
  return clamp(trait.centre + lift, trait.low + 7, trait.high - 7);
}

/** Where the lead instrument would put a tune of this style if the key left it free. */
export const sweetSpot = (ctx: Pick<Ctx, "config" | "style">) =>
  naturalCentre(ctx.config.instrument, ctx.style);

/** semitones folded into [-6, 6): the shorter way round the octave */
const nearestOctave = (semitones: number) => mod(semitones + 6, 12) - 6;

/**
 * The widest compass a tune has around its centre, in semitones: the verse
 * lives in about a tenth, the chorus up to a fifth above it, a breakdown a
 * third below.
 */
export const TUNE_BELOW = 10;
export const TUNE_ABOVE = 15;
/**
 * Where most of a tune's notes lie inside that compass: the verse's own tenth
 * and the chorus a fourth above it. Beyond lie only the peaks of the chorus
 * and the ends of cadence walks.
 */
const BODY_BELOW = 8;
const BODY_ABOVE = 12;

/** Where a tune sits on an instrument and how far it reaches from there. */
export interface TuneCompass {
  /** where the instrument puts the centre of the tune when the key leaves it free */
  centre: number;
  /** semitones the tune may reach below and above its centre */
  below: number;
  above: number;
}

/**
 * The compass of a tune on this instrument: what the instrument has around
 * the tune's natural centre, up to a fifth above the verse's tenth and a
 * third below it. It belongs to the instrument, the style and a register
 * hint (which slides the centre by a fourth, as far as the instrument goes)
 * and never to the key: in every key the tune has the same notes to choose
 * from, so another key is the same tune transposed, to the last note. Where
 * the key puts that compass a little past the end of the instrument, the few
 * notes out there are played an octave nearer (see composeLead) — they are
 * not redrawn.
 */
export function tuneCompass(
  instrument: InstrumentId,
  style: StyleDef,
  register?: "low" | "mid" | "high",
): TuneCompass {
  const trait = LEAD_TRAITS[instrument];
  const slide = register === "low" ? -5 : register === "high" ? 5 : 0;
  const centre = clamp(
    naturalCentre(instrument, style) + slide,
    trait.low + 7,
    trait.high - 7,
  );
  return {
    centre,
    below: Math.min(TUNE_BELOW, centre - trait.low),
    above: Math.min(TUNE_ABOVE, trait.high - centre),
  };
}

/**
 * Where the tune sits, so the accompaniment can keep out of its way.
 *
 * The tune is anchored to the TONIC, not to the instrument: its centre lies a
 * fixed interval from the tonic (the interval the style's own key and lead
 * give, where the centre is the instrument's sweet spot), and the tonic is
 * taken in the octave that brings this centre closest to where the
 * instrument in use would put it (tuneCompass). Another key therefore moves
 * the whole tune by the shorter way round instead of re-drawing it around a
 * fixed pitch, and another lead instrument moves it by octaves only. The
 * shorter way is not taken at any price: every semitone of the tune's
 * compass that an octave would push out of the instrument's range counts
 * against it — the notes out there have to be played an octave nearer — and
 * those the body of the tune lives on (BODY_BELOW … BODY_ABOVE) count far
 * more than the peaks of the chorus and the ends of cadence walks. An
 * instrument that already sings high (bells, a music box, a flute) is rather
 * taken down than up.
 */
export function leadCentre(ctx: Pick<Ctx, "config" | "style" | "key">): number {
  const home = styleInfo(ctx.style.id);
  const homeCentre = naturalCentre(home.instrument, ctx.style);
  const offset = nearestOctave(homeCentre - parseKey(home.key).tonic);
  const instrument = ctx.config.instrument;
  const trait = LEAD_TRAITS[instrument];
  const compass = tuneCompass(
    instrument,
    ctx.style,
    ctx.config.arrangement?.melody?.register,
  );
  // (a register hint slides the centre along the scale, away from the tonic's own interval)
  const slide = compass.centre - naturalCentre(instrument, ctx.style);
  const wanted = compass.centre;
  const near = wanted + nearestOctave(ctx.key.tonic + offset + slide - wanted);
  // going up costs more the higher the instrument already sits
  const shrill = 1 + clamp((trait.centre - 72) / 4, 0, 2);
  const outside = (centre: number, below: number, above: number) =>
    Math.max(0, centre + above - trait.high) +
    Math.max(0, trait.low - (centre - below));
  const cost = (centre: number) => {
    const all = outside(centre, compass.below, compass.above);
    const body = outside(
      centre,
      Math.min(BODY_BELOW, compass.below),
      Math.min(BODY_ABOVE, compass.above),
    );
    const away = centre - wanted;
    return (away > 0 ? away * shrill : -away) + 1.5 * (all - body) + 6 * body;
  };
  let centre = near;
  for (const other of [near - 12, near + 12])
    if (cost(other) < cost(centre)) centre = other;
  return centre;
}

const DEFAULT_EXTENSIONS: ExtensionTable = {
  major: ["maj7", "maj9"],
  minor: ["7", "9"],
  dominant: ["7", "9"],
};
const NINTH_SUFFIXES = new Set(["maj9", "9", "m9", "add9", "69", "13"]);

const FUNCTION_POOLS = {
  major: { T: ["I"], t: ["vi", "iii"], S: ["IV", "ii"], D: ["V"] },
  minor: { T: ["i"], t: ["bVI", "bIII"], S: ["iv", "bVI"], D: ["V", "bVII"] },
};
const FUNCTION_SHAPES = ["tSTD", "SDtD", "STSD", "ttSD"];

/** A four-bar progression from the T–S–D grammar, for section types the bank leaves open. */
function functionalProgression(minor: boolean, rng: Rng): Progression {
  const pools = FUNCTION_POOLS[minor ? "minor" : "major"];
  const shape = rng.pick(FUNCTION_SHAPES);
  const bars: string[] = [];
  for (const letter of shape) {
    const pool = pools[letter as keyof typeof pools];
    let roman = rng.pick(pool);
    if (roman === bars[bars.length - 1] && pool.length > 1)
      roman = pool[(pool.indexOf(roman) + 1) % pool.length];
    bars.push(roman);
  }
  return bars;
}

const SUBSTITUTES: Record<"major" | "minor", Record<string, string>> = {
  major: { IV: "ii", ii: "IV", iii: "I/III" },
  minor: { iv: "bVI", bVI: "iv" },
};

const pitchDistance = (a: number, b: number) =>
  Math.min(mod(a - b, 12), mod(b - a, 12));

/**
 * Cadences and turnarounds for the modes whose colour is one altered degree.
 * They are used whenever the style's own tables (written for major and minor)
 * would bring back the unaltered degree: the natural fourth in lydian, the
 * flat sixth in dorian, the natural second in phrygian, the leading tone in
 * mixolydian.
 */
const MODAL_CADENCES: Partial<Record<ScaleName, Progression[]>> = {
  lydian: [["II"], ["vii", "II"]],
  dorian: [
    ["IV", "bVII"],
    ["ii", "bVII"],
  ],
  phrygian: [["bII"], ["bvii", "bII"]],
  mixolydian: [["bVII"], ["v", "bVII"]],
};
const MODAL_TURNAROUNDS: Partial<Record<ScaleName, string[]>> = {
  lydian: ["V", "II"],
  dorian: ["bVII", "v"],
  phrygian: ["bII", "bvii"],
  mixolydian: ["bVII", "v"],
};

export function planHarmony(input: {
  config: MusicConfig;
  style: StyleDef;
  key: KeyContext;
  mode: ModeDef;
  timing: Timing;
  sections: SectionPlan[];
  rng: Rng;
}): HarmonyPlan {
  const { config, style, key, mode, timing, sections, rng } = input;
  const def = style.harmony;
  const complexity = config.complexity;
  const tonality = key.minor ? "minor" : "major";
  const tonicRoman = key.minor ? "i" : "I";
  const override = config.arrangement?.progression;
  const overridden = !!override && override.length >= 2;
  // a five-note tune has only two or three notes to offer a chromatic chord:
  // pentatonic modes keep their harmony diatonic
  const chromatic = key.pcs.length >= 7;

  const cache = new Map<string, Chord>();
  const parse = (roman: string): Chord => {
    let chord = cache.get(roman);
    if (!chord) {
      chord = parseRoman(roman, key) ?? parseRoman(tonicRoman, key)!;
      cache.set(roman, chord);
    }
    return chord;
  };
  const single = (bar: string): Chord | null => {
    const tokens = splitBar(bar);
    return tokens.length === 1 ? parse(tokens[0]) : null;
  };
  const firstChord = (bar: string) => parse(splitBar(bar)[0] ?? tonicRoman);
  const lastChord = (bar: string) => {
    const tokens = splitBar(bar);
    return parse(tokens[tokens.length - 1] ?? tonicRoman);
  };

  /* ---- the mode's own colour ---- */
  // notes of plain major / natural minor that this mode has replaced
  const foreign = SCALES[key.minor ? "naturalMinor" : "major"]
    .map((interval) => mod(key.tonic + interval, 12))
    .filter((pitch) => !key.parent[pitch]);
  /** true when no chord of the bar brings back a degree the mode has altered */
  const modal = (bar: string) =>
    !foreign.length ||
    splitBar(bar).every(
      (token) =>
        !parse(token).pitchClasses.some((pitch) => foreign.includes(pitch)),
    );
  const turnarounds = (mode.turnaround ?? def.turnaround[tonality]).filter(
    modal,
  );
  if (!turnarounds.length && def.turnaround[tonality].length)
    turnarounds.push(...(MODAL_TURNAROUNDS[key.scaleName] ?? []).filter(modal));
  /** a plain chord that leads to the tonic without leaving the mode */
  const dominant =
    (key.minor ? ["v", "bVII", "bvii", "bII"] : ["V", "v", "bVII", "II"]).find(
      modal,
    ) ?? "V";

  /* ---- colour: triads → sevenths → ninths as the level rises ---- */
  const colourLevel = lerp(def.colour[0], def.colour[1], complexity);
  const extensions: ExtensionTable = {
    ...DEFAULT_EXTENSIONS,
    ...def.extensions,
  };
  const colourise = (roman: string): string => {
    const chord = parse(roman);
    const level =
      chord.suffix === ""
        ? 0
        : ["7", "maj7", "m7"].includes(chord.suffix)
          ? 1
          : -1;
    if (level < 0 || !chord.intervals.includes(7)) return roman;
    const lowerCase = chord.head === chord.head.toLowerCase();
    if (chord.minor !== lowerCase) return roman;
    const draw = hashUnit(rng.seed, `colour:${chord.head}`);
    const target =
      colourLevel > 0.55 + 0.45 * draw
        ? 2
        : colourLevel > 0.12 + 0.5 * draw
          ? 1
          : 0;
    if (target <= level) return roman;
    let category: keyof ExtensionTable;
    if (chord.minor) category = "minor";
    else if (chord.applied) category = "dominant";
    else if (key.parent[mod(chord.root + 11, 12)]) category = "major";
    else if (key.parent[mod(chord.root + 10, 12)]) category = "dominant";
    else category = "major";
    const table = extensions[category];
    let suffix = table[target - 1];
    const ninthFits = key.parent[mod(chord.root + 2, 12)] && !chord.applied;
    if (
      target === 2 &&
      (suffix === "" || (NINTH_SUFFIXES.has(suffix) && !ninthFits))
    )
      suffix = level < 1 ? table[0] : "";
    if (NINTH_SUFFIXES.has(suffix) && !ninthFits) suffix = "";
    if (!suffix || suffix === chord.suffix) return roman;
    return `${chord.head}${suffix}${chord.slash ? `/${chord.slash}` : ""}`;
  };

  /* ---- functional variation of a bank progression ---- */
  const vary = (progression: Progression, type: SectionType): Progression => {
    const bars = progression.slice();
    const count = bars.length;
    // every decision has a draw of its own, held against a threshold that
    // moves with the complexity: turning the control flips the decisions one
    // by one instead of re-rolling the whole progression
    const takes = (name: string, probability: number) =>
      hashUnit(rng.seed, `vary:${type}:${name}`) < probability;
    const plain = (chord: Chord | null): chord is Chord =>
      !!chord && chord.suffix === "" && !chord.slash;
    // same-function swaps in the middle of the phrase
    for (let i = 1; i < count - 1; i++) {
      const chord = single(bars[i]);
      const swap = plain(chord) ? SUBSTITUTES[tonality][chord.head] : undefined;
      if (swap && takes(`swap:${i}`, def.variation * 0.3 * (0.4 + complexity)))
        bars[i] = swap;
    }
    // first inversions that turn a leaping bass into a line
    for (let i = 1; i < count - 1; i++) {
      const chord = single(bars[i]);
      if (!plain(chord)) continue;
      const before = lastChord(bars[i - 1]).bass;
      const after = firstChord(bars[i + 1]).bass;
      const third = mod(chord.root + (chord.minor ? 3 : 4), 12);
      const smooth =
        third !== before &&
        third !== after &&
        pitchDistance(third, before) <= 2 &&
        pitchDistance(third, after) <= 2;
      if (
        smooth &&
        takes(`invert:${i}`, def.variation * (0.25 + 0.6 * complexity))
      )
        bars[i] = `${chord.roman}/${numeralForPitch(third, key)}`;
    }
    // secondary dominants into diatonic chords other than the tonic
    let applied = 0;
    const appliedLimit = count > 4 ? 2 : 1;
    // (not from the last bar: what follows a section is not always its own first chord)
    for (let i = 0; i < count - 1 && applied < appliedLimit; i++) {
      const chord = single(bars[i]);
      const target = firstChord(bars[(i + 1) % count]);
      if (!chord || chord.fn === "D" || target.applied || target.slash)
        continue;
      if (target.root === key.tonic || target.root === chord.root) continue;
      if (!target.intervals.includes(7) || !key.parent[target.root]) continue;
      // as a plain triad the dominant of IV is just the tonic again
      if (
        colourLevel <= 0.3 &&
        !key.minor &&
        mod(target.root + 7, 12) === key.tonic
      )
        continue;
      if (colourLevel <= 0.3 && mod(target.root + 7, 12) === chord.root)
        continue;
      if (
        !chromatic ||
        !takes(`applied:${i}`, def.secondary * ramp(0.3, 0.9, complexity))
      )
        continue;
      bars[i] = `${bars[i]} ${colourLevel > 0.3 ? "V7" : "V"}/${target.head}`;
      applied++;
    }
    // minor subdominant on the way home
    if (!key.minor && chromatic)
      for (let i = 0; i < count; i++) {
        const chord = single(bars[i]);
        if (!plain(chord) || chord.head !== "IV") continue;
        if (firstChord(bars[(i + 1) % count]).head !== "I") continue;
        if (takes("borrowed", def.borrowed * ramp(0.45, 1, complexity)))
          bars[i] = "IV iv";
        break;
      }
    // suspended dominant resolving inside the last bar
    const closing = single(bars[count - 1]);
    if (
      closing &&
      closing.head === "V" &&
      !closing.slash &&
      (closing.suffix === "" || closing.suffix === "7") &&
      takes("sus", def.sus * ramp(0.3, 0.9, complexity))
    )
      bars[count - 1] =
        `${closing.suffix === "7" ? "V7sus4" : "Vsus4"} ${closing.roman}`;
    return bars;
  };

  const chosen = new Map<SectionType, Progression>();
  const progressionFor = (type: SectionType): Progression => {
    const known = chosen.get(type);
    if (known) return known;
    const bank = mode.bank;
    const dice = rng.fork(`progression:${type}`);
    let result: Progression;
    if (type === "intro" || type === "outro")
      result = bank[type]
        ? vary(dice.pick(bank[type]!), type)
        : progressionFor("verse");
    else {
      let options: Progression[];
      if (type === "verse") options = bank.verse;
      else if (type === "chorus") options = bank.chorus ?? bank.verse;
      else if (type === "bridge")
        options = bank.bridge ?? [functionalProgression(key.minor, dice)];
      else if (type === "breakdown")
        options = bank.breakdown ?? bank.bridge ?? bank.verse;
      else options = bank.build ?? bank.chorus ?? bank.verse;
      if (type !== "verse" && options.length > 1) {
        // contrast: avoid the progression the verse already uses
        const verse = progressionFor("verse").join("|");
        const others = options.filter(
          (option) => vary(option, "verse").join("|") !== verse,
        );
        if (others.length) options = others;
      }
      result = vary(dice.pick(options.length ? options : [[tonicRoman]]), type);
    }
    if (!result.length) result = [tonicRoman];
    chosen.set(type, result);
    return result;
  };

  /* ---- one entry per bar ---- */
  const scoredBars = timing.loop ? timing.bars : timing.finalBar + 1;
  /** `home`: the chord the bar would hold if the applied chord spread into it were dropped */
  const entries: { bar: string; group: string; home?: string }[] = [];
  if (overridden) {
    const anchor =
      sections.find((section) => section.type !== "intro")?.startBar ?? 0;
    for (let bar = 0; bar < scoredBars; bar++)
      entries.push({
        bar: override![mod(bar - anchor, override!.length)],
        group: `o${bar}`,
      });
  } else {
    for (const section of sections) {
      const progression = progressionFor(section.type);
      const length = progression.length;
      const step = barsPerChord(style, timing.bpm, section.type);
      const pass = length * step;
      const count = section.playBars;
      const remainder = count % 4;
      for (let b = 0; b < count; b++) {
        let aligned = b;
        if (section.type === "intro") aligned = b + mod(-count, pass);
        else if (
          count >= 4 &&
          remainder > 0 &&
          remainder <= 2 &&
          b >= count - remainder
        )
          aligned = pass - remainder + (b - (count - remainder));
        const position = Math.floor(aligned / step);
        const entry = progression[mod(position, length)];
        const tokens = splitBar(entry);
        // at two bars per entry a split entry gives each chord a bar of its own
        const spread = step === 2 && tokens.length >= 2;
        entries[section.startBar + b] = {
          bar: spread ? tokens[mod(aligned, 2)] : entry,
          group:
            step === 1 || spread
              ? `s${section.index}b${b}`
              : `s${section.index}p${position}`,
          home: spread && mod(aligned, 2) === 1 ? tokens[0] : undefined,
        };
      }
    }
  }
  for (let bar = 0; bar < scoredBars; bar++)
    if (!entries[bar]) entries[bar] = { bar: tonicRoman, group: `f${bar}` };

  /** bars whose chord was replaced after the progressions were laid out */
  const rewritten = new Set<number>();
  const rewrite = (bar: number, roman: string, group: string) => {
    entries[bar] = { bar: roman, group };
    rewritten.add(bar);
  };

  // a build must end unresolved: its last bar is a dominant
  if (!overridden)
    for (const section of sections) {
      if (section.type !== "build" || section.ending || section.playBars < 2)
        continue;
      const bar = section.startBar + section.playBars - 1;
      if (lastChord(entries[bar].bar).fn !== "D")
        rewrite(bar, turnarounds[0] ?? dominant, `b${bar}`);
    }

  let turned = false;
  if (!timing.loop) {
    /* ---- ending: cadence bars, then the held tonic ---- */
    const ending = sections[sections.length - 1];
    const finalBar = timing.finalBar;
    if (overridden) {
      const before = finalBar - 1;
      if (before >= 0 && lastChord(entries[before].bar).fn === "T")
        entries[before] = { bar: "V", group: `c${before}` };
      entries[finalBar] = { bar: tonicRoman, group: "final" };
    } else {
      // the style's cadences, as far as they keep to the mode; otherwise the mode's own
      let cadences = (mode.cadence ?? def.cadence[tonality]).filter((option) =>
        option.every(modal),
      );
      if (!cadences.length)
        cadences = (MODAL_CADENCES[key.scaleName] ?? []).filter((option) =>
          option.every(modal),
        );
      if (!cadences.length) cadences = [[dominant]];
      const cadence = rng.fork("cadence").pick(cadences);
      const room = Math.min(cadence.length, ending.playBars, finalBar);
      for (let i = 0; i < room; i++)
        rewrite(
          finalBar - room + i,
          cadence[cadence.length - room + i],
          `c${i}`,
        );
      // a last chord that would deny the mode is played plain; the colour pass may dress it again
      const final = mode.final ?? def.final[tonality];
      rewrite(finalBar, modal(final) ? final : tonicRoman, "final");
    }
  } else if (!overridden && def.turnaround[tonality].length) {
    /* ---- loop: the last bar must lead back into bar 1 ---- */
    const lastBar = scoredBars - 1;
    const home = firstChord(entries[0].bar);
    const closing = lastChord(entries[lastBar].bar);
    const pull = mod(closing.root - home.root, 12);
    const leadsHome =
      closing.fn === "D" &&
      (pull === 7 || pull === 10 || pull === 11 || pull === 1);
    if (!leadsHome) {
      // only turnarounds that really move towards the first chord
      const pulls = (bar: string) =>
        [7, 10, 11, 1, 5, 2].includes(mod(lastChord(bar).root - home.root, 12));
      const options = turnarounds.filter(pulls);
      const applicable =
        home.root !== key.tonic &&
        home.intervals.includes(7) &&
        !home.slash &&
        modal(`V/${home.head}`);
      let turnaround = options.length
        ? rng.fork("turnaround").pick(options)
        : applicable
          ? `V/${home.head}`
          : dominant;
      if (applicable && chromatic && def.secondary > 0 && complexity >= 0.45)
        turnaround = `${colourLevel > 0.3 ? "V7" : "V"}/${home.head}`;
      const tokens = splitBar(turnaround);
      const opening = splitBar(entries[lastBar].bar)[0];
      rewrite(
        lastBar,
        tokens.length >= 2 ||
          lastBar === 0 ||
          parse(opening).root === parse(tokens[0]).root
          ? turnaround
          : `${opening} ${tokens[0]}`,
        "turnaround",
      );
      turned = true;
    }
  }

  /* ---- an applied dominant keeps its target ---- */
  // vary() aims "V7/x" at the chord of the next bar; where the form cuts the
  // progression short, or a cadence, a turnaround or a build's dominant has
  // replaced that bar, the dominant would resolve to nothing
  if (!overridden)
    for (let bar = 0; bar < scoredBars; bar++) {
      const after = bar + 1 < scoredBars ? bar + 1 : timing.loop ? 0 : -1;
      const tokens = splitBar(entries[bar].bar);
      const kept: string[] = [];
      tokens.forEach((token, k) => {
        const chord = parse(token);
        const next =
          k + 1 < tokens.length
            ? parse(tokens[k + 1])
            : after >= 0
              ? firstChord(entries[after].bar)
              : undefined;
        const aims = mod(chord.root + (chord.head === "V" ? 5 : 1), 12);
        if (!chord.applied || !next || next.root === aims) {
          kept.push(token);
          return;
        }
        // one of two chords in the bar (added by vary(), or left over in front
        // of a turnaround): the bar keeps its other chord
        if (tokens.length >= 2) return;
        // spread over a bar of its own at two bars per chord: the chord before it stays
        if (entries[bar].home) {
          kept.push(entries[bar].home!);
          return;
        }
        // written in the bank, and what it led to has been replaced: it leads to the new chord
        if (rewritten.has(after)) {
          const seventh = chord.suffix === "7" ? "V7" : "V";
          const diatonic =
            next.root !== key.tonic &&
            key.parent[next.root] &&
            next.intervals.includes(7) &&
            !next.slash;
          if (diatonic) kept.push(`${seventh}/${next.head}`);
          else if (next.root === key.tonic)
            kept.push(dominant === "V" ? seventh : dominant);
          else kept.push(token);
          return;
        }
        // written in the bank at the end of a section: a deceptive turn the style asked for
        kept.push(token);
      });
      if (kept.join(" ") !== tokens.join(" "))
        entries[bar] = {
          ...entries[bar],
          bar: kept.length ? kept.join(" ") : tonicRoman,
        };
    }

  /* ---- slots ---- */
  const sectionOfBar: number[] = [];
  for (const section of sections)
    for (let b = 0; b < section.bars; b++)
      sectionOfBar[section.startBar + b] = section.index;
  const finish = (roman: string) => (overridden ? roman : colourise(roman));
  const slots: ChordSlot[] = [];
  const push = (bar: number, beat: number, beats: number, roman: string) =>
    slots.push({
      index: slots.length,
      bar,
      beat,
      beats,
      chord: parse(finish(roman)),
      plain: parse(roman),
      section: sectionOfBar[bar] ?? sections.length - 1,
    });
  const beatsPerBar = timing.beatsPerBar;
  for (let bar = 0; bar < scoredBars;) {
    const entry = entries[bar];
    const tokens = splitBar(entry.bar);
    if (tokens.length >= 2) {
      const half = beatsPerBar / 2;
      push(bar, bar * beatsPerBar, half, tokens[0]);
      push(bar, bar * beatsPerBar + half, beatsPerBar - half, tokens[1]);
      bar++;
      continue;
    }
    let span = 1;
    while (
      bar + span < scoredBars &&
      entries[bar + span].group === entry.group &&
      entries[bar + span].bar === entry.bar &&
      sectionOfBar[bar + span] === sectionOfBar[bar]
    )
      span++;
    push(bar, bar * beatsPerBar, span * beatsPerBar, tokens[0] ?? tonicRoman);
    bar += span;
  }
  const totalBeats = timing.bars * beatsPerBar;
  const last = slots[slots.length - 1];
  last.beats = totalBeats - last.beat;

  const byBeat: ChordSlot[] = [];
  for (const slot of slots)
    for (let beat = slot.beat; beat < slot.beat + slot.beats; beat++)
      byBeat[beat] = slot;

  const outline: HarmonyPlan["outline"] = {};
  for (const section of sections) {
    if (outline[section.type] || section.ending) continue;
    outline[section.type] = slots
      .filter((slot) => slot.section === section.index)
      .slice(0, 8)
      .map((slot) => slot.chord.roman);
  }

  return {
    slots,
    at: (beat) => {
      const index = Math.floor(beat);
      return byBeat[
        timing.loop ? mod(index, totalBeats) : clamp(index, 0, totalBeats - 1)
      ];
    },
    after: (slot) => slots[slot.index + 1] ?? (timing.loop ? slots[0] : slot),
    outline,
    overridden,
    turnaround: turned,
  };
}

/** Bars each entry of a progression lasts in a section of this type at this tempo. */
export function barsPerChord(
  style: StyleDef,
  bpm: number,
  section: SectionType,
): 1 | 2 {
  return (
    style.harmony.barsPerChord?.({ bpm, section }) ??
    (isFastTempo(bpm, style) ? 2 : 1)
  );
}

export function chordSpans(plan: HarmonyPlan, timing: Timing): ChordSpan[] {
  const last = plan.slots.length - 1;
  return plan.slots.map((slot, index) => ({
    start: Math.min(slot.beat * timing.beatSeconds, timing.duration),
    // the last chord ends exactly with the piece, whatever the rounding
    end:
      index === last
        ? timing.duration
        : Math.min(
            (slot.beat + slot.beats) * timing.beatSeconds,
            timing.duration,
          ),
    bar: slot.bar,
    symbol: slot.chord.symbol,
    roman: slot.chord.roman,
    pitchClasses: slot.chord.pitchClasses.slice(),
    root: slot.chord.root,
  }));
}

/* ------------------------------------------------------------------ */
/* chordal parts                                                       */
/* ------------------------------------------------------------------ */

/** One voicing per chord slot, each moving as little as possible from the last. */
export function voiceLead(
  plan: HarmonyPlan,
  options: { style: VoicingStyle; voices: number; low: number; high: number },
): number[][] {
  const result: number[][] = [];
  let previous: number[] | undefined;
  for (const slot of plan.slots) {
    const notes = voiceChord(slot.chord, { ...options, previous });
    result.push(notes);
    previous = notes;
  }
  return result;
}

/**
 * Notes a comp row plays. "all" is the voicing as it stands; the split rows
 * work like two hands: "low" / "1" is the chord's bass note at or below the
 * voicing, the other rows are the voicing above it.
 */
function rowNotes(
  voicing: number[],
  row: CompRow,
  bassPc: number,
  floor: number,
): number[] {
  // `floor`: lowest note the left hand may take (it stays out of a playing bass's octave)
  if (row === "all") return voicing;
  let bass = voicing[0] - mod(voicing[0] - bassPc, 12);
  // keep the "left hand" clear of the voicing, by more the lower it lies
  const clearance = voicing[0] < 55 ? 5 : 3;
  if (bass > voicing[0] - clearance && bass - 12 >= floor) bass -= 12;
  // no room underneath (a bass instrument owns that octave): the left hand
  // takes the lowest note of the voicing, whichever chord tone it is
  if (bass < floor) bass = voicing[0];
  const hand = voicing.filter((note) => note > bass);
  const upper = hand.length ? hand : voicing;
  const count = upper.length;
  switch (row) {
    case "low":
    case "1":
      return [bass];
    case "top":
      return [upper[count - 1]];
    case "upper":
      return upper;
    case "mid":
      return count > 1 ? upper.slice(0, count - 1) : upper;
    default: {
      const index = Number(row) - 2;
      // a row above the voicing reaches for the octave of a lower note
      return [index < count ? upper[index] : upper[index % count] + 12];
    }
  }
}

function pickPattern<T>(
  tiers: Tier<T[]>,
  tier: keyof Tier<T[]>,
  rng: Rng,
  lifted: boolean,
): T | undefined {
  const order: (keyof Tier<T[]>)[] =
    tier === "low"
      ? ["low", "mid", "high"]
      : tier === "mid"
        ? ["mid", "low", "high"]
        : ["high", "mid", "low"];
  for (const name of order)
    if (tiers[name]?.length) return pickRanked(tiers[name], lifted, rng);
  return undefined;
}

export function composeComp(
  ctx: Ctx,
  def: CompDef,
  voice: VoiceId,
): BeatNote[] {
  const { harmony, timing, style, sections } = ctx;
  const range = VOICE_RANGES[voice];
  // the accompaniment keeps underneath the tune: its top is capped a little
  // below the lead's centre, as far as the voicing still has room to breathe
  const [windowLow, windowHigh] = style.harmony.register;
  const low = Math.max(windowLow, range[0]);
  const room = style.harmony.voicing === "open" ? 17 : 13;
  const high = Math.min(
    range[1],
    Math.max(low + room, Math.min(windowHigh, leadCentre(ctx) - 5)),
  );
  const voicings = voiceLead(harmony, {
    style: style.harmony.voicing,
    voices: style.harmony.voices,
    low,
    high,
  });
  const beatsPerBar = timing.beatsPerBar;
  // sixteenths shorter than about 85 ms smear: the off-sixteenths are left out
  const tooFast = timing.beatSeconds / 4 < 0.085;
  const notes: BeatNote[] = [];
  for (const section of sections) {
    if (!ctx.plays.comp[section.index]) continue;
    const tier = tierOf(section.energy);
    const pattern: CompPattern | undefined = pickPattern(
      def.patterns,
      tier,
      ctx.rng.fork(`comp:${section.type}:${tier}`),
      isLifted(section.type),
    );
    if (!pattern) continue;
    // with a bass playing, the left hand leaves the octave below C3 to it
    const bassless = !ctx.plays.bass[section.index];
    const floor = Math.max(range[0], bassless ? 36 : 50);
    for (let b = 0; b < section.playBars; b++) {
      const bar = section.startBar + b;
      const level =
        (0.62 + 0.38 * energyAtBar(section, bar)) * (pattern.level ?? 1);
      for (const [row, text] of Object.entries(pattern.rows) as [
        CompRow,
        string,
      ][]) {
        const parsed = parseSteps(text);
        const offset = (b % (parsed.steps / 16)) * 16;
        for (const hit of parsed.hits) {
          if (hit.step < offset || hit.step >= offset + 16) continue;
          const step = hit.step - offset;
          if (tooFast && step % 2 === 1) continue;
          const beat = bar * beatsPerBar + step / 4;
          let slot = harmony.at(beat);
          const pushed = !!pattern.push && step >= 14;
          if (pushed)
            slot = harmony.after(
              harmony.at(bar * beatsPerBar + beatsPerBar - 0.01),
            );
          let length = hit.length / 4;
          if (!pushed) length = Math.min(length, slot.beat + slot.beats - beat);
          length = Math.max(0.2, length * (pattern.gate ?? 1));
          let pitches = rowNotes(
            voicings[slot.index],
            row,
            slot.chord.bass,
            floor,
          );
          // nobody else plays the bass here: a block chord gets its own bass note
          // underneath, or an inverted voicing would change what the chord is
          if (
            row === "all" &&
            bassless &&
            mod(pitches[0], 12) !== slot.chord.bass
          ) {
            const under = rowNotes(
              voicings[slot.index],
              "low",
              slot.chord.bass,
              floor,
            )[0];
            if (under < pitches[0]) pitches = [under, ...pitches];
          }
          const upstroke = !!pattern.strumAlternate && step % 4 === 2;
          pitches.forEach((midi, index) => {
            const order = upstroke ? pitches.length - 1 - index : index;
            notes.push({
              beat,
              len: length,
              midi,
              vel: clamp(
                hit.vel * level * (row === "all" && index > 0 ? 0.94 : 1),
                0.06,
                1,
              ),
              late: pattern.strum ? order * pattern.strum : undefined,
            });
          });
        }
      }
    }
  }
  const ending = sections[sections.length - 1];
  if (!timing.loop && ctx.plays.comp[ending.index]) {
    const beat = timing.finalBar * beatsPerBar;
    const slot = harmony.at(beat);
    let voicing = voicings[slot.index];
    // without a bass under it the last chord rests on its own root
    if (
      !ctx.plays.bass[ending.index] &&
      mod(voicing[0], 12) !== slot.chord.bass
    ) {
      const under = rowNotes(
        voicing,
        "low",
        slot.chord.bass,
        Math.max(range[0], 36),
      )[0];
      if (under < voicing[0]) voicing = [under, ...voicing];
    }
    voicing.forEach((midi, index) =>
      notes.push({
        beat,
        len: timing.endBeat - beat,
        midi,
        vel: clamp(0.62 * (0.62 + 0.38 * ending.energy), 0.1, 1),
        late: index * 0.028,
      }),
    );
  }
  return notes;
}

export function composePad(ctx: Ctx, def: PadDef, voice: VoiceId): BeatNote[] {
  const { harmony, timing, sections } = ctx;
  const range = VOICE_RANGES[voice];
  const window = def.register ?? [48, 76];
  const voicings = voiceLead(harmony, {
    style: def.voicing ?? "open",
    voices: def.voices ?? 3,
    low: Math.max(window[0], range[0]),
    high: Math.min(window[1], range[1]),
  });
  const notes: BeatNote[] = [];
  /** notes still sounding, by pitch, so common tones are tied instead of re-struck */
  const open = new Map<number, BeatNote>();
  for (const slot of harmony.slots) {
    const section = sections[slot.section];
    if (!ctx.plays.pad[section.index]) {
      open.clear();
      continue;
    }
    const final = !timing.loop && slot.bar >= timing.finalBar;
    const length = final ? timing.endBeat - slot.beat : slot.beats;
    const energy = energyAtBar(section, slot.bar);
    const sounding = new Map<number, BeatNote>();
    for (const midi of voicings[slot.index]) {
      const held = open.get(midi);
      if (held && Math.abs(held.beat + held.len - slot.beat) < 1e-6 && !final) {
        held.len += length;
        sounding.set(midi, held);
        continue;
      }
      const note: BeatNote = {
        beat: slot.beat,
        len: length,
        midi,
        vel: clamp(0.42 + 0.3 * energy, 0.1, 1),
      };
      notes.push(note);
      sounding.set(midi, note);
    }
    open.clear();
    for (const [midi, note] of sounding) open.set(midi, note);
  }
  return notes;
}
