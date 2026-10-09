/**
 * The time axis of the player card: section bands, a canvas waveform with
 * the playhead, and the chord strip. The canvas is painted straight from
 * the player's clock (no React render per tick); the bands and chords
 * re-render only when the current section or chord changes.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import type { ArrangementSummary } from "../../music/score";
import type { Player } from "../../player/usePlayer";
import { formatTime } from "../../state/format";
import { SEEK_STEP_SECONDS } from "../../state/shortcuts";
import { useElementWidth } from "../hooks/useElementWidth";
import { usePlaybackSelector } from "../hooks/usePlaybackSelector";
import { useRenderCount } from "../hooks/useRenderCount";
import {
  chordLayout,
  chordPill,
  percentAt,
  resamplePeaks,
  spanIndexAt,
  timeAtX,
  waveBarCount,
} from "../logic/timeline";

type Sections = ArrangementSummary["sections"];
type Chords = ArrangementSummary["chords"];

/* ---------------- section bands ---------------- */

export const SectionBands = memo(function SectionBands(props: {
  player: Player;
  sections: Sections;
  total: number;
}) {
  useRenderCount("SectionBands");
  const { player, sections, total } = props;
  const current = usePlaybackSelector(player, (time) =>
    spanIndexAt(sections, time),
  );
  if (!sections.length) return null;
  return (
    <div className="bands" role="group" aria-label="段落（点击跳到段落开头）">
      {sections.map((section, index) => (
        <button
          key={`${section.startBar}-${section.type}`}
          type="button"
          className="band"
          data-testid="section-band"
          data-type={section.type}
          aria-current={index === current ? "true" : undefined}
          aria-label={`${section.label}，从 ${formatTime(section.start)} 开始`}
          data-tip={`${section.label} · ${formatTime(section.start)}–${formatTime(section.end)} · ${section.bars} 小节`}
          style={{
            left: `${percentAt(section.start, total)}%`,
            width: `${percentAt(section.end - section.start, total)}%`,
          }}
          disabled={!player.ready}
          onClick={() => player.seek(section.start)}
        >
          <span>{section.label}</span>
        </button>
      ))}
    </div>
  );
});

/* ---------------- chord strip ---------------- */

export const ChordStrip = memo(function ChordStrip(props: {
  player: Player;
  chords: Chords;
  total: number;
}) {
  useRenderCount("ChordStrip");
  const { player, chords, total } = props;
  const strip = useRef<HTMLDivElement>(null);
  const width = useElementWidth(strip);
  const marks = useMemo(
    () => chordLayout(chords, total, width),
    [chords, total, width],
  );
  const current = usePlaybackSelector(player, (time) =>
    spanIndexAt(chords, time),
  );
  const pill = useMemo(
    () => chordPill(chords, marks, current, total, width),
    [chords, marks, current, total, width],
  );
  if (!chords.length) return null;
  return (
    <div
      ref={strip}
      className="chords"
      data-testid="chord-strip"
      role="group"
      aria-label="和弦进行"
    >
      {chords.map((chord, index) => {
        const here = index === current;
        const mark = marks[index];
        const shown = here || (mark?.label && !pill.hidden.has(index));
        return (
          <span
            key={`${chord.bar}-${chord.start}`}
            className="chord"
            data-current={here || undefined}
            data-shown={shown || undefined}
            data-tick={mark?.tick || undefined}
            data-edge={(here && pill.edge) || undefined}
            aria-current={here ? "true" : undefined}
            data-tip={`${chord.symbol} · ${chord.roman} · 第 ${chord.bar + 1} 小节`}
            style={{
              left: `${percentAt(chord.start, total)}%`,
              width: `${percentAt(chord.end - chord.start, total)}%`,
            }}
          >
            {chord.symbol}
          </span>
        );
      })}
    </div>
  );
});

/* ---------------- waveform ---------------- */

interface Palette {
  idle: string;
  played: string;
  head: string;
  mark: string;
}

function readPalette(node: Element): Palette {
  const style = getComputedStyle(node);
  const read = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    idle: read("--wave-idle", "#4b4c59"),
    played: read("--wave-played", "#b8a3fa"),
    head: read("--wave-head", "#f4f0ff"),
    mark: read("--border-strong", "#3c3d46"),
  };
}

interface Geometry {
  width: number;
  height: number;
  ratio: number;
  bars: Path2D;
}

const BAR_PITCH = 4;
const BAR_WIDTH = 2.4;

function buildBars(peaks: readonly number[], width: number, height: number) {
  const count = waveBarCount(width, BAR_PITCH);
  const values = resamplePeaks(peaks, count);
  const pitch = width / count;
  const path = new Path2D();
  const middle = height / 2;
  for (let index = 0; index < count; index++) {
    const bar = Math.max(2, values[index] * (height - 6));
    const x = index * pitch + (pitch - BAR_WIDTH) / 2;
    const y = middle - bar / 2;
    if (typeof path.roundRect === "function")
      path.roundRect(x, y, BAR_WIDTH, bar, BAR_WIDTH / 2);
    else path.rect(x, y, BAR_WIDTH, bar);
  }
  return path;
}

export const WaveformCanvas = memo(function WaveformCanvas(props: {
  player: Player;
  peaks: readonly number[];
  sections?: Sections;
  chords?: Chords;
}) {
  useRenderCount("WaveformCanvas");
  const { player, peaks, sections, chords } = props;
  const { duration, ready, seek, getTime, subscribeTime } = player;
  const canvas = useRef<HTMLCanvasElement>(null);
  const geometry = useRef<Geometry | null>(null);
  const hover = useRef<number | null>(null);
  const paintRef = useRef<() => void>(() => {});
  const [tip, setTip] = useState<{ x: number; text: string } | null>(null);

  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const context = node.getContext("2d");
    if (!context) return;
    let palette = readPalette(node);
    let lastSecond = -1;

    const measure = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      if (!width || !height) {
        geometry.current = null;
        return;
      }
      const ratio = Math.min(3, window.devicePixelRatio || 1);
      node.width = Math.round(width * ratio);
      node.height = Math.round(height * ratio);
      palette = readPalette(node);
      geometry.current = {
        width,
        height,
        ratio,
        bars: buildBars(peaks, width, height),
      };
    };

    const paint = () => {
      const shape = geometry.current;
      const time = getTime();
      const second = Math.round(time);
      if (second !== lastSecond) {
        // Kept on the element itself: assistive tech reads it on demand.
        lastSecond = second;
        node.setAttribute("aria-valuenow", String(second));
        node.setAttribute(
          "aria-valuetext",
          `${formatTime(time)} / ${formatTime(duration)}`,
        );
      }
      if (!shape) return;
      const { width, height, ratio, bars } = shape;
      const played = duration > 0 ? Math.min(1, time / duration) * width : 0;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      // faint section boundaries tie the bands above to the waveform
      if (sections && duration > 0) {
        context.fillStyle = palette.mark;
        for (const section of sections.slice(1)) {
          const x = Math.round((section.start / duration) * width);
          context.fillRect(x, 0, 1, height);
        }
      }

      context.fillStyle = palette.idle;
      context.fill(bars);
      if (played > 0) {
        context.save();
        context.beginPath();
        context.rect(0, 0, played, height);
        context.clip();
        context.fillStyle = palette.played;
        context.fill(bars);
        context.restore();
      }

      const at = hover.current;
      if (at !== null) {
        context.fillStyle = "rgba(244, 240, 255, 0.4)";
        context.fillRect(Math.round(at), 0, 1, height);
      }
      if (ready) {
        const x = Math.max(1, Math.min(width - 1, played));
        context.fillStyle = palette.head;
        context.fillRect(x - 1, 0, 2, height);
      }
    };

    paintRef.current = paint;
    measure();
    paint();
    const unsubscribe = subscribeTime(paint);
    const resized = () => {
      measure();
      paint();
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(resized);
    observer?.observe(node);
    window.addEventListener("resize", resized);
    return () => {
      unsubscribe();
      observer?.disconnect();
      window.removeEventListener("resize", resized);
    };
  }, [peaks, sections, duration, ready, getTime, subscribeTime]);

  const describe = (time: number): string => {
    const parts = [formatTime(time)];
    const section = sections?.[spanIndexAt(sections, time)];
    if (section) parts.push(section.label);
    const chord = chords?.[spanIndexAt(chords, time)];
    if (chord) parts.push(chord.symbol);
    return parts.join(" · ");
  };

  const position = (event: PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(box.width, event.clientX - box.left));
    return { x, time: timeAtX(x, box.width, duration) };
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!ready) return;
    const { x, time } = position(event);
    if (event.buttons & 1) seek(time);
    if (event.pointerType !== "touch" || event.buttons & 1) {
      hover.current = x;
      setTip({ x, text: describe(time) });
      paintRef.current();
    }
  };

  const clearHover = () => {
    hover.current = null;
    setTip(null);
    paintRef.current();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (!ready || event.ctrlKey || event.metaKey || event.altKey) return;
    const time = getTime();
    const step = event.shiftKey ? 1 : SEEK_STEP_SECONDS;
    const moves: Record<string, number> = {
      ArrowLeft: time - step,
      ArrowDown: time - step,
      ArrowRight: time + step,
      ArrowUp: time + step,
      PageDown: time - duration / 10,
      PageUp: time + duration / 10,
      Home: 0,
      End: duration,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    event.stopPropagation();
    seek(Math.max(0, Math.min(duration, moves[event.key])));
  };

  return (
    <div className="wave">
      <canvas
        ref={canvas}
        className="wave-canvas"
        data-testid="waveform"
        role="slider"
        tabIndex={ready ? 0 : -1}
        aria-label="播放位置"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={0}
        aria-disabled={!ready || undefined}
        onPointerDown={(event) => {
          if (!ready || event.button !== 0) return;
          try {
            // keeps the scrub going when the pointer leaves the canvas
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            /* a pointer that is already gone: the click still seeks */
          }
          const { x, time } = position(event);
          seek(time);
          hover.current = x;
          setTip({ x, text: describe(time) });
        }}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => {
          if (event.pointerType === "touch") clearHover();
        }}
        onPointerLeave={clearHover}
        onPointerCancel={clearHover}
        onKeyDown={onKeyDown}
      />
      {tip && (
        <span
          className="wave-tip tabular"
          aria-hidden
          style={{ "--x": `${tip.x}px` } as CSSProperties}
        >
          {tip.text}
        </span>
      )}
    </div>
  );
});
