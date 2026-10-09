/**
 * Tempo / length planning and song form.
 *
 * LOOP     the tempo is the one asked for. Only where a multiple of four
 *          bars already lies within ±3 % of it is the tempo bent that little,
 *          so the audio is exactly the requested length; otherwise the tempo
 *          is kept to the digit and the length snaps to whole bars (see
 *          loopBars). No intro or outro: A-B / AABA shapes whose last bar
 *          turns around into bar 1. Styles with `form.build` prepare every
 *          arrival of B with a build.
 * NON-LOOP the requested tempo and length are kept exactly; the form is scaled
 *          to the bars that fit and ends on a held final chord with room for
 *          the natural tail.
 */
import type { MusicConfig } from "../types";
import { styleInfo, type SectionType } from "./catalog";
import type { Section } from "./score";
import type { StyleDef } from "./styles/types";
import { clamp } from "./theory";

export interface Timing {
  bpm: number;
  beatsPerBar: number;
  beatSeconds: number;
  barSeconds: number;
  /** bars in the score (the last one may be cut short by `duration` in non-loop pieces) */
  bars: number;
  duration: number;
  loop: boolean;
  /** what a loop had to change to close seamlessly */
  adjusted: "tempo" | "duration" | "none";
  /** bar that holds the final chord (non-loop); -1 for loops */
  finalBar: number;
  /** beat by which every note has been released (loop: the end of the last bar) */
  endBeat: number;
  /** the same in seconds */
  endTime: number;
}

/**
 * How far a loop may bend the tempo to land on the requested length. Small
 * enough that nobody hears it and that a tempo the user names (or a step of
 * a few BPM) is what they get: beyond it the length gives way, never the tempo.
 */
export const TEMPO_FIT_TOLERANCE = 0.03;
/** From this tempo up a bar is so short that chords last two bars and phrases eight. */
export const FAST_TEMPO = 152;
/** How far a tempo has to move past FAST_TEMPO, away from the style's own side of it, to change sides. */
const FAST_HYSTERESIS = 0.14;

/**
 * Whether a bar flies by at this tempo. The switch at FAST_TEMPO reshapes the
 * whole piece (phrase length, harmonic rhythm), so it has a hysteresis band
 * around it, and the side a style starts on is decided by the style's own
 * tempo: a style that lives below FAST_TEMPO turns fast from 173 BPM, one
 * that lives above it calms down below 131. Nudging the tempo by a tenth
 * therefore never restructures a piece.
 */
export function isFastTempo(bpm: number, style: Pick<StyleDef, "id">): boolean {
  const home = styleInfo(style.id).bpm >= FAST_TEMPO;
  return bpm >= FAST_TEMPO * (home ? 1 - FAST_HYSTERESIS : 1 + FAST_HYSTERESIS);
}

/**
 * Bars of a loop that keeps its tempo: the whole bars nearest to the requested
 * length, an even count at least, and a multiple of four (whole four-bar
 * phrases) wherever that is no more than one bar from the request. The loop
 * is therefore never more than one bar longer or shorter than asked for.
 */
export function loopBars(duration: number, bpm: number): number {
  const wanted = (duration * bpm) / 240;
  const fours = 4 * Math.round(wanted / 4);
  if (fours >= 4 && Math.abs(fours - wanted) <= 1 + 1e-9) return fours;
  return Math.max(2, 2 * Math.round(wanted / 2));
}

export function planTiming(config: MusicConfig, style: StyleDef): Timing {
  const beatsPerBar = 4;
  if (config.loop) {
    // the multiple of four bars whose tempo comes closest to the one asked for
    let bars = 4;
    let fitted = (240 * bars) / config.duration;
    for (let candidate = 4; candidate <= 512; candidate += 4) {
      const bpm = (240 * candidate) / config.duration;
      if (
        Math.abs(Math.log(bpm / config.bpm)) <
        Math.abs(Math.log(fitted / config.bpm))
      ) {
        bars = candidate;
        fitted = bpm;
      }
      if (bpm > config.bpm * 2) break;
    }
    let bpm = config.bpm;
    let duration = config.duration;
    let adjusted: Timing["adjusted"] = "none";
    if (Math.abs(fitted / config.bpm - 1) <= TEMPO_FIT_TOLERANCE) {
      bpm = fitted;
      if (Math.abs(fitted - config.bpm) > 0.005) adjusted = "tempo";
    } else {
      bars = loopBars(config.duration, bpm);
      duration = (bars * 240) / bpm;
      if (Math.abs(duration - config.duration) > 0.005) adjusted = "duration";
    }
    const beatSeconds = 60 / bpm;
    return {
      bpm,
      beatsPerBar,
      beatSeconds,
      barSeconds: beatSeconds * beatsPerBar,
      bars,
      duration,
      loop: true,
      adjusted,
      finalBar: -1,
      endBeat: bars * beatsPerBar,
      endTime: duration,
    };
  }
  const bpm = config.bpm;
  const beatSeconds = 60 / bpm;
  const barSeconds = beatSeconds * beatsPerBar;
  const duration = config.duration;
  const tail = clamp(style.form.tail ?? 2.2, 1.5, 3);
  const endTime = duration - tail;
  // the final chord starts on a downbeat and is held for at least two beats
  const minimumHold = Math.max(beatSeconds * 2, 1.2);
  const finalBar = Math.max(
    1,
    Math.floor((endTime - minimumHold) / barSeconds + 1e-9),
  );
  return {
    bpm,
    beatsPerBar,
    beatSeconds,
    barSeconds,
    bars: Math.max(finalBar + 1, Math.ceil(duration / barSeconds - 1e-9)),
    duration,
    loop: false,
    adjusted: "none",
    finalBar,
    endBeat: endTime / beatSeconds,
    endTime,
  };
}

/* ------------------------------------------------------------------ */

export interface SectionPlan extends Section {
  index: number;
  /** 0 for the first section of its type, 1 for the next … */
  occurrence: number;
  /** bars of ordinary music; the ending section also owns the final chord bar and the tail */
  playBars: number;
  /** energy at the first and the last bar (they differ inside a build) */
  energyFrom: number;
  energyTo: number;
  /** the section that follows; wraps in loops, -1 after the ending */
  next: number;
  /** true for the last section of a non-loop piece */
  ending: boolean;
}

export const SECTION_LABELS: Record<SectionType, string> = {
  intro: "前奏",
  verse: "主歌",
  chorus: "副歌",
  bridge: "桥段",
  breakdown: "间奏",
  build: "铺垫",
  outro: "尾声",
};
const LOOP_LABELS: Partial<Record<SectionType, string>> = {
  verse: "A 段",
  chorus: "B 段",
  breakdown: "C 段",
};

/** section energy = clamp(energy × mul + add) */
const ENERGY_SHAPE: Record<SectionType, [number, number]> = {
  intro: [0.55, 0.02],
  verse: [0.82, 0.02],
  chorus: [1, 0.1],
  bridge: [0.72, 0.02],
  breakdown: [0.45, 0.02],
  build: [0.85, 0.03],
  outro: [0.55, 0.02],
};

/** Energy of a section of this type in a piece of the given energy, before repeats and builds shape it. */
export function sectionEnergy(
  style: StyleDef,
  type: SectionType,
  energy: number,
): number {
  const [mul, add] = style.form.energy?.[type] ?? ENERGY_SHAPE[type];
  return clamp(energy * mul + add, 0, 1);
}

type Block = { type: SectionType; bars: number; energy?: number };

const v = (units: number): [SectionType, number] => ["verse", units];
const c = (units: number): [SectionType, number] => ["chorus", units];
const bd: [SectionType, number] = ["breakdown", 1];
const bu: [SectionType, number] = ["build", 1];
const br = (units: number): [SectionType, number] => ["bridge", units];
/** body sections (in 4- or 8-bar units) by how many units fit */
const BODY: [SectionType, number][][] = [
  [],
  [v(1)],
  [v(1), c(1)],
  [v(1), c(2)],
  [v(2), c(2)],
  [v(2), c(2), v(1)],
  [v(2), c(2), v(1), c(1)],
  [v(2), c(2), bd, c(2)],
  [v(2), c(2), bd, bu, c(2)],
  [v(2), c(2), v(1), bd, bu, c(2)],
  [v(2), c(2), v(2), bd, bu, c(2)],
  [v(2), c(2), v(2), c(1), bd, bu, c(2)],
  [v(2), c(2), v(2), c(2), bd, bu, c(2)],
  [v(2), c(2), v(2), c(2), br(1), bd, bu, c(2)],
  [v(2), c(2), v(2), c(2), br(2), bd, bu, c(2)],
];

/** the same for styles whose main section is always prepared by a build */
const BODY_BUILD: [SectionType, number][][] = [
  [],
  [c(1)],
  [bu, c(1)],
  [v(1), bu, c(1)],
  [v(1), bu, c(2)],
  [v(2), bu, c(2)],
  [v(1), bu, c(2), bu, c(1)],
  [v(2), bu, c(2), bu, c(1)],
  [v(2), bu, c(2), bd, bu, c(1)],
  [v(2), bu, c(2), bd, bu, c(2)],
  [v(2), bu, c(2), v(1), bd, bu, c(2)],
  [v(2), bu, c(2), v(2), bd, bu, c(2)],
  [v(2), bu, c(2), v(1), bu, c(1), bd, bu, c(2)],
  [v(2), bu, c(2), v(1), bu, c(2), bd, bu, c(2)],
  [v(2), bu, c(2), v(2), bu, c(2), bd, bu, c(2)],
];

const LOOP_AB = [
  "",
  "A",
  "AB",
  "AAB",
  "AABB",
  "AABAB",
  "AABBAB",
  "AABBCBB",
  "AABBAABB",
  "AABBCAABB",
  "AABBAABBCB",
  "AABBAABBCBB",
  "AABBAABBCCBB",
];
const LOOP_AABA = [
  "",
  "A",
  "AB",
  "AAB",
  "AABA",
  "AABAA",
  "AABABA",
  "AABAABA",
  "AAAABBAA",
  "AAAABBAAB",
  "AAAABBAABA",
  "AAAABBAAABA",
  "AAAABBAAAABA",
];

/** A groove, U a build, B the drop, C a breakdown */
const LOOP_BUILD = [
  "",
  "A",
  "AB",
  "AUB",
  "AUBB",
  "AAUBB",
  "AAUBBC",
  "AUBBCUB",
  "AAUBBCUB",
  "AAUBBCUBB",
  "AAUBBACUBB",
  "AAUBBAACUBB",
  "AAUBBAACUBBB",
];

function nearest(options: number[], value: number): number {
  let best = options[0];
  for (const option of options)
    if (Math.abs(option - value) < Math.abs(best - value)) best = option;
  return best;
}

/** Bars before the final chord of a non-loop piece → section blocks. */
function throughComposed(
  playable: number,
  barSeconds: number,
  duration: number,
  style: StyleDef,
  fast: boolean,
): Block[] {
  const unitFor = (body: number) =>
    body >= 60 || (fast && body >= 16) ? 8 : 4;
  if (playable <= 3)
    return playable > 1
      ? [
          { type: "verse", bars: playable - 1 },
          { type: "outro", bars: 1 },
        ]
      : [{ type: "outro", bars: playable }];
  const size = duration <= 22 ? 0 : duration <= 45 ? 1 : duration <= 80 ? 2 : 3;
  const introIdeal = nearest(
    [0, 1, 2, 4, 8],
    ([2.2, 4.5, 8, 8.5][size] * style.form.intro) / barSeconds,
  );
  const cadenceIdeal = clamp(
    Math.round(([2.2, 4.5, 6.5, 7.5][size] * style.form.outro) / barSeconds),
    1,
    4,
  );
  let best = { intro: 0, cadence: 1, cost: Infinity };
  for (const intro of [0, 1, 2, 3, 4, 6, 8])
    for (const cadence of [1, 2, 3, 4, 5, 6]) {
      const body = playable - intro - cadence;
      if (body < 1) continue;
      const unit = unitFor(body);
      const cost =
        (body % unit) * 8 +
        Math.abs(intro - introIdeal) +
        Math.abs(cadence - cadenceIdeal) * 1.2 +
        (intro === 3 ? 0.6 : 0) +
        (cadence >= 5 ? 0.5 : 0);
      if (cost < best.cost) best = { intro, cadence, cost };
    }
  const body = playable - best.intro - best.cadence;
  const unit = unitFor(body);
  const units = Math.floor(body / unit);
  const blocks: Block[] = [];
  if (best.intro) blocks.push({ type: "intro", bars: best.intro });
  if (units < 1) blocks.push({ type: "verse", bars: body });
  else {
    const table = style.form.build ? BODY_BUILD : BODY;
    const template = table[Math.min(units, table.length - 1)];
    const extraUnits =
      units - template.reduce((sum, [, count]) => sum + count, 0);
    template.forEach(([type, count], index) => {
      // anything beyond the largest template lengthens the last chorus
      const bonus = index === template.length - 1 ? extraUnits : 0;
      blocks.push({ type, bars: (count + bonus) * unit });
    });
    blocks[blocks.length - 1].bars += body - units * unit;
  }
  blocks.push({ type: "outro", bars: best.cadence });
  return blocks;
}

function looped(bars: number, style: StyleDef, fast: boolean): Block[] {
  if (bars < 4) return [{ type: "verse", bars }];
  let unit = fast && bars >= 16 ? 8 : 4;
  while (Math.floor(bars / unit) > 12) unit *= 2;
  const units = Math.floor(bars / unit);
  const pattern = (
    style.form.build
      ? LOOP_BUILD
      : style.form.loop === "AABA"
        ? LOOP_AABA
        : LOOP_AB
  )[units];
  const blocks: Block[] = [];
  for (const letter of pattern) {
    const type: SectionType =
      letter === "A"
        ? "verse"
        : letter === "B"
          ? "chorus"
          : letter === "U"
            ? "build"
            : "breakdown";
    const last = blocks[blocks.length - 1];
    if (last && last.type === type) last.bars += unit;
    else blocks.push({ type, bars: unit });
  }
  blocks[blocks.length - 1].bars += bars - units * unit;
  return blocks;
}

type Hint = { type: SectionType; bars: number; energy: number };

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
const isBody = (type: SectionType) =>
  type === "verse" || type === "chorus" || type === "bridge";

/** Fewest bars a section can have and still be heard as a section of its own. */
function shortest(item: Hint, total: number): number {
  const floor =
    total >= 16
      ? isBody(item.type)
        ? 4
        : 2
      : total >= 6 && isBody(item.type)
        ? 2
        : 1;
  return Math.min(item.bars, floor);
}

/**
 * Hand `total` bars to the sections in proportion to `wants`, none below its
 * `least`, counted in phrase units of 4, 2 or 1 bars; bars a unit cannot
 * place go to the last section. Of the three results the one that stays
 * closest to the proportions while keeping to even phrase lengths wins.
 * Needs sum(least) <= total.
 */
function shareBars(wants: number[], least: number[], total: number): number[] {
  const wanted = sum(wants);
  let best: number[] | undefined;
  let bestCost = Infinity;
  for (const unit of [4, 2, 1]) {
    const units = Math.floor(total / unit);
    const need = least.map((bars) => Math.max(1, Math.ceil(bars / unit)));
    if (sum(need) > units) continue;
    const ideal = wants.map((want) => (want * total) / wanted / unit);
    const got = ideal.map((value, index) =>
      Math.max(need[index], Math.floor(value)),
    );
    let used = sum(got);
    while (used < units) {
      let pick = 0;
      for (let i = 1; i < got.length; i++)
        if (ideal[i] - got[i] > ideal[pick] - got[pick] + 1e-9) pick = i;
      got[pick]++;
      used++;
    }
    while (used > units) {
      let pick = -1;
      for (let i = 0; i < got.length; i++)
        if (
          got[i] > need[i] &&
          (pick < 0 || got[i] - ideal[i] > got[pick] - ideal[pick] + 1e-9)
        )
          pick = i;
      got[pick]--;
      used--;
    }
    const bars = got.map((count) => count * unit);
    bars[bars.length - 1] += total - units * unit;
    let cost = 0;
    bars.forEach((count, index) => {
      // distance from the proportions asked for, plus a price for odd phrase lengths
      cost += Math.abs(count - (wants[index] * total) / wanted);
      cost += count % 4 === 0 ? 0 : count % 2 === 0 ? 1 : 2.5;
    });
    if (cost < bestCost - 1e-9) {
      best = bars;
      bestCost = cost;
    }
  }
  if (best) return best;
  // unreachable while sum(least) <= total; keep the caller safe anyway
  const bars = wants.map(() => 1);
  bars[bars.length - 1] += Math.max(0, total - bars.length);
  return bars;
}

/** The section a form that does not fit can lose first. */
function mostDispensable(cell: readonly Hint[]): number {
  const lastOf = (type: SectionType) =>
    cell.map((item) => item.type).lastIndexOf(type);
  for (const type of ["breakdown", "bridge", "build"] as const)
    if (lastOf(type) >= 0) return lastOf(type);
  // a later statement of a section that has been heard already
  for (let i = cell.length - 1; i > 0; i--)
    if (
      isBody(cell[i].type) &&
      cell.findIndex((item) => item.type === cell[i].type) < i
    )
      return i;
  for (const type of ["intro", "outro"] as const)
    if (lastOf(type) >= 0 && cell.length > 1) return lastOf(type);
  return cell.length - 1;
}

export interface FormFit {
  blocks: { type: SectionType; bars: number; energy?: number }[];
  /** what had to change, as a Chinese clause for Score.notes; undefined when the hint fitted as written */
  note?: string;
}

/**
 * Make a hinted form fit `total` bars of music (`shown` is what the listener
 * counts: in a piece that ends, the last section also owns the final chord).
 *   as long as the piece       → kept as written
 *   too long                   → squeezed in proportion; when the sections
 *                                would get too short to mean anything, the
 *                                most dispensable ones are left out first
 *   a little short (under 2×)  → stretched in proportion
 *   far too short              → the body is repeated (in phrases of at least
 *                                four bars) between its intro and outro; a
 *                                body with nothing to contrast is opened out
 *                                into the style's own form (`fallback`)
 * Lengths stay on four- or two-bar phrases wherever the total allows.
 */
export function fitForm(
  hinted: readonly Hint[],
  total: number,
  shown: number,
  fallback: () => Block[],
  fast = false,
): FormFit {
  const requested = sum(hinted.map((item) => item.bars));
  const asWritten = (cell: readonly Hint[], bars: number[]): Block[] =>
    cell.map((item, index) => ({
      type: item.type,
      bars: bars[index],
      energy: item.energy,
    }));
  if (requested === total)
    return {
      blocks: asWritten(
        hinted,
        hinted.map((item) => item.bars),
      ),
    };
  const last = hinted[hinted.length - 1];
  // written for the whole length of a piece that ends: the final chord and
  // its tail come out of the last section, which owns them anyway
  if (
    requested > total &&
    requested <= shown &&
    last.bars > requested - total
  ) {
    const bars = hinted.map((item) => item.bars);
    bars[bars.length - 1] -= requested - total;
    return { blocks: asWritten(hinted, bars) };
  }

  if (requested > total) {
    const cell = hinted.map((item) => ({ ...item }));
    const dropped: SectionType[] = [];
    while (
      cell.length > 1 &&
      sum(cell.map((item) => shortest(item, total))) > total
    ) {
      const index = mostDispensable(cell);
      dropped.push(cell[index].type);
      cell.splice(index, 1);
      // neighbours of the same kind become one section
      const before = cell[index - 1];
      const after = cell[index];
      if (before && after && before.type === after.type) {
        before.bars += after.bars;
        before.energy = Math.max(before.energy, after.energy);
        cell.splice(index, 1);
      }
    }
    const least = cell.map((item) => shortest(item, total));
    const bars = shareBars(
      cell.map((item) => item.bars),
      sum(least) <= total ? least : cell.map(() => 1),
      total,
    );
    // kinds of section that are gone altogether are named; lost repeats are not
    const gone = [
      ...new Set(
        dropped
          .filter((type) => !cell.some((item) => item.type === type))
          .map((type) => SECTION_LABELS[type]),
      ),
    ];
    const repeats = dropped.some((type) =>
      cell.some((item) => item.type === type),
    );
    const left = [
      ...(gone.length ? [gone.join("、")] : []),
      ...(repeats ? ["部分反复"] : []),
    ];
    return {
      blocks: asWritten(cell, bars),
      note: `提示的曲式共 ${requested} 小节，这里只有 ${shown} 小节，已${
        left.length ? `省去${left.join("和")}并` : ""
      }按比例压缩`,
    };
  }

  if (total < requested * 2) {
    const wants = hinted.map((item) => item.bars);
    return {
      blocks: asWritten(hinted, shareBars(wants, wants, total)),
      note: `提示的曲式共 ${requested} 小节，已按比例延展到 ${shown} 小节`,
    };
  }

  // far too short: repeat the body between its intro and outro
  let from = 0;
  let to = hinted.length;
  while (from < to && hinted[from].type === "intro") from++;
  while (to > from && hinted[to - 1].type === "outro") to--;
  if (from === to) {
    from = 0;
    to = hinted.length;
  }
  const head = hinted.slice(0, from);
  const body = hinted.slice(from, to);
  const tail = hinted.slice(to);
  if (new Set(body.map((item) => item.type)).size < 2 && total >= 16) {
    // one kind of section cannot carry a whole piece: open it out into the
    // style's form, keeping the energy asked for each kind of section
    const energyOf = new Map<SectionType, number>();
    for (const item of hinted)
      if (!energyOf.has(item.type)) energyOf.set(item.type, item.energy);
    return {
      blocks: fallback().map((block) => ({
        ...block,
        energy: energyOf.get(block.type),
      })),
      note: `提示的曲式只有 ${requested} 小节的${
        SECTION_LABELS[body[0].type]
      }，撑不满全曲，已按本风格的常规曲式展开`,
    };
  }
  const edges =
    sum(head.map((item) => item.bars)) + sum(tail.map((item) => item.bars));
  const bodyBars = sum(body.map((item) => item.bars));
  const phrase = fast ? 8 : 4;
  const smallest = Math.min(...body.map((item) => item.bars));
  let grow = 1;
  while (smallest * grow < phrase && edges + bodyBars * grow * 2 <= total)
    grow *= 2;
  const repeatsAt = () =>
    Math.max(1, Math.floor((total - edges) / (bodyBars * grow)));
  let repeats = repeatsAt();
  // more than sixteen sections is a list, not a form: longer phrases instead
  while (
    repeats > 1 &&
    head.length + tail.length + body.length * repeats > 16
  ) {
    grow *= 2;
    repeats = repeatsAt();
  }
  const cell: Hint[] = [...head];
  for (let pass = 0; pass < repeats; pass++)
    for (const item of body)
      cell.push({
        type: item.type,
        bars: item.bars * grow,
        // each return of the verse and the chorus arrives a little stronger
        energy:
          item.type === "verse" || item.type === "chorus"
            ? clamp(item.energy + 0.03 * Math.min(pass, 3), 0, 1)
            : item.energy,
      });
  cell.push(...tail);
  const wants = cell.map((item) => item.bars);
  return {
    blocks: asWritten(
      cell,
      shareBars(wants, sum(wants) <= total ? wants : cell.map(() => 1), total),
    ),
    note:
      repeats > 1
        ? `提示的曲式共 ${requested} 小节，已反复 ${repeats} 遍填满 ${shown} 小节`
        : `提示的曲式共 ${requested} 小节，已按比例延展到 ${shown} 小节`,
  };
}

export interface FormPlan {
  sections: SectionPlan[];
  /** set when a hinted form had to be squeezed, trimmed, stretched or repeated */
  note?: string;
}

export function planForm(
  config: MusicConfig,
  style: StyleDef,
  timing: Timing,
): SectionPlan[] {
  return planFormWithNote(config, style, timing).sections;
}

export function planFormWithNote(
  config: MusicConfig,
  style: StyleDef,
  timing: Timing,
): FormPlan {
  const playable = timing.loop ? timing.bars : timing.finalBar;
  const hinted = config.arrangement?.form;
  const fast = isFastTempo(timing.bpm, style);
  const styleForm = (): Block[] =>
    timing.loop
      ? looped(playable, style, fast)
      : throughComposed(
          playable,
          timing.barSeconds,
          timing.duration,
          style,
          fast,
        );
  let blocks: Block[];
  let note: string | undefined;
  if (hinted && hinted.length) {
    const fit = fitForm(hinted, playable, timing.bars, styleForm, fast);
    note = fit.note;
    blocks = fit.blocks.map((block) => ({
      ...block,
      energy:
        block.energy === undefined
          ? undefined
          : clamp(block.energy * (0.6 + 0.8 * config.energy), 0, 1),
    }));
  } else blocks = styleForm();

  const seen = new Map<SectionType, number>();
  const sections: SectionPlan[] = [];
  let startBar = 0;
  blocks.forEach((block, index) => {
    const occurrence = seen.get(block.type) ?? 0;
    seen.set(block.type, occurrence + 1);
    const ending = !timing.loop && index === blocks.length - 1;
    const bars = ending ? timing.bars - startBar : block.bars;
    const [mul, add] =
      style.form.energy?.[block.type] ?? ENERGY_SHAPE[block.type];
    const lift =
      occurrence > 0 && (block.type === "chorus" || block.type === "verse")
        ? 0.04
        : 0;
    const energy =
      block.energy ??
      clamp(config.energy * mul + add + lift * config.energy, 0, 1);
    const label =
      (timing.loop && !hinted ? LOOP_LABELS[block.type] : undefined) ??
      SECTION_LABELS[block.type];
    sections.push({
      type: block.type,
      label,
      startBar,
      bars,
      start: startBar * timing.barSeconds,
      end: Math.min((startBar + bars) * timing.barSeconds, timing.duration),
      energy,
      index,
      occurrence,
      playBars: block.bars,
      energyFrom: energy,
      energyTo: energy,
      next: index + 1 < blocks.length ? index + 1 : timing.loop ? 0 : -1,
      ending,
    });
    startBar += bars;
  });
  sections[sections.length - 1].end = timing.duration;

  // a build climbs from the section before it towards the section after it
  for (const section of sections) {
    if (section.type !== "build") continue;
    const before = sections[section.index - 1];
    const after = section.next >= 0 ? sections[section.next] : undefined;
    section.energyFrom = before
      ? Math.min(section.energy, before.energy + 0.05)
      : section.energy * 0.7;
    section.energyTo = after
      ? Math.max(section.energy, after.energy * 0.95)
      : section.energy;
    section.energy = (section.energyFrom + section.energyTo) / 2;
  }
  return { sections, note };
}

/** "前奏 2 小节 → 主歌 4 → 副歌 4 → 尾声 3" */
export function describeForm(sections: readonly Section[]): string {
  return sections
    .map((section, index) =>
      index === 0
        ? `${section.label} ${section.bars} 小节`
        : `${section.label} ${section.bars}`,
    )
    .join(" → ");
}

/** Energy at a bar inside a section (linear inside builds, constant elsewhere). */
export function energyAtBar(section: SectionPlan, bar: number): number {
  if (section.energyFrom === section.energyTo || section.playBars <= 1)
    return section.energyTo;
  const progress = clamp(
    (bar - section.startBar) / (section.playBars - 1),
    0,
    1,
  );
  return (
    section.energyFrom + (section.energyTo - section.energyFrom) * progress
  );
}
