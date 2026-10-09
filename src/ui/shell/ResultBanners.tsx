/**
 * Paid results that are not safe yet and are not the loaded work — shown on
 * every page, like the unsaved-result banner, until each one is dealt with:
 *
 *  - a result the service made and billed, whose file never arrived
 *    (`studio.pending`): 重新下载, or 放弃这次结果 after a question;
 *  - results that arrived after their job was cancelled and could not be
 *    stored (`studio.strays`): 重试保存, or 导出原始音频.
 *
 * None of them can be closed: what was paid for is never dropped by a
 * stray click.
 */
import { memo, useState } from "react";
import { CloudDownload, Download, RotateCw, TriangleAlert } from "lucide-react";
import { providerName } from "../../providers";
import { joinText } from "../../state/logic";
import type { AppActions, PendingResult, StrayResult } from "../../state/types";
import { Button } from "../primitives/Button";

export const PendingBanner = memo(function PendingBanner(props: {
  pending: PendingResult;
  /** the download of this result is running */
  downloading: boolean;
  /** another job is running, or a question is open */
  locked: boolean;
  actions: AppActions;
}) {
  const { pending, downloading, locked, actions } = props;
  return (
    <div
      className="shell-banner notice notice-warn"
      role="alert"
      data-testid="pending-banner"
      data-provider={pending.provider}
    >
      <CloudDownload size={16} aria-hidden />
      <span className="grow" data-testid="pending-text">
        <strong className="shell-banner-lead">
          {joinText(pending.name, "的一次付费生成还没有取回。")}
        </strong>
        {pending.text}
      </span>
      <span className="shell-banner-actions">
        <Button
          size="sm"
          variant="primary"
          data-testid="pending-download"
          icon={<CloudDownload size={14} aria-hidden />}
          busy={downloading}
          disabled={locked}
          onClick={() => void actions.downloadPending()}
        >
          {downloading ? "正在下载" : "重新下载"}
        </Button>
        <Button
          size="sm"
          data-testid="pending-discard"
          disabled={locked}
          onClick={() => void actions.discardPending()}
        >
          放弃这次结果
        </Button>
      </span>
    </div>
  );
});

export const StrayBanner = memo(function StrayBanner(props: {
  stray: StrayResult;
  actions: AppActions;
}) {
  const { stray, actions } = props;
  const [working, setWorking] = useState<"save" | "export" | null>(null);
  const run = (kind: "save" | "export", task: () => Promise<boolean>) => {
    setWorking(kind);
    void task().finally(() => setWorking(null));
  };
  return (
    <div
      className="shell-banner notice notice-danger"
      role="alert"
      data-testid="stray-banner"
      data-project={stray.id}
    >
      <TriangleAlert size={16} aria-hidden />
      <span className="grow">
        {joinText(
          `《${stray.title}》由`,
          providerName(stray.provider),
          "付费生成，在取消等待后才到达，还没有保存到「我的作品」，现在只存在于当前窗口。请先导出原始音频，或重试保存。",
        )}
      </span>
      <span className="shell-banner-actions">
        <Button
          size="sm"
          data-testid="stray-retry"
          icon={<RotateCw size={14} aria-hidden />}
          busy={working === "save"}
          disabled={working !== null}
          onClick={() => run("save", () => actions.retryStray(stray.id))}
        >
          重试保存
        </Button>
        <Button
          size="sm"
          variant="primary"
          data-testid="stray-export"
          icon={<Download size={14} aria-hidden />}
          busy={working === "export"}
          disabled={working !== null}
          onClick={() => run("export", () => actions.exportStray(stray.id))}
        >
          导出原始音频
        </Button>
      </span>
    </div>
  );
});
