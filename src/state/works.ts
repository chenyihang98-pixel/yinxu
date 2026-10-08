/** Pure helpers for the work list: ordering, searching, lineage. */
import { instrumentLabel, styleLabel } from "../music/catalog";
import type { MusicConfig, Project } from "../types";

const time = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Newest first — the order storage.listProjects returns. */
export function sortProjects(projects: readonly Project[]): Project[] {
  return [...projects].sort(
    (a, b) =>
      time(b.updatedAt) - time(a.updatedAt) ||
      time(b.createdAt) - time(a.createdAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export function upsertProject(
  projects: readonly Project[],
  project: Project,
): Project[] {
  return sortProjects([
    project,
    ...projects.filter((item) => item.id !== project.id),
  ]);
}

/** Replace a work in place (rename, favourite): the order does not change. */
export function patchProject(
  projects: readonly Project[],
  id: string,
  patch: Partial<Project>,
): Project[] {
  return projects.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

/** Length shown for a work: what was actually rendered, else what was asked. */
export function projectDuration(project: Project): number {
  return project.audioDuration ?? project.config.duration;
}

export type LibrarySort = "recent" | "title" | "duration";

export interface LibraryQuery {
  search?: string;
  favouritesOnly?: boolean;
  sort?: LibrarySort;
}

function haystack(project: Project): string {
  const { config } = project;
  return [
    project.title,
    config.prompt,
    ...project.tags,
    styleLabel(config.mood),
    `${config.bpm}`,
  ]
    .join(" ")
    .toLowerCase();
}

/** 搜索 / 收藏 / 排序 of the library page. */
export function queryProjects(
  projects: readonly Project[],
  query: LibraryQuery,
): Project[] {
  const words = (query.search ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const matched = projects.filter((project) => {
    if (query.favouritesOnly && !project.favorite) return false;
    if (!words.length) return true;
    const text = haystack(project);
    return words.every((word) => text.includes(word));
  });
  switch (query.sort) {
    case "title":
      return [...matched].sort(
        (a, b) =>
          a.title.localeCompare(b.title, "zh-CN") ||
          time(b.updatedAt) - time(a.updatedAt),
      );
    case "duration":
      return [...matched].sort(
        (a, b) =>
          projectDuration(b) - projectDuration(a) ||
          time(b.updatedAt) - time(a.updatedAt),
      );
    default:
      return sortProjects(matched);
  }
}

/** "v2 · 源自《…》" when the parent is still in the library, else "v2". */
export function versionLabel(
  project: Project,
  projects: readonly Project[],
): string {
  const tag = `v${project.revision}`;
  if (!project.parentId) return tag;
  const parent = projects.find((item) => item.id === project.parentId);
  return parent ? `${tag} · 源自《${parent.title}》` : tag;
}

/** The library work a thread's version tag points at, if it still exists. */
export function findVersion(
  current: Project | null,
  projects: readonly Project[],
  revision: number,
): Project | undefined {
  if (!current) return undefined;
  if (current.revision === revision) return current;
  // Walk up the lineage: versions are linked through parentId.
  const byId = new Map(projects.map((item) => [item.id, item]));
  let cursor: Project | undefined = current;
  for (let hops = 0; cursor && hops < 200; hops++) {
    if (cursor.revision === revision) return cursor;
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return undefined;
}

/** "国风古韵 · 78 BPM · 古筝" — the short description under a title. */
export function recipeLine(config: MusicConfig): string {
  return [
    styleLabel(config.mood),
    `${config.bpm} BPM`,
    instrumentLabel(config.instrument),
  ]
    .filter(Boolean)
    .join(" · ");
}
