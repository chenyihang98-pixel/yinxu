/**
 * 制作人: the conversation that produced this work, and the composer for the
 * next change. Reads like notes from a collaborator: what was asked, what
 * the producer understood and changed, and which version came out of it.
 */
import { memo, useRef, useState } from "react";
import {
  ArrowUp,
  CircleDollarSign,
  History,
  LoaderCircle,
  MessageSquareText,
  SlidersHorizontal,
  TriangleAlert,
  WandSparkles,
} from "lucide-react";
import type { AgentTurn } from "../../agent/types";
import { LIMITS } from "../../music/catalog";
import type { Platform } from "../../platform";
import { REFINE_PLACEHOLDER, THREAD_EXAMPLES } from "../../state/content";
import type {
  AppActions,
  BrainOption,
  EngineOption,
  Job,
  PaidNotice,
  TurnNote,
} from "../../state/types";
import { versionOfTurn } from "../../state/works";
import type { BrainKind } from "../../agent/types";
import type { Project, Provider } from "../../types";
import { useAutosize } from "../hooks/useAutosize";
import { useRenderCount } from "../hooks/useRenderCount";
import { Button, LinkButton, classes } from "../primitives/Button";
import { Badge, Chip, Progress } from "../primitives/Controls";
import { BrainSelect, DesktopLink, EngineSelect } from "./ComposerOptions";

/** Turns shown before "显示更早的对话" is used. */
const VISIBLE_TURNS = 8;

function clock(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function brainName(turn: AgentTurn, note: TurnNote | undefined): string {
  if (!turn.brain) return "直接调整";
  return turn.brain === "llm" ? (note?.model ?? "大模型") : "离线规则";
}

const AgentMark = memo(function AgentMark(props: {
  busy?: boolean;
  error?: boolean;
}) {
  return (
    <span
      className={classes("turn-mark", props.error && "turn-mark-error")}
      aria-hidden
    >
      {props.busy ? (
        <LoaderCircle className="spin" size={15} />
      ) : props.error ? (
        <TriangleAlert size={15} />
      ) : (
        <WandSparkles size={15} />
      )}
    </span>
  );
});

const Turn = memo(function Turn(props: {
  turn: AgentTurn;
  note: TurnNote | undefined;
  /** the library work this turn's version tag opens, if it still exists */
  version: Project | undefined;
  current: boolean;
  busy: boolean;
  actions: AppActions;
}) {
  const { turn, note, version, current, busy, actions } = props;
  if (turn.role === "user")
    return (
      <li className="turn turn-user" data-testid="thread-turn" data-role="user">
        <span className="sr-only">你：</span>
        <p className="turn-bubble">{turn.text}</p>
      </li>
    );
  return (
    <li
      className={classes("turn turn-agent", turn.error && "turn-error")}
      data-testid="thread-turn"
      data-role="agent"
      data-error={turn.error || undefined}
    >
      <AgentMark error={turn.error} />
      <div className="turn-body">
        <span className="sr-only">制作人：</span>
        <p className="turn-text">{turn.text}</p>
        {turn.reasoning && turn.reasoning.length > 0 && (
          <ul className="turn-reasons" aria-label="理解与改动">
            {turn.reasoning.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        )}
        {turn.note && (
          // The model's own words. The answer above is written by the app
          // from what really changed; this is clearly a second voice.
          <p className="turn-note" data-testid="turn-note">
            <span className="turn-note-label">模型说明：</span>
            {turn.note}
          </p>
        )}
        {note?.fallbackReason && (
          <p className="turn-fallback" data-testid="turn-fallback">
            <TriangleAlert size={14} aria-hidden />
            <span>{note.fallbackReason}</span>
          </p>
        )}
        <p className="turn-meta">
          <Badge testId="turn-brain">
            {turn.brain ? null : <SlidersHorizontal size={11} aria-hidden />}
            {brainName(turn, note)}
          </Badge>
          {turn.revision !== undefined &&
            (current ? (
              <Badge tone="accent" testId="turn-version" tip="正在听的版本">
                v{turn.revision} · 当前
              </Badge>
            ) : (
              // the pill stays small; the button around it is a full-size target
              <button
                type="button"
                className="badge-btn"
                data-testid="turn-version"
                disabled={!version || busy}
                data-tip={
                  version ? "打开这个版本" : "这个版本已经不在「我的作品」里"
                }
                onClick={() => version && void actions.openProject(version.id)}
              >
                <span className="badge">v{turn.revision}</span>
              </button>
            ))}
          <time className="turn-time tabular" dateTime={turn.at}>
            {clock(turn.at)}
          </time>
        </p>
      </div>
    </li>
  );
});

export interface ProducerThreadProps {
  project: Project;
  /** every version of this piece, newest first; resolves the version tags */
  versions: readonly Project[];
  /** the newest version of this piece (the loaded work when it is the newest) */
  latest: Project;
  /** the next generation is a paid request: said next to the send button */
  paid: PaidNotice | null;
  thread: readonly AgentTurn[];
  pendingTurn: AgentTurn | null;
  turnNotes: Record<string, TurnNote>;
  job: Job | null;
  composerText: string;
  suggestions: readonly string[];
  engines: readonly EngineOption[];
  brains: readonly BrainOption[];
  provider: Provider;
  activeBrain: BrainKind;
  platform: Platform;
  /** a question from the app is open: nothing here starts another one */
  asking: boolean;
  actions: AppActions;
}

/**
 * Fader moves replace `project` many times a second; the thread only cares
 * about which work it is.
 */
function sameThreadProps(
  before: ProducerThreadProps,
  after: ProducerThreadProps,
): boolean {
  const keys = Object.keys(after) as (keyof ProducerThreadProps)[];
  return keys.every((key) =>
    key === "project"
      ? before.project.id === after.project.id &&
        before.project.revision === after.project.revision &&
        before.project.parentId === after.project.parentId
      : Object.is(before[key], after[key]),
  );
}

export const ProducerThread = memo(function ProducerThread(
  props: ProducerThreadProps,
) {
  useRenderCount("ProducerThread");
  const {
    project,
    versions,
    latest,
    thread,
    pendingTurn,
    job,
    turnNotes,
    actions,
  } = props;
  const { paid } = props;
  const busy = job !== null;
  const [showAll, setShowAll] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useAutosize(input, props.composerText);

  const hidden = showAll ? 0 : Math.max(0, thread.length - VISIBLE_TURNS);
  const visible = hidden ? thread.slice(hidden) : thread;
  const generating = job?.kind === "generate";
  const canSend = !busy && !props.asking && !!props.composerText.trim();
  const send = () => {
    if (canSend) void actions.send();
  };
  const desktopOnly = props.engines.some((option) => option.desktopOnly);

  return (
    <section className="card thread-card" aria-labelledby="thread-title">
      <div className="card-head">
        <h2 id="thread-title">
          <MessageSquareText size={16} aria-hidden />
          制作人
        </h2>
        <span className="card-note grow">
          说出想怎么改，每次改动都会存成一个新版本
        </span>
      </div>

      {latest.id !== project.id && (
        // An earlier version is loaded: the conversation below goes on past
        // it, and this is the way back.
        <p className="notice thread-version" data-testid="thread-version-note">
          <History size={15} aria-hidden />
          <span className="grow">
            正在听 v{project.revision}。这段对话之后还有更新的版本，最新的是 v
            {latest.revision}；现在发送的修改会从 v{project.revision} 出发。
          </span>
          <Button
            size="sm"
            data-testid="thread-latest"
            disabled={busy}
            onClick={() => void actions.openProject(latest.id)}
          >
            回到最新版本
          </Button>
        </p>
      )}

      {hidden > 0 && (
        <LinkButton
          className="thread-more"
          data-testid="thread-more"
          onClick={() => setShowAll(true)}
        >
          显示更早的 {hidden} 条对话
        </LinkButton>
      )}

      <ol className="thread" data-testid="thread" aria-label="对话记录">
        {thread.length === 0 && !pendingTurn && (
          <li className="thread-empty">
            这首作品还没有对话。告诉制作人想怎么改，比如
            {THREAD_EXAMPLES.map((text) => `「${text}」`).join("")}。
          </li>
        )}
        {visible.map((turn) => {
          const version = versionOfTurn(turn, versions, project);
          return (
            <Turn
              key={turn.id}
              turn={turn}
              note={turnNotes[turn.id]}
              version={version}
              current={
                turn.revision !== undefined &&
                turn.revision === project.revision &&
                version?.id === project.id
              }
              busy={busy}
              actions={actions}
            />
          );
        })}
        {pendingTurn && (
          <li className="turn turn-user" data-testid="pending-turn">
            <span className="sr-only">你：</span>
            <p className="turn-bubble">{pendingTurn.text}</p>
          </li>
        )}
        {generating && job && (
          // The bottom bar announces the phase; this copy is for the eye.
          <li className="turn turn-agent turn-live" aria-hidden>
            <AgentMark busy />
            <div className="turn-body">
              <p className="turn-text">
                {job.phase}
                {job.progress !== null
                  ? ` · ${Math.round(job.progress * 100)}%`
                  : "…"}
              </p>
              <Progress value={job.progress} label={job.phase} />
            </div>
          </li>
        )}
      </ol>

      <div className="refine">
        {paid && (
          <p
            className="notice notice-warn paid-notice"
            data-testid="paid-notice"
          >
            <CircleDollarSign size={15} aria-hidden />
            <span>{paid.text}</span>
          </p>
        )}
        {props.suggestions.length > 0 && (
          <div className="refine-chips" role="group" aria-label="常用调整">
            {props.suggestions.map((text) => (
              <Chip
                key={text}
                data-testid="suggestion-chip"
                disabled={busy || props.asking}
                // With a cloud engine a chip only fills the input: one click
                // is never a paid request.
                data-tip={paid ? "填入输入框，不会直接发送" : undefined}
                onClick={() => void actions.pickSuggestion(text)}
              >
                {text}
              </Chip>
            ))}
          </div>
        )}
        <div className="refine-box">
          <textarea
            ref={input}
            className="refine-input"
            data-testid="composer-input"
            aria-label="告诉制作人怎么改"
            rows={1}
            maxLength={LIMITS.promptChars}
            placeholder={REFINE_PLACEHOLDER}
            value={props.composerText}
            onChange={(event) => actions.setComposerText(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line; an input method
              // that is composing keeps its Enter. Ctrl+Enter is global.
              if (
                event.key !== "Enter" ||
                event.shiftKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.altKey ||
                event.nativeEvent.isComposing ||
                event.keyCode === 229
              )
                return;
              event.preventDefault();
              send();
            }}
          />
          <button
            type="button"
            className="refine-send"
            data-testid="send-button"
            aria-label="发送"
            data-tip="发送（Enter）"
            disabled={!canSend}
            onClick={send}
          >
            {generating ? (
              <LoaderCircle className="spin" size={16} aria-hidden />
            ) : (
              <ArrowUp size={18} strokeWidth={2.4} aria-hidden />
            )}
          </button>
        </div>
        <div className="refine-foot">
          <EngineSelect
            engines={props.engines}
            provider={props.provider}
            disabled={busy}
            actions={actions}
          />
          <BrainSelect
            brains={props.brains}
            activeBrain={props.activeBrain}
            disabled={busy}
            actions={actions}
          />
          <span className="refine-hint">Enter 发送 · Shift+Enter 换行</span>
          {desktopOnly && (
            <DesktopLink href={props.platform.downloadUrl} short />
          )}
        </div>
      </div>
    </section>
  );
}, sameThreadProps);
