/**
 * Navigation. One element with two layouts: a 216 px sidebar from 1100 px
 * up, a top bar below that (labels shrink to icons under 520 px).
 */
import { memo } from "react";
import {
  CircleHelp,
  Library,
  Lightbulb,
  Plus,
  Settings,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { styleInfo } from "../../music/catalog";
import type { AppActions, Page } from "../../state/types";
import type { Project } from "../../types";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useRenderCount } from "../hooks/useRenderCount";
import { LogoMark } from "../primitives/Art";
import { Button } from "../primitives/Button";

const PAGES: { id: Page; label: string; icon: LucideIcon }[] = [
  { id: "studio", label: "创作", icon: Sparkles },
  { id: "library", label: "我的作品", icon: Library },
  { id: "inspiration", label: "灵感", icon: Lightbulb },
];

const RECENT_COUNT = 8;

export interface ShellNavProps {
  page: Page;
  /** newest first */
  projects: readonly Project[];
  currentId: string | null;
  busy: boolean;
  desktop: boolean;
  version: string;
  actions: AppActions;
}

export const ShellNav = memo(function ShellNav(props: ShellNavProps) {
  useRenderCount("ShellNav");
  const { page, projects, currentId, busy, desktop, version, actions } = props;
  const iconTabs = useMediaQuery("(max-width: 519px)");
  const compact = useMediaQuery("(max-width: 1099px)");
  const recents = projects.slice(0, RECENT_COUNT);
  return (
    <header className="shell-nav">
      <div className="brand">
        <LogoMark size={30} />
        <span className="brand-name">
          音序 <em>Muse</em>
        </span>
      </div>

      <nav className="nav" aria-label="主导航">
        {PAGES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className="nav-item"
            data-testid={`nav-${id}`}
            aria-current={page === id ? "page" : undefined}
            data-tip={iconTabs ? label : undefined}
            onClick={() => actions.navigate(id)}
          >
            <Icon size={18} aria-hidden />
            <span className="nav-label">{label}</span>
            {id === "library" && projects.length > 0 && (
              <span className="nav-count">
                {projects.length}
                <span className="sr-only"> 首</span>
              </span>
            )}
          </button>
        ))}
      </nav>

      <Button
        className="new-piece"
        data-testid="new-piece"
        icon={<Plus size={16} aria-hidden />}
        disabled={busy}
        aria-label="新建创作"
        data-tip={compact ? "新建创作" : undefined}
        onClick={() => actions.newPiece()}
      >
        新建创作
        {desktop && <kbd aria-hidden>Ctrl N</kbd>}
      </Button>

      <section className="recents" aria-label="最近作品">
        <h2 className="recents-title">最近作品</h2>
        {recents.length === 0 ? (
          <p className="recents-empty">生成的作品会出现在这里。</p>
        ) : (
          <ul className="recents-list">
            {recents.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  className="recent"
                  data-testid="recent-work"
                  aria-current={project.id === currentId ? "true" : undefined}
                  disabled={busy && project.id !== currentId}
                  onClick={() => void actions.openProject(project.id)}
                >
                  <span
                    className="recent-swatch"
                    style={{
                      background: styleInfo(project.config.mood).palette[0],
                    }}
                    aria-hidden
                  />
                  <span className="grow ellipsis">{project.title}</span>
                  <span className="recent-version">v{project.revision}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="shell-foot">
        <p className="local-note">
          <span className="local-note-dot" aria-hidden />
          <span>
            {desktop
              ? "本地作曲已就绪，离线可用"
              : "网页版 · 本地作曲不联网，作品只保存在这个浏览器"}
          </span>
        </p>
        <button
          type="button"
          className="foot-item"
          data-testid="settings-button"
          aria-label="设置"
          data-tip={compact ? "设置" : undefined}
          onClick={() => actions.openModal("settings")}
        >
          <Settings size={18} aria-hidden />
          <span className="foot-label">设置</span>
        </button>
        <button
          type="button"
          className="foot-item"
          data-testid="help-button"
          aria-label="使用指南"
          data-tip={compact ? "使用指南" : undefined}
          onClick={() => actions.openModal("help")}
        >
          <CircleHelp size={18} aria-hidden />
          <span className="foot-label">使用指南</span>
          <span className="foot-version" aria-hidden>
            v{version}
          </span>
        </button>
      </div>
    </header>
  );
});
