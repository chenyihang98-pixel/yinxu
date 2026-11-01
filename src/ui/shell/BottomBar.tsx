/**
 * The bar at the bottom of every page: the running job (phase, progress,
 * 取消) and — when a work is loaded and its transport is not on screen — a
 * mini transport.
 */
import { memo, useEffect, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { styleLabel } from "../../music/catalog";
import type { Player } from "../../player/usePlayer";
import { formatTime } from "../../state/format";
import { plainPhase, plainSummary } from "../../state/plain";
import type { AppActions, Job } from "../../state/types";
import type { Project } from "../../types";
import { useRenderCount } from "../hooks/useRenderCount";
import { Cover } from "../primitives/Art";
import { Button, IconButton } from "../primitives/Button";
import { Progress } from "../primitives/Controls";
import { PlayButton, ProgressLine, TimeText } from "../studio/Transport";

/** Seconds since the job started, for waits of unknown length. */
function Elapsed(props: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="jobbar-extra">
      已等待 {formatTime(Math.max(0, (now - props.since) / 1000))}
    </span>
  );
}

function JobBar(props: { job: Job; simple: boolean; onCancel(): void }) {
  const { job } = props;
  const percent = job.progress === null ? null : Math.round(job.progress * 100);
  const phase = props.simple ? plainPhase(job) : job.phase;
  return (
    <div
      className="jobbar"
      data-testid="job-status"
      data-kind={job.kind}
      data-stage={job.stage}
    >
      <LoaderCircle className="spin jobbar-icon" size={18} aria-hidden />
      <div className="jobbar-text">
        <div className="jobbar-line">
          <span className="jobbar-phase" data-testid="job-phase">
            {phase}
          </span>
          {percent !== null ? (
            <span className="jobbar-extra">{percent}%</span>
          ) : (
            job.stage !== "cancelling" && <Elapsed since={job.startedAt} />
          )}
        </div>
        <Progress value={job.progress} label={phase} testId="job-progress" />
      </div>
      <Button
        size="sm"
        data-testid="job-cancel"
        disabled={!job.cancellable}
        onClick={props.onCancel}
      >
        取消
      </Button>
    </div>
  );
}

export interface BottomBarProps {
  job: Job | null;
  /** the loaded work when the mini transport should show, else null */
  mini: Project | null;
  player: Player;
  /** 简单模式: plain words, no version, 下载 saves the piece at once */
  simple?: boolean;
  actions: AppActions;
}

export const BottomBar = memo(function BottomBar(props: BottomBarProps) {
  useRenderCount("BottomBar");
  const { job, mini, player, actions } = props;
  const simple = props.simple === true;
  if (!job && !mini) return null;
  return (
    <footer className="bottom-bar" aria-label={job ? "任务进度" : "播放控制"}>
      {mini && player.ready && (
        <ProgressLine player={player} className="bar-progress" />
      )}
      {job ? (
        <>
          {mini && <PlayButton player={player} testId="mini-play" />}
          <JobBar job={job} simple={simple} onCancel={actions.cancelJob} />
        </>
      ) : (
        mini && (
          <div className="mini" data-testid="mini-transport">
            <PlayButton player={player} testId="mini-play" />
            <Cover mood={mini.config.mood} className="mini-cover" />
            <button
              type="button"
              className="mini-title"
              data-testid="mini-title"
              data-tip="回到这首作品"
              onClick={() => {
                actions.navigate("studio");
                requestAnimationFrame(() =>
                  document
                    .querySelector('[data-testid="player-card"]')
                    ?.scrollIntoView({ block: "start", behavior: "smooth" }),
                );
              }}
            >
              <strong className="ellipsis">{mini.title}</strong>
              <span className="ellipsis">
                {simple
                  ? plainSummary(mini)
                  : `${styleLabel(mini.config.mood)} · v${mini.revision}`}
              </span>
            </button>
            <TimeText
              player={player}
              testId="mini-time"
              className="mini-time"
            />
            <IconButton
              label={simple ? "下载音乐" : "导出"}
              tip={simple ? "下载音乐" : "导出（Ctrl+E）"}
              data-testid="mini-export"
              onClick={() =>
                simple
                  ? void actions.downloadMusic()
                  : actions.openModal("export")
              }
            >
              <Download size={18} aria-hidden />
            </IconButton>
          </div>
        )
      )}
    </footer>
  );
});
