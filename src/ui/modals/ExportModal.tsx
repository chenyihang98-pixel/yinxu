/**
 * 导出. Every file is built from the committed work: the full mix at the
 * saved faders, one stem, the provider's original bytes or the recipe. Solo
 * and the listening volume are not inputs.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import {
  Download,
  Drum,
  FileAudio,
  FileJson,
  FileMusic,
  Guitar,
  Layers,
  LoaderCircle,
  Music2,
  TriangleAlert,
} from "lucide-react";
import { LOOP_REPEATS, exportChoices } from "../../services/exporter";
import type { ExportOptionId } from "../../services/exporter";
import { useApp } from "../../state/context";
import { engineBadge, formatTime } from "../../state/format";
import type { ExportRequest } from "../../state/types";
import { Segmented } from "../primitives/Controls";
import { Modal } from "../primitives/Modal";

const ICONS: Record<ExportOptionId, ReactNode> = {
  mix: <FileAudio size={18} aria-hidden />,
  "stem-melody": <Music2 size={18} aria-hidden />,
  "stem-chords": <Layers size={18} aria-hidden />,
  "stem-bass": <Guitar size={18} aria-hidden />,
  "stem-drums": <Drum size={18} aria-hidden />,
  original: <FileMusic size={18} aria-hidden />,
  project: <FileJson size={18} aria-hidden />,
};

export function ExportModal() {
  const { studio, platform, actions } = useApp();
  const { project, audio } = studio;
  const [repeats, setRepeats] = useState<1 | 2 | 4>(1);
  const [fade, setFade] = useState(true);
  if (!project) return null;
  const choices = exportChoices(project, audio);
  const request = (base: ExportRequest): ExportRequest =>
    base.kind === "mix"
      ? {
          kind: "mix",
          ...(choices.canRepeat ? { repeats } : {}),
          ...(choices.canFade ? { fade } : {}),
        }
      : base;
  const mix = choices.options.find((option) => option.id === "mix");
  const rest = choices.options.filter((option) => option.id !== "mix");
  const row = (option: (typeof choices.options)[number], primary = false) => (
    <li key={option.id}>
      <button
        type="button"
        className="export-option"
        data-testid={`export-option-${option.id}`}
        data-primary={primary || undefined}
        disabled={studio.exporting}
        onClick={() => void actions.exportWork(request(option.request))}
      >
        <span className="export-icon" data-kind={option.id}>
          {ICONS[option.id]}
        </span>
        <span className="export-text">
          <strong>{option.title}</strong>
          <span>{option.detail}</span>
        </span>
        <Download className="export-go" size={16} aria-hidden />
      </button>
    </li>
  );
  return (
    <Modal
      title="导出"
      subtitle={`${project.title} · v${project.revision} · ${engineBadge(project)}${
        audio ? ` · ${formatTime(audio.duration)}` : ""
      }`}
      icon={<Download size={18} />}
      testId="export-modal"
      onClose={actions.closeModal}
    >
      <div className="export">
        {studio.audioError && (
          <p className="notice notice-warn">
            <TriangleAlert size={16} aria-hidden />
            <span>{studio.audioError}</span>
          </p>
        )}

        {mix && (
          <section className="export-group" aria-label="完整混音">
            <ul className="export-list">{row(mix, true)}</ul>
            {choices.canRepeat && (
              <div className="export-setting">
                <div>
                  <strong id="export-repeats-label">循环次数</strong>
                  <p className="muted">
                    把这段循环首尾相接重复几遍，方便直接铺满时间线。
                  </p>
                </div>
                <Segmented<1 | 2 | 4>
                  label="循环次数"
                  testId="export-repeats"
                  value={repeats}
                  options={LOOP_REPEATS.map((count) => ({
                    value: count,
                    label: `${count} 次${
                      audio ? ` · ${formatTime(audio.duration * count)}` : ""
                    }`,
                    testId: `export-repeats-${count}`,
                  }))}
                  onChange={setRepeats}
                />
              </div>
            )}
            {choices.canFade && (
              <label className="export-check">
                <input
                  type="checkbox"
                  data-testid="export-fade"
                  checked={fade}
                  onChange={(event) => setFade(event.target.checked)}
                />
                <span>
                  <strong>头尾各 1 秒淡入淡出</strong>
                  <span className="muted">避免开头和结尾突然出现或中断</span>
                </span>
              </label>
            )}
          </section>
        )}

        {rest.length > 0 && (
          <section className="export-group" aria-label="其他文件">
            <h3 className="export-heading">
              {audio?.kind === "stems" ? "分轨与工程" : "其他文件"}
            </h3>
            <ul className="export-list export-list-grid">
              {rest.map((option) => row(option))}
            </ul>
          </section>
        )}

        {choices.options.length === 0 && (
          <p className="notice notice-warn">
            <TriangleAlert size={16} aria-hidden />
            <span>这首作品的音频不可用，暂时没有可以导出的文件。</span>
          </p>
        )}

        <p className="export-note" role="status">
          {studio.exporting ? (
            <>
              <LoaderCircle className="spin" size={14} aria-hidden />
              正在准备文件…
            </>
          ) : (
            <>
              导出的是已保存的混音，不受独奏和试听音量影响。
              {platform.isWeb ? "文件会下载到浏览器的下载目录。" : ""}
              {project.provider !== "local"
                ? "云端生成作品的使用权以服务商条款为准。"
                : ""}
            </>
          )}
        </p>
      </div>
    </Modal>
  );
}
