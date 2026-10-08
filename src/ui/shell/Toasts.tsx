/** Bottom-centre notices: a polite live region that is always mounted. */
import { memo } from "react";
import { CircleAlert, CircleCheck, X } from "lucide-react";
import type { AppActions, Toast } from "../../state/types";
import { Button, IconButton } from "../primitives/Button";

export const Toasts = memo(function Toasts(props: {
  toasts: readonly Toast[];
  /** the bottom bar is showing: sit above it */
  raised: boolean;
  actions: AppActions;
}) {
  const { toasts, actions } = props;
  return (
    <div
      className="toasts"
      role="status"
      aria-live="polite"
      aria-relevant="additions text"
      data-raised={props.raised}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="toast"
          data-testid="toast"
          data-kind={toast.kind}
        >
          {toast.kind === "error" ? (
            <CircleAlert className="toast-icon" size={18} aria-hidden />
          ) : (
            <CircleCheck className="toast-icon" size={18} aria-hidden />
          )}
          <span>{toast.text}</span>
          {toast.action && (
            <Button
              size="sm"
              variant="primary"
              data-testid="toast-action"
              onClick={() => {
                toast.action?.run();
                actions.dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </Button>
          )}
          <IconButton
            size="sm"
            label="关闭提示"
            data-testid="toast-close"
            onClick={() => actions.dismissToast(toast.id)}
          >
            <X size={16} aria-hidden />
          </IconButton>
        </div>
      ))}
    </div>
  );
});
