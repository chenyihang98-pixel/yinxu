/** "理解预览" under the new-piece composer, ~300 ms after typing stops. */
import { useEffect, useState } from "react";
import type { BrainKind } from "../agent/types";
import type { Provider } from "../types";
import { canSendPinsOnly, planPreview } from "./plan";
import type { PlanPreview } from "./plan";
import type { Pins } from "./types";

export function usePlanPreview(
  text: string,
  pins: Pins,
  provider: Provider = "local",
  /** the producer that will really plan: the line promises nothing a language model decides */
  brain: BrainKind = "rules",
  delayMs = 300,
): PlanPreview | null {
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  useEffect(() => {
    // Nothing typed and no style chosen: there is nothing to preview.
    if (!text.trim() && !canSendPinsOnly(text, pins)) {
      setPreview(null);
      return;
    }
    // Offline rules only: nothing leaves the page, nothing touches the draft.
    const timer = setTimeout(
      () => setPreview(planPreview(text, pins, provider, brain)),
      delayMs,
    );
    return () => clearTimeout(timer);
  }, [text, pins, provider, brain, delayMs]);
  return preview;
}
