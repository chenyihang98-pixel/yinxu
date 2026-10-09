/**
 * Render counter for performance work, in development builds only
 * (`npm run dev`): set `window.__museRenders = {}` in the console and every
 * render of a counted component is tallied there by name. A production build
 * replaces `import.meta.env.DEV` with false, so nothing of this ships.
 */
export function useRenderCount(name: string): void {
  if (!import.meta.env.DEV) return;
  const counts = (window as { __museRenders?: Record<string, number> })
    .__museRenders;
  if (counts) counts[name] = (counts[name] ?? 0) + 1;
}
