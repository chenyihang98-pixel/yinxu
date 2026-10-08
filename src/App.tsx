/**
 * App root: the state provider and the interface on top of it. All logic
 * lives in src/state (hooks, reducer, core) and src/services; the interface
 * (src/ui) only reads `useApp()` and calls its actions.
 */
import { AppProvider } from "./state/context";
import { AppShell } from "./ui/AppShell";

export default function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}
