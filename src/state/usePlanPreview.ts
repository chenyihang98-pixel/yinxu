/** "理解预览" under the new-piece composer, ~300 ms after typing stops. */
import { useEffect, useState } from "react";
import { planPreview } from "./plan";
import type { PlanPreview } from "./plan";
import type { Pins } from "./types";

export function usePlanPreview(
  text: string,
  pins: Pins,
  delayMs = 300,
): PlanPreview | null {
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  useEffect(() => {
    if (!text.trim()) {
      setPreview(null);
      return;
    }
    // Offline rules only: nothing leaves the page, nothing touches the draft.
    const timer = setTimeout(() => setPreview(planPreview(text, pins)), delayMs);
    return () => clearTimeout(timer);
  }, [text, pins, delayMs]);
  return preview;
}
