/** CSS/SVG-only artwork: the logo mark, cover art, a small bar waveform. */
import type { CSSProperties, ReactNode } from "react";
import type { StyleId } from "../../music/catalog";
import { coverGradient } from "../../state/format";
import { classes } from "./Button";

export function LogoMark(props: { size?: number }) {
  const size = props.size ?? 32;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden
      focusable="false"
    >
      <rect width="32" height="32" rx="9" fill="#b8a3fa" />
      <path
        d="M9 19v-6M13.7 23V9M18.3 20.5v-9M23 17.5v-3"
        stroke="#1a1530"
        strokeWidth="2.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/** Cover art for a style: its two palette colours plus a sun and a ring. */
export function Cover(props: {
  mood: StyleId;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <span
      className={classes("cover", props.className)}
      style={{ background: coverGradient(props.mood), ...props.style }}
      aria-hidden={props.children ? undefined : true}
    >
      <span className="cover-shade" />
      {props.children}
    </span>
  );
}

/**
 * A row of mirrored bars from 0..1 peaks, as one SVG path. Takes its colour
 * from `currentColor` and stretches to the size of its box.
 */
export function PeakBars(props: {
  peaks: readonly number[];
  className?: string;
}) {
  const { peaks } = props;
  const count = peaks.length || 1;
  const pitch = 4;
  const height = 24;
  let path = "";
  for (let index = 0; index < peaks.length; index++) {
    const value = Number.isFinite(peaks[index]) ? peaks[index] : 0;
    const bar = Math.max(1.5, Math.min(1, Math.max(0, value)) * (height - 2));
    const x = index * pitch + 1;
    const y = (height - bar) / 2;
    path += `M${x} ${y.toFixed(2)}v${bar.toFixed(2)}`;
  }
  return (
    <svg
      className={props.className}
      viewBox={`0 0 ${count * pitch} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
      focusable="false"
    >
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
