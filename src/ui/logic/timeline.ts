/**
 * Pure helpers for the things laid out along a work's time axis: section
 * bands, the chord strip and the waveform's bars. No DOM.
 */

export interface TimeSpan {
  /** seconds */
  start: number;
  /** seconds */
  end: number;
}

/**
 * Index of the span playing at `time`: the last span that has started.
 * -1 before the first span; a time past the end stays on the last span.
 */
export function spanIndexAt(spans: readonly TimeSpan[], time: number): number {
  if (!spans.length || !(time >= spans[0].start)) return -1;
  let low = 0;
  let high = spans.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (spans[middle].start <= time) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Position of `time` on an axis of `total` seconds, as 0..100. */
export function percentAt(time: number, total: number): number {
  if (!(total > 0) || !Number.isFinite(time)) return 0;
  return Math.max(0, Math.min(100, (time / total) * 100));
}

export interface ChordLike extends TimeSpan {
  symbol: string;
}

/** Estimated width of a chord symbol set in the strip's 12 px type. */
export function chordLabelWidth(symbol: string): number {
  return Math.ceil(symbol.length * 7.4) + 8;
}

export interface ChordMark {
  /** print the symbol */
  label: boolean;
  /** draw the tick that marks where the chord starts */
  tick: boolean;
}

/**
 * How to draw each chord when the strip is `width` px wide. A chord that
 * repeats the one before it is a continuation: no label, no tick. The rest
 * get a tick, and a label wherever the previous label leaves room; a tick
 * that would cut through a printed label is left out. The returned array is
 * parallel to `chords`.
 */
export function chordLayout(
  chords: readonly ChordLike[],
  total: number,
  width: number,
  gap = 8,
): ChordMark[] {
  const marks = chords.map<ChordMark>(() => ({ label: false, tick: false }));
  if (!(total > 0) || !(width > 0)) return marks;
  /** right edge of the last printed label */
  let inked = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < chords.length; index++) {
    const chord = chords[index];
    if (index > 0 && chords[index - 1].symbol === chord.symbol) continue;
    const left = (chord.start / total) * width;
    const right = left + chordLabelWidth(chord.symbol);
    if (left >= inked) marks[index].tick = true;
    if (left + 0.5 < inked + gap || right > width + 1) continue;
    marks[index].label = true;
    inked = right;
  }
  return marks;
}

/**
 * Where the highlighted chord's pill sits (it hangs left at the right edge
 * of the strip) and which printed labels it covers.
 */
export function chordPill(
  chords: readonly ChordLike[],
  marks: readonly ChordMark[],
  current: number,
  total: number,
  width: number,
): { edge: boolean; hidden: Set<number> } {
  const hidden = new Set<number>();
  const chord = chords[current];
  if (!chord || !(total > 0) || !(width > 0)) return { edge: false, hidden };
  // the pill is the symbol plus a little more padding than a plain label
  const size = chordLabelWidth(chord.symbol) + 4;
  const start = (chord.start / total) * width;
  const edge = start + size > width;
  const left = edge ? width - size : start;
  const right = left + size;
  for (let index = 0; index < chords.length; index++) {
    if (index === current || !marks[index]?.label) continue;
    const from = (chords[index].start / total) * width;
    const to = from + chordLabelWidth(chords[index].symbol);
    if (from < right + 4 && to > left - 4) hidden.add(index);
  }
  return { edge, hidden };
}

/**
 * `peaks` resampled to `count` bars: the loudest input in each bar when
 * shrinking, linear interpolation when stretching. Values stay in 0..1.
 */
export function resamplePeaks(
  peaks: readonly number[],
  count: number,
): number[] {
  const bars = Math.max(0, Math.floor(count));
  const out = new Array<number>(bars).fill(0);
  const length = peaks.length;
  if (!bars || !length) return out;
  const clean = (value: number) =>
    Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  if (bars >= length) {
    for (let bar = 0; bar < bars; bar++) {
      const position = bars === 1 ? 0 : (bar * (length - 1)) / (bars - 1);
      const low = Math.floor(position);
      const high = Math.min(length - 1, low + 1);
      const mix = position - low;
      out[bar] = clean(peaks[low]) * (1 - mix) + clean(peaks[high]) * mix;
    }
    return out;
  }
  for (let bar = 0; bar < bars; bar++) {
    const from = Math.floor((bar * length) / bars);
    const to = Math.max(from + 1, Math.floor(((bar + 1) * length) / bars));
    let peak = 0;
    for (let index = from; index < to && index < length; index++)
      peak = Math.max(peak, clean(peaks[index]));
    out[bar] = peak;
  }
  return out;
}

/** How many bars of `pitch` px fit into `width` px (at least 8). */
export function waveBarCount(width: number, pitch = 4): number {
  return Math.max(8, Math.floor(width / pitch));
}

/** Seconds at a pointer position over an axis that is `width` px wide. */
export function timeAtX(x: number, width: number, total: number): number {
  if (!(width > 0) || !(total > 0)) return 0;
  return Math.max(0, Math.min(1, x / width)) * total;
}

/** 0..1 position of a slider value, for the filled part of its track. */
export function sliderRatio(value: number, min: number, max: number): number {
  if (!(max > min) || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}
