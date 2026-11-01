/**
 * 简单模式's body: a slim top bar (做音乐 · 我的音乐, help, settings), the
 * same banners as 专业模式 for whatever was paid for or made and is not safe
 * yet, one page, and — on 我的音乐 only — the bar with the running job and
 * the loaded piece. Everything else (modals, questions, toasts) is shared
 * with 专业模式 in AppShell.
 */
import { memo, useMemo, useRef } from "react";
import { CircleHelp, Library, Settings, Sparkles } from "lucide-react";
import { plainPhase } from "../../state/plain";
import type { AppActions, AppContextValue } from "../../state/types";
import { groupPieces } from "../../state/works";
import { LogoMark } from "../primitives/Art";
import { BottomBar } from "../shell/BottomBar";
import { PendingBanner, StrayBanner } from "../shell/ResultBanners";
import { UnsavedBanner } from "../shell/UnsavedBanner";
import { SimpleLibraryPage } from "./SimpleLibraryPage";
import { SimpleStudio } from "./SimpleStudio";

/** The bottom bar is up (toasts sit above it): only on 我的音乐. */
export function simpleBarShown(app: AppContextValue): boolean {
  const { ui, studio } = app;
  return (
    ui.page === "library" &&
    (studio.job !== null || (!!studio.project && !!studio.audio))
  );
}

const SimpleNav = memo(function SimpleNav(props: {
  library: boolean;
  /** pieces in the library */
  count: number;
  actions: AppActions;
}) {
  const { actions } = props;
  return (
    <header className="simple-nav">
      <span className="simple-brand">
        <LogoMark size={30} />
        <span className="simple-brand-name">音序</span>
      </span>
      <nav className="simple-tabs" aria-label="主导航">
        <button
          type="button"
          className="simple-tab"
          data-testid="simple-nav-make"
          aria-current={props.library ? undefined : "page"}
          onClick={() => actions.navigate("studio")}
        >
          <Sparkles size={18} aria-hidden />
          <span>做音乐</span>
        </button>
        <button
          type="button"
          className="simple-tab"
          data-testid="simple-nav-library"
          aria-current={props.library ? "page" : undefined}
          onClick={() => actions.navigate("library")}
        >
          <Library size={18} aria-hidden />
          <span>我的音乐</span>
          {props.count > 0 && (
            <span className="simple-tab-count tabular">
              {props.count}
              <span className="sr-only"> 首</span>
            </span>
          )}
        </button>
      </nav>
      <span className="simple-nav-tools">
        <button
          type="button"
          className="simple-tool"
          data-testid="help-button"
          aria-label="怎么用"
          data-tip="怎么用"
          onClick={() => actions.openModal("help")}
        >
          <CircleHelp size={20} aria-hidden />
        </button>
        <button
          type="button"
          className="simple-tool"
          data-testid="settings-button"
          aria-label="设置"
          data-tip="设置"
          onClick={() => actions.openModal("settings")}
        >
          <Settings size={20} aria-hidden />
        </button>
      </span>
    </header>
  );
});

export function SimpleBody(props: { app: AppContextValue; inert: boolean }) {
  const { ui, studio, library, player, actions } = props.app;
  const main = useRef<HTMLElement>(null);
  const onLibrary = ui.page === "library";
  const { project, job } = studio;
  const pieces = useMemo(
    () => groupPieces(library.projects).length,
    [library.projects],
  );
  const banners =
    studio.pending !== null ||
    studio.strays.length > 0 ||
    (studio.unsaved && project !== null);
  const mini = onLibrary && project && studio.audio ? project : null;

  return (
    <div className="app-body simple-body" inert={props.inert}>
      <button
        type="button"
        className="skip-link"
        onClick={() => main.current?.focus()}
      >
        跳到主要内容
      </button>
      <SimpleNav library={onLibrary} count={pieces} actions={actions} />
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
                simple
                actions={actions}
              />
            )}
          </div>
        )}
        <main ref={main} className="page-host" tabIndex={-1}>
          {onLibrary ? <SimpleLibraryPage /> : <SimpleStudio />}
        </main>
        {onLibrary && (
          <BottomBar
            job={job}
            mini={mini}
            player={player}
            simple
            actions={actions}
          />
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {job ? plainPhase(job) : ""}
      </p>
    </div>
  );
}
