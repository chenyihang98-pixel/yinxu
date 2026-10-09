/**
 * 灵感: the 22 styles and ready-made scenario prompts. Choosing one fills
 * the composer (a style card also pins its style) and opens 创作.
 */
import { memo } from "react";
import { ArrowRight } from "lucide-react";
import {
  SCENARIO_GROUPS,
  STYLE_CARDS,
  scenarioInspiration,
  styleInspiration,
} from "../../state/content";
import { useApp } from "../../state/context";
import type { AppActions } from "../../state/types";
import { useRenderCount } from "../hooks/useRenderCount";
import { Cover } from "../primitives/Art";

const StyleGrid = memo(function StyleGrid(props: {
  disabled: boolean;
  actions: AppActions;
}) {
  return (
    <ul className="style-cards">
      {STYLE_CARDS.map(({ style }) => (
        <li key={style.id}>
          <button
            type="button"
            className="style-card"
            data-testid="inspiration-card"
            data-style={style.id}
            disabled={props.disabled}
            onClick={() =>
              props.actions.chooseInspiration(styleInspiration(style))
            }
          >
            <Cover mood={style.id} className="style-card-art">
              <span className="style-card-english">{style.english}</span>
            </Cover>
            <span className="style-card-body">
              <strong>{style.label}</strong>
              <span className="style-card-text">{style.description}</span>
              <span className="style-card-tags">
                {style.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
});

const ScenarioGroups = memo(function ScenarioGroups(props: {
  disabled: boolean;
  actions: AppActions;
}) {
  return (
    <>
      {SCENARIO_GROUPS.map((group) => (
        <section
          key={group.id}
          className="scenario-group"
          aria-labelledby={`scenario-${group.id}`}
        >
          <h3 id={`scenario-${group.id}`} className="scenario-title">
            {group.label}
          </h3>
          <ul className="prompt-grid">
            {group.prompts.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="prompt-card"
                  data-testid="inspiration-prompt"
                  data-prompt={item.id}
                  disabled={props.disabled}
                  onClick={() =>
                    props.actions.chooseInspiration(scenarioInspiration(item))
                  }
                >
                  <Cover mood={item.style} className="prompt-art" />
                  <span className="prompt-text">
                    <strong>{item.title}</strong>
                    <span>{item.prompt}</span>
                  </span>
                  <ArrowRight className="prompt-go" size={15} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
});

export function InspirationPage() {
  useRenderCount("InspirationPage");
  const { studio, actions } = useApp();
  return (
    <div className="page" data-testid="inspiration-page">
      <div className="page-inner">
        <header className="page-head">
          <div className="grow">
            <h1>灵感</h1>
            <p className="page-lede">
              从一种风格或一个场景开始。风格卡片只固定风格，描述留给你写；场景卡片会填入一段现成的描述，可以改完再生成。
            </p>
          </div>
        </header>

        <section aria-labelledby="styles-title">
          <div className="section-title">
            <h2 id="styles-title">{STYLE_CARDS.length} 种风格</h2>
            <span className="muted">
              选中即固定为这次创作的风格，可以直接生成
            </span>
          </div>
          <StyleGrid disabled={studio.busy} actions={actions} />
        </section>

        <section aria-labelledby="scenarios-title">
          <div className="section-title">
            <h2 id="scenarios-title">按场景开始</h2>
            <span className="muted">现成的描述，制作人都听得懂</span>
          </div>
          <div className="scenario-groups">
            <ScenarioGroups disabled={studio.busy} actions={actions} />
          </div>
        </section>
      </div>
    </div>
  );
}
