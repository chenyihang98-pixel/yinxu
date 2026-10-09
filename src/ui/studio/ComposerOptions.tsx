/**
 * The selectors shared by both composers: 生成引擎 and 制作人, plus the
 * desktop-download link the web build shows next to its disabled options.
 */
import { memo } from "react";
import { ArrowUpRight } from "lucide-react";
import type { BrainKind } from "../../agent/types";
import type { AppActions, BrainOption, EngineOption } from "../../state/types";
import type { Provider } from "../../types";
import { Select } from "../primitives/Controls";

const optionText = (option: {
  label: string;
  hint?: string;
  billing?: string;
}) => [option.label, option.hint, option.billing].filter(Boolean).join(" · ");

export const EngineSelect = memo(function EngineSelect(props: {
  engines: readonly EngineOption[];
  provider: Provider;
  disabled: boolean;
  actions: AppActions;
}) {
  return (
    <Select
      prefix="引擎"
      wrapClassName="option-select option-select-wide"
      data-testid="composer-engine"
      aria-label="生成引擎"
      value={props.provider}
      disabled={props.disabled}
      onChange={(event) =>
        props.actions.setProvider(event.target.value as Provider)
      }
    >
      {props.engines.map((option) => (
        <option
          key={option.id}
          value={option.id}
          disabled={!!option.desktopOnly}
        >
          {optionText(option)}
        </option>
      ))}
    </Select>
  );
});

export const BrainSelect = memo(function BrainSelect(props: {
  brains: readonly BrainOption[];
  activeBrain: BrainKind;
  disabled: boolean;
  actions: AppActions;
}) {
  return (
    <Select
      prefix="制作人"
      wrapClassName="option-select option-select-wide"
      data-testid="composer-brain"
      aria-label="制作人"
      value={props.activeBrain}
      disabled={props.disabled}
      onChange={(event) =>
        props.actions.setBrain(event.target.value === "llm" ? "llm" : "rules")
      }
    >
      {props.brains.map((option) => (
        <option
          key={option.id}
          value={option.id}
          disabled={!!option.desktopOnly}
        >
          {optionText(option)}
        </option>
      ))}
    </Select>
  );
});

/** Web build: where the disabled options live. Never a dead end. */
export function DesktopLink(props: { href: string; short?: boolean }) {
  return (
    <a
      className="desktop-link"
      href={props.href}
      target="_top"
      rel="noopener"
      data-testid="desktop-link"
    >
      {props.short ? (
        <>
          <span className="sr-only">云端生成与制作人大模型在桌面版可用，</span>
          了解桌面版
        </>
      ) : (
        <>
          <span className="desktop-link-long">
            云端生成与制作人大模型在桌面版可用 · 下载 Windows 版
          </span>
          <span className="desktop-link-short" aria-hidden>
            云端生成与大模型：桌面版可用
          </span>
        </>
      )}
      <ArrowUpRight size={14} aria-hidden />
    </a>
  );
}
