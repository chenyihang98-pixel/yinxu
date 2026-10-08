/**
 * Tempo / length planning and song form.
 *
 * LOOP     bars are a multiple of 4 and the tempo is fitted so the audio is
 *          exactly the requested length (within ±6 %); otherwise the tempo is
 *          kept and the length snaps to an even number of bars. No intro or
 *          outro: A-B / AABA shapes whose last bar turns around into bar 1.
 *          Styles with `form.build` prepare every arrival of B with a build.
 * NON-LOOP the requested tempo and length are kept exactly; the form is scaled
 *          to the bars that fit and ends on a held final chord with room for
 *          the natural tail.
 */
import type { MusicConfig } from "../types";
import type { SectionType } from "./catalog";
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

const TEMPO_FIT_TOLERANCE = 0.06;
/** From this tempo up a bar is so short that chords last two bars and phrases eight. */
export const FAST_TEMPO = 152;

export function planTiming(config: MusicConfig, style: StyleDef): Timing {
  const beatsPerBar = 4;
  if (config.loop) {
    let bars = 4;
    let fitted = (240 * bars) / config.duration;
    for (let candidate = 4; candidate <= 512; candidate += 4) {
      const bpm = (240 * candidate) / config.duration;
      if (Math.abs(Math.log(bpm / config.bpm)) < Math.abs(Math.log(fitted / config.bpm))) {
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
      const barSeconds = 240 / config.bpm;
      bars = Math.max(2, 2 * Math.round(config.duration / barSeconds / 2));
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
  const finalBar = Math.max(1, Math.floor((endTime - minimumHold) / barSeconds + 1e-9));
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
): Block[] {
  const fast = 240 / barSeconds >= FAST_TEMPO;
  const unitFor = (body: number) => (body >= 60 || (fast && body >= 16) ? 8 : 4);
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
    const extraUnits = units - template.reduce((sum, [, count]) => sum + count, 0);
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
    style.form.build ? LOOP_BUILD : style.form.loop === "AABA" ? LOOP_AABA : LOOP_AB
  )[units];
  const blocks: Block[] = [];
  for (const letter of pattern) {
    const type: SectionType =
      letter === "A" ? "verse" : letter === "B" ? "chorus" : letter === "U" ? "build" : "breakdown";
    const last = blocks[blocks.length - 1];
    if (last && last.type === type) last.bars += unit;
    else blocks.push({ type, bars: unit });
  }
  blocks[blocks.length - 1].bars += bars - units * unit;
  return blocks;
}

/** Scale requested section lengths so they add up to `total` bars (each at least 1). */
function fitBars(requested: number[], total: number): number[] {
  const wants = requested.slice(0, Math.max(1, total));
  const sum = wants.reduce((a, b) => a + b, 0);
  if (sum === total) return wants;
  const scale = total / sum;
  const bars = wants.map((want) => Math.max(1, Math.floor(want * scale)));
  let used = bars.reduce((a, b) => a + b, 0);
  const order = wants
    .map((want, index) => ({ index, part: want * scale - Math.floor(want * scale) }))
    .sort((a, b) => b.part - a.part || a.index - b.index);
  for (let k = 0; used < total; k++, used++) bars[order[k % order.length].index]++;
  while (used > total) {
    let widest = 0;
    for (let i = 1; i < bars.length; i++) if (bars[i] > bars[widest]) widest = i;
    if (bars[widest] <= 1) break;
    bars[widest]--;
    used--;
  }
  return bars;
}

export function planForm(
  config: MusicConfig,
  style: StyleDef,
  timing: Timing,
): SectionPlan[] {
  const playable = timing.loop ? timing.bars : timing.finalBar;
  const hinted = config.arrangement?.form;
  let blocks: Block[];
  if (hinted && hinted.length) {
    const bars = fitBars(
      hinted.map((item) => item.bars),
      playable,
    );
    blocks = bars.map((count, index) => ({
      type: hinted[index].type,
      bars: count,
      energy: clamp(hinted[index].energy * (0.6 + 0.8 * config.energy), 0, 1),
    }));
  } else
    blocks = timing.loop
      ? looped(playable, style, timing.bpm >= FAST_TEMPO)
      : throughComposed(playable, timing.barSeconds, timing.duration, style);

  const seen = new Map<SectionType, number>();
  const sections: SectionPlan[] = [];
  let startBar = 0;
  blocks.forEach((block, index) => {
    const occurrence = seen.get(block.type) ?? 0;
    seen.set(block.type, occurrence + 1);
    const ending = !timing.loop && index === blocks.length - 1;
    const bars = ending ? timing.bars - startBar : block.bars;
    const [mul, add] = style.form.energy?.[block.type] ?? ENERGY_SHAPE[block.type];
    const lift =
      occurrence > 0 && (block.type === "chorus" || block.type === "verse") ? 0.04 : 0;
    const energy =
      block.energy ?? clamp(config.energy * mul + add + lift * config.energy, 0, 1);
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
    section.energyFrom = before ? Math.min(section.energy, before.energy + 0.05) : section.energy * 0.7;
    section.energyTo = after ? Math.max(section.energy, after.energy * 0.95) : section.energy;
    section.energy = (section.energyFrom + section.energyTo) / 2;
  }
  return sections;
}

/** "前奏 2 小节 → 主歌 4 → 副歌 4 → 尾声 3" */
export function describeForm(sections: readonly Section[]): string {
  return sections
    .map((section, index) =>
      index === 0 ? `${section.label} ${section.bars} 小节` : `${section.label} ${section.bars}`,
    )
    .join(" → ");
}

/** Energy at a bar inside a section (linear inside builds, constant elsewhere). */
export function energyAtBar(section: SectionPlan, bar: number): number {
  if (section.energyFrom === section.energyTo || section.playBars <= 1)
    return section.energyTo;
  const progress = clamp((bar - section.startBar) / (section.playBars - 1), 0, 1);
  return section.energyFrom + (section.energyTo - section.energyFrom) * progress;
}
