/**
 * 简单模式 without a piece: 想要什么样的背景音乐？ Twelve scene cards that
 * start a piece with one tap, the other styles as small buttons, an optional
 * sentence with 做一首, the length, and — on the desktop, once an AI service
 * is set up — the switch to use it. While the first version is being made
 * the cards make room for its progress.
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  BookOpen,
  Camera,
  Coffee,
  Cpu,
  Dumbbell,
  Flame,
  Flower2,
  Gamepad2,
  Heart,
  Moon,
  Mountain,
  PawPrint,
  Sparkles,
} from "lucide-react";
import { LIMITS } from "../../music/catalog";
import { providerName } from "../../providers";
import { useApp } from "../../state/context";
import { joinText } from "../../state/logic";
import { activeBrain } from "../../state/options";
import { plainSummary } from "../../state/plain";
import {
  LENGTH_CHOICES,
  MORE_STYLES,
  SCENES,
  scenePins,
  sentencePins,
} from "../../state/scenes";
import type { Scene } from "../../state/scenes";
import { groupPieces } from "../../state/works";
import { useRenderCount } from "../hooks/useRenderCount";
import { Cover } from "../primitives/Art";
import { Button } from "../primitives/Button";
import { Segmented } from "../primitives/Controls";
import {
  LLM_HINT,
  ProLink,
  SimpleFailure,
  SimpleProgress,
  attempt,
} from "./parts";

const ICONS: Record<string, ReactNode> = {
  vlog: <Camera size={22} aria-hidden />,
  cafe: <Coffee size={22} aria-hidden />,
  travel: <Mountain size={22} aria-hidden />,
  pets: <PawPrint size={22} aria-hidden />,
  study: <BookOpen size={22} aria-hidden />,
  sleep: <Moon size={22} aria-hidden />,
  workout: <Dumbbell size={22} aria-hidden />,
  game: <Gamepad2 size={22} aria-hidden />,
  epic: <Flame size={22} aria-hidden />,
  guofeng: <Flower2 size={22} aria-hidden />,
  romantic: <Heart size={22} aria-hidden />,
  tech: <Cpu size={22} aria-hidden />,
};

type LengthValue = "auto" | number;

/** The length last picked on the scene page (null: 自动), for this session. */
let pickedLength: number | null = null;

const LENGTH_OPTIONS = LENGTH_CHOICES.map((choice) => ({
  value: (choice.value ?? "auto") as LengthValue,
  label: choice.label,
  testId: `length-${choice.value ?? "auto"}`,
}));

export function SimpleMakePage() {
  useRenderCount("SimpleMakePage");
  const { studio, library, platform, ui, actions } = useApp();
  const { composerText: text, job } = studio;
  const locked = studio.busy || ui.dialog !== null;
  const creating = job?.kind === "generate";
  // The length picked here stays picked for the next piece (重新挑 comes
  // back to it) for as long as the app is open; a pin left by 专业模式 is
  // not this choice. Scenes and 做一首 send it as their own pin.
  const [length, setLength] = useState<number | null>(pickedLength);
  const pick = (value: number | null) => {
    pickedLength = value;
    setLength(value);
  };
  // The AI service a new piece could be made by (desktop, once set up).
  const service = platform.canUseCloud
    ? studio.engines.find((option) => option.id !== "local" && option.available)
    : undefined;
  const aiOn = studio.provider !== "local";
  // Words typed here go to the user's own language model, when one is set up.
  const llm = activeBrain(studio.brain, studio.brains) === "llm";
  const aiName = aiOn ? providerName(studio.provider) : (service?.label ?? "");
  const recent = useMemo(
    () => groupPieces(library.projects).slice(0, 3),
    [library.projects],
  );

  const start = (scene: Scene) => {
    if (locked) return;
    void attempt(() => actions.startPiece(scenePins(scene, length)));
  };
  const make = () => {
    if (locked || !text.trim()) return;
    // the length picked here; with 自动 the one the sentence names, else a minute
    void attempt(() =>
      actions.startPiece(sentencePins(text, length), { withText: true }),
    );
  };

  return (
    <div className="page simple-page" data-testid="simple-make">
      <div className="page-inner simple-inner">
        <header className="simple-head">
          <h1 id="simple-make-title">想要什么样的背景音乐？</h1>
          <p className="simple-lede" data-testid="simple-lede">
            {aiOn
              ? joinText(
                  "将由",
                  aiName,
                  "来做，按次付费，通常要几十秒到几分钟。",
                )
              : "点一个场景，几秒钟就做好，完全免费、不用联网。"}
          </p>
        </header>

        {creating && job ? (
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
            <section
              className="simple-scenes"
              aria-labelledby="simple-scenes-title"
            >
              <div className="simple-row">
                <h2 id="simple-scenes-title" className="simple-section-title">
                  选一个场景
                </h2>
                <div className="simple-length">
                  <span className="simple-length-label" aria-hidden>
                    长度
                  </span>
                  <Segmented
                    label="长度"
                    testId="simple-length"
                    value={length ?? "auto"}
                    options={LENGTH_OPTIONS}
                    disabled={locked}
                    onChange={(value) => pick(value === "auto" ? null : value)}
                  />
                </div>
              </div>
              <ul className="scene-grid">
                {SCENES.map((scene) => (
                  <li key={scene.id}>
                    <button
                      type="button"
                      className="scene-card"
                      data-testid="scene-card"
                      data-scene={scene.id}
                      disabled={locked}
                      onClick={() => start(scene)}
                    >
                      <Cover mood={scene.mood} className="scene-art">
                        <span className="scene-icon">{ICONS[scene.id]}</span>
                      </Cover>
                      <span className="scene-text">
                        <strong>{scene.title}</strong>
                        <span>{scene.use}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="simple-more">
                <span className="simple-more-label" id="simple-more-title">
                  更多风格
                </span>
                <ul aria-labelledby="simple-more-title">
                  {MORE_STYLES.map((style) => (
                    <li key={style.id}>
                      <button
                        type="button"
                        className="simple-style"
                        data-testid="more-style"
                        data-style={style.mood}
                        disabled={locked}
                        onClick={() => start(style)}
                      >
                        {style.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <div className="simple-describe">
              <label className="simple-label" htmlFor="simple-input">
                或者用一句话说说你想要的（可选）
              </label>
              <div className="simple-input-row">
                <input
                  id="simple-input"
                  className="simple-input"
                  data-testid="simple-input"
                  type="text"
                  autoComplete="off"
                  maxLength={LIMITS.promptChars}
                  placeholder="比如：下雨天的咖啡馆，安静一点，要钢琴"
                  value={text}
                  disabled={locked}
                  onChange={(event) =>
                    actions.setComposerText(event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.nativeEvent.isComposing)
                      return;
                    event.preventDefault();
                    make();
                  }}
                />
                <Button
                  variant={text.trim() ? "primary" : "secondary"}
                  size="lg"
                  className="simple-make"
                  data-testid="simple-send"
                  icon={<Sparkles size={17} aria-hidden />}
                  disabled={locked || !text.trim()}
                  onClick={make}
                >
                  做一首
                </Button>
              </div>
              {llm && (
                <p className="simple-hint" data-testid="simple-llm-hint">
                  {LLM_HINT}
                </p>
              )}
            </div>

            {(service || aiOn) && (
              <div className="simple-ai">
                <button
                  type="button"
                  role="switch"
                  className="simple-switch"
                  data-testid="simple-ai-toggle"
                  aria-checked={aiOn}
                  disabled={locked}
                  onClick={() =>
                    actions.setProvider(
                      aiOn ? "local" : (service?.id ?? "local"),
                    )
                  }
                >
                  <span className="simple-switch-track" aria-hidden>
                    <span className="simple-switch-thumb" />
                  </span>
                  <span>用 AI 服务生成（{aiName}，按次付费）</span>
                </button>
              </div>
            )}
          </>
        )}

        {recent.length > 0 && !creating && (
          <section
            className="simple-recent"
            aria-labelledby="simple-recent-title"
          >
            <h2 id="simple-recent-title" className="simple-section-title">
              最近做的
            </h2>
            <ul>
              {recent.map(({ latest }) => (
                <li key={latest.id}>
                  <button
                    type="button"
                    className="simple-recent-card"
                    data-testid="simple-recent"
                    data-project={latest.id}
                    disabled={locked}
                    onClick={() => void actions.openProject(latest.id)}
                  >
                    <Cover
                      mood={latest.config.mood}
                      className="simple-recent-art"
                    />
                    <span className="simple-recent-text">
                      <strong className="ellipsis">{latest.title}</strong>
                      <span className="ellipsis">{plainSummary(latest)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <ProLink actions={actions} />
      </div>
    </div>
  );
}
