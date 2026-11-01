/**
 * 我的作品: search, favourites, sort, cards with quick play, soft delete
 * (cloud works ask first), records this build cannot read, import, and —
 * on the web — where the works actually live.
 */
import { memo, useCallback, useRef, useState } from "react";
import {
  FileWarning,
  HardDrive,
  Heart,
  Library,
  Pause,
  Play,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useApp } from "../../state/context";
import {
  cardLine,
  formatBytes,
  formatDate,
  formatTime,
} from "../../state/format";
import type { AppActions, LibraryView } from "../../state/types";
import { useLibraryFilter } from "../../state/useLibrary";
import { projectDuration, versionTag } from "../../state/works";
import type { LibrarySort } from "../../state/works";
import type { DamagedRecord } from "../../storage";
import type { Project } from "../../types";
import { useRenderCount } from "../hooks/useRenderCount";
import { Cover } from "../primitives/Art";
import { Button, IconButton } from "../primitives/Button";
import { Badge, Chip, Segmented } from "../primitives/Controls";

const SORTS: { value: LibrarySort; label: string; testId: string }[] = [
  { value: "recent", label: "最近", testId: "library-sort-recent" },
  { value: "title", label: "名称", testId: "library-sort-title" },
  { value: "duration", label: "时长", testId: "library-sort-duration" },
];

const WorkCard = memo(function WorkCard(props: {
  project: Project;
  /** "v3" */
  version: string;
  /** "源自 v2" — where this version came from, when that work still exists */
  origin: string | null;
  /** the whole lineage line, for the tooltip */
  versionTip: string;
  current: boolean;
  /** this is the loaded work and it is playing */
  playing: boolean;
  busy: boolean;
  confirming: boolean;
  onRemove(id: string, confirmed: boolean): void;
  onCancelRemove(): void;
  onPause(): void;
  actions: AppActions;
}) {
  const { project, current, busy, actions } = props;
  const cloud = project.provider !== "local";
  return (
    <li
      className="work-card"
      data-testid="library-card"
      data-project={project.id}
      data-current={current || undefined}
    >
      <button
        type="button"
        className="work-cover"
        data-testid="library-play"
        data-playing={props.playing || undefined}
        aria-label={`播放《${project.title}》`}
        aria-pressed={current ? props.playing : undefined}
        data-tip={props.playing ? "暂停" : current ? "播放" : "打开并播放"}
        disabled={busy}
        onClick={() =>
          props.playing
            ? props.onPause()
            : void actions.openProject(project.id, { autoplay: true })
        }
      >
        <Cover mood={project.config.mood} className="work-art">
          <span className="work-play" aria-hidden>
            {props.playing ? <Pause size={18} /> : <Play size={18} />}
          </span>
        </Cover>
        <span className="work-duration tabular" aria-hidden>
          {formatTime(projectDuration(project))}
        </span>
      </button>
      {current && (
        // On the cover, away from the version line: that line is the only
        // thing that tells two versions of a piece apart.
        <span className="work-now" data-testid="library-current">
          当前打开
        </span>
      )}
      <div className="work-body">
        <button
          type="button"
          className="work-title"
          data-testid="library-open"
          disabled={busy}
          onClick={() => void actions.openProject(project.id)}
        >
          <span className="ellipsis">{project.title}</span>
        </button>
        <p className="work-line ellipsis">{cardLine(project)}</p>
        <p className="work-sub">
          <Badge
            tone={current ? "accent" : "neutral"}
            testId="library-version"
            className="work-version"
            tip={props.origin ? props.versionTip : undefined}
          >
            {props.version}
          </Badge>
          {props.origin && (
            <span
              className="work-origin ellipsis"
              data-testid="library-origin"
              data-tip={props.versionTip}
            >
              {props.origin}
            </span>
          )}
          <time className="work-date tabular" dateTime={project.updatedAt}>
            {formatDate(project.updatedAt)}
          </time>
        </p>
      </div>
      {props.confirming ? (
        <div
          className="work-confirm"
          role="alertdialog"
          aria-label="确认删除"
          aria-describedby={`confirm-${project.id}`}
        >
          <p id={`confirm-${project.id}`}>
            这是{cloud ? "付费生成的音频" : "一首作品"}，删除后无法找回。
          </p>
          <div className="work-confirm-actions">
            <Button
              size="sm"
              data-autofocus
              autoFocus
              onClick={props.onCancelRemove}
            >
              取消
            </Button>
            <Button
              size="sm"
              variant="danger"
              data-testid="library-delete-confirm"
              onClick={() => props.onRemove(project.id, true)}
            >
              确认删除
            </Button>
          </div>
        </div>
      ) : (
        <div className="work-actions">
          <IconButton
            size="sm"
            label={`收藏《${project.title}》`}
            tip={project.favorite ? "取消收藏" : "收藏"}
            pressed={project.favorite}
            data-testid="library-favourite"
            onClick={() => void actions.toggleFavourite(project.id)}
          >
            <Heart
              size={16}
              fill={project.favorite ? "currentColor" : "none"}
              aria-hidden
            />
          </IconButton>
          <IconButton
            size="sm"
            danger
            label={`删除《${project.title}》`}
            tip={cloud ? "删除（需确认）" : "删除（8 秒内可撤销）"}
            data-testid="library-delete"
            disabled={busy}
            onClick={() => props.onRemove(project.id, false)}
          >
            <Trash2 size={16} aria-hidden />
          </IconButton>
        </div>
      )}
    </li>
  );
});

export function DamagedSection(props: {
  records: readonly DamagedRecord[];
  actions: AppActions;
}) {
  const { records, actions } = props;
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <section
      className="card damaged"
      data-testid="damaged-section"
      aria-labelledby="damaged-title"
    >
      <div className="card-head">
        <h2 id="damaged-title">
          <FileWarning size={16} aria-hidden />
          无法读取的记录
          <span className="muted">（{records.length}）</span>
        </h2>
      </div>
      <p className="damaged-lede">
        这些记录不会影响其他作品。可以先导出原始数据（参数与对话，不含音频）留存，再删除；带有音频的记录请先导出原始音频。
      </p>
      <ul className="damaged-list">
        {records.map((record) => (
          <li
            key={record.id}
            className="damaged-row"
            data-testid="damaged-record"
            data-record={record.id}
          >
            <div className="grow">
              <strong className="ellipsis">
                {record.title || "未命名的记录"}
              </strong>
              <p className="damaged-reason" data-testid="damaged-reason">
                {record.reason}
              </p>
              {record.audio && (
                <p className="damaged-audio" data-testid="damaged-audio-note">
                  {record.paid ? "含付费生成的音频" : "含音频"}（
                  {formatBytes(record.audio.size)}）。删除前请先导出原始音频。
                </p>
              )}
              {confirming === record.id && (
                <p
                  className="damaged-audio"
                  role="alert"
                  data-testid="damaged-confirm-note"
                >
                  {record.audio
                    ? record.paid
                      ? "删除后，这段付费生成的音频将无法找回。"
                      : "删除后，这段音频将无法找回。"
                    : "删除后无法找回。"}
                </p>
              )}
            </div>
            <div className="damaged-actions">
              <Button
                size="sm"
                data-testid="damaged-export"
                onClick={() => void actions.exportDamaged(record.id)}
              >
                导出原始数据
              </Button>
              {record.audio && (
                <Button
                  size="sm"
                  variant="primary"
                  data-testid="damaged-export-audio"
                  onClick={() => void actions.exportDamagedAudio(record.id)}
                >
                  导出原始音频
                </Button>
              )}
              {confirming === record.id ? (
                <>
                  <Button size="sm" onClick={() => setConfirming(null)}>
                    取消
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    data-testid="damaged-delete-confirm"
                    autoFocus
                    onClick={() => {
                      setConfirming(null);
                      void actions.removeDamaged(record.id);
                    }}
                  >
                    确认删除
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="damaged-delete"
                  onClick={() => setConfirming(record.id)}
                >
                  删除
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StorageNote(props: { storage: LibraryView["storage"] }) {
  const { storage } = props;
  const used =
    storage && storage.quota > 0
      ? Math.min(1, storage.usage / storage.quota)
      : null;
  return (
    <p className="storage-note" data-testid="storage-note">
      <HardDrive size={15} aria-hidden />
      <span>
        作品只保存在这个浏览器里，清除网站数据会丢失；重要作品请导出。
        {storage && (
          <>
            {" "}
            已用 {formatBytes(storage.usage)}
            {storage.quota ? ` / ${formatBytes(storage.quota)}` : ""}
            {used !== null && used >= 0.8 ? "，空间快满了" : ""}
            {storage.persisted ? " · 已申请持久保存" : ""}
          </>
        )}
      </span>
    </p>
  );
}

export function LibraryPage() {
  useRenderCount("LibraryPage");
  const { library, studio, platform, player, actions } = useApp();
  const filter = useLibraryFilter(library.projects);
  const file = useRef<HTMLInputElement>(null);
  /** id of the work waiting for a second click */
  const [confirming, setConfirming] = useState<string | null>(null);
  const busy = studio.busy;
  const currentId = studio.project?.id ?? null;
  const total = library.projects.length;
  const filtered = filter.search.trim() !== "" || filter.favouritesOnly;

  const remove = useCallback(
    (id: string, confirmed: boolean) => {
      const result = actions.removeProject(id, confirmed);
      setConfirming(result === "confirm" ? id : null);
    },
    [actions],
  );
  const cancelRemove = useCallback(() => setConfirming(null), []);

  return (
    <div className="page" data-testid="library-page">
      <div className="page-inner">
        <header className="page-head">
          <div className="grow">
            <h1 id="library-title">
              我的作品
              <span className="count tabular" data-testid="library-count">
                {filtered ? `${filter.results.length} / ${total}` : total} 首
              </span>
            </h1>
            <p className="page-lede">
              {platform.isDesktop
                ? "每一个版本都保存在这台电脑上，随时可以打开继续调整。"
                : "每一个版本都保存在这个浏览器里，随时可以打开继续调整。"}
            </p>
          </div>
          <Button
            data-testid="import-button"
            icon={<Upload size={15} aria-hidden />}
            data-tip="导入之前导出的工程文件（.json）"
            disabled={busy}
            onClick={() => file.current?.click()}
          >
            导入工程
          </Button>
          <input
            ref={file}
            type="file"
            hidden
            data-testid="import-input"
            accept="application/json,.json"
            aria-label="选择工程文件"
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              event.target.value = "";
              if (chosen) void actions.importFile(chosen);
            }}
          />
        </header>

        <div className="library-tools" role="search">
          <label className="search">
            <Search size={15} aria-hidden />
            <span className="sr-only">搜索作品</span>
            <input
              className="search-input"
              type="search"
              data-testid="library-search"
              placeholder="搜索名称、描述或风格"
              value={filter.search}
              onChange={(event) => filter.setSearch(event.target.value)}
            />
            {filter.search && (
              <IconButton
                size="sm"
                label="清除搜索"
                onClick={() => filter.setSearch("")}
              >
                <X size={14} aria-hidden />
              </IconButton>
            )}
          </label>
          <Chip
            data-testid="library-favourites"
            pressed={filter.favouritesOnly}
            onClick={() => filter.setFavouritesOnly(!filter.favouritesOnly)}
          >
            {!filter.favouritesOnly && <Heart size={13} aria-hidden />}
            只看收藏
          </Chip>
          <span className="grow" />
          <Segmented
            label="排序"
            testId="library-sort"
            value={filter.sort}
            options={SORTS}
            onChange={filter.setSort}
          />
        </div>

        {library.status === "loading" && (
          <p className="library-state" role="status">
            正在读取作品…
          </p>
        )}
        {library.status === "error" && (
          <div
            className="notice notice-danger"
            role="alert"
            data-testid="library-error"
          >
            <FileWarning size={16} aria-hidden />
            <span className="grow">{library.error}</span>
            <Button size="sm" onClick={() => void actions.refreshLibrary()}>
              重试
            </Button>
          </div>
        )}
        {library.status === "ready" && total === 0 && (
          <div className="empty" data-testid="library-empty">
            <span className="empty-art" aria-hidden>
              <Library size={26} />
            </span>
            <h2>还没有作品</h2>
            <p>回到「创作」，写一句话就能生成第一首。</p>
            <Button
              variant="primary"
              icon={<Sparkles size={15} aria-hidden />}
              onClick={() => actions.navigate("studio")}
            >
              去创作
            </Button>
          </div>
        )}
        {total > 0 && filter.results.length === 0 && (
          <div className="empty" data-testid="library-no-match">
            <span className="empty-art" aria-hidden>
              <Search size={24} />
            </span>
            <h2>没有符合条件的作品</h2>
            <p>换个关键词，或者取消「只看收藏」。</p>
            <Button
              onClick={() => {
                filter.setSearch("");
                filter.setFavouritesOnly(false);
              }}
            >
              清除筛选
            </Button>
          </div>
        )}

        {filter.results.length > 0 && (
          <ul className="work-grid" aria-labelledby="library-title">
            {filter.results.map((project) => {
              const version = versionTag(project, library.projects);
              return (
                <WorkCard
                  key={project.id}
                  project={project}
                  version={version.tag}
                  origin={version.origin}
                  versionTip={version.full}
                  current={project.id === currentId}
                  playing={project.id === currentId && player.playing}
                  busy={busy}
                  confirming={confirming === project.id}
                  onRemove={remove}
                  onCancelRemove={cancelRemove}
                  onPause={player.pause}
                  actions={actions}
                />
              );
            })}
          </ul>
        )}

        {library.damaged.length > 0 && (
          <DamagedSection records={library.damaged} actions={actions} />
        )}

        {platform.isWeb && <StorageNote storage={library.storage} />}
      </div>
    </div>
  );
}
