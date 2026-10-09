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
  /** index of the bar the chord starts in, when known */
  bar?: number;
}

/** Width of a chord symbol's text; the strip measures the real glyphs. */
export type MeasureText = (symbol: string) => number;

/**
 * Width of a chord symbol set in the strip's 12 px type, when nothing can
 * measure it: capitals are wide, "m" wider still, small letters and digits
 * narrower, marks narrowest.
 */
export function estimateChordText(symbol: string): number {
  let width = 0;
  for (const char of symbol)
    width += /[A-Z#w]/.test(char)
      ? 7.8
      : char === "m"
        ? 10.4
        : /[a-z0-9♭♯]/.test(char)
          ? 6.6
          : /[/()+.\-°ø]/.test(char)
            ? 4.8
            : 9;
  return width;
}

/** What stands left of a label's text: the tick and its padding. */
const LABEL_INSET = 6;

/** Width a printed label takes from its chord's tick to the end of its text. */
export function chordLabelWidth(
  symbol: string,
  measure: MeasureText = estimateChordText,
): number {
  return Math.ceil(measure(symbol)) + LABEL_INSET;
}

export interface ChordMark {
  /** print the symbol */
  label: boolean;
  /** draw the tick that marks where the chord starts */
  tick: boolean;
}

/**
 * How to draw each chord when the strip is `width` px wide. A chord that
 * repeats the one before it is a continuation: no label, no tick. Every
 * other chord is labelled when its label fits — `gap` px clear of the labels
 * around it and inside the strip. Where not all of them fit, the chords that
 * open a bar come first: they are placed before the chords inside a bar, so
 * a change on the third beat never costs the next bar its name. A chord gets
 * a tick unless the tick would cut through a printed label. The returned
 * array is parallel to `chords`.
 */
export function chordLayout(
  chords: readonly ChordLike[],
  total: number,
  width: number,
  gap = 3,
  measure: MeasureText = estimateChordText,
): ChordMark[] {
  const marks = chords.map<ChordMark>(() => ({ label: false, tick: false }));
  if (!(total > 0) || !(width > 0)) return marks;
  const left = (index: number) => (chords[index].start / total) * width;
  const right = (index: number) =>
    left(index) + chordLabelWidth(chords[index].symbol, measure);
  /** chords that are drawn at all, in time order */
  const drawn: number[] = [];
  for (let index = 0; index < chords.length; index++)
    if (index === 0 || chords[index - 1].symbol !== chords[index].symbol)
      drawn.push(index);
  const opensBar = (index: number) =>
    chords[index].bar === undefined ||
    index === 0 ||
    chords[index - 1].bar !== chords[index].bar;
  /** printed labels, kept in time order */
  const printed: number[] = [];
  const place = (index: number) => {
    if (right(index) > width + 1) return;
    // the labels on either side of where this one would go
    let after = printed.findIndex((other) => other > index);
    if (after < 0) after = printed.length;
    const previous = printed[after - 1];
    const next = printed[after];
    if (previous !== undefined && left(index) + 0.5 < right(previous) + gap)
      return;
    if (next !== undefined && right(index) + gap > left(next) + 0.5) return;
    printed.splice(after, 0, index);
    marks[index].label = true;
  };
  for (const index of drawn) if (opensBar(index)) place(index);
  for (const index of drawn) if (!opensBar(index)) place(index);
  // ticks: wherever a chord starts, except inside a printed label
  let covered = Number.NEGATIVE_INFINITY;
  let cursor = 0;
  for (const index of drawn) {
    while (cursor < printed.length && printed[cursor] < index)
      covered = Math.max(covered, right(printed[cursor++]));
    marks[index].tick = marks[index].label || left(index) >= covered;
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
  measure: MeasureText = estimateChordText,
): { edge: boolean; hidden: Set<number> } {
  const hidden = new Set<number>();
  const chord = chords[current];
  if (!chord || !(total > 0) || !(width > 0)) return { edge: false, hidden };
  // the pill is the symbol in bold with padding on both sides
  const size = Math.ceil(measure(chord.symbol) * 1.08) + 12;
  const start = (chord.start / total) * width;
  const edge = start + size > width;
  const left = edge ? width - size : start;
  const right = left + size;
  for (let index = 0; index < chords.length; index++) {
    if (index === current || !marks[index]?.label) continue;
    const from = (chords[index].start / total) * width;
    const to = from + chordLabelWidth(chords[index].symbol, measure);
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
