/**
 * Melodic parts: the motif-based lead, the counter-melody and the arpeggio.
 *
 * The lead is not a random walk. A one- or two-bar motif (rhythm + contour in
 * scale steps) is invented per section family and then developed: repeated,
 * sequenced, given a varied tail, and shaped into question / answer phrases
 * with a breath at every phrase end and one climax per section. Strong beats
 * take chord tones, weak beats pass or neighbour inside the scale, and a leap
 * is answered by a step back.
 *
 * The tune belongs to the seed and the style. Tempo, energy, complexity, key
 * and lead instrument adapt it without drawing it again: see composeLead.
 */
import type { MusicConfig } from "../types";
import { styleInfo, type InstrumentId, type SectionType } from "./catalog";
import type { SectionPlan } from "./form";
import { FAST_TEMPO, energyAtBar, sectionEnergy } from "./form";
import {
  TUNE_ABOVE,
  TUNE_BELOW,
  leadCentre,
  sweetSpot,
  tierOf,
  type Ctx,
} from "./harmony";
import { hashUnit, type Rng } from "./random";
import type { VoiceId } from "./score";
import type { ArpDef, ArpPattern, CounterDef, StyleDef } from "./styles/types";
import {
  LEAD_TRAITS,
  VOICE_RANGES,
  clamp,
  mod,
  nearestIndex,
  nearestPitch,
  ramp,
  scaleLadder,
  type BeatNote,
  type Chord,
} from "./theory";

/* ------------------------------------------------------------------ */
/* rhythm vocabulary                                                   */
/* ------------------------------------------------------------------ */

type Onsets = [start: number, length: number][];
interface Cell {
  notes: Onsets;
  /** 0 = on the beat, 1 = off-beat, 2 = pushed */
  sync: number;
  /** needs sixteenth notes */
  fine: boolean;
  /** written for the style (MelodyDef.cells) rather than taken from the generic list */
  own?: boolean;
}
const cell = (notes: Onsets, sync = 0): Cell => ({
  notes,
  sync,
  fine: notes.some(([start, length]) => start % 2 === 1 || length % 2 === 1),
});

/** Half-bar rhythm cells on a grid of eight sixteenth steps. */
const CELLS: Cell[] = [
  cell([]),
  cell([[0, 8]]),
  cell([[0, 6]]),
  cell([[0, 4]]),
  cell([[4, 4]]),
  cell([
    [0, 4],
    [4, 4],
  ]),
  cell([
    [0, 6],
    [6, 2],
  ]),
  cell(
    [
      [0, 2],
      [2, 6],
    ],
    1,
  ),
  cell(
    [
      [2, 2],
      [4, 4],
    ],
    1,
  ),
  cell([
    [0, 4],
    [6, 2],
  ]),
  cell(
    [
      [0, 3],
      [3, 5],
    ],
    2,
  ),
  cell([
    [0, 4],
    [4, 2],
    [6, 2],
  ]),
  cell([
    [0, 2],
    [2, 2],
    [4, 4],
  ]),
  cell(
    [
      [0, 2],
      [2, 4],
      [6, 2],
    ],
    1,
  ),
  cell(
    [
      [0, 3],
      [3, 3],
      [6, 2],
    ],
    2,
  ),
  cell(
    [
      [2, 2],
      [4, 2],
      [6, 2],
    ],
    1,
  ),
  cell([
    [0, 2],
    [2, 2],
    [4, 2],
    [6, 2],
  ]),
  cell([
    [0, 3],
    [3, 1],
    [4, 4],
  ]),
  cell([
    [0, 2],
    [2, 1],
    [3, 1],
    [4, 4],
  ]),
  cell([
    [0, 4],
    [4, 1],
    [5, 1],
    [6, 2],
  ]),
  cell([
    [0, 2],
    [2, 2],
    [4, 1],
    [5, 1],
    [6, 2],
  ]),
  cell([
    [0, 1],
    [1, 1],
    [2, 2],
    [4, 2],
    [6, 2],
  ]),
  cell([
    [0, 2],
    [2, 1],
    [3, 1],
    [4, 2],
    [6, 1],
    [7, 1],
  ]),
];
/** a cell that lets a motif breathe at its end: one or two notes from the beat, the last one long */
const isResting = (item: Cell): boolean => {
  const count = item.notes.length;
  if (count < 1 || count > 2 || item.notes[0][0] !== 0) return false;
  const [start, length] = item.notes[count - 1];
  return length >= 4 || start + length <= 6;
};

/** "x...x.x." → a cell: x starts a note, "." lets it ring, "_" starts a rest. */
function parseCell(text: string): Cell | null {
  const raw = text.replace(/[\s|]/g, "");
  if (raw.length !== 8 || /[^x._]/.test(raw)) return null;
  const notes: Onsets = [];
  for (let i = 0; i < 8; i++) {
    if (raw[i] !== "x") continue;
    let end = i + 1;
    while (end < 8 && raw[end] === ".") end++;
    notes.push([i, end - i]);
  }
  let sync = notes.length && notes[0][0] === 2 ? 1 : 0;
  for (const [start, length] of notes) {
    if (start % 2 === 1 && length >= 2) sync = 2;
    else if (start % 4 === 2 && length >= 3) sync = Math.max(sync, 1);
  }
  return { ...cell(notes, sync), own: true };
}

const vocabularyCache = new Map<string, Cell[]>();
/** The style's own cells first, then the generic ones they do not already cover. */
function vocabularyOf(own: readonly string[] | undefined): Cell[] {
  if (!own || !own.length) return CELLS;
  const cacheKey = own.join("|");
  const cached = vocabularyCache.get(cacheKey);
  if (cached) return cached;
  const signature = (item: Cell) =>
    item.notes.map(([start, length]) => `${start}:${length}`).join(",");
  const cells: Cell[] = [];
  const seen = new Set<string>();
  for (const text of own) {
    const parsed = parseCell(text);
    if (!parsed || seen.has(signature(parsed))) continue;
    seen.add(signature(parsed));
    cells.push(parsed);
  }
  for (const generic of CELLS)
    if (!seen.has(signature(generic))) cells.push(generic);
  vocabularyCache.set(cacheKey, cells);
  return cells;
}

/** How much likelier a style's own cell is than a generic one of the same fit. */
const OWN_CELL_BOOST = 4;

/** Whole-bar phrase endings; the last note is the cadence note. */
const ENDINGS: Onsets[] = [
  [[0, 8]],
  [[0, 12]],
  [
    [0, 4],
    [4, 8],
  ],
  [
    [0, 6],
    [6, 6],
  ],
  [
    [0, 2],
    [2, 2],
    [4, 8],
  ],
  [
    [0, 4],
    [4, 4],
    [8, 6],
  ],
  [
    [0, 4],
    [4, 2],
    [6, 2],
    [8, 6],
  ],
  [
    [0, 2],
    [2, 2],
    [4, 4],
    [8, 6],
  ],
  [
    [0, 2],
    [2, 2],
    [4, 2],
    [6, 2],
    [8, 6],
  ],
];

/** The bar before the final chord: a line that walks onto the tonic. */
const APPROACHES: Onsets[] = [
  [[0, 12]],
  [
    [0, 8],
    [8, 8],
  ],
  [
    [0, 4],
    [4, 4],
    [8, 8],
  ],
  [
    [0, 4],
    [4, 4],
    [8, 4],
    [12, 4],
  ],
];

interface MotifNote {
  /** sixteenth step from the start of the motif */
  step: number;
  /** sixteenths the note sounds in the motif as written */
  length: number;
  /** structural note: lands on (or is tied over) a strong beat, or is long */
  strong: boolean;
  /** step of the strong beat a syncopated note is tied over */
  boundary?: number;
  /** skeleton position in scale steps relative to the motif's first note */
  degree: number;
  /** direction a passing or neighbour note leans (+1 up, -1 down) */
  turn: number;
  /**
   * Activity down to which the note sounds: 0 = always, otherwise below 1,
   * and the less the note matters the closer to 1.
   */
  from: number;
}
/** A passing note the tune takes on when it is asked to be busier than written. */
interface AddedNote {
  step: number;
  turn: number;
  /** activity from which it sounds, above 1 */
  from: number;
}
interface Motif {
  bars: 1 | 2;
  /** the motif as written */
  notes: MotifNote[];
  /** what it grows into, in the order the notes join in */
  added: AddedNote[];
}

interface MotifSettings {
  bars: 1 | 2;
  /** target notes per bar */
  perBar: number;
  /** 0..1 */
  syncopation: number;
  /** 0..1 weight of sixteenth-note cells */
  fine: number;
  stepBias: number;
  motion?: "stepwise" | "leaps" | "arpeggio";
  /** rhythm cells to choose from */
  cells: Cell[];
  /** sixteenth steps between metric accents: 8 normally, 16 when a bar flies by */
  grid: 8 | 16;
  /** swung eighths: a note on an odd sixteenth would fall between the swung pair */
  swung: boolean;
  /** 0..1 weight of the style's own sixteenth-note cells (they outlive low complexity while playable) */
  ownFine: number;
}

function chooseCell(
  rng: Rng,
  pool: Cell[],
  perHalf: number,
  settings: MotifSettings,
): Cell {
  const weights = pool.map((candidate) => {
    const count = candidate.notes.length;
    if (count === 0 && perHalf > 0.9) return 0;
    const fit = Math.exp(-((count - perHalf) ** 2) / 1.3);
    const sync =
      candidate.sync === 0
        ? 1
        : candidate.sync === 1
          ? 0.2 + 1.3 * settings.syncopation
          : 0.04 + 1.3 * settings.syncopation ** 2;
    const odd =
      settings.swung && candidate.notes.some(([start]) => start % 2 === 1);
    const fine = candidate.own
      ? Math.max(settings.fine, settings.ownFine)
      : settings.fine;
    return (
      fit *
      sync *
      (candidate.fine ? fine : 1) *
      (candidate.own ? OWN_CELL_BOOST : 1) *
      (odd ? 0.04 : 1)
    );
  });
  return rng.weighted(pool, weights);
}

/** Skeleton interval sizes in scale steps: [repeat, step, third, fourth, fifth]. */
function skeletonWeights(settings: MotifSettings): number[] {
  if (settings.motion === "stepwise") return [0.1, 0.62, 0.23, 0.05, 0];
  if (settings.motion === "leaps") return [0.05, 0.15, 0.35, 0.28, 0.17];
  if (settings.motion === "arpeggio") return [0.04, 0.06, 0.6, 0.12, 0.18];
  const step = clamp(0.12 + (settings.stepBias - 0.5) * 1.3, 0.1, 0.5);
  const rest = 0.9 - step;
  return [0.1, step, rest * 0.6, rest * 0.27, rest * 0.13];
}

/** How much a position in the bar matters: the downbeat, beat three, the other beats, the eighths. */
const metricWeight = (step: number) =>
  step % 16 === 0
    ? 1.5
    : step % 8 === 0
      ? 1
      : step % 4 === 0
        ? 0.6
        : step % 2 === 0
          ? 0.3
          : 0;

/**
 * Where a note of `length` sixteenths starting at `step` is split when the
 * tune takes on another note: on the coarsest grid that falls inside it, as
 * near to its middle as that grid allows, and never on the strong beat a
 * syncopated note is tied over (the push would be gone). -1 = it stays whole.
 */
function splitPoint(step: number, length: number, swung: boolean): number {
  for (const unit of [8, 4, 2, 1]) {
    if (unit >= length || (unit === 1 && swung)) continue;
    const points: number[] = [];
    for (
      let at = (Math.floor(step / unit) + 1) * unit;
      at < step + length;
      at += unit
    )
      if (!(at % 8 === 0 && step % 8 !== 0)) points.push(at);
    if (!points.length) continue;
    const middle = step + length / 2;
    return points.reduce((a, b) =>
      Math.abs(b - middle) <= Math.abs(a - middle) ? b : a,
    );
  }
  return -1;
}

/**
 * The motif of one section family. It is drawn ONCE, at the density the style
 * itself asks for, and every draw comes from a stream of its own, named after
 * the thing it decides (`…:cell:2`, `…:note:5`): no choice can shift another.
 *
 * Around the motif as written lies everything it can turn into. Each written
 * note carries the activity below which it drops out (the least important
 * first: off-beat passing notes, then the beats, last the skeleton), and a
 * list of passing notes says where the tune splits its longest notes when it
 * is asked to be busier. The lead is always composed from the motif as
 * written; only then are notes taken away or added (see `adapt` in
 * composeLead), so the notes that stay are the notes that were there.
 */
function makeMotif(rng: Rng, name: string, settings: MotifSettings): Motif {
  const fork = (part: string) => rng.fork(`${name}:${part}`);
  const perHalf = settings.perBar / 2;
  const grid = settings.grid;
  const sounding = settings.cells.filter(
    (candidate) => candidate.notes.length > 0,
  );
  const downbeat = sounding.filter((candidate) => candidate.notes[0][0] === 0);
  const resting = settings.cells.filter(isResting);
  // most ideas state their first note on the downbeat
  const opening = fork("cell:0");
  const first = chooseCell(
    opening,
    opening.chance(0.25 + 0.5 * settings.syncopation) ? sounding : downbeat,
    Math.max(perHalf, 1),
    settings,
  );
  const cells: Cell[] = [first];
  if (settings.bars === 2) {
    cells.push(chooseCell(fork("cell:1"), settings.cells, perHalf, settings));
    const third = fork("cell:2");
    cells.push(
      third.chance(0.45)
        ? first
        : chooseCell(third, sounding, Math.max(perHalf, 1), settings),
    );
    cells.push(
      chooseCell(
        fork("cell:3"),
        perHalf < 0.7 ? [CELLS[0], ...resting] : resting,
        Math.min(perHalf, 2),
        settings,
      ),
    );
  } else
    cells.push(
      chooseCell(
        fork("cell:1"),
        perHalf > 2.4 ? settings.cells : resting,
        Math.min(perHalf, 2.5),
        settings,
      ),
    );

  const onsets: Onsets = [];
  cells.forEach((item, index) =>
    item.notes.forEach(([start, length]) =>
      onsets.push([index * 8 + start, length]),
    ),
  );
  // the motif ends on a longer note with a breath after it
  const total = settings.bars * 16;
  const closing = onsets[onsets.length - 1];
  closing[1] = clamp(total - 2 - closing[0], closing[1], 8);

  const weights = skeletonWeights(settings);
  // two structural notes in a row have nothing between them to smooth a leap
  const adjacentWeights =
    settings.motion === "leaps" || settings.motion === "arpeggio"
      ? weights
      : [0.07, Math.max(weights[1], 0.5), 0.28, 0.11, 0.04];
  const shape = fork("shape").pick([
    "arch",
    "arch",
    "rise",
    "fall",
    "wave",
    "valley",
  ]);
  const disjunct =
    settings.motion === "leaps" || settings.motion === "arpeggio";
  const long = grid === 16 ? 8 : 5;
  const tied = (step: number, length: number) =>
    step % grid !== 0 &&
    Math.floor((step + length - 1) / grid) > Math.floor(step / grid);
  const structural = onsets.map(
    ([step, length], index) =>
      disjunct ||
      index === 0 ||
      step % grid === 0 ||
      length >= long ||
      tied(step, length),
  );
  const strongCount = structural.filter(Boolean).length;
  const written: MotifNote[] = [];
  let degree = 0;
  let lastMove = 0;
  let seen = 0;
  onsets.forEach(([step, length], index) => {
    const dice = fork(`note:${index}`);
    const strong = structural[index];
    const progress = strongCount > 1 ? seen / (strongCount - 1) : 0;
    const upChance =
      shape === "arch"
        ? progress < 0.55
          ? 0.75
          : 0.22
        : shape === "rise"
          ? 0.72
          : shape === "fall"
            ? 0.28
            : shape === "valley"
              ? progress < 0.5
                ? 0.25
                : 0.75
              : seen % 2
                ? 0.72
                : 0.28;
    if (strong) {
      if (seen > 0) {
        let move: number;
        // a leap is answered by a step back
        if (Math.abs(lastMove) >= 3) move = -Math.sign(lastMove);
        else
          move =
            dice.weightedIndex(
              structural[index - 1] ? adjacentWeights : weights,
            ) * (dice.chance(upChance) ? 1 : -1);
        if (Math.abs(degree + move) > 4) move = -move;
        degree += move;
        lastMove = move;
      }
      seen++;
    }
    written.push({
      step,
      length,
      strong,
      boundary: tied(step, length)
        ? (Math.floor(step / grid) + 1) * grid
        : undefined,
      degree,
      turn: dice.chance(upChance) ? 1 : -1,
      from: 0,
    });
  });

  // thinning order: the first note stays whatever happens, then the skeleton,
  // the beats, the off-beats; a draw of its own settles ties between equals.
  // A note goes more readily after a structural note (which simply rings on
  // through it) than after a passing note that would be left holding a long
  // note of its own, and might have to move for it.
  const count = written.length;
  const strands = (index: number) => {
    const before = written[index - 1];
    return !before.strong && before.length + written[index].length >= long;
  };
  written
    .map((note, index) => ({
      note,
      salience:
        index === 0
          ? Infinity
          : (note.strong ? 2 : 0) +
            metricWeight(note.step) +
            Math.min(note.length, 8) / 32 +
            (strands(index) ? 0.8 : 0) +
            0.5 * fork(`keep:${index}`).next(),
    }))
    .sort((a, b) => a.salience - b.salience)
    .forEach((item, rank) => {
      // evenly spread, so that the number of notes follows the activity
      item.note.from = rank === count - 1 ? 0 : 1 - (rank + 0.5) / count;
    });

  // passing notes for a busier tune: the longest note is split first
  const cover = new Array<boolean>(total).fill(false);
  for (const note of written)
    for (
      let step = note.step;
      step < Math.min(total, note.step + note.length);
      step++
    )
      cover[step] = true;
  const steps = written.map((note) => note.step);
  const sounds = (step: number) => {
    let next = total;
    for (const other of steps) if (other > step && other < next) next = other;
    let end = step + 1;
    while (end < next && cover[end]) end++;
    return end - step;
  };
  const added: AddedNote[] = [];
  while (added.length < count * 2 + 2) {
    let cut = -1;
    let best = -Infinity;
    for (const step of steps) {
      const length = sounds(step);
      const at = splitPoint(step, length, settings.swung);
      if (at < 0) continue;
      const score = length + 0.9 * hashUnit(rng.seed, `${name}:split:${at}`);
      if (score > best) {
        best = score;
        cut = at;
      }
    }
    if (cut < 0) break;
    steps.push(cut);
    added.push({
      step: cut,
      turn: fork(`add:${cut}`).chance(0.5) ? 1 : -1,
      from: 1 + (added.length + 0.5) / count,
    });
  }
  return { bars: settings.bars, notes: written, added };
}

/**
 * `count` passing / neighbour notes between two structural notes, moving by
 * step wherever the distance allows. `degree` is the scale degree of `from`
 * (0 = the tonic): the one choice made here depends on it and not on the
 * ladder index, so that the same line comes out in every key.
 */
function connect(
  from: number,
  to: number,
  count: number,
  turn: number,
  degree: number,
): number[] {
  const gap = to - from;
  const distance = Math.abs(gap);
  const path: number[] = [];
  if (count <= 0) return path;
  if (distance >= count + 1) {
    for (let i = 1; i <= count; i++)
      path.push(from + Math.round((gap * i) / (count + 1)));
    return path;
  }
  const walk = (goal: number, steps: number): number[] => {
    // `steps` moves of one scale step from `from` to `goal`; steps - |goal - from| is even
    const span = Math.abs(goal - from);
    const direction = Math.sign(goal - from) || turn;
    const detour = (steps - span) / 2;
    const moves: number[] = [];
    if (turn === direction) {
      // overshoot the goal and step back onto it
      for (let i = 0; i < span + detour; i++) moves.push(direction);
      for (let i = 0; i < detour; i++) moves.push(-direction);
    } else {
      // lean away first, then walk to the goal
      for (let i = 0; i < detour; i++) moves.push(-direction);
      for (let i = 0; i < span + detour; i++) moves.push(direction);
    }
    let position = from;
    return moves.map((move) => (position += move));
  };
  const spare = count + 1 - distance;
  if (spare % 2 === 0) return walk(to, count + 1).slice(0, count);
  // one move too many for a pure stepwise line: arrive by a third from a
  // neighbour of the goal, or (now and then) repeat the first note
  if ((degree + count) % 3 !== 0)
    for (const side of [turn, -turn]) {
      const neighbour = to + 2 * side;
      if (Math.abs(neighbour - from) <= count) return walk(neighbour, count);
    }
  return [from, ...walk(to, count).slice(0, count - 1)];
}

/* ------------------------------------------------------------------ */
/* what the controls do to the tune                                    */
/* ------------------------------------------------------------------ */

/**
 * Everything tempo, energy and density ask of the tune, in the few numbers
 * the lead actually reads. Two configs with the same seed, style, key, lead,
 * complexity, form and harmony give note-for-note the same tune exactly when
 * these traits are equal (compose.ts builds melodyContinuity on that).
 */
export interface LeadTraits {
  /**
   * How busy the tune should be, relative to the density the style writes it
   * at: 1 = the motif as written, 0.5 = about half its notes, 1.5 = half as
   * many again. Tempo and energy move it only outside a dead zone; the
   * complexity control and a density hint move it directly.
   */
  activity: number;
  /**
   * -2..2: how far the energy lies above or below the style's own. It scales
   * the lift of the chorus and of the answering and climax phrases; the
   * opening phrase of a section never moves.
   */
  lift: number;
  /** sixteenth notes would be shorter than MIN_NOTE_SECONDS: they are left out */
  coarse: boolean;
  /** beats per note of a turn (sixteenths up to 96 BPM, eighths up to 132); 0 = too fast for turns */
  turnUnit: number;
  /** beats of a grace note (a sixteenth up to 126 BPM, an eighth above) */
  graceLength: number;
  /** beats of one tremolo stroke: about a tenth of a second, whatever the tempo */
  stroke: number;
}

/**
 * Half-width, as a ratio, of the dead zone in which tempo and energy leave
 * the tune alone: a tenth more or less tempo (even on top of the few percent
 * a loop bends its tempo to fit), or any nudge of the energy, moves no note.
 * Beyond it the activity follows continuously, and the notes come and go one
 * at a time.
 */
const ACTIVITY_DEAD_ZONE = 1.15;
/**
 * How far the complexity control thins or fills the tune: 0 plays about 70 %
 * of the notes written at 0.5, 1 about 130 %. It has no dead zone — rhythmic
 * detail is what the control is for — but it moves the same share of notes
 * in a sparse tune as in a busy one.
 */
const COMPLEXITY_ACTIVITY = 0.6;
/** A note shorter than this does not speak: sixteenths go above 176 BPM. */
const MIN_NOTE_SECONDS = 0.085;
/** Energy this far from the style's own moves the register one step, and twice as far two. */
const LIFT_STEPS = [0.22, 0.47];

/** How much tempo and energy ask of the tune: a slow bar has room for more notes, a lively piece wants more. */
const drive = (bpm: number, energy: number) =>
  clamp((100 / bpm) ** 0.8, 0.55, 1.6) * (0.88 + 0.24 * energy);
/** Notes per bar the tune is written with. */
const notesPerBar = (density: number, bpm: number, energy: number) =>
  (0.6 + 8 * density) * drive(bpm, energy);
/** The density a style writes its tune at (its own complexity). */
const writtenDensity = (style: StyleDef) =>
  clamp(
    style.melody.density + (styleInfo(style.id).complexity - 0.5) * 0.45,
    0,
    1,
  );

const eighthSwing = (style: StyleDef) =>
  style.swing >= 0.3 && (style.swingGrid ?? 8) === 8;

/** `bpm` is the tempo the piece is actually played at (a loop may have fitted it). */
export function leadTraits(
  config: MusicConfig,
  style: StyleDef,
  bpm: number,
): LeadTraits {
  const home = styleInfo(style.id);
  const pace = drive(bpm, config.energy) / drive(home.bpm, home.energy);
  const settled =
    pace > ACTIVITY_DEAD_ZONE
      ? pace / ACTIVITY_DEAD_ZONE
      : pace < 1 / ACTIVITY_DEAD_ZONE
        ? pace * ACTIVITY_DEAD_ZONE
        : 1;
  const hinted = config.arrangement?.melody?.density;
  const busy =
    hinted !== undefined
      ? (0.6 + 8 * hinted) / (0.6 + 8 * writtenDensity(style))
      : (1 + (config.complexity - 0.5) * COMPLEXITY_ACTIVITY) /
        (1 + (home.complexity - 0.5) * COMPLEXITY_ACTIVITY);
  // (exactly 1 at the style's own settings, whatever the rounding)
  const activity =
    settled === 1 && Math.abs(busy - 1) < 1e-9 ? 1 : settled * busy;
  const distance = config.energy - home.energy;
  const lift =
    Math.sign(distance) *
    (Math.abs(distance) > LIFT_STEPS[1]
      ? 2
      : Math.abs(distance) > LIFT_STEPS[0]
        ? 1
        : 0);
  const beatSeconds = 60 / bpm;
  const swung = eighthSwing(style);
  // tremolo strokes of roughly a tenth of a second, whatever the tempo
  let stroke = 0.25;
  while (stroke * beatSeconds > 0.15) stroke /= 2;
  while (stroke * beatSeconds < 0.08) stroke *= 2;
  return {
    activity,
    lift: lift + 0,
    coarse: beatSeconds / 4 < MIN_NOTE_SECONDS,
    turnUnit: bpm > 132 ? 0 : bpm <= 96 && !swung ? 0.25 : 0.5,
    graceLength: bpm <= 126 && !swung ? 0.25 : 0.5,
    stroke,
  };
}

/* ------------------------------------------------------------------ */
/* lead                                                                */
/* ------------------------------------------------------------------ */

interface Draft {
  beat: number;
  /** beats */
  len: number;
  /** index into the scale ladder; -1 until a weak note has been connected */
  index: number;
  /** structural note (chord tone) */
  strong: boolean;
  turn: number;
  /** first note of a phrase (a pickup may lead into it) */
  phraseStart?: boolean;
  /** last note of a phrase */
  cadence?: boolean;
  /** 0..1 position inside the phrase, for dynamics */
  position: number;
  section: number;
  phrase: number;
  /** exact pitch of a chromatic grace note (it lies outside the scale ladder) */
  midi?: number;
  /** activity down to which the note sounds (0 = always; see MotifNote.from) */
  from: number;
  /** the note rings on through one that was thinned away after it */
  grown?: boolean;
}

type Cadence = "open" | "closed" | "final";

const MOTIF_FAMILY: Record<SectionType, string> = {
  intro: "a",
  verse: "a",
  outro: "a",
  breakdown: "a",
  chorus: "b",
  build: "b",
  bridge: "c",
};

/**
 * The lead, in two stages.
 *
 * 1. THE TUNE is a function of the seed, the style and the section family,
 *    and of nothing else: its motifs are written at the style's own tempo,
 *    energy and complexity (makeMotif), and where each phrase aims is fixed
 *    relative to the tonic (leadCentre). Every draw has a named stream of its
 *    own, keyed by where it sits in the music (family, phrase, step) and
 *    never by an absolute bar or by how many draws came before.
 *
 * 2. THE SETTINGS only adapt it. Each phrase is first composed as written,
 *    its structural notes settling on the chords actually sounding, bar by
 *    bar (a chord that changes moves only the notes over it). Then tempo,
 *    energy and density take notes away from it or add passing notes to it,
 *    one at a time and not at all inside a dead zone (LeadTraits.activity);
 *    energy raises the chorus and the answering phrases in coarse steps and
 *    sets the dynamics; complexity adds ornaments one by one; the key
 *    transposes; the lead instrument moves the tune by octaves.
 */
export function composeLead(ctx: Ctx): BeatNote[] {
  const { config, style, key, timing, sections, harmony, rng } = ctx;
  const instrument: InstrumentId = config.instrument;
  const trait = LEAD_TRAITS[instrument];
  const hints = config.arrangement?.melody;
  const def = style.melody;
  const beatsPerBar = timing.beatsPerBar;
  // The tune keeps to a compass measured from its own centre, and the centre
  // is measured from the tonic: in another key the ladder below is the same
  // ladder transposed, and so is every note chosen on it.
  const baseCentre = leadCentre(ctx);
  const compassLow = Math.max(trait.low, baseCentre - TUNE_BELOW);
  const compassHigh = Math.min(trait.high, baseCentre + TUNE_ABOVE);
  const ladder = scaleLadder(key, compassLow, compassHigh);
  if (ladder.length < 5) return [];
  const top = ladder.length - 1;
  const octave = key.pcs.length;
  /** a tonic on the ladder: scale degrees are counted from it */
  const tonicIndex = Math.max(
    0,
    ladder.findIndex((midi) => mod(midi, 12) === key.tonic),
  );
  const complexity = config.complexity;
  const traits = leadTraits(config, style, timing.bpm);

  /* ---- the style's own settings: the tune is written at these ---- */
  const home = styleInfo(style.id);
  const homeBeatSeconds = 60 / home.bpm;
  const homeDensity = writtenDensity(style);
  const perBarHome = notesPerBar(homeDensity, home.bpm, home.energy);
  /**
   * Sixteenths between the accents that must carry chord tones: beats one and
   * three, or the downbeat only when a bar flies by. Styles that ask for a
   * very stepwise line also anchor it on the downbeat alone, so that beat
   * three is free to be a passing note.
   */
  const grid: 8 | 16 = home.bpm >= FAST_TEMPO || def.stepBias >= 0.74 ? 16 : 8;
  const vocabulary = vocabularyOf(def.cells);
  const swung = eighthSwing(style);
  const fine =
    home.bpm <= 138
      ? ramp(0.35, 0.95, homeDensity + (home.complexity - 0.5) * 0.5) *
        (home.bpm <= 112 ? 1 : 0.5)
      : 0;
  const syncopation = clamp(
    def.syncopation * (0.55 + 0.9 * home.complexity),
    0,
    1,
  );
  /** sixteenths from which a note is long enough to carry the line */
  const long = grid === 16 ? 8 : 5;
  // "arpeggio" and "leaps" make every note a structural one: nothing is smoothed by passing notes
  const arpeggiated = hints?.motion === "arpeggio";
  const disjunct = arpeggiated || hints?.motion === "leaps";

  /* ---- chord-tone helpers ---- */
  /** Restful pitch classes for a note starting at `beat` and lasting `len` beats. */
  const strongPcs = (beat: number, colour = false, len = 0): number[] => {
    const slot = harmony.at(beat);
    // (the chord as the progression writes it: see ChordSlot.plain)
    const chord = slot.plain;
    let tones = chord.pitchClasses.filter((pc) => key.inScale[pc]);
    // inside a phrase the ninth is as restful as a chord tone
    const ninth = mod(chord.root + 2, 12);
    if (colour && key.inScale[ninth] && !tones.includes(ninth))
      tones.push(ninth);
    // a note held into the next chord should belong to both, or at least not grate on it
    const end = beat + len;
    if (len > 0 && end - (slot.beat + slot.beats) >= 0.5) {
      const later = harmony.at(end - 0.26).plain.pitchClasses;
      const common = tones.filter((pc) => later.includes(pc));
      const mild = tones.filter((pc) => !later.includes(mod(pc - 1, 12)));
      if (common.length) tones = common;
      else if (mild.length) tones = mild;
    }
    return tones.length ? tones : key.pcs;
  };
  const bound = (index: number) => clamp(index, 0, top);
  /**
   * Motif contours are written in steps of a seven-note scale; in a five-note
   * scale the same shape needs fewer steps, or every third becomes a fourth.
   */
  const span = (degrees: number) => Math.round((degrees * octave) / 7);
  /** nearest chord tone, looking first in the preferred direction */
  const snap = (
    index: number,
    beat: number,
    prefer: number,
    colour = false,
    len = 0,
  ): number => {
    const start = bound(index);
    const tones = strongPcs(beat, colour, len);
    if (tones.includes(mod(ladder[start], 12))) return start;
    for (let distance = 1; distance <= octave; distance++) {
      const order = prefer < 0 ? [-distance, distance] : [distance, -distance];
      for (const offset of order) {
        const candidate = start + offset;
        if (candidate < 0 || candidate > top) continue;
        if (tones.includes(mod(ladder[candidate], 12))) return candidate;
      }
    }
    return start;
  };
  const nearestTone = (midi: number, pcs: number[]): number => {
    let best = nearestIndex(ladder, midi);
    let distance = Infinity;
    for (let index = 0; index <= top; index++) {
      if (!pcs.includes(mod(ladder[index], 12))) continue;
      const d = Math.abs(ladder[index] - midi);
      if (d < distance) {
        distance = d;
        best = index;
      }
    }
    return best;
  };

  /* ---- motifs per section family ---- */
  const motifs = new Map<string, Motif>();
  const motifFor = (type: SectionType): Motif => {
    const family = MOTIF_FAMILY[type];
    let motif = motifs.get(family);
    if (!motif) {
      // the B idea contrasts in rhythm: busier over a calm verse, broader over a busy one
      const contrast =
        family === "b"
          ? perBarHome < 3.6
            ? 1.3
            : 0.75
          : family === "c"
            ? 0.85
            : 1;
      // salted with the style: the same seed gives every style a tune of its own
      motif = makeMotif(rng, `motif:${style.id}:${family}`, {
        bars: def.motifBars,
        perBar: clamp(perBarHome * contrast, 0.6, 11),
        syncopation,
        fine,
        stepBias: def.stepBias,
        motion: hints?.motion,
        cells: vocabulary,
        grid,
        swung,
        // sixteenths stay clear down to about 85 ms
        ownFine: homeBeatSeconds / 4 >= MIN_NOTE_SECONDS ? 0.6 : 0,
      });
      motifs.set(family, motif);
    }
    return motif;
  };

  /** a note a semitone above a chord tone that is not itself in the chord (the classic avoid note) */
  const rubs = (index: number, beat: number): boolean => {
    const chord = harmony.at(beat).chord;
    const pitch = mod(ladder[index], 12);
    return (
      !chord.pitchClasses.includes(pitch) &&
      chord.pitchClasses.includes(mod(pitch - 1, 12))
    );
  };

  /**
   * A note that cannot stand against the chord as an accent: an avoid note,
   * or the plain form of a degree the chord has raised — G against the G-sharp
   * of E7 in A minor, a false relation with the accompaniment.
   */
  const grates = (index: number, beat: number): boolean => {
    if (rubs(index, beat)) return true;
    const chord = harmony.at(beat).chord;
    const pitch = mod(ladder[index], 12);
    const raised = mod(pitch + 1, 12);
    return (
      !chord.pitchClasses.includes(pitch) &&
      chord.pitchClasses.includes(raised) &&
      !key.inScale[raised] &&
      !(key.pcs.length < 7 && key.parent[raised])
    );
  };

  const cadenceTarget = (
    beat: number,
    len: number,
    kind: Cadence,
    nearMidi: number,
  ): number => {
    const chord: Chord = harmony.at(beat + Math.max(0, len - 0.26)).chord;
    const tones = strongPcs(beat, false, len);
    let allowed: number[];
    if (kind === "open") {
      allowed = tones.filter((pc) => pc !== key.tonic);
      if (!allowed.length) allowed = tones;
    } else
      allowed = tones.includes(key.tonic)
        ? [key.tonic]
        : tones.includes(chord.root)
          ? [chord.root]
          : tones;
    return nearestTone(nearMidi, allowed);
  };

  const pickEnding = (dice: Rng, perBar: number): Onsets => {
    const target = clamp(perBar * (0.75 - 0.45 * def.space), 1, 5);
    return dice.weighted(
      ENDINGS,
      ENDINGS.map((pattern) =>
        Math.exp(-((pattern.length - target) ** 2) / 1.2),
      ),
    );
  };

  // the chorus sits higher than the verse — but only as far as the instrument
  // has room: leads centred on C5 or lower get the whole lift, a flute about
  // half, a dizi or a bell a third or less and a music box none, so a tune
  // that already sings near the top is not pushed into its whistle register.
  // Energy well above the style's own raises it further, energy well below
  // lets it sink back towards the verse.
  const wantedLift = def.chorusLift ?? 3;
  const ownLift =
    wantedLift > 0
      ? wantedLift * clamp((81 - trait.centre) / 9, 0, 1)
      : wantedLift;
  const chorusLift =
    traits.lift >= 0
      ? ownLift + 2 * traits.lift
      : Math.max(ownLift + 2 * traits.lift, Math.min(ownLift, -1));

  /** the last note of each section that has been written, by section index */
  const lastOf = new Map<number, Draft>();

  const composeSection = (section: SectionPlan): Draft[] => {
    const motif = motifFor(section.type);
    const family = MOTIF_FAMILY[section.type];
    const lift =
      section.type === "chorus" || section.type === "build"
        ? chorusLift
        : section.type === "bridge"
          ? -2
          : section.type === "breakdown"
            ? -3
            : 0;
    // a livelier kind of section sits a little higher, a calmer one lower — as
    // the style writes them, at its own energy (the energy control acts
    // through the lift above, in steps)
    const centre = clamp(
      baseCentre +
        lift +
        (sectionEnergy(style, section.type, home.energy) - 0.5) * 4,
      compassLow + 6,
      compassHigh - 6,
    );
    // the section lives inside roughly a tenth around its centre
    const bandLow = nearestIndex(ladder, centre - 8);
    const bandHigh = nearestIndex(ladder, centre + 9);
    const inBand = (midi: number) => clamp(midi, centre - 8, centre + 9);
    /** chord tone near `index` that stays inside the section's band */
    const settle = (
      index: number,
      beat: number,
      prefer: number,
      colour: boolean,
      len: number,
    ): number => {
      const found = snap(index, beat, prefer, colour, len);
      if (found < bandLow - 1) return snap(bandLow, beat, 1, colour, len);
      if (found > bandHigh + 1) return snap(bandHigh, beat, -1, colour, len);
      return found;
    };
    const bars = section.playBars;
    const phrases = Math.ceil(bars / 4);
    const climax =
      phrases <= 1
        ? 0
        : Math.min(phrases - 1, Math.round((phrases - 1) * 0.66));
    // how the section's last phrase ends when its place in the piece decides it:
    // on the final chord, or left open where the music has to lead on
    const closing: Cadence | undefined = section.ending
      ? "final"
      : (timing.loop && section.index === sections.length - 1) ||
          section.type === "build" ||
          section.type === "intro"
        ? "open"
        : undefined;
    // phrase endings are sized for the style's own density, like the motif
    const perBar = clamp(
      perBarHome *
        (0.9 + 0.2 * sectionEnergy(style, section.type, home.energy)),
      0.6,
      11,
    );
    // the second time a section comes round it is varied: A A', B B'
    const varied = section.occurrence % 2 === 1;
    const sequenceUp =
      rng.fork(`lead:${section.type}:sequence`).chance(0.65) !== varied;
    // a looped riff states its motif again and again instead of developing it
    const hooked =
      (def.hook ?? 0) > 0 && rng.fork(`hook:${family}`).chance(def.hook ?? 0);
    /** the phrases as written, with the motif units each was laid from */
    const laid: {
      notes: Draft[];
      units: { fromStep: number; toStep: number; bar: number }[];
    }[] = [];
    /** the note the line has just left: the last one of the phrase (or of the section) before */
    let leftBy = lastOf.get(section.index - 1);

    for (let p = 0; p < phrases; p++) {
      const startBar = section.startBar + p * 4;
      const length = Math.min(4, bars - p * 4);
      const lastPhrase = p === phrases - 1;
      // otherwise phrases go in pairs, a question left open and an answer that
      // closes — whatever the length of the section, so a phrase is the same
      // phrase in a verse of four bars and in one of eight
      const cadence: Cadence =
        (lastPhrase && closing) || (p % 2 === 0 ? "open" : "closed");
      // the answer sits a little above the statement and the climax above both:
      // more so the further the energy lies above the style's own, and not at
      // all far below it. The statement (the first phrase) never moves.
      const phraseLift = Math.max(
        0,
        phrases > 1 && p === climax
          ? 3 + 1.5 * traits.lift
          : p % 2 === 1
            ? 1.5 + 0.75 * traits.lift
            : 0,
      );
      const anchorMidi = centre + phraseLift;
      const notes: Draft[] = [];
      const units: { fromStep: number; toStep: number; bar: number }[] = [];
      let lastStrong = -1;
      /** where the unit before left the line, reckoned from the motif alone (semitones) */
      let lineEnd: number | undefined;
      // a looped riff fills the whole phrase; it keeps to a narrow compass so
      // that jumping back to its first note is never a wide leap
      const riff = hooked && cadence !== "final" && length === 4;
      const reach = riff ? 3 : 4;

      /** lay the motif notes that start inside [fromStep, toStep) from `bar` */
      const layMotif = (
        fromStep: number,
        toStep: number,
        bar: number,
        unitMidi: number,
        offset: number,
      ) => {
        const picked = motif.notes.filter(
          (note) => note.step >= fromStep && note.step < toStep,
        );
        if (!picked.length) return;
        units.push({ fromStep, toStep, bar });
        const origin = picked[0].degree;
        const firstBeat = bar * beatsPerBar + (picked[0].step - fromStep) / 4;
        // a new unit starts close to where the line already is
        const offsets = picked.map((note) =>
          span(clamp(note.degree - origin, -reach, reach)),
        );
        // the shape as a whole, not just its first note, sits where the section wants
        // it: an idea that falls away from its first note starts that much higher
        const drift =
          (offsets.reduce((sum, value) => sum + value, 0) / offsets.length) *
          (12 / octave);
        const reference =
          (lineEnd !== undefined ? (unitMidi * 2 + lineEnd) / 3 : unitMidi) -
          drift * 0.7;
        // (reckoned from the motif, not from the notes it settles on: a chord
        // that changes under one unit does not move the next)
        let resting = 0;
        picked.forEach((note, k) => {
          if (note.strong) resting = offsets[k];
        });
        lineEnd = reference + resting * (12 / octave);
        const firstTones = strongPcs(firstBeat, false, picked[0].length / 4);
        let anchor = nearestTone(inBand(reference), firstTones);
        // start low (or high) enough that the whole shape fits inside the band
        const over = anchor + Math.max(...offsets) - bandHigh;
        const under = bandLow - (anchor + Math.min(...offsets));
        if (over > 0 && under <= 0)
          anchor = nearestTone(ladder[bound(anchor - over)], firstTones);
        else if (under > 0 && over <= 0)
          anchor = nearestTone(ladder[bound(anchor + under)], firstTones);
        // and never more than an octave from where the line has just been: the
        // last structural note of this phrase, or the note the phrase before ended on
        const left = lastStrong >= 0 ? lastStrong : (leftBy?.index ?? -1);
        if (left >= 0 && Math.abs(ladder[anchor] - ladder[left]) > 12)
          anchor = nearestTone(
            ladder[left] + 9 * Math.sign(ladder[anchor] - ladder[left]),
            firstTones,
          );
        let previous = anchor;
        let previousDegree = picked[0].degree;
        picked.forEach((note, k) => {
          const beat = bar * beatsPerBar + (note.step - fromStep) / 4;
          const strong = k === 0 || note.strong || disjunct;
          let index = -1;
          if (strong) {
            const chordBeat =
              note.boundary !== undefined && note.boundary < toStep
                ? bar * beatsPerBar + (note.boundary - fromStep) / 4
                : beat;
            if (k === 0) index = anchor;
            else {
              const intended = Math.sign(note.degree - previousDegree);
              const wanted = clamp(
                anchor + span(clamp(note.degree - origin, -reach, reach)),
                bandLow,
                bandHigh,
              );
              // the downbeat keeps to real chord tones; elsewhere the ninth may colour the line
              const colour = note.step % 16 !== 0 && !arpeggiated;
              const held = note.length / 4 - (chordBeat - beat);
              index = settle(
                wanted,
                chordBeat,
                intended || Math.sign(wanted - previous),
                colour,
                held,
              );
              if (index === previous && intended !== 0)
                index = settle(
                  previous + intended,
                  chordBeat,
                  intended,
                  colour,
                  held,
                );
            }
            previous = index;
            previousDegree = note.degree;
            lastStrong = index;
          }
          notes.push({
            beat,
            len: note.length / 4,
            index,
            strong,
            turn: note.turn,
            position: (offset + (note.step - fromStep) / 16) / length,
            section: section.index,
            phrase: p,
            from: note.from,
          });
        });
      };

      /** a bar that walks stepwise onto `target`; `landing` puts the target on its last note */
      const layEnding = (
        pattern: Onsets,
        bar: number,
        target: number,
        fromAbove: boolean,
        landing: boolean,
      ) => {
        const count = pattern.length;
        // a tune asked to be sparser than written keeps the frame of the walk:
        // where it starts, its strongest beats and where it lands
        const from = pattern.map(() => 0);
        pattern
          .map(([step], k) => ({
            k,
            salience:
              landing && k === count - 1
                ? Infinity
                : (k === 0 ? 2 : 0) +
                  metricWeight(step) +
                  0.5 *
                    hashUnit(
                      rng.seed,
                      `ending:${family}:${p % 2}:keep:${step}`,
                    ),
          }))
          .sort((a, b) => a.salience - b.salience)
          .forEach((item, rank) => {
            from[item.k] = rank === count - 1 ? 0 : 1 - (rank + 0.5) / count;
          });
        pattern.forEach(([step, len], k) => {
          const beat = bar * beatsPerBar + step / 4;
          const distance = landing ? count - 1 - k : count - k;
          const last = landing && k === count - 1;
          const walked = bound(target + (fromAbove ? distance : -distance));
          let index = walked;
          if (!last && (step % grid === 0 || len >= 6)) {
            const settled = snap(
              walked,
              beat,
              fromAbove ? 1 : -1,
              false,
              len / 4,
            );
            index = settled;
            // rather an accented passing note than the same chord tone over and
            // over, as long as it does not grate against the chord
            const before = notes[notes.length - 1];
            if (index === target || (k > 0 && before && before.index === index))
              index = grates(walked, beat) ? settled : walked;
          }
          if (last) index = target;
          lastStrong = index;
          notes.push({
            beat,
            len: len / 4,
            index,
            // a passing note of the walk stays a passing note for the checks below
            strong: last || !grates(index, beat),
            turn: fromAbove ? 1 : -1,
            cadence: last,
            position: (length - 1 + step / 16) / length,
            section: section.index,
            phrase: p,
            from: from[k],
          });
        });
      };

      const headBars = length - 1;
      const sequence = sequenceUp ? 2 : -2;
      if (riff) {
        for (let unit = 0; unit < 4; unit += motif.bars)
          layMotif(0, motif.bars * 16, startBar + unit, anchorMidi, unit);
        // the riff's last note is where the phrase comes to rest
        const rest = notes[notes.length - 1];
        if (rest) {
          const near = rest.index >= 0 ? rest.index : Math.max(lastStrong, 0);
          rest.index =
            cadence === "closed" && rest.len >= 1
              ? cadenceTarget(rest.beat, rest.len, cadence, ladder[near])
              : rest.index >= 0
                ? rest.index
                : snap(near, rest.beat, -1, true, rest.len);
          rest.strong = true;
          rest.cadence = true;
          rest.from = 0;
        }
      } else if (motif.bars === 2) {
        if (headBars >= 2) layMotif(0, 32, startBar, anchorMidi, 0);
        // the bar before the ending restates the opening of the motif, shifted
        if (headBars === 3)
          layMotif(0, 16, startBar + 2, anchorMidi + sequence, 2);
        else if (headBars === 1) layMotif(0, 16, startBar, anchorMidi, 0);
      } else
        for (let unit = 0; unit < headBars; unit++)
          layMotif(0, 16, startBar + unit, anchorMidi + sequence * unit, unit);

      // ending bar: walk onto the cadence note. Where the cadence lies follows
      // from where the motif leaves the line as written, not from the note it
      // happened to settle on: a chord that changes in the bar before does not
      // move the cadence. The walk itself comes from the side the line is
      // really on.
      const endBar = startBar + length - 1;
      const nearMidi = inBand(lineEnd ?? anchorMidi);
      const lineMidi = lastStrong >= 0 ? ladder[lastStrong] : nearMidi;
      if (riff) {
        // the riff already fills the phrase
      } else if (cadence === "final") {
        const finalBeat = timing.finalBar * beatsPerBar;
        const tonic = nearestTone(inBand(nearMidi - 2), [key.tonic]);
        const approach =
          APPROACHES[clamp(Math.round(perBar * 0.6), 0, APPROACHES.length - 1)];
        // walk home from the side the line is already on
        const above =
          lineMidi > ladder[tonic]
            ? true
            : lineMidi < ladder[tonic]
              ? false
              : rng.fork(`lead:${section.type}:home`).chance(0.7);
        const fromAbove =
          tonic + approach.length <= top &&
          (tonic - approach.length < 0 || above);
        layEnding(approach, endBar, tonic, fromAbove, false);
        notes.push({
          beat: finalBeat,
          len: timing.endBeat - finalBeat,
          index: tonic,
          strong: true,
          turn: 1,
          cadence: true,
          position: 1,
          section: section.index,
          phrase: p,
          from: 0,
        });
      } else {
        // (the same rhythm whether the phrase closes the section or not: a
        // verse cut to four bars still ends the way its first half did)
        const pattern = pickEnding(
          rng.fork(`ending:${family}:${p % 2}${varied ? ":again" : ""}`),
          perBar,
        );
        const [lastStep, lastLength] = pattern[pattern.length - 1];
        const target = cadenceTarget(
          endBar * beatsPerBar + lastStep / 4,
          lastLength / 4,
          cadence,
          inBand(nearMidi - (cadence === "closed" ? 2 : 0)),
        );
        const fromAbove =
          lineMidi >= ladder[target] && target + pattern.length - 1 <= top;
        layEnding(
          pattern,
          endBar,
          target,
          fromAbove || target - (pattern.length - 1) < 0,
          true,
        );
      }

      // weak notes pass or neighbour between the structural notes around them
      for (let i = 0; i < notes.length;) {
        if (notes[i].index >= 0) {
          i++;
          continue;
        }
        let end = i;
        while (end < notes.length && notes[end].index < 0) end++;
        const from = notes[i - 1].index;
        const to = end < notes.length ? notes[end].index : from;
        const path = connect(
          from,
          to,
          end - i,
          notes[i].turn,
          mod(from - tonicIndex, octave),
        );
        for (let k = i; k < end; k++)
          notes[k].index = bound(
            clamp(path[k - i] ?? from, bandLow - 2, bandHigh + 2),
          );
        i = end;
      }

      for (let i = 1; i < notes.length; i++) {
        const note = notes[i];
        const before = notes[i - 1];
        const interval = ladder[note.index] - ladder[before.index];
        // no melodic tritones
        if (Math.abs(interval) === 6) {
          const toward = -Math.sign(interval);
          if (!note.strong) note.index = bound(note.index + toward);
          else if (!before.strong && i > 1)
            before.index = bound(before.index - toward);
          else if (!note.cadence) {
            const moved = snap(note.index + toward, note.beat, toward);
            if (Math.abs(ladder[moved] - ladder[before.index]) !== 6)
              note.index = moved;
          }
        }
        // a leap is answered by a step in the other direction
        const next = notes[i + 1];
        const leap = ladder[note.index] - ladder[before.index];
        if (next && Math.abs(leap) >= 5) {
          const back = -Math.sign(leap);
          const after = notes[i + 2];
          if (!next.strong) {
            const answer = bound(note.index + back);
            if (!after || Math.abs(after.index - answer) <= 3)
              next.index = answer;
          } else if (
            !next.cadence &&
            Math.sign(next.index - note.index) === -back
          ) {
            // (the ninth may answer anywhere but on a downbeat)
            const answer = snap(
              note.index + back,
              next.beat,
              back,
              Math.round(next.beat * 4) % 16 !== 0,
            );
            if (Math.abs(answer - note.index) <= 2) next.index = answer;
          }
        }
      }

      // three of the same note in a row: the middle one becomes a neighbour note
      for (let i = 1; i < notes.length - 1; i++) {
        const note = notes[i];
        if (
          note.strong ||
          note.index !== notes[i - 1].index ||
          note.index !== notes[i + 1].index
        )
          continue;
        const moved = note.index + note.turn;
        note.index =
          moved >= 0 && moved <= top ? moved : bound(note.index - note.turn);
      }

      // avoid notes: a passing note a semitone above a chord tone grates as soon as it is held
      for (let i = 1; i < notes.length; i++) {
        const note = notes[i];
        // (how long "held" is, is judged at the tempo the tune was written for:
        // playing it a little faster or slower does not rewrite it)
        const seconds = note.len * homeBeatSeconds;
        const accented = Math.round(note.beat * 4) % 8 === 0;
        const held = note.len >= 1 || seconds >= 0.42;
        if (note.strong || !(held || accented) || !rubs(note.index, note.beat))
          continue;
        const next = notes[i + 1];
        // an appoggiatura that leans down a step into a chord tone is the oldest
        // sigh in music; it only has to resolve before it outstays its welcome
        const resolves =
          !!next &&
          next.index === note.index - 1 &&
          next.beat - (note.beat + note.len) < 0.26 &&
          harmony
            .at(next.beat)
            .chord.pitchClasses.includes(mod(ladder[next.index], 12));
        if (resolves && seconds <= 0.95 && note.len <= 1.5) continue;
        const toward = next
          ? Math.sign(next.index - note.index) || note.turn
          : note.turn;
        const before = notes[i - 1];
        // rather a new pitch than a repeat of a neighbour
        const repeats = (index: number) =>
          index === before.index || (!!next && index === next.index) ? 1 : 0;
        const options = [note.index + toward, note.index - toward]
          .filter(
            (index) => index >= 0 && index <= top && !rubs(index, note.beat),
          )
          .sort((a, b) => repeats(a) - repeats(b));
        if (options.length) note.index = options[0];
      }

      laid.push({ notes, units });
      leftBy = notes[notes.length - 1] ?? leftBy;
    }

    // one climax: the highest note may sound only once, inside the climax phrase.
    // (A section of a single phrase has no arch to shape: it is left as the
    // first phrase of a longer section would be, so that a verse cut from
    // eight bars to four keeps the notes of its first half.)
    const result = laid.flatMap((phrase) => phrase.notes);
    if (phrases > 1 && result.length > 2) {
      const peak = Math.max(...result.map((note) => note.index));
      const peaks = result.filter((note) => note.index === peak);
      if (peaks.length > 1) {
        const keep =
          peaks.find(
            (note) => note.phrase === climax && note.strong && !note.cadence,
          ) ??
          peaks.find((note) => note.phrase === climax) ??
          peaks.reduce((a, b) => (b.len > a.len ? b : a));
        for (const note of peaks) {
          if (note === keep || note.cadence) continue;
          if (note.strong) note.index = snap(note.index - 1, note.beat, -1);
          else {
            // one step down, or two when that step would grate against the chord
            const lowered = bound(note.index - 1);
            note.index = rubs(lowered, note.beat)
              ? bound(note.index - 2)
              : lowered;
          }
        }
      }
    }

    /**
     * The phrase as it is played: busier or sparser than written. Notes are
     * only ever added to the written phrase or taken away from it; a note
     * that stays keeps its pitch (unless it is left holding a note foreign
     * to the chord, which then settles on the nearest chord tone).
     */
    const adapt = (phrase: (typeof laid)[number]): Draft[] => {
      const notes = phrase.notes;
      if (!notes.length) return notes;
      const phraseBeat = (section.startBar + notes[0].phrase * 4) * beatsPerBar;
      const phraseBeats = Math.min(4, bars - notes[0].phrase * 4) * beatsPerBar;
      // busier: passing notes split the longest notes, in the motif's own order
      if (traits.activity > 1)
        for (const unit of phrase.units)
          for (const extra of motif.added) {
            if (extra.from > traits.activity) break;
            if (extra.step < unit.fromStep || extra.step >= unit.toStep)
              continue;
            const beat =
              unit.bar * beatsPerBar + (extra.step - unit.fromStep) / 4;
            const at = notes.findIndex(
              (note) =>
                note.beat < beat - 1e-6 && note.beat + note.len > beat + 1e-6,
            );
            if (at < 0 || notes[at].cadence) continue;
            const parent = notes[at];
            const next = notes[at + 1];
            const gap = next ? next.index - parent.index : 0;
            let index: number;
            if (disjunct)
              index = snap(parent.index + 2 * extra.turn, beat, extra.turn);
            else {
              // on the way to the next note where there is a way; a neighbour
              // note where the line stands still; a changing note round a step
              index =
                Math.abs(gap) >= 2
                  ? parent.index + Math.sign(gap)
                  : gap === 0
                    ? parent.index + extra.turn
                    : extra.turn === Math.sign(gap)
                      ? parent.index + 2 * Math.sign(gap)
                      : parent.index - Math.sign(gap);
              index = bound(clamp(index, bandLow - 2, bandHigh + 2));
              // never a tritone from either neighbour, never a held or accented
              // rub against the chord: the note is repeated instead
              const awkward =
                Math.abs(ladder[index] - ladder[parent.index]) === 6 ||
                (!!next &&
                  Math.abs(ladder[index] - ladder[next.index]) === 6) ||
                (rubs(index, beat) &&
                  (Math.round(beat * 4) % 4 === 0 ||
                    parent.beat + parent.len - beat >= 1));
              if (awkward) index = parent.index;
            }
            const end = parent.beat + parent.len;
            parent.len = beat - parent.beat;
            notes.splice(at + 1, 0, {
              beat,
              len: end - beat,
              index,
              strong: disjunct,
              turn: extra.turn,
              position: clamp((beat - phraseBeat) / phraseBeats, 0, 1),
              section: section.index,
              phrase: parent.phrase,
              from: extra.from,
            });
          }
      // sparser: the least important notes go first, and the note before rings
      // on through them. Sixteenths too short to speak go at any activity.
      const kept: Draft[] = [];
      for (const note of notes) {
        const unplayable =
          traits.coarse &&
          note.from > 0 &&
          !note.cadence &&
          Math.round(note.beat * 4) % 2 === 1;
        if (note.from <= traits.activity && !unplayable) {
          kept.push(note);
          continue;
        }
        const before = kept[kept.length - 1];
        if (
          before &&
          !before.cadence &&
          Math.abs(before.beat + before.len - note.beat) < 1e-6
        ) {
          before.len = Math.min(before.len + note.len, Math.max(before.len, 2));
          before.grown = true;
        }
      }
      // a passing note left long, or tied over a strong beat, now carries the line there
      for (const note of kept) {
        if (!note.grown || note.strong) continue;
        const step = mod(Math.round(note.beat * 4), 16);
        const steps = Math.round(note.len * 4);
        const tied =
          step % grid !== 0 &&
          Math.floor((step + steps - 1) / grid) > Math.floor(step / grid);
        if (steps < long && !tied) continue;
        const chordBeat = tied
          ? Math.floor(note.beat / beatsPerBar) * beatsPerBar +
            ((Math.floor(step / grid) + 1) * grid) / 4
          : note.beat;
        const held = note.len - (chordBeat - note.beat);
        if (
          !strongPcs(chordBeat, true, held).includes(
            mod(ladder[note.index], 12),
          )
        )
          note.index = snap(note.index, chordBeat, note.turn, true, held);
        note.strong = true;
      }
      if (kept.length) kept[0].phraseStart = true;
      return kept;
    };
    const played = laid.flatMap(adapt);
    if (played.length) lastOf.set(section.index, played[played.length - 1]);

    // intros and breakdowns keep only the skeleton of the idea
    if (section.type === "intro" || section.type === "breakdown") {
      const kept = played.filter((note) => note.strong || note.cadence);
      kept.forEach((note, i) => {
        const next = kept[i + 1];
        const room = next ? next.beat - note.beat : note.len;
        note.len = Math.max(note.len, Math.min(room, trait.sustain ? 3 : 2));
      });
      return kept;
    }
    return played;
  };

  const drafts: Draft[] = [];
  for (const section of sections)
    if (ctx.plays.lead[section.index]) drafts.push(...composeSection(section));
  drafts.sort((a, b) => a.beat - b.beat);

  /** sixteenths from the start of the note's phrase: the same wherever the form puts the section */
  const placeOf = (note: Draft) =>
    Math.round(
      (note.beat -
        (sections[note.section].startBar + note.phrase * 4) * beatsPerBar) *
        4,
    );

  /* ---- pickups into phrase starts ---- */
  const totalBeats = timing.bars * beatsPerBar;
  const pickups: Draft[] = [];
  drafts.forEach((note, i) => {
    if (!note.phraseStart) return;
    const section = sections[note.section];
    const dice = rng.fork(`pickup:${section.type}:${note.phrase}`);
    const [takes, pair, side] = [dice.next(), dice.next(), dice.next()];
    // the last bar of a loop leads back into bar 1: wherever the tune leaves
    // room for it there, the pickup into the first phrase is all but certain
    const wanted = def.pickup * (0.6 + 0.6 * complexity);
    if (takes >= (i === 0 && timing.loop ? Math.max(wanted, 0.85) : wanted))
      return;
    const count = homeDensity > 0.55 && pair < 0.5 ? 2 : 1;
    const previous =
      i > 0
        ? drafts[i - 1]
        : timing.loop
          ? drafts[drafts.length - 1]
          : undefined;
    const previousEnd = previous
      ? previous.beat + previous.len - (i > 0 ? 0 : totalBeats)
      : -Infinity;
    const first = note.beat - count * 0.5;
    if (previousEnd > first - 0.25) return;
    if (first < 0 && !timing.loop) return;
    // the pickup comes from the side the line is already on
    const drop = previous ? ladder[note.index] - ladder[previous.index] : 0;
    const fromBelow = drop > 4 ? true : drop < -4 ? false : side < 0.62;
    for (let k = count; k >= 1; k--) {
      const beat = mod(note.beat - k * 0.5, totalBeats);
      let index = note.index + (fromBelow ? -k : k);
      if (index < 0 || index > top) return;
      // a phrase that starts off the beat puts its pickup on the beat: there it must be a chord tone
      const accented = Math.round(beat * 4) % 8 === 0;
      if (accented) index = snap(index, beat, fromBelow ? -1 : 1, true, 0.5);
      if (previous && Math.abs(ladder[index] - ladder[previous.index]) > 12)
        return;
      pickups.push({
        beat,
        len: 0.5,
        index,
        strong: accented,
        turn: 1,
        position: 0,
        section: note.section,
        phrase: note.phrase,
        from: 0,
      });
    }
  });
  drafts.push(...pickups);
  drafts.sort((a, b) => a.beat - b.beat);

  /* ---- ornaments: an upper-neighbour turn on some longer notes ---- */
  const ornamented: Draft[] = [];
  const turnChance = def.ornaments * ramp(0.3, 1, complexity) * 0.35;
  const unit = traits.turnUnit;
  for (const note of drafts) {
    const eligible =
      turnChance > 0 &&
      unit > 0 &&
      !note.cadence &&
      note.strong &&
      note.len >= 1 &&
      note.len >= unit * 3 &&
      note.index < top;
    if (
      !eligible ||
      !rng
        .fork(
          `turn:${sections[note.section].type}:${note.phrase}:${placeOf(note)}`,
        )
        .chance(turnChance)
    ) {
      ornamented.push(note);
      continue;
    }
    ornamented.push(
      { ...note, len: unit },
      {
        ...note,
        beat: note.beat + unit,
        len: unit,
        index: note.index + 1,
        strong: false,
        phraseStart: false,
      },
      {
        ...note,
        beat: note.beat + unit * 2,
        len: note.len - unit * 2,
        strong: false,
        phraseStart: false,
      },
    );
  }

  /**
   * Chord-scale inflection for passing notes: when the chord holds a note
   * foreign to the key (a borrowed bVI, the third of a secondary dominant, the
   * leading tone of V in minor), the scale degree it alters follows the chord,
   * so the line says A-flat over an A-flat chord and G-sharp over E7. Where
   * the altered note would stand an augmented second from its neighbour (F to
   * G-sharp), the unaltered one is no way out either — it would be held
   * against the chord's own third — so the note gives way to a chord tone.
   */
  const inflect = (
    note: Draft,
    before: Draft | undefined,
    after: Draft | undefined,
  ): number => {
    const natural = ladder[note.index];
    const chord = harmony.at(note.beat).chord;
    const pitch = mod(natural, 12);
    if (chord.pitchClasses.includes(pitch)) return natural;
    for (const interval of chord.intervals) {
      const foreign = mod(chord.root + interval, 12);
      // a pentatonic tune keeps to its five notes over the diatonic chords around it
      if (key.inScale[foreign] || (key.pcs.length < 7 && key.parent[foreign]))
        continue;
      const tone = interval % 12;
      const diminished = chord.intervals.includes(6);
      // does the chord tone lower a scale degree (b3, b5, b7, flat roots) or raise one?
      const lowers =
        tone === 0 || tone === 7
          ? chord.head.startsWith("b") ||
            (!chord.head.startsWith("#") && !chord.applied && !diminished)
          : tone === 1 ||
            tone === 3 ||
            tone === 5 ||
            tone === 6 ||
            tone === 10 ||
            (tone === 9 && diminished);
      const shift = lowers ? -1 : 1;
      if (pitch !== mod(foreign - shift, 12)) continue;
      const candidate = natural + shift;
      // not outside the instrument, and not at the price of an augmented
      // second against a neighbouring scale step
      const awkward =
        candidate < trait.low ||
        candidate > trait.high ||
        [before, after].some(
          (other) =>
            !!other &&
            other.midi === undefined &&
            Math.abs(other.index - note.index) === 1 &&
            Math.abs(ladder[other.index] - candidate) === 3,
        );
      if (!awkward) return candidate;
      // the nearest note of the scale that belongs to the chord, on the side the line is moving to
      const toward = after
        ? Math.sign(after.index - note.index)
        : before
          ? Math.sign(note.index - before.index)
          : 0;
      const pcs = chord.pitchClasses.filter((pc) => key.inScale[pc]);
      if (!pcs.length) return natural;
      let best = note.index;
      let cost = Infinity;
      for (
        let index = Math.max(0, note.index - octave);
        index <= Math.min(top, note.index + octave);
        index++
      ) {
        if (!pcs.includes(mod(ladder[index], 12))) continue;
        const repeats =
          (!!before && before.index === index) ||
          (!!after && after.index === index);
        const value =
          Math.abs(index - note.index) +
          (Math.sign(index - note.index) === toward ? 0 : 0.5) +
          (repeats ? 0.75 : 0);
        if (value < cost) {
          cost = value;
          best = index;
        }
      }
      return ladder[best];
    }
    return natural;
  };

  /* ---- chromatic lower-neighbour grace notes before accented notes ---- */
  ornamented.sort((a, b) => a.beat - b.beat);
  const graceChance = (def.chromatic ?? 0) * (0.4 + 0.6 * complexity);
  if (graceChance > 0) {
    const graceLength = traits.graceLength;
    const graces: Draft[] = [];
    for (let i = 1; i < ornamented.length; i++) {
      const note = ornamented[i];
      const before = ornamented[i - 1];
      if (
        !note.strong ||
        note.beat % 1 !== 0 ||
        note.midi !== undefined ||
        before.midi !== undefined
      )
        continue;
      // the grace note borrows its time from the note before, or from the rest before
      const gap = note.beat - (before.beat + before.len);
      const room = gap >= graceLength - 1e-6 || before.len >= graceLength * 2;
      if (!room || before.beat >= note.beat - graceLength + 1e-6) continue;
      if (ladder[note.index] - 1 < compassLow) continue;
      // a grace note belongs to a line that is already close by, not to a leap
      if (Math.abs(ladder[note.index] - ladder[before.index]) > 7) continue;
      const dice = rng.fork(
        `grace:${sections[note.section].type}:${note.phrase}:${placeOf(note)}`,
      );
      if (!dice.chance(graceChance)) continue;
      if (gap < graceLength - 1e-6)
        before.len = note.beat - graceLength - before.beat;
      graces.push({
        ...note,
        beat: note.beat - graceLength,
        len: graceLength,
        strong: false,
        phraseStart: false,
        cadence: false,
        midi: ladder[note.index] - 1,
      });
    }
    ornamented.push(...graces);
    ornamented.sort((a, b) => a.beat - b.beat);
  }

  /* ---- to notes: legato, dynamics, slides, tremolo ---- */
  const gate = trait.sustain ? (def.gate ?? 0.95) : 1;
  const stroke = traits.stroke;
  const tremoloChance = trait.sustain
    ? 0
    : (def.tremolo ?? 0) * (0.55 + 0.45 * complexity);
  const notes: BeatNote[] = [];
  ornamented.forEach((note, i) => {
    const section = sections[note.section];
    const energy = energyAtBar(section, Math.floor(note.beat / beatsPerBar));
    const next = ornamented[i + 1];
    let len = note.len;
    if (next && next.beat > note.beat)
      len = Math.min(len, next.beat - note.beat);
    const slot = len;
    len = Math.max(0.12, len * (note.cadence ? 1 : gate));
    if (def.staccato !== undefined && slot <= 1 && !note.cadence)
      len = Math.max(0.1, slot * clamp(def.staccato, 0.1, 1));
    const midi =
      note.midi ??
      (note.strong
        ? ladder[note.index]
        : inflect(note, ornamented[i - 1], next));
    const onBeat = note.beat % 1 === 0;
    const accent = note.strong ? 0.07 : onBeat ? 0.03 : 0;
    const arc = 0.05 * Math.sin(Math.PI * clamp(note.position, 0, 1));
    const height = clamp((midi - baseCentre) * 0.006, -0.05, 0.07);
    const vel = clamp(
      0.5 + 0.3 * energy + accent + arc + height - (note.cadence ? 0.04 : 0),
      0.18,
      1,
    );
    const out: BeatNote = { beat: note.beat, len, midi, vel };
    // decorations are keyed by the note's place in its phrase, like everything else
    const place = `${section.type}:${note.phrase}:${placeOf(note)}`;
    if (trait.bend > 0 && len >= 0.5 && (note.strong || note.cadence)) {
      const dice = rng.fork(`bend:${place}`);
      if (
        dice.chance(trait.bend * (0.6 + 0.8 * def.ornaments + 0.4 * complexity))
      ) {
        const natural = ladder[note.index];
        const below = note.index > 0 ? ladder[note.index - 1] - natural : -2;
        const above = note.index < top ? ladder[note.index + 1] - natural : 2;
        out.bend =
          instrument === "guzheng" && dice.chance(0.25) ? above : below;
      }
    }
    // a long note re-struck as a tremolo that swells and settles on a last ringing stroke
    const ending = !timing.loop && note.beat >= timing.finalBar * beatsPerBar;
    if (
      tremoloChance > 0 &&
      note.strong &&
      !ending &&
      note.midi === undefined &&
      // (long at the tempo the tune was written for)
      len * homeBeatSeconds >= 0.8 &&
      len >= stroke * 3 &&
      rng.fork(`tremolo:${place}`).chance(tremoloChance)
    ) {
      const strokes = Math.max(3, Math.floor((len * 0.72) / stroke));
      for (let k = 0; k < strokes; k++) {
        const last = k === strokes - 1;
        const swell =
          0.66 + 0.3 * Math.sin((Math.PI * k) / Math.max(1, strokes - 1));
        const struck: BeatNote = {
          beat: note.beat + k * stroke,
          len: last ? len - k * stroke : stroke,
          midi,
          vel: clamp(k === 0 ? vel : vel * swell, 0.12, 1),
        };
        if (k === 0 && out.bend !== undefined) struck.bend = out.bend;
        notes.push(struck);
      }
      return;
    }
    notes.push(out);
  });
  return notes;
}

/* ------------------------------------------------------------------ */
/* counter-melody                                                      */
/* ------------------------------------------------------------------ */

export function composeCounter(
  ctx: Ctx,
  def: CounterDef,
  voice: VoiceId,
  lead: readonly BeatNote[],
): BeatNote[] {
  const { harmony, timing, sections, key, config } = ctx;
  const range = VOICE_RANGES[voice];
  const beatsPerBar = timing.beatsPerBar;
  const notes: BeatNote[] = [];
  const tune = leadCentre(ctx);

  if (def.mode === "double") {
    for (const note of lead) {
      const section = ctx.sections.find(
        (item) =>
          note.beat >= item.startBar * beatsPerBar &&
          note.beat < (item.startBar + item.bars) * beatsPerBar,
      );
      if (!section || !ctx.plays.counter[section.index] || note.len < 0.75)
        continue;
      let midi = note.midi - 12;
      while (midi < range[0]) midi += 12;
      while (midi > range[1]) midi -= 12;
      notes.push({
        beat: note.beat,
        len: note.len,
        midi,
        vel: clamp(note.vel * 0.82, 0.1, 1),
      });
    }
    return notes;
  }

  // (whether the lead is a high instrument decides it, not where this key
  // happens to put the tune: the texture must not flip with the key)
  const descant =
    def.placement === "above" && sweetSpot(ctx) <= 74 && range[1] >= tune + 16;
  // a descant floats over the tune as it was actually written: its floor lies
  // above the middle of the tune's notes, wherever the key has put them
  const leadMean = lead.length
    ? lead.reduce((sum, note) => sum + note.midi, 0) / lead.length
    : tune;
  const low = descant
    ? Math.max(range[0], tune + 2, Math.round(leadMean) + 2)
    : Math.max(range[0], 52);
  const high = descant
    ? Math.min(range[1], Math.max(tune + 15, low + 9))
    : Math.min(range[1], Math.max(low + 12, tune - 3));
  const centre = descant
    ? clamp(tune + 8, low + 3, high - 3)
    : clamp(tune - 10, low + 3, high - 3);
  const ladder = scaleLadder(key, low, high);
  const leadAt = (beat: number): number | undefined => {
    for (const note of lead)
      if (note.beat <= beat && note.beat + note.len > beat)
        return mod(note.midi, 12);
    return undefined;
  };
  const leadBusy = (from: number, to: number) =>
    lead.some((note) => note.beat < to && note.beat + note.len > from);
  let previous = centre;
  // how strongly the line is drawn back to the middle of its register. A
  // descant has to stay clear of the tune under it: left to voice leading
  // alone it sinks into the tune's own octave within a few bars.
  const pull = descant ? 0.4 : 0.15;
  // beside a five-note tune the line keeps to those five notes: every chord
  // the pentatonic banks use has at least two of them
  const pentatonic = key.pcs.length < 7;
  const guideOf = (chord: Chord, beat: number): number => {
    let best = previous;
    let bestCost = Infinity;
    const leadPc = leadAt(beat);
    const inside = chord.intervals.some(
      (interval) => key.inScale[mod(chord.root + interval, 12)],
    );
    for (const interval of chord.intervals) {
      const tone = interval % 12;
      const pc = mod(chord.root + tone, 12);
      const weight =
        tone === 3 || tone === 4 || tone === 10 || tone === 11
          ? 0
          : tone === 7
            ? 1.5
            : tone === 0
              ? 2.5
              : 2;
      const midi = nearestPitch(pc, previous, low, high);
      // (a chord tone outside the scale only when the chord has no other)
      const outside = pentatonic && !key.inScale[pc] ? (inside ? 1000 : 3) : 0;
      const cost =
        Math.abs(midi - previous) +
        weight +
        outside +
        (pc === leadPc ? 3 : 0) +
        Math.abs(midi - centre) * pull;
      if (cost < bestCost) {
        bestCost = cost;
        best = midi;
      }
    }
    return best;
  };

  /** another chord tone next to `from`, on the side of `toward` */
  const neighbourTone = (
    chord: Chord,
    from: number,
    toward: number,
  ): number => {
    const direction = toward >= from ? 1 : -1;
    for (const side of [direction, -direction])
      for (let step = 1; step <= 7; step++) {
        const candidate = from + side * step;
        if (candidate < low || candidate > high) break;
        const pc = mod(candidate, 12);
        if (chord.pitchClasses.includes(pc) && (!pentatonic || key.inScale[pc]))
          return candidate;
      }
    return from;
  };

  for (const slot of harmony.slots) {
    const section = sections[slot.section];
    if (!ctx.plays.counter[section.index]) continue;
    const final = !timing.loop && slot.bar >= timing.finalBar;
    if (!final && slot.bar >= section.startBar + section.playBars) continue;
    const energy = energyAtBar(section, slot.bar);
    const midi = guideOf(slot.chord, slot.beat);
    const end = final ? timing.endBeat : slot.beat + slot.beats;
    const vel = clamp(0.4 + 0.25 * energy, 0.1, 1);
    const next = harmony.after(slot);
    previous = midi;
    if (final) {
      notes.push({ beat: slot.beat, len: end - slot.beat, midi, vel });
      continue;
    }
    const dice = ctx.rng.fork(
      `counter:${section.type}:${slot.bar % 8}:${slot.beat % 4}`,
    );
    const target = guideOf(next.chord, end);
    // a small answer when the lead rests before the next downbeat
    const wantsAnswer =
      slot.beats >= 2 &&
      ladder.length > 4 &&
      !leadBusy(end - 1, end) &&
      dice.chance(0.35 + 0.4 * config.complexity);
    const lineEnd = wantsAnswer ? end - 1 : end;
    // long chords get a second, moving note so the line is a line and not a drone
    const moves =
      lineEnd - slot.beat >= 3 && dice.chance(0.25 + 0.6 * config.complexity);
    if (moves) {
      const half = Math.floor((lineEnd - slot.beat) / 2);
      const second = neighbourTone(
        slot.chord,
        midi,
        target === midi ? midi + (slot.bar % 2 ? 1 : -1) : target,
      );
      notes.push({ beat: slot.beat, len: half * 0.97, midi, vel });
      notes.push({
        beat: slot.beat + half,
        len: (lineEnd - slot.beat - half) * 0.97,
        midi: second,
        vel: vel * 0.94,
      });
      previous = second;
    } else
      notes.push({
        beat: slot.beat,
        len: (lineEnd - slot.beat) * 0.97,
        midi,
        vel,
      });
    if (wantsAnswer) {
      const targetIndex = nearestIndex(ladder, target);
      const direction = target >= previous ? -1 : 1;
      for (let k = 2; k >= 1; k--) {
        const index = clamp(targetIndex + direction * k, 0, ladder.length - 1);
        notes.push({
          beat: end - k * 0.5,
          len: 0.5,
          midi: ladder[index],
          vel: vel * 0.9,
        });
      }
    }
  }
  return notes;
}

/* ------------------------------------------------------------------ */
/* arpeggio                                                            */
/* ------------------------------------------------------------------ */

const ARP_ORDERS: Partial<Record<ArpPattern, number[]>> = {
  alberti: [0, 2, 1, 2],
  broken: [0, 1, 2, 1],
  ostinato: [0, 0, 2, 0, 1, 0, 2, 0],
};

function arpTones(
  chord: Chord,
  low: number,
  high: number,
  octaves: number,
): number[] {
  const offsets = [
    ...new Set(chord.intervals.slice(0, 4).map((interval) => interval % 12)),
  ].sort((a, b) => a - b);
  let root = low + mod(chord.root - low, 12);
  if (root + 12 * octaves > high && root - 12 >= low - 5) root -= 12;
  const tones: number[] = [];
  for (let o = 0; o < octaves; o++)
    for (const offset of offsets) tones.push(root + o * 12 + offset);
  tones.push(root + octaves * 12);
  return tones.filter((tone) => tone <= high + 2);
}

export function composeArp(ctx: Ctx, def: ArpDef, voice: VoiceId): BeatNote[] {
  const { harmony, timing, sections } = ctx;
  const range = VOICE_RANGES[voice];
  const window = def.register ?? [60, 84];
  let low = Math.max(window[0], range[0]);
  let high = Math.min(window[1], range[1]);
  // a figure running right where the tune sits masks it: it moves an octave underneath
  const tune = leadCentre(ctx);
  const middle = (low + high) / 2;
  if (
    middle > tune - 6 &&
    middle < tune + 8 &&
    low - 12 >= Math.max(range[0], 45)
  ) {
    low -= 12;
    high -= 12;
  }
  const beatsPerBar = timing.beatsPerBar;
  const gate = def.gate ?? 0.9;
  const notes: BeatNote[] = [];
  for (const section of sections) {
    if (!ctx.plays.arp[section.index]) continue;
    const dice = ctx.rng.fork(`arp:${section.type}`);
    const pattern = dice.pick(def.pattern);
    const walk = Array.from({ length: 8 }, () => dice.int(0, 7));
    // sixteenths blur into a buzz once they are shorter than ~85 ms
    const tooFast = timing.beatSeconds / 4 < 0.085;
    const rate = Math.max(def.rate[tierOf(section.energy)], tooFast ? 2 : 1);
    for (let b = 0; b < section.playBars; b++) {
      const bar = section.startBar + b;
      const level = 0.6 + 0.4 * energyAtBar(section, bar);
      for (let step = 0; step < 16; step += rate) {
        const beat = bar * beatsPerBar + step / 4;
        const slot = harmony.at(beat);
        const tones =
          pattern === "octaves"
            ? arpTones(slot.chord, low, high, 1).filter(
                (_, i, all) => i === 0 || i === all.length - 1,
              )
            : arpTones(slot.chord, low, high, def.octaves ?? 1);
        const count = tones.length;
        if (!count) continue;
        const k = Math.round(((beat - slot.beat) * 4) / rate);
        let index: number;
        if (pattern === "down") index = count - 1 - (k % count);
        else if (pattern === "updown") {
          const period = Math.max(1, 2 * count - 2);
          const j = k % period;
          index = j < count ? j : period - j;
        } else if (pattern === "random") index = walk[k % 8] % count;
        else if (pattern === "octaves") index = k % 2;
        else {
          const order = ARP_ORDERS[pattern];
          index = order
            ? Math.min(count - 1, order[k % order.length])
            : k % count;
        }
        const accent = step % 4 === 0 ? 0.64 : step % 2 === 0 ? 0.54 : 0.46;
        notes.push({
          beat,
          len: (rate / 4) * gate,
          midi: tones[Math.min(index, count - 1)],
          vel: clamp(accent * level, 0.08, 1),
        });
      }
    }
  }
  const ending = sections[sections.length - 1];
  if (!timing.loop && ctx.plays.arp[ending.index]) {
    const beat = timing.finalBar * beatsPerBar;
    const tones = arpTones(harmony.at(beat).chord, low, high, 1);
    if (tones.length)
      notes.push({
        beat,
        len: timing.endBeat - beat,
        midi: tones[0],
        vel: 0.4,
      });
  }
  return notes;
}
