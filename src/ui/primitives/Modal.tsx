/**
 * Dialog / sheet. Centred on wide screens, a full-screen sheet below 720 px.
 * Focus moves in and is trapped, Tab wraps, the previously focused element
 * gets focus back on close, and the page behind is inert (the shell reads
 * `ui.modal` and the `localOverlays` count).
 */
import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { localOverlays } from "../hooks/uiStores";
import { focusables, trapTarget } from "../logic/focus";
import { IconButton, classes } from "./Button";

export interface ModalProps {
  title: string;
  /** one line under the title */
  subtitle?: ReactNode;
  icon?: ReactNode;
  testId: string;
  onClose(): void;
  size?: "md" | "lg";
  /**
   * true for sheets that are not `ui.modal`: the dialog closes itself on
   * Escape, keeps global shortcuts out and marks the page inert.
   */
  local?: boolean;
  /** pinned under the scrolling body */
  footer?: ReactNode;
  /** rendered between the header and the body (tabs) */
  toolbar?: ReactNode;
  children: ReactNode;
}

export function Modal(props: ModalProps) {
  const { title, onClose, local } = props;
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const before =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const node = dialog.current;
    (node?.querySelector<HTMLElement>("[data-autofocus]") ?? node)?.focus({
      preventScroll: true,
    });
    return () => {
      if (!before?.isConnected) return;
      const restore = () => {
        const active = document.activeElement;
        // only when focus has nowhere to be; never steal it back
        if (before.isConnected && (!active || active === document.body))
          before.focus({ preventScroll: true });
      };
      // The page may stay inert until the render that follows this one.
      if (before.closest("[inert]")) requestAnimationFrame(restore);
      else before.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (!local) return;
    localOverlays.set(localOverlays.get() + 1);
    return () => localOverlays.set(Math.max(0, localOverlays.get() - 1));
  }, [local]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const node = dialog.current;
    if (event.key === "Tab" && node) {
      const active =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const target = trapTarget(focusables(node), active, event.shiftKey);
      if (target) {
        event.preventDefault();
        target.focus();
      }
    }
    if (!local) return;
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onClose();
    }
    // A local sheet owns the keyboard: Space, L and the arrows stay inside.
    event.stopPropagation();
  };

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className={classes("modal", props.size === "lg" && "modal-lg")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={props.testId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="modal-head">
          {props.icon && (
            <span className="modal-icon" aria-hidden>
              {props.icon}
            </span>
          )}
          <div className="grow">
            <h2 id={titleId}>{title}</h2>
            {props.subtitle && (
              <p className="modal-subtitle ellipsis">{props.subtitle}</p>
            )}
          </div>
          <IconButton
            label="关闭"
            tip="关闭（Esc）"
            data-testid="modal-close"
            onClick={onClose}
          >
            <X size={18} aria-hidden />
          </IconButton>
        </header>
        {props.toolbar}
        <div className="modal-body">{props.children}</div>
        {props.footer && <footer className="modal-foot">{props.footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
