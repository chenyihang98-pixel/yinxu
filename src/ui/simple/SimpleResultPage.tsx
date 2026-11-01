/**
 * 简单模式 with a piece: what it is (cover, a title one can change, one plain
 * line), a big player, 下载音乐 · 换一首 · 重新挑, one-tap tweaks that are
 * fixed sentences for the producer, a box to say it in one's own words, and
 * — after each change — what changed, with 撤销. Nothing here names a tempo,
 * a key, a version number or an engine.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Music,
  Pause,
  Play,
  RefreshCw,
  Send,
  Shuffle,
  Undo2,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { Player } from "../../player/usePlayer";
import { useApp } from "../../state/context";
import {
  FALLBACK_NOTE,
  UNDONE_LINE,
  changeLine,
  drumsHeard,
  newPieceLine,
  plainSummary,
  plainWords,
} from "../../state/plain";
import { activeBrain } from "../../state/options";
import { tweaksFor } from "../../state/scenes";
import type { AppActions, LoadedAudio } from "../../state/types";
import { lineage } from "../../state/works";
import type { Project } from "../../types";
import { useRenderCount } from "../hooks/useRenderCount";
import { sameListing, useStableList } from "../hooks/useStable";
import { Cover } from "../primitives/Art";
import { Button, LinkButton } from "../primitives/Button";
import { Slider } from "../primitives/Controls";
import { TitleInput } from "../studio/PlayerCard";
import { TimeText } from "../studio/Transport";
import { WaveformCanvas } from "../studio/Waveform";
import {
  LLM_HINT,
  PlainLine,
  ProLink,
  SimpleFailure,
  SimpleProgress,
  attempt,
} from "./parts";

/** A big play button, the waveform (click to jump), the time and the volume. */
const SimplePlayer = memo(function SimplePlayer(props: {
  player: Player;
  audio: LoadedAudio;
  playRef: { current: HTMLButtonElement | null };
}) {
  useRenderCount("SimplePlayer");
  const { player, audio } = props;
  const percent = Math.round(player.volume * 100);
  const VolumeIcon = percent === 0 ? VolumeX : percent < 50 ? Volume1 : Volume2;
  return (
    <div className="simple-player" role="group" aria-label="播放">
      <button
        ref={props.playRef}
        type="button"
        className="simple-play"
        data-testid="simple-play"
        aria-label="播放"
        aria-pressed={player.playing}
        disabled={!player.ready}
        onClick={() => player.toggle()}
      >
        {player.playing ? (
          <Pause size={28} aria-hidden />
        ) : (
          <Play size={28} aria-hidden />
        )}
      </button>
      <div className="simple-track">
        <WaveformCanvas player={player} peaks={audio.peaks} />
        <div className="simple-track-foot">
          <TimeText
            player={player}
            testId="simple-time"
            className="simple-time"
          />
          <label className="simple-volume">
            <VolumeIcon size={18} aria-hidden />
            <span className="sr-only">音量</span>
            <Slider
              data-testid="simple-volume"
              value={percent}
              valueText={`${percent}%`}
              onValue={(value) => player.setVolume(value / 100)}
            />
          </label>
        </div>
      </div>
    </div>
  );
});

function VersionNav(props: {
  older: Project | undefined;
  newer: Project | undefined;
  disabled: boolean;
  actions: AppActions;
}) {
  const { older, newer, actions } = props;
  if (!older && !newer) return null;
  return (
    <nav className="simple-versions" aria-label="其他版本">
      {older && (
        <LinkButton
          data-testid="simple-prev"
          disabled={props.disabled}
          onClick={() => void actions.openProject(older.id, { choose: true })}
        >
          <ChevronLeft size={15} aria-hidden />
          上一版
        </LinkButton>
      )}
      {newer && (
        <LinkButton
          data-testid="simple-next"
          disabled={props.disabled}
          onClick={() => void actions.openProject(newer.id, { choose: true })}
        >
          下一版
          <ChevronRight size={15} aria-hidden />
        </LinkButton>
      )}
    </nav>
  );
}

export function SimpleResultPage() {
  useRenderCount("SimpleResultPage");
  const { studio, library, player, ui, platform, actions } = useApp();
  const { project, audio, job, lastLoad } = studio;
  const page = useRef<HTMLDivElement>(null);
  const play = useRef<HTMLButtonElement>(null);
  const listed = useStableList(library.projects, sameListing);
  const locked = studio.busy || ui.dialog !== null;

  useEffect(() => {
    // A piece that was just made or opened: from the top, with the keyboard
    // on 播放. A restored session leaves focus alone.
    if (!lastLoad || lastLoad.reason === "restored") return;
    page.current?.scrollTo({ top: 0 });
    play.current?.focus({ preventScroll: true });
  }, [lastLoad?.seq, lastLoad?.reason]);

  const id = project?.id;
  const versions = useMemo(
    () => (project ? lineage(project, listed).versions : []),
    // the versions of a piece do not change when its title does
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, project?.revision, listed],
  );
  const parent = project?.parentId
    ? listed.find((item) => item.id === project.parentId)
    : undefined;
  const seconds = audio?.duration;
  const generated = lastLoad?.reason === "generated";
  // The reply the version came with: did the language model fail?
  const lastTurn = project?.chat?.at(-1)?.id;
  const fellBack =
    generated && !!lastTurn && !!studio.turnNotes[lastTurn]?.fallbackReason;
  const saved = studio.saveState !== "failed";
  const line = useMemo(() => {
    if (!project || !generated) return null;
    if (parent) return changeLine(parent, project, seconds);
    return project.parentId ? null : newPieceLine(saved);
    // what changed is about the music, not the title
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generated, id, parent?.id, seconds, saved]);
  // 撤销 went back to this version: say so where the change line was.
  const [undone, setUndone] = useState<{ id: string; seq: number } | null>(
    null,
  );
  const wasUndone =
    !!undone &&
    undone.id === id &&
    lastLoad?.reason === "opened" &&
    lastLoad.seq === undone.seq;
  // 下载音乐 says it was saved on the button itself: a toast would cover
  // the buttons below it.
  const [downloaded, setDownloaded] = useState<string | null>(null);
  useEffect(() => {
    if (!downloaded) return;
    const timer = setTimeout(() => setDownloaded(null), 4000);
    return () => clearTimeout(timer);
  }, [downloaded]);
  const drums = useMemo(
    () => (project ? drumsHeard(project, audio) : false),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, audio],
  );
  if (!project) return null;

  const index = versions.findIndex((item) => item.id === project.id);
  const older = index >= 0 ? versions[index + 1] : undefined;
  const newer = index > 0 ? versions[index - 1] : undefined;
  const cloud = project.provider !== "local";
  const tweaks = tweaksFor(project.config, drums);
  const text = studio.composerText;
  const say = () => {
    if (locked || !text.trim()) return;
    void attempt(() => actions.send());
  };
  const downloadable = cloud ? !!project.audioBlob : !!audio;
  const download = () => {
    const piece = project.id;
    void actions.downloadMusic(undefined, { quiet: true }).then((ok) => {
      if (ok) setDownloaded(piece);
    });
  };
  const undo = (to: Project) => {
    setUndone({ id: to.id, seq: (lastLoad?.seq ?? 0) + 1 });
    void actions.openProject(to.id, { choose: true });
  };
  // One line under the player: what this tap did, or why it did nothing.
  const message = studio.notice
    ? { text: studio.notice, kind: "notice" as const }
    : line
      ? {
          text: fellBack ? `${line}${FALLBACK_NOTE}` : line,
          kind: "change" as const,
        }
      : wasUndone
        ? { text: UNDONE_LINE, kind: "undone" as const }
        : null;

  return (
    <div
      ref={page}
      className="page simple-page"
      data-testid="simple-result"
      data-project={project.id}
      data-revision={project.revision}
      data-audio={audio?.kind ?? "none"}
      data-duration={audio ? audio.duration.toFixed(3) : "0"}
    >
      <div className="page-inner simple-inner simple-result">
        <h1 className="sr-only">{project.title}</h1>
        <section className="simple-work" aria-label="这首音乐">
          <header className="simple-work-head">
            <Cover mood={project.config.mood} className="simple-cover">
              <Music size={26} aria-hidden />
            </Cover>
            <div className="simple-work-id">
              <TitleInput
                project={project}
                actions={actions}
                testId="simple-title"
                className="title-input simple-title"
              />
              <p className="simple-summary" data-testid="simple-summary">
                <PlainLine text={plainSummary(project, audio?.duration)} />
              </p>
              <VersionNav
                older={older}
                newer={newer}
                disabled={locked}
                actions={actions}
              />
            </div>
          </header>
          {studio.audioError && (
            <p className="notice notice-danger" role="alert">
              {plainWords(studio.audioError)}
            </p>
          )}
          {audio && (
            <SimplePlayer player={player} audio={audio} playRef={play} />
          )}
        </section>

        {message && (
          <p
            className="simple-change"
            data-testid="simple-change"
            data-kind={message.kind}
            role="status"
          >
            <span className="grow">{message.text}</span>
            {message.kind === "change" && parent && (
              <Button
                size="sm"
                data-testid="simple-undo"
                icon={<Undo2 size={14} aria-hidden />}
                disabled={locked}
                onClick={() => undo(parent)}
              >
                撤销
              </Button>
            )}
          </p>
        )}

        {job ? (
          <SimpleProgress job={job} actions={actions} />
        ) : (
          <>
            {studio.failure && (
              <SimpleFailure
                busy={locked}
                message={studio.failure}
                cloud={studio.provider !== "local"}
              />
            )}
            <div className="simple-actions">
              <Button
                variant="primary"
                size="lg"
                className="simple-download"
                data-testid="simple-download"
                icon={
                  downloaded === project.id ? (
                    <Check size={18} aria-hidden />
                  ) : (
                    <Download size={18} aria-hidden />
                  )
                }
                data-done={downloaded === project.id || undefined}
                busy={studio.exporting}
                disabled={!downloadable || studio.exporting}
                onClick={download}
              >
                {downloaded === project.id
                  ? platform.isDesktop
                    ? "已保存"
                    : "已开始下载"
                  : "下载音乐"}
              </Button>
              <Button
                size="lg"
                data-testid="simple-another"
                icon={<Shuffle size={17} aria-hidden />}
                disabled={locked}
                onClick={() => void attempt(() => actions.variation())}
              >
                换一首
              </Button>
              <Button
                size="lg"
                data-testid="simple-restart"
                icon={<RefreshCw size={17} aria-hidden />}
                disabled={locked}
                onClick={() => actions.newPiece()}
              >
                重新挑
              </Button>
            </div>

            <section
              className="simple-tweaks"
              aria-labelledby="simple-tweaks-title"
            >
              <h2 id="simple-tweaks-title" className="simple-section-title">
                觉得哪里不对？点一下就改
              </h2>
              {cloud && (
                <p className="simple-paid" data-testid="simple-paid">
                  这首是 AI
                  服务做的：每次修改都会重新付费生成一首，点之前会先问你。
                </p>
              )}
              <ul className="tweak-grid">
                {tweaks.map((tweak) => (
                  <li key={tweak.id}>
                    <button
                      type="button"
                      className="tweak"
                      data-testid={`tweak-${tweak.id}`}
                      disabled={locked}
                      onClick={() =>
                        void attempt(() => actions.tweak(tweak.id))
                      }
                    >
                      {tweak.label}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="simple-say">
                <input
                  className="simple-input"
                  data-testid="simple-say-input"
                  type="text"
                  aria-label="想怎么改"
                  autoComplete="off"
                  maxLength={1500}
                  placeholder="也可以直接说想怎么改，比如：鼓声小一点"
                  value={text}
                  disabled={locked}
                  onChange={(event) =>
                    actions.setComposerText(event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.nativeEvent.isComposing)
                      return;
                    event.preventDefault();
                    say();
                  }}
                />
                <Button
                  size="lg"
                  variant={text.trim() ? "primary" : "secondary"}
                  data-testid="simple-say-send"
                  icon={<Send size={16} aria-hidden />}
                  disabled={locked || !text.trim()}
                  onClick={say}
                >
                  发送
                </Button>
              </div>
              {activeBrain(studio.brain, studio.brains) === "llm" && (
                <p className="simple-hint" data-testid="simple-llm-hint">
                  {LLM_HINT}
                </p>
              )}
            </section>
          </>
        )}

        <ProLink actions={actions} />
      </div>
    </div>
  );
}
