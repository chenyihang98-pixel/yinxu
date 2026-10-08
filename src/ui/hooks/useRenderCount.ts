/**
 * Render counter for performance checks. Costs one property read unless a
 * test or a developer creates `window.__museRenders = {}` before the app
 * starts; then every render of a counted component is tallied by name.
 */
export function useRenderCount(name: string): void {
  if (typeof window === "undefined") return;
  const counts = (window as { __museRenders?: Record<string, number> })
    .__museRenders;
  if (counts) counts[name] = (counts[name] ?? 0) + 1;
}
