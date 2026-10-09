/**
 * 混音: four groups, each with its instruments, the stem's own waveform, a
 * fader and M / S. Faders write the committed volumes (heard at once, saved
 * a moment later); solo is for listening only.
 */
import { memo, useMemo } from "react";
import type { CSSProperties } from "react";
import { Drum, Guitar, Layers, Music2, SlidersHorizontal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { TRACKS } from "../../music/score";
import { STEM_LABELS } from "../../services/exporter";
import { percent } from "../../state/format";
import { silentStem } from "../../state/score";
import type { AppActions, LoadedAudio } from "../../state/types";
import type { Project, TrackName } from "../../types";
import { useRenderCount } from "../hooks/useRenderCount";
import { stemInstruments } from "../logic/instruments";
import { PeakBars } from "../primitives/Art";
import { Slider } from "../primitives/Controls";

const TRACK_ICONS: Record<TrackName, LucideIcon> = {
  melody: Music2,
  chords: Layers,
  bass: Guitar,
  drums: Drum,
};

const MixerRow = memo(function MixerRow(props: {
  track: TrackName;
  value: number;
  soloed: boolean;
  /** another group is soloed: this one is not heard */
  masked: boolean;
  peaks: readonly number[];
  instruments: readonly string[];
  /** the stem is silent: nothing was written for this group in this version */
  silent: boolean;
  actions: AppActions;
}) {
  const { track, value, soloed, masked, actions } = props;
  const label = STEM_LABELS[track];
  const muted = value <= 0;
  const shown = Math.round(value * 100);
  const Icon = TRACK_ICONS[track];
  return (
    <li
      className="mix-row"
      data-testid={`mixer-${track}`}
      data-track={track}
      data-quiet={muted || masked || props.silent || undefined}
      data-silent={props.silent || undefined}
      style={{ "--track": `var(--track-${track})` } as CSSProperties}
    >
      <span className="mix-icon" aria-hidden>
        <Icon size={16} />
      </span>
      <div className="mix-name">
        <strong>{label}</strong>
        <span
          className="ellipsis"
          data-testid={`mixer-${track}-instruments`}
          data-tip={
            props.silent
              ? `这一版的编曲没有写${label}，推子暂时不起作用`
              : props.instruments.length > 1
                ? props.instruments.join(" · ")
                : undefined
          }
        >
          {props.silent
            ? "这一版没有用到"
            : props.instruments.length
              ? props.instruments.join(" · ")
              : " "}
        </span>
      </div>
      <PeakBars peaks={props.peaks} className="mix-wave" />
      <Slider
        className="mix-fader"
        data-testid={`mixer-${track}-fader`}
        aria-label={`${label}音量`}
        value={shown}
        valueText={muted ? "静音" : percent(value)}
        color={`var(--track-${track})`}
        onValue={(next) => actions.setVolume(track, next / 100)}
        onPointerUp={() => actions.commitMix()}
        onKeyUp={() => actions.commitMix()}
        onBlur={() => actions.commitMix()}
      />
      <output className="mix-value tabular" aria-hidden>
        {shown}
      </output>
      <button
        type="button"
        className="mix-toggle"
        data-testid={`mixer-${track}-mute`}
        data-kind="mute"
        aria-label={`${label}静音`}
        aria-pressed={muted}
        data-tip={muted ? "取消静音" : "静音（会保存到作品）"}
        onClick={() => actions.toggleMute(track)}
      >
        M
      </button>
      <button
        type="button"
        className="mix-toggle"
        data-testid={`mixer-${track}-solo`}
        data-kind="solo"
        aria-label={`${label}独奏`}
        aria-pressed={soloed}
        data-tip={soloed ? "取消独奏" : "独奏（只影响试听）"}
        onClick={() => actions.toggleSolo(track)}
      >
        S
      </button>
    </li>
  );
});

export interface MixerProps {
  project: Project;
  audio: LoadedAudio;
  solo: TrackName | null;
  actions: AppActions;
}

export const Mixer = memo(function Mixer(props: MixerProps) {
  useRenderCount("Mixer");
  const { project, audio, solo, actions } = props;
  const { config } = project;
  const arrangement = audio.kind === "stems" ? audio.arrangement : undefined;
  // Composing is deterministic; the grouping only changes with the piece.
  const instruments = useMemo(
    () => stemInstruments(config, arrangement),
    // keyed on the work: volumes are part of `config` but not of who plays
    [project.id, arrangement],
  );

  if (audio.kind !== "stems")
    return (
      <section className="card mixer-card" aria-label="混音">
        <p className="mixer-note">
          <SlidersHorizontal size={16} aria-hidden />
          <span>
            <span data-testid="mixer-note">
              云端生成的是混合音轨，不能分轨调整。
            </span>
            <span className="muted">
              可以继续用对话或「声音微调」生成新版本。
            </span>
          </span>
        </p>
      </section>
    );

  return (
    <section className="card mixer-card" aria-labelledby="mixer-title">
      <div className="card-head">
        <h2 id="mixer-title">
          <SlidersHorizontal size={16} aria-hidden />
          混音
        </h2>
        <span className="card-note grow">
          {solo
            ? `正在独奏「${STEM_LABELS[solo]}」· 只影响试听，导出仍是完整混音`
            : "推子即时生效并自动保存"}
        </span>
      </div>
      <ul className="mix-rows">
        {TRACKS.map((track) => (
          <MixerRow
            key={track}
            track={track}
            value={config.volumes[track]}
            soloed={solo === track}
            masked={solo !== null && solo !== track}
            peaks={audio.stemPeaks[track]}
            instruments={instruments[track]}
            // Told by the audio itself, not by a list of names: a group is
            // unused only when its stem is silent.
            silent={silentStem(audio.stemPeaks[track])}
            actions={actions}
          />
        ))}
      </ul>
    </section>
  );
});
