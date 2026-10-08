/**
 * Rhythm section: the beat → seconds map (one swing ratio for every part),
 * drum grooves with ghost notes, fills and section accents, the percussion
 * layer, and bass lines that lock to the kick.
 */
import type { BassFeel, DrumFeel, SectionType } from "./catalog";
import { energyAtBar, type SectionPlan, type Timing } from "./form";
import { isLifted, pickRanked, tierOf, type Ctx } from "./harmony";
import type { Rng } from "./random";
import { CYMBAL_SWELL_SECONDS } from "./score";
import type { DrumKind, DrumKitId } from "./score";
import type { BassDef, DrumsDef, Groove, PercDef, Tier } from "./styles/types";
import {
  VOICE_RANGES,
  clamp,
  mod,
  parseSteps,
  type BeatNote,
  type Chord,
} from "./theory";

/* ------------------------------------------------------------------ */
/* time                                                                */
/* ------------------------------------------------------------------ */

export interface TimeMap {
  /** seconds at a beat position, swing included */
  seconds(beat: number): number;
}

/**
 * Swing delays the second half of every pair (pair = one beat for eighth-note
 * swing, half a beat for sixteenth-note swing): the off-beat lands at
 * 0.5 + swing / 4 of the pair, so 0.66 is a triplet feel. The warp is
 * continuous, so note lengths stretch with it and nothing overlaps.
 *
 * Rubato lets the tempo breathe inside every four-bar phrase (two bars when a
 * loop is not a multiple of four): it lingers at the phrase edges and moves on
 * in the middle, up to ±7 % at rubato 1. Every part shares the same clock, the
 * phrase boundaries stay exactly on the bar grid, and a piece that ends
 * settles back onto the grid for its final chord.
 */
export function makeTimeMap(timing: Timing, swing: number, grid: 8 | 16, rubato = 0): TimeMap {
  const pair = grid === 8 ? 1 : 0.5;
  const point = 0.5 + clamp(swing, 0, 0.66) / 4;
  const period = (timing.loop && timing.bars % 4 !== 0 ? 2 : 4) * timing.beatsPerBar;
  const depth = (clamp(rubato, 0, 1) * 0.07 * period) / (2 * Math.PI);
  const settle = timing.finalBar * timing.beatsPerBar;
  const breathe = (beat: number) => {
    if (depth <= 0) return 0;
    const fade = timing.loop ? 1 : clamp((settle - beat) / timing.beatsPerBar, 0, 1);
    return depth * fade * Math.sin((2 * Math.PI * beat) / period);
  };
  return {
    seconds(beat) {
      let warped = beat;
      if (swing > 0) {
        const base = Math.floor(beat / pair) * pair;
        const x = (beat - base) / pair;
        warped =
          base + (x < 0.5 ? x * 2 * point : point + (x - 0.5) * 2 * (1 - point)) * pair;
      }
      return (warped + breathe(beat)) * timing.beatSeconds;
    },
  };
}

/* ------------------------------------------------------------------ */
/* drums                                                               */
/* ------------------------------------------------------------------ */

export interface BeatHit {
  beat: number;
  kind: DrumKind;
  vel: number;
  /** extra delay in seconds (laid-back backbeat) */
  late?: number;
}

/** Seconds before a section downbeat at which a cymbalSwell starts. */
export const SWELL_LEAD_SECONDS = CYMBAL_SWELL_SECONDS;

type Feel = Exclude<DrumFeel, "auto" | "none">;

/** Built-in grooves for config.arrangement.drums. */
const FEEL_GROOVES: Record<Feel, Tier<Groove[]>> = {
  light: {
    low: [{ kick: "o...............", rim: "........o.......", shaker: "..g...g...g...g." }],
    mid: [{ kick: "x.........o.....", rim: "....o.......o...", shaker: "o.g.o.g.o.g.o.g." }],
    high: [{ kick: "x.....o...x.....", rim: "....x.......x...", hatClosed: "o.g.o.g.o.g.o.g." }],
  },
  straight: {
    low: [{ kick: "x.......x.......", snare: "....o.......o...", hatClosed: "o...o...o...o..." }],
    mid: [{ kick: "X.......x.x.....", snare: "....X.......X...", hatClosed: "x.o.x.o.x.o.x.o." }],
    high: [
      {
        kick: "X.....x.x.x.....",
        snare: "....X.......X...",
        hatClosed: "x.o.x.o.x.o.x.o.",
        hatOpen: "..............o.",
      },
    ],
  },
  halftime: {
    low: [{ kick: "x...............", snare: "........o.......", hatClosed: "o...o...o...o..." }],
    mid: [{ kick: "X.........x.....", snare: "........X.......", hatClosed: "x.o.x.o.x.o.x.o." }],
    high: [
      {
        kick: "X..x......x..x..",
        snare: "........X.......",
        hatClosed: "x.o.x.o.x.o.x.o.",
        hatOpen: "..............o.",
      },
    ],
  },
  fourfloor: {
    low: [{ kick: "x...x...x...x...", hatClosed: "..o...o...o...o." }],
    mid: [{ kick: "X...X...X...X...", clap: "....x.......x...", hatClosed: "..x...x...x...x." }],
    high: [
      {
        kick: "X...X...X...X...",
        clap: "....X.......X...",
        hatOpen: "..x...x...x...x.",
        hatClosed: "x..gx..gx..gx..g",
      },
    ],
  },
  swing: {
    low: [{ ride: "o...o.g.o...o.g.", hatClosed: "....o.......o..." }],
    mid: [
      {
        ride: "x...x.o.x...x.o.",
        hatClosed: "....x.......x...",
        kick: "g...g...g...g...",
        snare: "..........g.....",
      },
    ],
    high: [
      {
        ride: "X...x.x.X...x.x.",
        hatClosed: "....x.......x...",
        kick: "o.....g...o.....",
        snare: "......g.....o...",
      },
    ],
  },
  shuffle: {
    low: [{ kick: "x.......x.......", snare: "....o.......o...", hatClosed: "o.g.o.g.o.g.o.g." }],
    mid: [{ kick: "X.....x.X.......", snare: "....X.......X...", hatClosed: "x.o.x.o.x.o.x.o." }],
    high: [
      {
        kick: "X.....x.X.....x.",
        snare: "....X.......X...",
        hatClosed: "x.x.x.x.x.x.x.x.",
        hatOpen: "..............o.",
      },
    ],
  },
  breakbeat: {
    low: [{ kick: "x.........x.....", snare: "....o.......o...", hatClosed: "o.o.o.o.o.o.o.o." }],
    mid: [{ kick: "X.....x...x.....", snare: "....X..g.g..X...", hatClosed: "x.x.x.x.x.x.x.x." }],
    high: [
      {
        kick: "X..x..x...x..x..",
        snare: "....X..g.g..X..g",
        hatClosed: "x.x.x.x.x.x.x.x.",
        hatOpen: "......o.........",
      },
    ],
  },
  march: {
    low: [{ kick: "x.......x.......", snare: "....o.......o.g." }],
    mid: [{ kick: "X.......X.......", snare: "x..gx..gx.g.x.xx" }],
    high: [{ kick: "X...x...X...x...", snare: "X.gxx.gxX.gxxrxx" }],
  },
  cinematic: {
    low: [{ taiko: "X.........o....." }],
    mid: [{ taiko: "X..x..x...x.x...", tomLow: "..............x." }],
    high: [{ taiko: "X..x..x.X..x..x.", tomLow: "....x.......x.x.", snare: "..........g.g.xx" }],
  },
};

const FEEL_KITS: Partial<Record<Feel, DrumKitId>> = {
  light: "soft",
  swing: "brush",
  shuffle: "acoustic",
  cinematic: "cinematic",
  march: "acoustic",
};

const DEFAULT_FILLS: NonNullable<DrumsDef["fills"]> = {
  light: [
    { snare: "..............ox" },
    { snare: "............o.ox" },
    { tomHigh: "............x...", tomLow: "..............x." },
  ],
  full: [
    { snare: "........o.o.oxxX" },
    {
      tomHigh: "........xx......",
      tomMid: "..........xx....",
      tomLow: "............xx..",
      snare: "..............xX",
    },
    { snare: "........x..x..x.", tomLow: "..............xx" },
  ],
};

/** kinds that keep playing underneath a fill */
const FILL_SURVIVORS = new Set<DrumKind>(["kick", "taiko", "subBoom", "gong"]);

export interface DrumSetup {
  kit: DrumKitId;
  from: number;
  mute?: SectionType[];
  grooves: Tier<Groove[]>;
  def?: DrumsDef;
}

/** Combine the style's kit with config.arrangement.drums. Returns null when no kit plays. */
export function resolveDrums(
  style: DrumsDef | undefined,
  feel: DrumFeel | undefined,
): DrumSetup | null {
  if (feel === "none") return null;
  // a breakdown is the section where the drums drop out
  const mute = style?.mute ?? ["breakdown"];
  if (feel && feel !== "auto")
    return {
      kit: style?.kit ?? FEEL_KITS[feel] ?? "pop",
      // an explicit feel is a request to hear drums: they play whatever the energy
      from: 0,
      mute,
      grooves: FEEL_GROOVES[feel],
      def: style,
    };
  if (!style) return null;
  return { kit: style.kit, from: style.from, mute, grooves: style.grooves, def: style };
}

/** Feels that imply swung time when the style itself is straight. */
export const SWUNG_FEELS: Partial<Record<DrumFeel, number>> = { swing: 0.6, shuffle: 0.64 };

interface BarHit {
  step: number;
  kind: DrumKind;
  vel: number;
  /** offset inside the step in sixteenths (rolls) */
  shift?: number;
}

function grooveBar(groove: Groove, barInSection: number): BarHit[] {
  const hits: BarHit[] = [];
  for (const [kind, row] of Object.entries(groove) as [DrumKind, string][]) {
    const parsed = parseSteps(row);
    const offset = (barInSection % (parsed.steps / 16)) * 16;
    for (const hit of parsed.hits) {
      if (hit.step < offset || hit.step >= offset + 16) continue;
      const step = hit.step - offset;
      if (hit.roll) {
        hits.push({ step, kind, vel: hit.vel * 0.8 });
        hits.push({ step, kind, vel: hit.vel, shift: 0.5 });
      } else hits.push({ step, kind, vel: hit.vel });
    }
  }
  return hits;
}

function pickGroove(
  tiers: Tier<Groove[]>,
  tier: keyof Tier<Groove[]>,
  rng: Rng,
  lifted: boolean,
): Groove {
  const order: (keyof Tier<Groove[]>)[] =
    tier === "low" ? ["low", "mid", "high"] : tier === "mid" ? ["mid", "low", "high"] : ["high", "mid", "low"];
  for (const name of order) if (tiers[name]?.length) return pickRanked(tiers[name], lifted, rng);
  return {};
}

export interface DrumResult {
  hits: BeatHit[];
  /** sixteenth steps on which the kick (or the lowest drum) plays, per bar */
  kickSteps: Map<number, number[]>;
}

export function composeDrums(ctx: Ctx, setup: DrumSetup): DrumResult {
  const { timing, sections, rng, config } = ctx;
  const def = setup.def;
  const beatsPerBar = timing.beatsPerBar;
  const fills = def?.fills ?? DEFAULT_FILLS;
  const remap = def?.remap ?? {};
  const complexity = config.complexity;
  const hits: BeatHit[] = [];
  const kickSteps = new Map<number, number[]>();
  const emit = (beat: number, kind: DrumKind, vel: number) => {
    const mapped = kind in remap ? remap[kind] : kind;
    if (!mapped) return;
    const lag = def?.lag?.[kind];
    hits.push({ beat, kind: mapped, vel: clamp(vel, 0.04, 1), late: lag ? lag / 1000 : undefined });
  };
  const plays = (section: SectionPlan | undefined) => !!section && ctx.plays.kit[section.index];

  for (const section of sections) {
    const next = section.next >= 0 ? sections[section.next] : undefined;
    const active = plays(section);
    const boundaryBeat = (section.startBar + section.playBars) * beatsPerBar;

    // riser into a section that lifts the energy
    if (def?.swell && next && plays(next) && next.energy > section.energy + 0.06 && !section.ending) {
      const lead = SWELL_LEAD_SECONDS / timing.beatSeconds;
      const beat = boundaryBeat - Math.min(lead, section.playBars * beatsPerBar);
      emit(beat, "cymbalSwell", 0.5 + 0.35 * next.energy);
    }
    if (!active) continue;

    const dice = rng.fork(`drums:${section.type}`);
    const ghostSteps = [7, 9, 15, 3, 11, 13]
      .filter(() => dice.chance((def?.ghost ?? 0.3) * complexity))
      .slice(0, 3);
    const variation = dice.int(0, 2);
    /** the lowest drum the section's grooves use; kits without one get no final thump */
    let lastLow: DrumKind | undefined;

    for (let b = 0; b < section.playBars; b++) {
      const bar = section.startBar + b;
      const energy = energyAtBar(section, bar);
      const tier = tierOf(energy);
      const groove = pickGroove(
        setup.grooves,
        tier,
        rng.fork(`groove:${section.type}:${tier}`),
        isLifted(section.type),
      );
      let barHits = grooveBar(groove, b);
      const has = (kind: DrumKind, step: number) =>
        barHits.some((hit) => hit.kind === kind && hit.step === step && !hit.shift);
      const lowDrum: DrumKind = groove.kick ? "kick" : groove.taiko ? "taiko" : "kick";
      const hasLow = !!groove.kick || !!groove.taiko;
      if (hasLow) lastLow = lowDrum;
      else if (groove.tomLow) lastLow = "tomLow";

      // ghost notes around the backbeat
      if (groove.snare && tier !== "low")
        for (const step of ghostSteps)
          if (!has("snare", step)) barHits.push({ step, kind: "snare", vel: 0.2 });

      // every fourth bar breathes: a pushed kick or an open hat
      const lastOfSection = b === section.playBars - 1;
      if (b % 4 === 3 && !lastOfSection && tier !== "low") {
        if (variation === 0 && hasLow && !has(lowDrum, 14))
          barHits.push({ step: 14, kind: lowDrum, vel: 0.6 });
        else if (variation === 1 && groove.hatClosed) {
          barHits = barHits.filter((hit) => !(hit.kind === "hatClosed" && hit.step === 14));
          barHits.push({ step: 14, kind: "hatOpen", vel: 0.5 });
        } else if (hasLow && !has(lowDrum, 11)) barHits.push({ step: 11, kind: lowDrum, vel: 0.5 });
      }

      // a build: the backbeat gives way to a roll that doubles its speed and grows
      const rolling = section.type === "build" && !!def?.buildRoll;
      if (rolling) {
        const roll = def!.buildRoll!;
        barHits = barHits.filter(
          (hit) => hit.kind !== "snare" && hit.kind !== "clap" && hit.kind !== "rim" && hit.kind !== roll,
        );
        for (let step = 0; step < 16; step++) {
          const progress = (b + step / 16) / section.playBars;
          const rate = progress < 0.5 ? 4 : progress < 0.75 ? 2 : 1;
          if (step % rate === 0) barHits.push({ step, kind: roll, vel: 0.36 + 0.56 * progress });
        }
        // the low drum drops out under the last two beats so the arrival lands harder
        if (lastOfSection)
          barHits = barHits.filter((hit) => !(hit.kind === lowDrum && hit.step >= 8));
      }

      // fill into the next section (or back to the top of the loop)
      const leadsOn = lastOfSection && (next !== undefined || section.ending);
      const fillEnergy = Math.max(energy, next ? next.energy : 0);
      if (leadsOn && fillEnergy >= 0.22 && !rolling) {
        const size = fillEnergy < 0.5 ? "light" : "full";
        const options = fills[size].length ? fills[size] : DEFAULT_FILLS[size];
        const fill = rng.fork(`fill:${section.type}:${section.occurrence % 2}`).pick(options);
        let fillHits = grooveBar(fill, 0);
        if (timing.bpm > 150) fillHits = fillHits.filter((hit) => hit.step % 2 === 0 || hit.step >= 14);
        if (fillHits.length) {
          const start = Math.min(...fillHits.map((hit) => hit.step));
          const fillHasLow = fillHits.some((hit) => FILL_SURVIVORS.has(hit.kind));
          barHits = barHits.filter(
            (hit) => hit.step < start || (FILL_SURVIVORS.has(hit.kind) && !fillHasLow),
          );
          for (const hit of fillHits)
            barHits.push({
              ...hit,
              vel: hit.vel * (0.72 + 0.28 * fillEnergy) + (0.1 * (hit.step - start)) / Math.max(1, 16 - start),
            });
        }
      }

      // an open hat silences the closed hat on the same step
      const openSteps = new Set(barHits.filter((hit) => hit.kind === "hatOpen").map((hit) => hit.step));
      barHits = barHits.filter((hit) => !(hit.kind === "hatClosed" && openSteps.has(hit.step)));

      kickSteps.set(
        bar,
        [...new Set(barHits.filter((hit) => hit.kind === lowDrum && !hit.shift).map((hit) => hit.step))].sort(
          (a, b2) => a - b2,
        ),
      );
      const level = 0.66 + 0.34 * energy;
      for (const hit of barHits)
        emit(
          bar * beatsPerBar + (hit.step + (hit.shift ?? 0)) / 4,
          hit.kind,
          hit.vel <= 0.3 ? hit.vel * (0.85 + 0.3 * energy) : hit.vel * level,
        );
    }

    // arrival accent on the first beat of a section that comes in with energy
    const firstOfPiece = section.index === 0 && !timing.loop;
    if (section.energy >= (firstOfPiece ? 0.75 : 0.42)) {
      const beat = section.startBar * beatsPerBar;
      if (def?.crash !== null) emit(beat, def?.crash ?? "crash", 0.5 + 0.4 * section.energy);
      if (def?.impact) emit(beat, def.impact, 0.6 + 0.35 * section.energy);
    }

    // the final chord lands with one last hit
    if (section.ending) {
      const beat = timing.finalBar * beatsPerBar;
      if (lastLow) emit(beat, lastLow, 0.55 + 0.35 * section.energy);
      if (def?.crash !== null && section.energy >= 0.25)
        emit(beat, def?.crash ?? "crash", 0.4 + 0.35 * section.energy);
      if (def?.impact) emit(beat, def.impact, 0.5 + 0.3 * section.energy);
    }
  }
  return { hits, kickSteps };
}

export function composePerc(ctx: Ctx, def: PercDef, remap: DrumsDef["remap"]): BeatHit[] {
  const { timing, sections, rng } = ctx;
  const hits: BeatHit[] = [];
  const grooves = def.byLead?.[ctx.config.instrument] ?? def.grooves;
  if (!grooves.length) return hits;
  for (const section of sections) {
    if (!ctx.plays.perc[section.index]) continue;
    const groove = rng.fork(`perc:${section.type}`).pick(grooves);
    for (let b = 0; b < section.playBars; b++) {
      const bar = section.startBar + b;
      const level = 0.62 + 0.38 * energyAtBar(section, bar);
      for (const hit of grooveBar(groove, b)) {
        const mapped = remap && hit.kind in remap ? remap[hit.kind] : hit.kind;
        if (!mapped) continue;
        hits.push({
          beat: bar * timing.beatsPerBar + (hit.step + (hit.shift ?? 0)) / 4,
          kind: mapped,
          vel: clamp(hit.vel * level, 0.04, 1),
        });
      }
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* bass                                                                */
/* ------------------------------------------------------------------ */

type ActiveBassFeel = Exclude<BassFeel, "auto">;

export function composeBass(
  ctx: Ctx,
  def: BassDef,
  feelOverride: ActiveBassFeel | undefined,
  kickSteps: Map<number, number[]>,
): BeatNote[] {
  const { harmony, timing, sections, key, config, rng } = ctx;
  const range = VOICE_RANGES[def.voice];
  const low = Math.max(def.register[0], range[0]);
  const high = Math.min(Math.max(def.register[1], low + 11), range[1]);
  const home = (low + high) / 2 - 1;
  const gate = def.gate ?? 0.92;
  const beatsPerBar = timing.beatsPerBar;
  const complexity = config.complexity;
  const notes: BeatNote[] = [];
  let previous = home;

  /** place a pitch class in the bass window, close to the last note and to the home register */
  const place = (pc: number, near = previous): number => {
    let best = low;
    let bestCost = Infinity;
    for (let midi = low; midi <= high; midi++) {
      if (mod(midi, 12) !== mod(pc, 12)) continue;
      const cost = Math.abs(midi - near) * 0.55 + Math.abs(midi - home) * 0.45;
      if (cost < bestCost) {
        bestCost = cost;
        best = midi;
      }
    }
    return best;
  };
  const fit = (midi: number): number => {
    let note = midi;
    // upper notes stay below C3 or so: above it they would rub against the chords
    while (note > high + 4 || note > range[1]) note -= 12;
    while (note < low - 5 || note < range[0]) note += 12;
    return note;
  };
  const add = (beat: number, len: number, midi: number, vel: number) => {
    const note: BeatNote = { beat, len: Math.max(0.1, len), midi: fit(midi), vel: clamp(vel, 0.1, 1) };
    const last = notes[notes.length - 1];
    // a held note that would be struck again at the very moment it ends (a
    // drone under a new section, the tonic under the final chord) is tied
    // instead: see the pedal figure below for what the re-strike sounds like
    if (last && last.midi === note.midi && last.len >= 2 && Math.abs(last.beat + last.len - beat) < 0.05) {
      last.len = beat + note.len - last.beat;
      previous = note.midi;
      return;
    }
    if (def.slide && last && last.midi !== note.midi && Math.abs(last.midi - note.midi) <= 12) {
      const dice = rng.fork(`slide:${Math.round(beat * 4) % 64}`);
      if (dice.chance(def.slide)) note.bend = last.midi - note.midi;
    }
    notes.push(note);
    previous = note.midi;
  };
  const fifthInterval = (chord: Chord) => chord.intervals.find((t) => t === 6 || t === 7 || t === 8) ?? 7;
  /**
   * Semitones from the chord's BASS note up to its fifth / third. Over an
   * inversion the bass is not the root, so the distance is measured from the
   * note actually played (C/E: the fifth G lies a minor third above E).
   */
  const above = (chord: Chord, interval: number) => mod(chord.root + interval - chord.bass, 12);
  const fifthOf = (chord: Chord) => above(chord, fifthInterval(chord)) || 12;
  const thirdOf = (chord: Chord) =>
    above(chord, chord.intervals.find((t) => t === 3 || t === 4) ?? fifthInterval(chord)) || 12;

  /** approach note one eighth (or one beat) before the next root */
  // a five-note tune has no leading tones: under it the bass approaches by
  // the scale's own neighbours (or the fifth), never by a semitone from outside
  const pentatonic = key.pcs.length <= 5;
  const inScale = (midi: number) => key.pcs.includes(mod(midi, 12));
  const approach = (target: number, from: number, dice: Rng): number => {
    const options: number[] = [];
    if (pentatonic) {
      for (const direction of [-1, 1])
        for (let step = 1; step <= 4; step++)
          if (inScale(target + direction * step)) {
            options.push(target + direction * step);
            break;
          }
    } else {
      options.push(target - 1, target + 1);
      for (const step of [-2, 2]) if (key.parent[mod(target + step, 12)]) options.push(target + step);
    }
    const fifth = target + 7 > high + 5 ? target - 5 : target + 7;
    // (over an inversion the fifth above the bass note may be foreign to chord and scale alike)
    if (!pentatonic || inScale(fifth)) options.push(fifth);
    const usable = options.filter((option) => option !== from);
    // prefer the neighbour that continues the line; chromatic approaches from
    // above are a colour for busier, jazzier settings
    const chromatic = 0.12 + 0.6 * complexity * def.approach;
    const weights = usable.map(
      (option) =>
        (key.parent[mod(option, 12)] || option === target - 1 ? 1 : chromatic) /
        (1 + Math.abs(option - from)) ** 2,
    );
    return dice.weighted(usable, weights);
  };

  for (const section of sections) {
    if (!ctx.plays.bass[section.index]) continue;
    for (let b = 0; b < section.playBars; b++) {
      const bar = section.startBar + b;
      const energy = energyAtBar(section, bar);
      const feel: ActiveBassFeel = feelOverride ?? def.feel[tierOf(energy)];
      if (feel === "none") continue;
      const tier = def.calm ? "low" : tierOf(energy);
      const dice = rng.fork(`bass:${section.type}:${b % 8}`);
      const barBeat = bar * beatsPerBar;
      const loud = (0.66 + 0.26 * energy) * (def.level?.[tierOf(energy)] ?? 1);
      const approachChance = def.approach * (0.35 + 0.65 * complexity);

      // chord segments inside this bar
      const segments: { beat: number; beats: number; chord: Chord; nextChord: Chord }[] = [];
      for (let beat = barBeat; beat < barBeat + beatsPerBar; ) {
        const slot = harmony.at(beat);
        const end = Math.min(slot.beat + slot.beats, barBeat + beatsPerBar);
        const following = end >= slot.beat + slot.beats ? harmony.after(slot) : slot;
        segments.push({ beat, beats: end - beat, chord: slot.chord, nextChord: following.chord });
        beat = end;
      }

      const written = feelOverride ? undefined : def.riffs?.[tierOf(energy)];
      if (written && written.length) {
        const text = pickRanked(written, isLifted(section.type), rng.fork(`riff:${section.type}:${tierOf(energy)}`))
          .replace(/[\s|]/g, "")
          .padEnd(16, ".")
          .slice(0, 16);
        // a chord change inside the bar restates the new root
        const changes = new Set(segments.slice(1).map((segment) => Math.round((segment.beat - barBeat) * 4)));
        const roots = new Map<number, number>();
        let ringing = false;
        for (let step = 0; step < 16; step++) {
          let symbol = text[step];
          if (symbol === "-") {
            ringing = false;
            continue;
          }
          if (symbol === ".") {
            if (!(ringing && changes.has(step))) continue;
            symbol = "1";
          } else if (changes.has(step)) symbol = "1";
          // faster than a bass can speak: the off-sixteenths are left out
          if (step % 2 === 1 && timing.beatSeconds / 4 < 0.078 && !changes.has(step)) continue;
          let end = step + 1;
          while (end < 16 && text[end] === "." && !changes.has(end)) end++;
          const beat = barBeat + step / 4;
          const slot = harmony.at(beat);
          const chord = slot.chord;
          let root = roots.get(slot.index);
          if (root === undefined) {
            root = place(chord.bass);
            roots.set(slot.index, root);
          }
          const next = harmony.after(slot).chord;
          let midi = root;
          if (symbol === "8") midi = root + 12;
          else if (symbol === "5") {
            // the fifth above, or the one below when that would leave the register
            midi = root + fifthOf(chord);
            if (midi > high + 1) midi -= 12;
          }
          else if (symbol === "3") midi = root + thirdOf(chord);
          else if (symbol === "7")
            midi =
              root -
              12 +
              (above(chord, chord.intervals.find((t) => t === 9 || t === 10 || t === 11) ?? 10) || 12);
          else if (symbol === "a")
            midi = next.bass !== chord.bass ? approach(place(next.bass, root), root, dice) : root + fifthOf(chord);
          const accent = step % 8 === 0 ? 1 : step % 4 === 0 ? 0.92 : 0.82;
          add(beat, ((end - step) / 4) * gate, midi, loud * accent * (symbol === "8" ? 0.92 : 1));
          // figures are anchored on the root, not on wherever the last note went
          previous = root;
          ringing = true;
        }
        continue;
      }

      if (feel === "pedal") {
        const tonic = place(key.tonic, home);
        if (tier === "low") {
          // One drone note for as long as it lasts. It is never re-struck:
          // a sustained bass has no reverb and a release of a tenth of a
          // second, and a new note of the same pitch starting where the old
          // one ends meets it at an arbitrary phase — a 20 dB hole of 40 ms
          // in the drone every time (seen in spectrograms of ambient pieces).
          const held = notes[notes.length - 1];
          if (held && Math.abs(held.beat + held.len - barBeat) < 0.05 && held.midi === tonic)
            held.len += beatsPerBar;
          else add(barBeat, beatsPerBar, tonic, loud * 0.9);
        } else {
          const rate = tier === "mid" ? 4 : 2;
          for (let step = 0; step < 16; step += rate)
            add(barBeat + step / 4, (rate / 4) * gate, tonic, step % 8 === 0 ? loud : loud * 0.8);
        }
        continue;
      }

      for (const segment of segments) {
        const { chord, nextChord } = segment;
        const root = place(chord.bass);
        const changes = nextChord.bass !== chord.bass;
        const target = place(nextChord.bass, root);
        const end = segment.beat + segment.beats;
        const lastSegment = segment === segments[segments.length - 1];
        const wantsApproach = changes && lastSegment && dice.chance(approachChance);

        if (feel === "walking") {
          const quarters = Math.max(1, Math.round(segment.beats));
          const third = root + thirdOf(chord);
          const fifth = root + fifthOf(chord);
          const second = root + (key.parent[mod(root + 2, 12)] ? 2 : 1);
          const lines = [
            [root, third, fifth, third],
            [root, second, third, fifth],
            [root, fifth, third, second],
            [root, fifth - 12, third - 12, root - (key.parent[mod(root - 2, 12)] ? 2 : 1)],
          ];
          const line = dice.pick(lines);
          for (let q = 0; q < quarters; q++) {
            const beat = segment.beat + q;
            const lastQuarter = q === quarters - 1 && quarters > 1;
            // the next root is taken in the octave the line is already in
            const midi =
              lastQuarter && changes
                ? approach(place(nextChord.bass, previous), previous, dice)
                : line[Math.min(q, line.length - 1)];
            add(beat, Math.min(1, end - beat) * gate, midi, q === 0 ? loud : loud * 0.86);
          }
          continue;
        }

        if (feel === "syncopated") {
          const offset = Math.round((segment.beat - barBeat) * 4);
          const limit = offset + Math.round(segment.beats * 4);
          const played = kickSteps.get(bar);
          const kicks = played && played.length ? played : [0, 6, 10];
          // every kick gets a note, unless they come faster than a bass can speak
          const spacing = Math.max(1, Math.ceil(0.1 / (timing.beatSeconds / 4)));
          const steps = [...new Set([offset, ...kicks.filter((step) => step >= offset && step < limit)])]
            .sort((a, b2) => a - b2)
            .filter((step, i, all) => i === 0 || step - all[i - 1] >= spacing);
          steps.forEach((step, i) => {
            const nextStep = steps[i + 1] ?? limit;
            if (wantsApproach && step >= limit - 2 && i > 0) return;
            const length = Math.min(nextStep - step, 4) / 4;
            const colour = i === 0 ? 0 : dice.next();
            const midi = colour > 0.85 ? root + 12 : colour > 0.72 ? root + fifthOf(chord) : root;
            add(barBeat + step / 4, length * gate * 0.9, midi, i === 0 ? loud : loud * 0.84);
          });
          if (wantsApproach) add(end - 0.5, 0.5 * gate, approach(target, root, dice), loud * 0.78);
          continue;
        }

        if (feel === "octave" || feel === "arpeggio") {
          const rate = tier === "low" ? 1 : 0.5;
          const count = Math.max(1, Math.round(segment.beats / rate));
          const fifth = root + fifthOf(chord);
          const order = feel === "octave" ? [root, root + 12] : [root, fifth, root + 12, fifth];
          for (let i = 0; i < count; i++) {
            const beat = segment.beat + i * rate;
            const lastNote = i === count - 1 && count > 1;
            const midi = lastNote && wantsApproach ? approach(target, previous, dice) : order[i % order.length];
            add(beat, rate * gate * (feel === "octave" ? 0.8 : 0.92), midi, i % 2 === 0 ? loud : loud * 0.8);
          }
          continue;
        }

        // "root": long notes that tighten into a pulse as the energy rises
        if (tier === "low" || segment.beats < 2) {
          const length = wantsApproach && segment.beats >= 2 ? segment.beats - 0.5 : segment.beats;
          add(segment.beat, length * gate, root, loud * 0.92);
          if (wantsApproach && segment.beats >= 2)
            add(end - 0.5, 0.5 * gate, approach(target, root, dice), loud * 0.74);
        } else if (tier === "mid") {
          if (segment.beats >= 4) {
            add(segment.beat, 1.5 * gate, root, loud);
            add(segment.beat + 1.5, 0.5 * gate, root, loud * 0.72);
            add(segment.beat + 2, (wantsApproach ? 1.5 : 2) * gate, root, loud * 0.9);
          } else add(segment.beat, (wantsApproach ? segment.beats - 0.5 : segment.beats) * gate, root, loud);
          if (wantsApproach) add(end - 0.5, 0.5 * gate, approach(target, root, dice), loud * 0.74);
        } else {
          const count = Math.round(segment.beats * 2);
          const pop = dice.int(2, 7);
          for (let i = 0; i < count; i++) {
            const lastNote = i === count - 1;
            let midi = root;
            if (lastNote && wantsApproach) midi = approach(target, root, dice);
            else if (i === pop && count >= 8 && dice.chance(0.5)) midi = root + 12;
            add(segment.beat + i * 0.5, 0.5 * gate * 0.88, midi, i % 2 === 0 ? loud : loud * 0.78);
          }
        }
      }
    }
  }

  const ending = sections[sections.length - 1];
  if (!timing.loop && ctx.plays.bass[ending.index] && (feelOverride ?? "root") !== "none") {
    const beat = timing.finalBar * beatsPerBar;
    add(beat, timing.endBeat - beat, place(harmony.at(beat).chord.bass), 0.7 + 0.2 * ending.energy);
  }
  return notes;
}
