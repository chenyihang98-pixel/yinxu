/**
 * The empty state of the studio: "你想听见什么？" — description, the
 * producer's understanding of it, style / duration / structure pins, engine
 * and producer, and a few ready-made prompts.
 */
import { memo, useCallback, useEffect, useRef } from "react";
import {
  ArrowRight,
  AudioLines,
  CircleDollarSign,
  CircleHelp,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { LIMITS, styleInfo } from "../../music/catalog";
import type { StyleId } from "../../music/catalog";
import type { Platform } from "../../platform";
import {
  COMPOSER_PLACEHOLDER,
  COMPOSER_PLACEHOLDER_SHORT,
  QUICK_PROMPTS,
  scenarioInspiration,
} from "../../state/content";
import { joinText } from "../../state/logic";
import { DURATION_CHOICES, canSendPinsOnly } from "../../state/plan";
import type { AppActions, StudioView } from "../../state/types";
import { usePlanPreview } from "../../state/usePlanPreview";
import { useAutosize } from "../hooks/useAutosize";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useRenderCount } from "../hooks/useRenderCount";
import { Cover } from "../primitives/Art";
import { Button, LinkButton } from "../primitives/Button";
import { Progress, Select } from "../primitives/Controls";
import { BrainSelect, DesktopLink, EngineSelect } from "./ComposerOptions";
import { StyleChips } from "./StyleChips";

const QuickPrompts = memo(function QuickPrompts(props: {
  disabled: boolean;
  actions: AppActions;
}) {
  const { actions } = props;
  return (
    <section className="quick" aria-labelledby="quick-title">
      <div className="section-title">
        <h2 id="quick-title">试试这些</h2>
        <span className="muted">点一下填入描述，可以再改</span>
        <span className="grow" />
        <LinkButton
          data-testid="more-inspiration"
          onClick={() => actions.navigate("inspiration")}
        >
          更多灵感
          <ArrowRight size={14} aria-hidden />
        </LinkButton>
      </div>
      <ul className="prompt-grid">
        {QUICK_PROMPTS.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="prompt-card"
              data-testid="quick-prompt"
              disabled={props.disabled}
              onClick={() =>
                actions.chooseInspiration(scenarioInspiration(item))
              }
            >
              <Cover mood={item.style} className="prompt-art" />
              <span className="prompt-text">
                <strong>{item.title}</strong>
                <span>{item.prompt}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
});

export function ComposerHero(props: {
  studio: StudioView;
  platform: Platform;
  actions: AppActions;
}) {
  useRenderCount("ComposerHero");
  const { studio, platform, actions } = props;
  const { pins, composerText: text, busy, job } = studio;
  const input = useRef<HTMLTextAreaElement>(null);
  useAutosize(input, text);
  const narrow = useMediaQuery("(max-width: 719px)");

  // Arriving here with the keyboard free (app start on desktop, 新建创作, a
  // chosen inspiration): start in the description. Not on touch screens,
  // where focus opens the keyboard, and not when this frame does not have
  // the user's focus (embedded in a page they are still reading).
  useEffect(() => {
    const node = input.current;
    if (!node || !document.hasFocus()) return;
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    node.focus({ preventScroll: true });
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);

  // A pinned style alone is enough to start from. Nothing is written into
  // the description for it: only the pin is sent, and the style's own blurb
  // is shown for reading, never parsed as the user's words.
  const pinsOnly = canSendPinsOnly(text, pins);
  const pinned = pinsOnly && pins.mood ? styleInfo(pins.mood) : null;
  const preview = usePlanPreview(
    text,
    pins,
    studio.provider,
    studio.activeBrain,
  );
  const creating = job?.kind === "generate";
  const canSend = !busy && (!!text.trim() || pinsOnly);
  const send = () => {
    if (canSend) void actions.send();
  };
  const pickStyle = useCallback(
    (mood: StyleId | undefined) => actions.setPin("mood", mood),
    [actions],
  );
  const desktopOnly = studio.engines.some((option) => option.desktopOnly);

  return (
    <div className="page" data-testid="studio-empty">
      <div className="page-inner hero">
        <header className="hero-head">
          <p className="eyebrow">一句描述 · 一首配乐</p>
          <h1 id="composer-title">你想听见什么？</h1>
          <p className="page-lede" data-testid="hero-lede">
            {studio.paid
              ? // The words follow the engine that is selected: nothing here
                // may promise "offline, on this computer" for a cloud request.
                joinText(
                  "写下画面、情绪或想要的乐器，制作人把它整理成描述，交给",
                  studio.paid.name,
                  "云端生成，按服务商计费。",
                )
              : `写下画面、情绪或想要的乐器，制作人替你编曲并在${
                  platform.isDesktop ? "本机" : "浏览器里"
                }合成。本地作曲不联网、不需要账号。`}
          </p>
        </header>

        <section className="card composer" aria-labelledby="composer-title">
          {creating && job ? (
            <div className="creating" data-testid="creating">
              <div className="creating-art" aria-hidden>
                <AudioLines size={28} />
              </div>
              <div className="grow">
                <p className="creating-quote">
                  {studio.pendingTurn?.text ?? "正在准备"}
                </p>
                <p className="creating-phase">
                  {job.phase}
                  {job.progress !== null
                    ? ` · ${Math.round(job.progress * 100)}%`
                    : "…"}
                </p>
                <Progress value={job.progress} label={job.phase} />
              </div>
            </div>
          ) : (
            <div className="composer-box">
              <textarea
                ref={input}
                className="composer-input"
                data-testid="composer-input"
                aria-label="音乐描述"
                aria-describedby="plan-preview"
                rows={3}
                maxLength={LIMITS.promptChars}
                placeholder={
                  narrow ? COMPOSER_PLACEHOLDER_SHORT : COMPOSER_PLACEHOLDER
                }
                value={text}
                disabled={busy}
                onChange={(event) =>
                  actions.setComposerText(event.target.value)
                }
                onKeyDown={(event) => {
                  // Ctrl+Enter is a global shortcut; handled here as well so
                  // it works while the description has the focus.
                  if (
                    event.key !== "Enter" ||
                    !(event.ctrlKey || event.metaKey) ||
                    event.nativeEvent.isComposing
                  )
                    return;
                  event.preventDefault();
                  send();
                }}
              />
              <div className="composer-status">
                <p
                  id="plan-preview"
                  className="plan-preview"
                  data-testid="plan-preview"
                  data-unsure={preview?.unsure || undefined}
                  aria-live="polite"
                >
                  {preview?.unsure ? (
                    <CircleHelp size={15} aria-hidden />
                  ) : (
                    <WandSparkles size={15} aria-hidden />
                  )}
                  <span>
                    {preview?.line ??
                      "写下场景、情绪或想要的乐器，其余交给制作人。"}
                  </span>
                </p>
                <span
                  className="composer-count tabular"
                  data-testid="composer-count"
                  aria-label={`已输入 ${text.length} 字，最多 ${LIMITS.promptChars} 字`}
                >
                  {text.length} / {LIMITS.promptChars}
                </span>
              </div>
              {pinned && (
                <p className="style-hint" data-testid="style-hint">
                  已选「{pinned.label}」：{pinned.description}
                  可以直接生成，也可以再写几句想要的画面。
                </p>
              )}
            </div>
          )}

          <StyleChips mood={pins.mood} disabled={busy} onPick={pickStyle} />

          <div className="composer-options">
            <Select
              prefix="时长"
              wrapClassName="option-select"
              data-testid="composer-duration"
              aria-label="时长"
              value={pins.duration ?? ""}
              disabled={busy}
              onChange={(event) =>
                actions.setPin(
                  "duration",
                  event.target.value ? Number(event.target.value) : undefined,
                )
              }
            >
              <option value="">自动</option>
              {DURATION_CHOICES.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds} 秒
                </option>
              ))}
            </Select>
            <Select
              prefix="结构"
              wrapClassName="option-select"
              data-testid="composer-structure"
              aria-label="结构"
              value={
                pins.loop === undefined ? "" : pins.loop ? "loop" : "ending"
              }
              disabled={busy}
              onChange={(event) =>
                actions.setPin(
                  "loop",
                  event.target.value
                    ? event.target.value === "loop"
                    : undefined,
                )
              }
            >
              <option value="">自动</option>
              <option value="loop">循环片段</option>
              <option value="ending">完整结尾</option>
            </Select>
            <EngineSelect
              engines={studio.engines}
              provider={studio.provider}
              disabled={busy}
              actions={actions}
            />
            <BrainSelect
              brains={studio.brains}
              activeBrain={studio.activeBrain}
              disabled={busy}
              actions={actions}
            />
            <Button
              variant="primary"
              size="lg"
              className="composer-send"
              data-testid="send-button"
              icon={<Sparkles size={16} aria-hidden />}
              busy={creating}
              disabled={!canSend}
              onClick={send}
            >
              {creating ? "正在生成" : "生成 BGM"}
              {!creating && <kbd aria-hidden>Ctrl ↵</kbd>}
            </Button>
          </div>

          {studio.paid && (
            <p
              className="notice notice-warn paid-notice"
              data-testid="paid-notice"
            >
              <CircleDollarSign size={15} aria-hidden />
              <span>{studio.paid.text}</span>
            </p>
          )}

          {desktopOnly && (
            <p className="composer-foot">
              <DesktopLink href={platform.downloadUrl} />
            </p>
          )}
        </section>

        <QuickPrompts disabled={busy} actions={actions} />
      </div>
    </div>
  );
}
