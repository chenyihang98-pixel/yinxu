/** Form primitives: Slider, Select, Segmented, Chip, Badge, Field, Progress. */
import { useId, useRef } from "react";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import { rovingIndex } from "../logic/focus";
import { sliderRatio } from "../logic/timeline";
import { classes } from "./Button";

/* ---------------- slider ---------------- */

export interface SliderProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** what a screen reader says instead of the bare number, e.g. "62%" */
  valueText: string;
  /** CSS colour of the filled part and the thumb ring */
  color?: string;
  onValue(value: number): void;
  ref?: Ref<HTMLInputElement>;
}

/**
 * A native range input (keyboard, touch and assistive tech for free) with a
 * 16 px thumb inside a 24 px hit area.
 */
export function Slider(props: SliderProps) {
  const {
    value,
    min = 0,
    max = 100,
    step = 1,
    valueText,
    color,
    onValue,
    className,
    style,
    ref,
    ...rest
  } = props;
  const custom = {
    "--ratio": sliderRatio(value, min, max),
    ...(color ? { "--slider-color": color } : {}),
    ...style,
  } as CSSProperties;
  return (
    <input
      ref={ref}
      type="range"
      className={classes("slider", className)}
      min={min}
      max={max}
      step={step}
      value={value}
      aria-valuetext={valueText}
      style={custom}
      onChange={(event) => onValue(Number(event.target.value))}
      {...rest}
    />
  );
}

/* ---------------- select ---------------- */

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** short label shown inside the control, before the value */
  prefix?: string;
  block?: boolean;
  wrapClassName?: string;
  ref?: Ref<HTMLSelectElement>;
}

/** A styled native <select>: the platform's own list, keyboard and a11y. */
export function Select(props: SelectProps) {
  const { prefix, block, wrapClassName, children, ref, ...rest } = props;
  return (
    <span
      className={classes("select", block && "select-block", wrapClassName)}
    >
      {prefix && (
        <span className="select-prefix" aria-hidden>
          {prefix}
        </span>
      )}
      <select ref={ref} {...rest}>
        {children}
      </select>
      <ChevronDown className="select-chevron" size={14} aria-hidden />
    </span>
  );
}

/* ---------------- segmented ---------------- */

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: ReactNode;
  /** data-testid of this option */
  testId?: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string | number> {
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange(value: T): void;
  block?: boolean;
  disabled?: boolean;
  testId?: string;
  className?: string;
}

/** A radio group drawn as one control; arrow keys move the choice. */
export function Segmented<T extends string | number>(props: SegmentedProps<T>) {
  const { label, value, options, onChange, block, disabled, testId, className } =
    props;
  const group = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = options.filter((option) => !option.disabled);
    const current = enabled.findIndex((option) => option.value === value);
    const next = rovingIndex(event.key, current, enabled.length);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    const target = enabled[next];
    onChange(target.value);
    const index = options.indexOf(target);
    group.current
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      [index]?.focus();
  };
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      data-value={String(value)}
      className={classes("segmented", block && "segmented-block", className)}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled || option.disabled}
            data-testid={option.testId}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- chip ---------------- */

export interface ChipProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  /** toggle chips expose aria-pressed and show a tick when on */
  pressed?: boolean;
  /** small colour swatch before the label (hidden while pressed) */
  swatch?: string;
  /** extra description for the tooltip and for assistive tech */
  description?: string;
}

export function Chip(props: ChipProps) {
  const { pressed, swatch, description, className, children, ...rest } = props;
  return (
    <button
      type="button"
      className={classes("chip", className)}
      aria-pressed={pressed}
      aria-description={description}
      data-tip={description}
      {...rest}
    >
      {pressed ? (
        <Check size={13} strokeWidth={2.6} aria-hidden />
      ) : (
        swatch && (
          <span className="chip-dot" style={{ background: swatch }} aria-hidden />
        )
      )}
      {children}
    </button>
  );
}

/* ---------------- badge ---------------- */

export function Badge(props: {
  tone?: "neutral" | "accent" | "ok" | "warn" | "danger";
  children: ReactNode;
  testId?: string;
  tip?: string;
  className?: string;
}) {
  const { tone = "neutral" } = props;
  return (
    <span
      className={classes(
        "badge",
        tone !== "neutral" && `badge-${tone}`,
        props.className,
      )}
      data-testid={props.testId}
      data-tip={props.tip}
    >
      {props.children}
    </span>
  );
}

/* ---------------- field ---------------- */

/**
 * Label + control (+ hint). Pass `htmlFor` when the control is a single
 * input; without it the label is plain text and the control names itself.
 */
export function Field(props: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  /** shown at the right end of the label row */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={classes("field", props.className)}>
      <div className="field-label">
        {props.htmlFor ? (
          <label htmlFor={props.htmlFor}>{props.label}</label>
        ) : (
          <span>{props.label}</span>
        )}
        {props.aside}
      </div>
      {props.children}
      {props.hint && <p className="field-hint">{props.hint}</p>}
    </div>
  );
}

/** Stable ids for label/control pairs. */
export function useFieldId(prefix: string): string {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/* ---------------- progress ---------------- */

export function Progress(props: {
  /** 0..1, or null while the length of the wait is unknown */
  value: number | null;
  label: string;
  testId?: string;
  className?: string;
}) {
  const { value } = props;
  const known = value !== null && Number.isFinite(value);
  const clamped = known ? Math.max(0, Math.min(1, value)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? Math.round(clamped * 100) : undefined}
      data-testid={props.testId}
      className={classes(
        "progress",
        !known && "progress-indeterminate",
        props.className,
      )}
    >
      <span
        className="progress-fill"
        style={known ? { transform: `scaleX(${clamped})` } : undefined}
      />
    </div>
  );
}
