/**
 * 创作. Without a work: the new-piece composer. With one: the player, the
 * producer thread, the mixer and the inspector — two columns from 1100 px
 * (main + a 320 px inspector, each scrolling on its own), one column below.
 */
import { useCallback, useMemo, useState } from "react";
import { useApp } from "../../state/context";
import { draftFit } from "../../state/format";
import { configFromDraft } from "../../state/logic";
import type { Job } from "../../state/types";
import { lineage } from "../../state/works";
import type { Project } from "../../types";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useRenderCount } from "../hooks/useRenderCount";
import { sameListing, useStableList } from "../hooks/useStable";
import { Progress } from "../primitives/Controls";
import { ComposerHero } from "./ComposerHero";
import { Inspector } from "./Inspector";
import { Mixer } from "./Mixer";
import { PlayerCard } from "./PlayerCard";
import { ProducerThread } from "./ProducerThread";

const NO_NOTES: readonly string[] = [];
const NO_VERSIONS: readonly Project[] = [];

/**
 * A work is being opened and nothing is loaded yet (e.g. session restore):
 * the outline of the player, with the job's progress where the transport
 * will be. The bottom bar carries the live announcement and 取消.
 */
function Opening(props: { job: Job; restoring: boolean }) {
  const { job } = props;
  return (
    <div className="page" data-testid="studio-opening">
      <div className="page-inner hero">
        <section className="card player-card opening" aria-busy="true">
          <header className="player-head" aria-hidden>
            <span className="sk player-cover" />
            <div className="player-id">
              <span className="sk sk-title" />
              <span className="sk sk-meta" />
            </div>
          </header>
          <div className="sk sk-wave" aria-hidden />
          <div className="opening-status">
            <p className="creating-quote">
              {props.restoring ? "正在打开上次的作品" : "正在打开作品"}
            </p>
            <p className="creating-phase">
              {job.phase}
              {job.progress !== null
                ? ` · ${Math.round(job.progress * 100)}%`
                : "…"}
            </p>
            <Progress value={job.progress} label={job.phase} />
          </div>
        </section>
      </div>
    </div>
  );
}

export function StudioPage() {
  useRenderCount("StudioPage");
  const { studio, library, platform, player, actions } = useApp();
  const { project, audio, job } = studio;
  const wide = useMediaQuery("(min-width: 1100px)");
  // Below 720 px the inspector starts folded so the page stays short.
  const [inspectorOpen, setInspectorOpen] = useState(
    () =>
      typeof window === "undefined" ||
      !window.matchMedia ||
      window.matchMedia("(min-width: 720px)").matches,
  );
  const toggleInspector = useCallback(
    () => setInspectorOpen((value) => !value),
    [],
  );
  const changedFields = useStableList(studio.changedFields);
  const listed = useStableList(library.projects, sameListing);
  const suggestions = useStableList(studio.suggestions);
  const parent = useMemo(
    () =>
      project?.parentId
        ? listed.find((item) => item.id === project.parentId)
        : undefined,
    [project?.parentId, listed],
  );
  // Every version of this piece: the thread's version tags, and the way
  // back to the newest one when an earlier version is loaded. Fader moves
  // replace `project` but not its conversation, so this is not recomputed.
  const chat = project?.chat;
  const line = useMemo(
    () => (project ? lineage(project, listed) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.id, project?.revision, project?.parentId, chat, listed],
  );

  // What the local engine will really make of the draft's tempo and length
  // (a loop is fitted to whole bars). A cloud service decides for itself.
  const fitted =
    project && studio.provider === "local"
      ? draftFit(configFromDraft(project.config, studio.draft))
      : null;
  const fit = useMemo(
    () => ({ bpm: fitted?.bpm, duration: fitted?.duration }),
    [fitted?.bpm, fitted?.duration],
  );

  if (!project) {
    if (job?.kind === "open")
      return <Opening job={job} restoring={studio.lastLoad === null} />;
    return (
      <ComposerHero studio={studio} platform={platform} actions={actions} />
    );
  }

  const arrangement = audio?.kind === "stems" ? audio.arrangement : undefined;
  return (
    <div className="studio" data-testid="studio-work">
      <h1 className="sr-only">创作：{project.title}</h1>
      <div className="studio-main">
        <div className="studio-flow">
          <PlayerCard
            project={project}
            audio={audio}
            audioError={studio.audioError}
            saveState={studio.saveState}
            stored={studio.stored}
            lastLoad={studio.lastLoad}
            parent={parent}
            busy={studio.busy}
            player={player}
            actions={actions}
          />
          <ProducerThread
            project={project}
            versions={line?.versions ?? NO_VERSIONS}
            latest={line?.latest ?? project}
            paid={studio.paid}
            thread={studio.thread}
            pendingTurn={studio.pendingTurn}
            turnNotes={studio.turnNotes}
            job={job}
            composerText={studio.composerText}
            suggestions={suggestions}
            engines={studio.engines}
            brains={studio.brains}
            provider={studio.provider}
            activeBrain={studio.activeBrain}
            platform={platform}
            actions={actions}
          />
          {audio && (
            <Mixer
              project={project}
              audio={audio}
              solo={studio.solo}
              actions={actions}
            />
          )}
        </div>
      </div>
      <div className="studio-side">
        <Inspector
          draft={studio.draft}
          changedFields={changedFields}
          canApply={studio.canApplyDraft}
          busy={studio.busy}
          legacy={project.provider === "local" && project.config.engine === 1}
          cloud={project.provider !== "local"}
          paid={studio.paid}
          applyHint={studio.applyHint}
          variationLabel={studio.variationLabel}
          fit={fit}
          notes={arrangement?.notes ?? NO_NOTES}
          collapsible={!wide}
          open={wide || inspectorOpen}
          onToggle={toggleInspector}
          actions={actions}
        />
      </div>
    </div>
  );
}
