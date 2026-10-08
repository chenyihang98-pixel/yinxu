/**
 * The style the offline producer hears in a ready-made prompt — used to give
 * prompt cards the colours of what they will actually produce.
 */
import type { StyleId } from "../../music/catalog";
import { planPreview } from "../../state/plan";

const cache = new Map<string, StyleId>();

export function promptMood(prompt: string): StyleId {
  const known = cache.get(prompt);
  if (known) return known;
  const mood = planPreview(prompt, {})?.config.mood ?? "bright";
  cache.set(prompt, mood);
  return mood;
}
