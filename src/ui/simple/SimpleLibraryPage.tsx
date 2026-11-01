/**
 * 我的音乐 in 简单模式: one card per piece (its newest version; 共 3 版 when
 * there are more), a search box, and on each card 播放 · 下载 · 删除 — 删除
 * takes every version of the piece, with the usual 8 s 撤销 (and a question
 * first when it was paid for). Records this build cannot read keep their
 * own section: their raw data must stay exportable.
 */
import { memo, useCallback, useMemo, useState } from "react";
import {
  Download,
  FileWarning,
  HardDrive,
  Library,
  Pause,
  Play,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useApp } from "../../state/context";
import { plainSummary, plainWords } from "../../state/plain";
import type { AppActions } from "../../state/types";
import { groupPieces, queryProjects } from "../../state/works";
import type { Piece } from "../../state/works";
import { useRenderCount } from "../hooks/useRenderCount";
import { DamagedSection } from "../library/LibraryPage";
import { Cover } from "../primitives/Art";
import { Button, IconButton } from "../primitives/Button";
import { PlainLine, ProLink } from "./parts";

const PieceCard = memo(function PieceCard(props: {
  piece: Piece;
  /** a version of this piece is the loaded work */
  current: boolean;
  /** …and it is playing */
  playing: boolean;
  busy: boolean;
  confirming: boolean;
  onPlay(piece: Piece): void;
  onDownload(piece: Piece): void;
  onRemove(piece: Piece, confirmed: boolean): void;
  onCancelRemove(): void;
  actions: AppActions;
}) {
  const { piece, current, playing, busy, actions } = props;
  const { latest, versions } = piece;
  const paid = versions.some((item) => item.provider !== "local");
  return (
    <li
      className="simple-card"
      data-testid="simple-card"
      data-project={latest.id}
      data-current={current || undefined}
    >
      <button
        type="button"
        className="simple-card-cover"
        data-testid="simple-card-play"
        data-playing={playing || undefined}
        aria-label={`${playing ? "暂停" : "播放"}《${latest.title}》`}
        disabled={busy && !current}
        onClick={() => props.onPlay(piece)}
      >
        <Cover mood={latest.config.mood} className="simple-card-art">
          <span className="simple-card-glyph" aria-hidden>
            {playing ? <Pause size={22} /> : <Play size={22} />}
          </span>
        </Cover>
      </button>
      <div className="simple-card-body">
        <button
          type="button"
          className="simple-card-title"
          data-testid="simple-card-open"
          disabled={busy}
          onClick={() => void actions.openProject(latest.id)}
        >
          <span className="ellipsis">{latest.title}</span>
        </button>
        <p className="simple-card-line">
          <PlainLine text={plainSummary(latest)} />
        </p>
        {versions.length > 1 && (
          <p
            className="simple-card-versions"
            data-testid="simple-card-versions"
          >
            共 {versions.length} 版
          </p>
        )}
      </div>
      {props.confirming ? (
        <div
          className="simple-card-confirm"
          role="alertdialog"
          aria-label="确认删除"
          aria-describedby={`simple-confirm-${latest.id}`}
        >
          <p id={`simple-confirm-${latest.id}`}>
            这首是付费做的。删除后 8 秒内还能撤销，之后就找不回来了。
          </p>
          <div className="simple-card-actions">
            <Button autoFocus onClick={props.onCancelRemove}>
              取消
            </Button>
            <Button
              variant="danger"
              data-testid="simple-card-delete-confirm"
              onClick={() => props.onRemove(piece, true)}
            >
              确认删除
            </Button>
          </div>
        </div>
      ) : (
        <div className="simple-card-actions">
          <Button
            data-testid="simple-card-download"
            icon={<Download size={16} aria-hidden />}
            disabled={busy}
            onClick={() => props.onDownload(piece)}
          >
            下载
          </Button>
          <Button
            variant="ghost"
            className="simple-card-delete"
            data-testid="simple-card-delete"
            icon={<Trash2 size={16} aria-hidden />}
            aria-label={`删除《${latest.title}》`}
            data-tip={paid ? "删除（会先问你）" : "删除（8 秒内可以撤销）"}
            disabled={busy}
            onClick={() => props.onRemove(piece, false)}
          >
            删除
          </Button>
        </div>
      )}
    </li>
  );
});

export function SimpleLibraryPage() {
  useRenderCount("SimpleLibraryPage");
  const { library, studio, platform, player, actions } = useApp();
  const [search, setSearch] = useState("");
  /** the piece waiting for its second click (paid audio) */
  const [confirming, setConfirming] = useState<string | null>(null);
  const currentId = studio.project?.id ?? null;
  // the loaded version stands for its piece (it is the one being listened to)
  const pieces = useMemo(
    () => groupPieces(library.projects, currentId),
    [library.projects, currentId],
  );
  const shown = useMemo(() => {
    if (!search.trim()) return pieces;
    return pieces.filter(
      (piece) => queryProjects(piece.versions, { search }).length > 0,
    );
  }, [pieces, search]);
  const busy = studio.busy;
  const total = pieces.length;

  const play = useCallback(
    (piece: Piece) => {
      const loaded = piece.versions.some((item) => item.id === currentId);
      // The piece that is loaded plays (or pauses); another one is opened
      // and played — right here, the list stays where it is.
      if (loaded && studio.audio) player.toggle();
      else
        void actions.openProject(piece.latest.id, {
          autoplay: true,
          stay: true,
        });
    },
    [actions, player, currentId, studio.audio],
  );
  const download = useCallback(
    (piece: Piece) => {
      // another piece is opened first, without leaving 我的音乐
      void actions.downloadMusic(piece.latest.id);
    },
    [actions],
  );
  const remove = useCallback(
    (piece: Piece, confirmed: boolean) => {
      const paid = piece.versions.some((item) => item.provider !== "local");
      if (paid && !confirmed) {
        setConfirming(piece.latest.id);
        return;
      }
      setConfirming(null);
      // every version of the piece: one 撤销 brings them all back
      for (const item of piece.versions) actions.removeProject(item.id, true);
    },
    [actions],
  );
  const cancelRemove = useCallback(() => setConfirming(null), []);

  return (
    <div className="page simple-page" data-testid="simple-library">
      <div className="page-inner simple-inner">
        <header className="simple-head simple-library-head">
          <h1 id="simple-library-title">
            我的音乐
            {total > 0 && (
              <span className="simple-count tabular" data-testid="simple-count">
                {total} 首
              </span>
            )}
          </h1>
          {total > 0 && (
            <label className="search simple-search">
              <Search size={16} aria-hidden />
              <span className="sr-only">搜索</span>
              <input
                className="search-input"
                type="search"
                data-testid="simple-search"
                placeholder="搜索名字"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search && (
                <IconButton
                  size="sm"
                  label="清除搜索"
                  onClick={() => setSearch("")}
                >
                  <X size={14} aria-hidden />
                </IconButton>
              )}
            </label>
          )}
        </header>

        {library.status === "loading" && (
          <p className="library-state" role="status">
            正在读取…
          </p>
        )}
        {library.status === "error" && (
          <div className="notice notice-danger" role="alert">
            <FileWarning size={16} aria-hidden />
            <span className="grow">{plainWords(library.error ?? "")}</span>
            <Button size="sm" onClick={() => void actions.refreshLibrary()}>
              重试
            </Button>
          </div>
        )}
        {library.status === "ready" && total === 0 && (
          <div
            className="empty simple-empty"
            data-testid="simple-library-empty"
          >
            <span className="empty-art" aria-hidden>
              <Library size={26} />
            </span>
            <h2>还没有音乐</h2>
            <p>去「做音乐」点一个场景，几秒钟就有第一首。</p>
            <Button
              variant="primary"
              size="lg"
              icon={<Sparkles size={16} aria-hidden />}
              onClick={() => actions.navigate("studio")}
            >
              去做音乐
            </Button>
          </div>
        )}
        {total > 0 && shown.length === 0 && (
          <div className="empty simple-empty">
            <span className="empty-art" aria-hidden>
              <Search size={24} />
            </span>
            <h2>没有找到</h2>
            <p>换个词试试。</p>
            <Button onClick={() => setSearch("")}>清除搜索</Button>
          </div>
        )}

        {shown.length > 0 && (
          <ul className="simple-cards" aria-labelledby="simple-library-title">
            {shown.map((piece) => {
              const current = piece.versions.some(
                (item) => item.id === currentId,
              );
              return (
                <PieceCard
                  key={piece.latest.id}
                  piece={piece}
                  current={current}
                  playing={current && player.playing}
                  busy={busy}
                  confirming={confirming === piece.latest.id}
                  onPlay={play}
                  onDownload={download}
                  onRemove={remove}
                  onCancelRemove={cancelRemove}
                  actions={actions}
                />
              );
            })}
          </ul>
        )}

        {library.damaged.length > 0 && (
          <DamagedSection records={library.damaged} simple actions={actions} />
        )}

        {platform.isWeb && total > 0 && (
          <p className="storage-note simple-storage" data-testid="storage-note">
            <HardDrive size={15} aria-hidden />
            <span>
              这些音乐只保存在这个浏览器里，清除网站数据会丢失，重要的请先下载。
            </span>
          </p>
        )}

        <ProLink actions={actions} />
      </div>
    </div>
  );
}
