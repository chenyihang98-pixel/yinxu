import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { prewarm } from "./audio/engine";
import { ErrorBoundary } from "./ui/ErrorBoundary";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Start the render worker while the user is still typing the first
// description. Optional: without it the first render simply starts cold.
const idle: (callback: () => void) => unknown =
  typeof requestIdleCallback === "function"
    ? (callback) => requestIdleCallback(callback, { timeout: 3000 })
    : (callback) => setTimeout(callback, 800);
idle(() => {
  try {
    prewarm();
  } catch {
    /* warming is best effort */
  }
});
