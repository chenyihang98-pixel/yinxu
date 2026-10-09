/**
 * The interface: navigation, the current page, the bottom bar (job progress
 * and mini transport), modals, toasts. Everything it shows comes from
 * `useApp()`; the page behind an open dialog is inert.
 */
import { useEffect, useRef } from "react";
import { useApp } from "../state/context";
import { useShortcuts } from "../state/shortcuts";
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
import { StudioPage } from "./studio/StudioPage";
import "./styles/index.css";

const BASE_TITLE = "音序 Muse · BGM 创作";

export function AppShell() {
  useRenderCount("AppShell");
  const app = useApp();
  useShortcuts(app);
  const { ui, studio, library, platform, player, actions } = app;
  const overlays = useValueStore(localOverlays);
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
  const barShown = job !== null || mini !== null;
  // What was paid for (or made) and is not safe yet, on every page.
  const banners =
    studio.pending !== null ||
    studio.strays.length > 0 ||
    (studio.unsaved && project !== null);

  const title = project?.title;
  useEffect(() => {
    document.title = title ? `${title} · 音序 Muse` : BASE_TITLE;
  }, [title]);

  return (
    <div
      className="app"
      data-page={ui.page}
      data-platform={platform.isDesktop ? "desktop" : "web"}
      data-embedded={platform.isEmbedded || undefined}
    >
      <div className="app-body" inert={ui.modal !== null || overlays > 0}>
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
