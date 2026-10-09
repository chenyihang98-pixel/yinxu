/**
 * 风格: "自动" plus the 22 styles. Wraps on wide screens; one scrolling row
 * below 720 px, with a 全部风格 sheet that shows every style with its
 * description.
 */
import { memo, useEffect, useRef, useState } from "react";
import { Check, LayoutGrid, Sparkles } from "lucide-react";
import { STYLES, styleInfo } from "../../music/catalog";
import type { StyleId } from "../../music/catalog";
import { coverGradient } from "../../state/format";
import { Cover } from "../primitives/Art";
import { LinkButton } from "../primitives/Button";
import { Chip } from "../primitives/Controls";
import { Modal } from "../primitives/Modal";

export interface StyleChipsProps {
  /** the pinned style; undefined = 自动 */
  mood: StyleId | undefined;
  disabled: boolean;
  onPick(mood: StyleId | undefined): void;
}

function StyleSheet(props: StyleChipsProps & { onClose(): void }) {
  const { mood, onPick, onClose } = props;
  const pick = (next: StyleId | undefined) => {
    onPick(next);
    onClose();
  };
  return (
    <Modal
      local
      size="lg"
      title="全部风格"
      subtitle="选一个风格，或交给制作人根据描述决定"
      icon={<LayoutGrid size={18} />}
      testId="style-sheet"
      onClose={onClose}
    >
      <div className="style-grid">
        <button
          type="button"
          className="style-option"
          data-testid="style-option-auto"
          aria-pressed={!mood}
          onClick={() => pick(undefined)}
        >
          <span className="style-option-art style-option-auto">
            <Sparkles size={18} aria-hidden />
          </span>
          <span className="style-option-text">
            <strong>自动</strong>
            <span>由制作人根据你的描述决定风格</span>
          </span>
          {!mood && (
            <Check className="style-option-tick" size={16} aria-hidden />
          )}
        </button>
        {STYLES.map((style) => (
          <button
            key={style.id}
            type="button"
            className="style-option"
            data-testid={`style-option-${style.id}`}
            aria-pressed={mood === style.id}
            onClick={() => pick(style.id)}
          >
            <Cover mood={style.id} className="style-option-art" />
            <span className="style-option-text">
              <strong>{style.label}</strong>
              <span>{style.description}</span>
            </span>
            {mood === style.id && (
              <Check className="style-option-tick" size={16} aria-hidden />
            )}
          </button>
        ))}
      </div>
    </Modal>
  );
}

export const StyleChips = memo(function StyleChips(props: StyleChipsProps) {
  const { mood, disabled, onPick } = props;
  const [sheet, setSheet] = useState(false);
  const row = useRef<HTMLDivElement>(null);

  // In the one-row layout keep the chosen chip in sight.
  useEffect(() => {
    const scroller = row.current;
    if (!scroller || scroller.scrollWidth <= scroller.clientWidth + 1) return;
    const chosen = scroller.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!chosen) return;
    const target =
      chosen.offsetLeft - (scroller.clientWidth - chosen.offsetWidth) / 2;
    scroller.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  }, [mood]);

  return (
    <div className="style-picker">
      <div className="style-picker-head">
        <span className="style-picker-label" id="style-picker-label">
          风格
        </span>
        <span className="style-picker-note ellipsis">
          {mood ? styleInfo(mood).description : "自动：由制作人根据描述决定"}
        </span>
        <LinkButton
          className="style-all"
          data-testid="style-all"
          disabled={disabled}
          onClick={() => setSheet(true)}
        >
          <LayoutGrid size={14} aria-hidden />
          全部风格
        </LinkButton>
      </div>
      <div
        ref={row}
        className="style-chips"
        role="group"
        aria-labelledby="style-picker-label"
      >
        <Chip
          data-testid="style-chip-auto"
          pressed={!mood}
          disabled={disabled}
          description="由制作人根据描述决定风格"
          onClick={() => onPick(undefined)}
        >
          自动
        </Chip>
        {STYLES.map((style) => (
          <Chip
            key={style.id}
            data-testid={`style-chip-${style.id}`}
            pressed={mood === style.id}
            disabled={disabled}
            swatch={coverGradient(style.id)}
            description={style.description}
            onClick={() => onPick(mood === style.id ? undefined : style.id)}
          >
            {style.label}
          </Chip>
        ))}
      </div>
      {sheet && <StyleSheet {...props} onClose={() => setSheet(false)} />}
    </div>
  );
});
