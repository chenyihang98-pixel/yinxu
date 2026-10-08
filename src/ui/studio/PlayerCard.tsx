/**
 * The committed work: cover, editable title, what it is, save state,
 * favourite, export — then its time axis and the transport. Everything
 * here reads `project.config`, never the inspector draft.
 */
import { memo, useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Check,
  Download,
  Heart,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import type { Player } from "../../player/usePlayer";
import {
  engineBadge,
  fitNotice,
  metaLine,
  saveStateLabel,
} from "../../state/format";
import { MAX_TITLE_CHARS } from "../../state/logic";
import type {
  AppActions,
  LoadEvent,
  LoadedAudio,
  SaveState,
} from "../../state/types";
import type { Project } from "../../types";
import { useRenderCount } from "../hooks/useRenderCount";
import { Cover } from "../primitives/Art";
import { Button, IconButton, LinkButton } from "../primitives/Button";
import { Badge } from "../primitives/Controls";
import { Transport } from "./Transport";
import { ChordStrip, SectionBands, WaveformCanvas } from "./Waveform";

function SaveIndicator(props: { state: SaveState }) {
  const { state } = props;
  return (
    <span
      className="save-state"
      data-testid="save-state"
      data-state={state}
      role="status"
    >
      {state === "saving" ? (
        <LoaderCircle className="spin" size={13} aria-hidden />
      ) : state === "failed" ? (
        <TriangleAlert size={13} aria-hidden />
      ) : (
        <Check size={13} aria-hidden />
      )}
      {saveStateLabel(state)}
    </span>
  );
}

/** The title reads as text and edits in place; Enter or leaving it saves. */
function TitleInput(props: { project: Project; actions: AppActions }) {
  const { project, actions } = props;
  const [title, setTitle] = useState(project.title);
  useEffect(() => setTitle(project.title), [project.id, project.title]);
  const commit = () => {
    if (title.trim() === project.title) {
      setTitle(project.title);
      return;
    }
    void actions.rename(project.id, title).then((changed) => {
      if (!changed) setTitle(project.title);
    });
  };
  return (
    <input
      className="title-input"
      data-testid="work-title"
      aria-label="作品名称"
      data-tip="点击修改名称"
      maxLength={MAX_TITLE_CHARS}
      spellCheck={false}
      autoComplete="off"
      value={title}
      onChange={(event) => setTitle(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          const node = event.currentTarget;
          setTitle(project.title);
          event.stopPropagation();
          // after the re-render, so leaving the field saves nothing
          requestAnimationFrame(() => node.blur());
        }
      }}
    />
  );
}

export interface PlayerCardProps {
  project: Project;
  audio: LoadedAudio | null;
  audioError: string | null;
  saveState: SaveState;
  lastLoad: LoadEvent | null;
  /** the work this one was derived from, when it is still in the library */
  parent: Project | undefined;
  busy: boolean;
  player: Player;
  actions: AppActions;
}

/** What the card shows of a work — everything except its fader positions. */
function sameWork(before: Project, after: Project): boolean {
  if (before === after) return true;
  const a = before.config;
  const b = after.config;
  return (
    before.id === after.id &&
    before.title === after.title &&
    before.favorite === after.favorite &&
    before.revision === after.revision &&
    before.provider === after.provider &&
    before.audioBlob === after.audioBlob &&
    a.mood === b.mood &&
    a.bpm === b.bpm &&
    a.key === b.key &&
    a.instrument === b.instrument &&
    a.duration === b.duration &&
    a.loop === b.loop &&
    a.engine === b.engine
  );
}

/** A fader move replaces `project`; the card does not show the faders. */
function samePlayerProps(
  before: PlayerCardProps,
  after: PlayerCardProps,
): boolean {
  const keys = Object.keys(after) as (keyof PlayerCardProps)[];
  return keys.every((key) =>
    key === "project"
      ? sameWork(before.project, after.project)
      : Object.is(before[key], after[key]),
  );
}

export const PlayerCard = memo(function PlayerCard(props: PlayerCardProps) {
  useRenderCount("PlayerCard");
  const { project, audio, saveState, lastLoad, parent, player, actions } =
    props;
  const card = useRef<HTMLElement>(null);
  const play = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // A new or newly opened work: bring it into view and hand the keyboard
    // to the play button. A restored session leaves focus alone.
    if (!lastLoad || lastLoad.reason === "restored") return;
    card.current?.scrollIntoView({ block: "start", behavior: "auto" });
    play.current?.focus({ preventScroll: true });
  }, [lastLoad?.seq, lastLoad?.reason]);

  const arrangement = audio?.kind === "stems" ? audio.arrangement : undefined;
  const notice = fitNotice(
    project,
    audio ? { bpm: arrangement?.bpm, duration: audio.duration } : null,
  );
  const total = audio?.duration ?? 0;
  const legacy = project.provider === "local" && project.config.engine === 1;

  return (
    <section
      ref={card}
      className="card player-card"
      data-testid="player-card"
      data-audio={audio?.kind ?? "none"}
      data-duration={audio ? audio.duration.toFixed(3) : "0"}
      data-revision={project.revision}
      data-engine={project.config.engine}
      data-render-path={audio?.kind === "stems" ? audio.renderPath : undefined}
      data-project={project.id}
      aria-label="当前作品"
    >
      <header className="player-head">
        <Cover mood={project.config.mood} className="player-cover">
          <AudioLines size={22} aria-hidden />
        </Cover>
        <div className="player-id">
          <TitleInput project={project} actions={actions} />
          <p className="player-meta" data-testid="work-meta">
            <span className="player-meta-text">{metaLine(project)}</span>
            <Badge
              tone={legacy ? "warn" : "neutral"}
              testId="engine-badge"
              tip={
                legacy
                  ? "由 v0.2 的旧版引擎生成；再次生成会改用新版引擎"
                  : project.provider === "local"
                    ? "在这台设备上作曲与合成，不联网"
                    : "由云端服务生成的混合音轨"
              }
            >
              {engineBadge(project)}
            </Badge>
            <Badge tone="accent" testId="work-version">
              v{project.revision}
            </Badge>
            <SaveIndicator state={saveState} />
          </p>
          {parent && (
            <LinkButton
              className="player-parent"
              data-testid="work-parent"
              disabled={props.busy}
              onClick={() => void actions.openProject(parent.id)}
            >
              <span className="ellipsis">
                源自《{parent.title}》v{parent.revision}
              </span>
            </LinkButton>
          )}
        </div>
        <div className="player-actions">
          <IconButton
            outline
            label="收藏"
            tip={project.favorite ? "取消收藏" : "收藏"}
            pressed={project.favorite}
            data-testid="favourite-button"
            onClick={() => void actions.toggleFavourite(project.id)}
          >
            <Heart
              size={17}
              fill={project.favorite ? "currentColor" : "none"}
              aria-hidden
            />
          </IconButton>
          <Button
            data-testid="export-button"
            icon={<Download size={15} aria-hidden />}
            data-tip="导出（Ctrl+E）"
            onClick={() => actions.openModal("export")}
          >
            导出
          </Button>
        </div>
      </header>

      {props.audioError && (
        <p className="notice notice-danger" role="alert" data-testid="audio-error">
          <TriangleAlert size={16} aria-hidden />
          <span>{props.audioError}</span>
        </p>
      )}

      {audio && (
        <>
          <div className="timeline">
            {arrangement && (
              <SectionBands
                player={player}
                sections={arrangement.sections}
                total={total}
              />
            )}
            <WaveformCanvas
              player={player}
              peaks={audio.peaks}
              sections={arrangement?.sections}
              chords={arrangement?.chords}
            />
            {arrangement && (
              <ChordStrip
                player={player}
                chords={arrangement.chords}
                total={total}
              />
            )}
          </div>
          <Transport player={player} playRef={play} />
        </>
      )}

      {notice && (
        <p className="player-notice" data-testid="fit-notice">
          {notice}
        </p>
      )}
    </section>
  );
}, samePlayerProps);
