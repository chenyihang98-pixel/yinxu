/**
 * The interface: one of two bodies over the same app core — 简单模式
 * (scenes, one-tap buttons; src/ui/simple) or 专业模式 (navigation, the
 * current page, the bottom bar with job progress and mini transport) — and
 * what both share: modals, the core's questions, toasts and tooltips.
 * Everything comes from `useApp()`; the page behind an open dialog is inert.
 */
import { useEffect, useRef } from "react";
import { useApp } from "../state/context";
import { useShortcuts } from "../state/shortcuts";
import type { AppContextValue } from "../state/types";
import { localOverlays, transportInView } from "./hooks/uiStores";
import { useValueStore } from "./hooks/store";
import { useRenderCount } from "./hooks/useRenderCount";
import { sameListing, useStableList } from "./hooks/useStable";
import { InspirationPage } from "./inspiration/InspirationPage";
import { LibraryPage } from "./library/LibraryPage";
import { ExportModal } from "./modals/ExportModal";
import { HelpModal } from "./modals/HelpModal";
import { SettingsModal } from "./modals/SettingsModal";
import { TooltipLayer } from "./primitives/Tooltip";
import { BottomBar } from "./shell/BottomBar";
import { CoreDialog } from "./shell/CoreDialog";
import { PendingBanner, StrayBanner } from "./shell/ResultBanners";
import { ShellNav } from "./shell/ShellNav";
import { Toasts } from "./shell/Toasts";
import { UnsavedBanner } from "./shell/UnsavedBanner";
import { SimpleBody, simpleBarShown } from "./simple/SimpleShell";
import { StudioPage } from "./studio/StudioPage";
import "./styles/index.css";

const BASE_TITLE = "音序 Muse · BGM 创作";

/** 专业模式: the v0.3 interface, unchanged. */
function ProBody(props: { app: AppContextValue; inert: boolean }) {
  const { ui, studio, library, platform, player, actions } = props.app;
  const inView = useValueStore(transportInView);
  const main = useRef<HTMLElement>(null);
  // the navigation lists works; it has no use for their fader positions
  const listed = useStableList(library.projects, sameListing);

  const { project, job } = studio;
  // A work with audio whose own transport is not on screen gets the mini one.
  const mini =
    project && studio.audio && !(ui.page === "studio" && inView)
      ? project
      : null;
  // What was paid for (or made) and is not safe yet, on every page.
  const banners =
    studio.pending !== null ||
    studio.strays.length > 0 ||
    (studio.unsaved && project !== null);

  return (
    <div className="app-body" inert={props.inert}>
      <button
        type="button"
        className="skip-link"
        onClick={() => main.current?.focus()}
      >
        跳到主要内容
      </button>
      <ShellNav
        page={ui.page}
        projects={listed}
        currentId={project?.id ?? null}
        busy={studio.busy}
        desktop={platform.isDesktop}
        version={platform.version}
        actions={actions}
      />
      <div className="shell-main">
        {banners && (
          <div className="shell-banners">
            {studio.pending && (
              <PendingBanner
                pending={studio.pending}
                downloading={job?.stage === "downloading"}
                locked={job !== null || ui.dialog !== null}
                actions={actions}
              />
            )}
            {studio.strays.map((stray) => (
              <StrayBanner key={stray.id} stray={stray} actions={actions} />
            ))}
            {studio.unsaved && project && (
              <UnsavedBanner
                project={project}
                exporting={studio.exporting}
                actions={actions}
              />
            )}
          </div>
        )}
        <main ref={main} className="page-host" tabIndex={-1}>
          {ui.page === "studio" && <StudioPage />}
          {ui.page === "library" && <LibraryPage />}
          {ui.page === "inspiration" && <InspirationPage />}
        </main>
        <BottomBar job={job} mini={mini} player={player} actions={actions} />
      </div>
      {/* Announces the job phase once per change, wherever the bar is. */}
      <p className="sr-only" role="status" aria-live="polite">
        {job?.phase ?? ""}
      </p>
    </div>
  );
}

export function AppShell() {
  useRenderCount("AppShell");
  const app = useApp();
  useShortcuts(app);
  const { ui, studio, platform, actions } = app;
  const overlays = useValueStore(localOverlays);
  const inView = useValueStore(transportInView);
  const simple = ui.mode === "simple";

  const { project, job } = studio;
  const barShown = simple
    ? simpleBarShown(app)
    : job !== null ||
      (!!project && !!studio.audio && !(ui.page === "studio" && inView));
  const inert = ui.modal !== null || overlays > 0;

  const title = project?.title;
  useEffect(() => {
    document.title = title ? `${title} · 音序 Muse` : BASE_TITLE;
  }, [title]);
  // Dialogs and modals are portaled to <body>: the interface mode is also
  // set on the root, so 简单模式's sizes reach them too (simple.css).
  useEffect(() => {
    document.documentElement.setAttribute("data-mode", ui.mode);
  }, [ui.mode]);

  return (
    <div
      className="app"
      data-mode={ui.mode}
      data-page={ui.page}
      data-platform={platform.isDesktop ? "desktop" : "web"}
      data-embedded={platform.isEmbedded || undefined}
    >
      {simple ? (
        <SimpleBody app={app} inert={inert} />
      ) : (
        <ProBody app={app} inert={inert} />
      )}
      {ui.modal === "settings" && <SettingsModal />}
      {ui.modal === "export" && <ExportModal />}
      {ui.modal === "help" && <HelpModal />}
      {ui.dialog && (
        <CoreDialog key={ui.dialog.id} dialog={ui.dialog} actions={actions} />
      )}
      <Toasts toasts={ui.toasts} raised={barShown} actions={actions} />
      <TooltipLayer />
    </div>
  );
}
