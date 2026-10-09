/**
 * Transport controls. Only the small components here follow the playhead:
 * the time text re-renders once per second, the progress line is moved
 * without rendering at all.
 */
import { memo, useEffect, useRef } from "react";
import type { Ref } from "react";
import {
  Pause,
  Play,
  Repeat,
  SkipBack,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { Player } from "../../player/usePlayer";
import { formatTime } from "../../state/format";
import { usePlaybackSelector } from "../hooks/usePlaybackSelector";
import { transportInView } from "../hooks/uiStores";
import { useRenderCount } from "../hooks/useRenderCount";
import { IconButton, classes } from "../primitives/Button";
import { Slider } from "../primitives/Controls";

export function PlayButton(props: {
  player: Player;
  testId: string;
  large?: boolean;
  /** where the tip goes; the main transport has the time axis right above it */
  tipSide?: "top" | "bottom";
  ref?: Ref<HTMLButtonElement>;
}) {
  const { player, large } = props;
  return (
    <button
      ref={props.ref}
      type="button"
      className={classes("play-btn", large && "play-btn-lg")}
      data-testid={props.testId}
      // a toggle: the name stays, aria-pressed carries the state
      aria-label="播放"
      aria-pressed={player.playing}
      data-tip={player.playing ? "暂停（空格）" : "播放（空格）"}
      data-tip-side={props.tipSide}
      disabled={!player.ready}
      onClick={() => player.toggle()}
    >
      {player.playing ? (
        <Pause size={large ? 20 : 16} aria-hidden />
      ) : (
        <Play size={large ? 20 : 16} aria-hidden />
      )}
    </button>
  );
}

/** "0:12 / 0:30"; renders once per second of playback. */
export function TimeText(props: {
  player: Player;
  testId: string;
  className?: string;
}) {
  const { player } = props;
  const now = usePlaybackSelector(player, formatTime);
  return (
    <span
      className={classes("tabular", props.className)}
      data-testid={props.testId}
    >
      {now} / {formatTime(player.duration)}
    </span>
  );
}

/** A thin progress line driven straight from the player's clock. */
export function ProgressLine(props: { player: Player; className?: string }) {
  const { player } = props;
  const fill = useRef<HTMLSpanElement>(null);
  const { subscribeTime, getTime, duration } = player;
  useEffect(() => {
    const paint = () => {
      const ratio = duration > 0 ? Math.min(1, getTime() / duration) : 0;
      if (fill.current) fill.current.style.transform = `scaleX(${ratio})`;
    };
    paint();
    return subscribeTime(paint);
  }, [subscribeTime, getTime, duration]);
  return (
    <span className={props.className} aria-hidden>
      <span ref={fill} />
    </span>
  );
}

/**
 * Tells the shell whether the main transport is on screen; the mini
 * transport appears whenever it is not.
 */
function useReportInView(ref: { current: HTMLElement | null }) {
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      transportInView.set(true);
      return () => transportInView.set(false);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) transportInView.set(entry.isIntersecting);
      },
      { threshold: 0.6 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      transportInView.set(false);
    };
  }, [ref]);
}

export const Transport = memo(function Transport(props: {
  player: Player;
  /** the work is a 循环片段: what the audition loop does by default */
  loopWork: boolean;
  /** 循环试听 on or off (remembered for works of this structure) */
  onLoop(loop: boolean): void;
  playRef?: Ref<HTMLButtonElement>;
}) {
  useRenderCount("Transport");
  const { player } = props;
  const row = useRef<HTMLDivElement>(null);
  useReportInView(row);
  const percent = Math.round(player.volume * 100);
  const VolumeIcon = percent === 0 ? VolumeX : percent < 50 ? Volume1 : Volume2;
  return (
    <div ref={row} className="transport" role="group" aria-label="播放控制">
      <div className="transport-main">
        <IconButton
          label="回到开头"
          data-testid="restart-button"
          data-tip-side="bottom"
          disabled={!player.ready}
          onClick={() => player.seek(0)}
        >
          <SkipBack size={18} aria-hidden />
        </IconButton>
        <PlayButton
          player={player}
          testId="play-button"
          large
          tipSide="bottom"
          ref={props.playRef}
        />
        <button
          type="button"
          className="loop-toggle"
          data-testid="loop-toggle"
          aria-pressed={player.loop}
          data-tip={
            props.loopWork
              ? "循环试听（L）· 循环片段默认开启，听首尾是否衔接；只影响试听"
              : "循环试听（L）· 完整结尾默认关闭，播到结尾停下；只影响试听"
          }
          data-tip-side="bottom"
          disabled={!player.ready}
          onClick={() => props.onLoop(!player.loop)}
        >
          <Repeat size={15} aria-hidden />
          <span>循环试听</span>
        </button>
      </div>
      <TimeText
        player={player}
        testId="time-display"
        className="transport-time"
      />
      <label
        className="transport-volume"
        data-tip="试听音量 · 不影响导出"
        data-tip-side="bottom"
      >
        <VolumeIcon size={16} aria-hidden />
        <span className="sr-only">试听音量</span>
        <Slider
          data-testid="volume-slider"
          value={percent}
          valueText={`${percent}%`}
          onValue={(value) => player.setVolume(value / 100)}
        />
      </label>
    </div>
  );
});
