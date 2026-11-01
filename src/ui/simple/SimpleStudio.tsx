/**
 * 做音乐 in 简单模式: the scene page without a piece, the piece itself
 * once there is one — and, while the last session's piece is being opened,
 * a progress in its place.
 */
import { useApp } from "../../state/context";
import { ProLink, SimpleProgress } from "./parts";
import { SimpleMakePage } from "./SimpleMakePage";
import { SimpleResultPage } from "./SimpleResultPage";

export function SimpleStudio() {
  const { studio, actions } = useApp();
  if (studio.project) return <SimpleResultPage />;
  if (studio.job?.kind === "open")
    return (
      <div className="page simple-page" data-testid="simple-opening">
        <div className="page-inner simple-inner">
          <SimpleProgress
            job={studio.job}
            title={
              studio.lastLoad === null ? "正在打开上次的音乐" : "正在打开音乐"
            }
            actions={actions}
          />
          <ProLink actions={actions} />
        </div>
      </div>
    );
  return <SimpleMakePage />;
}
