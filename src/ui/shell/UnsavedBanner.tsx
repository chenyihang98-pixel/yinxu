/**
 * Shown on every page for as long as the loaded work exists only in this
 * window (its save failed): what happened, and the two ways out — try the
 * library again, or take the audio away as a file.
 */
import { memo, useState } from "react";
import { Download, RotateCw, TriangleAlert } from "lucide-react";
import { providerName } from "../../providers";
import { joinText } from "../../state/logic";
import type { AppActions } from "../../state/types";
import type { Project } from "../../types";
import { Button } from "../primitives/Button";

export const UnsavedBanner = memo(function UnsavedBanner(props: {
  project: Project;
  exporting: boolean;
  /** 简单模式: its words, and 下载音乐 saves the piece at once */
  simple?: boolean;
  actions: AppActions;
}) {
  const { project, actions } = props;
  const [retrying, setRetrying] = useState(false);
  const paid = project.provider !== "local";
  const original = paid && !!project.audioBlob;
  const simple = props.simple === true;
  return (
    <div
      className="shell-banner unsaved-banner notice notice-danger"
      role="alert"
      data-testid="unsaved-banner"
      data-paid={paid || undefined}
    >
      <TriangleAlert size={16} aria-hidden />
      <span className="grow">
        {simple
          ? paid
            ? joinText(
                `《${project.title}》由`,
                providerName(project.provider),
                "付费做好了，但还没能存进「我的音乐」，现在只在这个窗口里。请先点「下载音乐」把它存下来，或者点「重试保存」。",
              )
            : `《${project.title}》还没能存进「我的音乐」，现在只在这个窗口里。请先点「下载音乐」把它存下来，或者点「重试保存」。`
          : paid
            ? joinText(
                `《${project.title}》由`,
                providerName(project.provider),
                "付费生成，但还没有保存到「我的作品」，现在只存在于当前窗口。请先导出原始音频，或重试保存。",
              )
            : `《${project.title}》还没有保存到「我的作品」，现在只存在于当前窗口。请先导出，或重试保存。`}
      </span>
      <span className="shell-banner-actions unsaved-actions">
        <Button
          size="sm"
          data-testid="retry-save"
          icon={<RotateCw size={14} aria-hidden />}
          busy={retrying}
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void actions.retrySave().finally(() => setRetrying(false));
          }}
        >
          重试保存
        </Button>
        <Button
          size="sm"
          variant="primary"
          data-testid="unsaved-export"
          icon={<Download size={14} aria-hidden />}
          disabled={props.exporting}
          onClick={() =>
            simple
              ? void actions.downloadMusic()
              : original
                ? void actions.exportWork({ kind: "original" })
                : actions.openModal("export")
          }
        >
          {simple ? "下载音乐" : original ? "导出原始音频" : "导出"}
        </Button>
      </span>
    </div>
  );
});
