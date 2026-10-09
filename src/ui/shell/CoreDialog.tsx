/**
 * A question from the app core (`ui.dialog`): a paid request about to be
 * sent, a language model that failed before a paid request, an unsaved
 * result about to be left. Escape and the close button give the dialog's
 * cancel answer; nothing behind it can be used until it is answered.
 */
import { useState } from "react";
import { CircleAlert, CircleDollarSign, Save } from "lucide-react";
import type { AppActions, Dialog } from "../../state/types";
import { Button } from "../primitives/Button";
import { Modal } from "../primitives/Modal";

const ICONS = {
  paid: CircleDollarSign,
  fallback: CircleAlert,
  unsaved: Save,
} as const;

export function CoreDialog(props: { dialog: Dialog; actions: AppActions }) {
  const { dialog, actions } = props;
  const [remember, setRemember] = useState(false);
  const Icon = ICONS[dialog.kind];
  const answer = (choice: string) =>
    actions.answerDialog(dialog.id, choice, remember);
  // The safe answer has the focus: Enter never confirms a payment or a loss.
  const safe = dialog.cancel;
  return (
    <Modal
      local
      title={dialog.title}
      icon={<Icon size={18} />}
      testId={`dialog-${dialog.kind}`}
      onClose={() => answer(dialog.cancel)}
      footer={
        <>
          {dialog.choices.map((choice) => (
            <Button
              key={choice.id}
              variant={choice.variant ?? "secondary"}
              data-testid={`dialog-choice-${choice.id}`}
              data-autofocus={choice.id === safe ? "" : undefined}
              onClick={() => answer(choice.id)}
            >
              {choice.label}
            </Button>
          ))}
        </>
      }
    >
      <div className="dialog-body" data-testid="dialog-body">
        {dialog.body.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
        {dialog.remember && (
          <label className="dialog-remember">
            <input
              type="checkbox"
              data-testid="dialog-remember"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>{dialog.remember}</span>
          </label>
        )}
      </div>
    </Modal>
  );
}
