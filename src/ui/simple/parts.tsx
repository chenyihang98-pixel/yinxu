/**
 * Small pieces the 简单模式 pages share: the big progress of a running job,
 * the failure line with 再试一次, the quiet link to 专业模式, and the one
 * remembered "do that again" of the last request.
 */
import { useEffect, useState } from "react";
import { AudioLines, RotateCw, TriangleAlert } from "lucide-react";
import { formatTime } from "../../state/format";
import { plainFailure, plainPhase } from "../../state/plain";
import type { AppActions, Job } from "../../state/types";
import { Button, LinkButton } from "../primitives/Button";
import { Progress } from "../primitives/Controls";

/**
 * The last thing a 简单模式 button asked for, so 再试一次 can ask again. It
 * outlives the page that set it (the failure is shown wherever the user
 * goes back to).
 */
let lastRequest: (() => Promise<boolean>) | null = null;

/** Run a request and remember it for 再试一次. */
export function attempt(request: () => Promise<boolean>): Promise<boolean> {
  lastRequest = request;
  return request();
}

export function canRetry(): boolean {
  return lastRequest !== null;
}

export function retry(): void {
  if (lastRequest) void lastRequest();
}

/** Under a box for one's own words, when a language model will read them. */
export const LLM_HINT =
  "你写的话会交给你在设置里接入的大模型来理解，可能要多等一会儿。";

/** Seconds since the job started, for waits of unknown length. */
function Waited(props: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="simple-progress-waited tabular">
      已等待 {formatTime(Math.max(0, (now - props.since) / 1000))}
    </span>
  );
}

/** "正在作曲… 37%", a big bar and 取消. */
export function SimpleProgress(props: {
  job: Job;
  /** a heading above the bar, e.g. 正在打开上次的音乐 */
  title?: string;
  actions: AppActions;
}) {
  const { job, actions } = props;
  const percent = job.progress === null ? null : Math.round(job.progress * 100);
  const phase = plainPhase(job);
  return (
    <section
      className="simple-progress"
      data-testid="simple-progress"
      data-stage={job.stage}
      aria-busy="true"
      aria-label="正在制作"
    >
      <span className="simple-progress-art" aria-hidden>
        <AudioLines size={30} />
      </span>
      {props.title && <h2 className="simple-progress-title">{props.title}</h2>}
      <p className="simple-progress-text" data-testid="simple-progress-text">
        {phase}…
        {percent !== null && <span className="tabular"> {percent}%</span>}
      </p>
      <Progress value={job.progress} label={phase} className="simple-bar" />
      {percent === null && job.stage !== "cancelling" && (
        <Waited since={job.startedAt} />
      )}
      <Button
        size="lg"
        className="simple-cancel"
        data-testid="simple-cancel"
        disabled={!job.cancellable}
        onClick={actions.cancelJob}
      >
        取消
      </Button>
    </section>
  );
}

/**
 * The last generation failed: why, in one plain sentence (plainFailure —
 * a wrong key is not "a passing problem"), and 再试一次.
 */
export function SimpleFailure(props: {
  busy: boolean;
  /** studio.failure: the app's own account of what went wrong */
  message: string;
  /** an AI service was asked */
  cloud: boolean;
}) {
  return (
    <div
      className="simple-failure notice notice-danger"
      role="alert"
      data-testid="simple-failure"
    >
      <TriangleAlert size={18} aria-hidden />
      <span className="grow">{plainFailure(props.message, props.cloud)}</span>
      {canRetry() && (
        <Button
          variant="primary"
          data-testid="simple-retry"
          icon={<RotateCw size={15} aria-hidden />}
          disabled={props.busy}
          onClick={retry}
        >
          再试一次
        </Button>
      )}
    </div>
  );
}

/** "轻快明亮 · 1 分钟 · 可以循环播放", wrapping only between its parts. */
export function PlainLine(props: { text: string }) {
  const parts = props.text.split(" · ");
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && " · "}
          <span className="plain-part">{part}</span>
        </span>
      ))}
    </>
  );
}

/** The quiet way to the complete interface, at the foot of every page. */
export function ProLink(props: { actions: AppActions }) {
  return (
    <footer className="simple-foot">
      <LinkButton
        className="simple-pro-link"
        data-testid="pro-mode-link"
        onClick={() => props.actions.setMode("pro")}
      >
        专业模式
      </LinkButton>
    </footer>
  );
}
