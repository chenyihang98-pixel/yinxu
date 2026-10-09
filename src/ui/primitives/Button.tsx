import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { LoaderCircle } from "lucide-react";

type NativeButton = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type">;

export interface ButtonProps extends NativeButton {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  /** stretch to the width of the container */
  block?: boolean;
  /** leading icon; replaced by a spinner while `busy` */
  icon?: ReactNode;
  /** work in progress: shows a spinner and reports aria-busy */
  busy?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

function classes(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

export function Button(props: ButtonProps) {
  const {
    variant = "secondary",
    size = "md",
    block,
    icon,
    busy,
    className,
    children,
    ref,
    ...rest
  } = props;
  return (
    <button
      ref={ref}
      type="button"
      className={classes(
        "btn",
        variant !== "secondary" && `btn-${variant}`,
        size !== "md" && `btn-${size}`,
        block && "btn-block",
        className,
      )}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? (
        <LoaderCircle
          className="spin"
          size={size === "lg" ? 16 : 14}
          aria-hidden
        />
      ) : (
        icon
      )}
      {children !== undefined && children !== null && (
        <span className="btn-label">{children}</span>
      )}
    </button>
  );
}

export interface IconButtonProps extends NativeButton {
  /** accessible name; also shown as the tooltip */
  label: string;
  /** toggle state, exposed as aria-pressed */
  pressed?: boolean;
  size?: "sm" | "md";
  outline?: boolean;
  danger?: boolean;
  /** tooltip text when it should differ from the label */
  tip?: string;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton(props: IconButtonProps) {
  const {
    label,
    pressed,
    size = "md",
    outline,
    danger,
    tip,
    className,
    children,
    ref,
    ...rest
  } = props;
  return (
    <button
      ref={ref}
      type="button"
      className={classes(
        "icon-btn",
        size === "sm" && "icon-btn-sm",
        outline && "icon-btn-outline",
        danger && "icon-btn-danger",
        className,
      )}
      aria-label={label}
      aria-pressed={pressed}
      data-tip={tip ?? label}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A button that reads as a text link (inline actions such as 还原). */
export function LinkButton(
  props: NativeButton & { ref?: Ref<HTMLButtonElement> },
) {
  const { className, ref, ...rest } = props;
  return (
    <button
      ref={ref}
      type="button"
      className={classes("link-btn", className)}
      {...rest}
    />
  );
}

export { classes };
