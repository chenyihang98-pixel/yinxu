/**
 * 简单模式 with a piece: what it is (cover, a title one can change, one plain
 * line), a big player, 下载音乐 · 换一首 · 重新挑, one-tap tweaks that are
 * fixed sentences for the producer, a box to say it in one's own words, and
 * — after each change — what changed, with 撤销. Nothing here names a tempo,
 * a key, a version number or an engine.
 */
import { memo, useEffect, useMemo, useRef } from "react";
import {
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
import { changeLine, newPieceLine, plainSummary } from "../../state/plain";
import { downloadRequest, tweaksFor } from "../../state/scenes";
import { scoreFacts, silentStem } from "../../state/score";
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

/** Drums one can hear in this piece: 去掉鼓 or 加点鼓. */
function hasDrums(project: Project, audio: LoadedAudio | null): boolean {
  const { config } = project;
  if (!(config.volumes.drums > 0)) return false;
  if (project.provider !== "local") return true;
  if (config.arrangement?.drums === "none") return false;
  if (audio?.kind === "stems") return !silentStem(audio.stemPeaks?.drums);
  return scoreFacts(config)?.playing.drums ?? true;
}

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
          onClick={() => void actions.openProject(older.id)}
        >
          <ChevronLeft size={15} aria-hidden />
          上一版
        </LinkButton>
      )}
      {newer && (
        <LinkButton
          data-testid="simple-next"
          disabled={props.disabled}
          onClick={() => void actions.openProject(newer.id)}
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
  const { studio, library, player, ui, actions } = useApp();
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
  const line = useMemo(() => {
    if (!project || !generated) return null;
    if (parent) return changeLine(parent, project, seconds);
    return project.parentId ? null : newPieceLine(project, seconds);
    // what changed is about the music, not the title
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generated, id, parent?.id, seconds]);
  const drums = useMemo(
    () => (project ? hasDrums(project, audio) : false),
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
              {studio.audioError}
            </p>
          )}
          {audio && (
            <SimplePlayer player={player} audio={audio} playRef={play} />
          )}
        </section>

        {line && (
          <p className="simple-change" data-testid="simple-change">
            <span className="grow">{line}</span>
            {parent && (
              <Button
                size="sm"
                data-testid="simple-undo"
                icon={<Undo2 size={14} aria-hidden />}
                disabled={locked}
                onClick={() => void actions.openProject(parent.id)}
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
            {studio.failure && <SimpleFailure busy={locked} />}
            <div className="simple-actions">
              <Button
                variant="primary"
                size="lg"
                className="simple-download"
                data-testid="simple-download"
                icon={<Download size={18} aria-hidden />}
                busy={studio.exporting}
                disabled={!downloadable || studio.exporting}
                onClick={() =>
                  void actions.exportWork(downloadRequest(project))
                }
              >
                下载音乐
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
                        void attempt(() => actions.send(tweak.phrase))
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
            </section>
          </>
        )}

        <ProLink actions={actions} />
      </div>
    </div>
  );
}
