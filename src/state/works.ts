/** Pure helpers for the work list: ordering, searching, lineage. */
import type { AgentTurn } from "../agent/types";
import { styleLabel } from "../music/catalog";
import type { Project } from "../types";
import { fittedTiming } from "./score";

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

/**
 * Length shown for a work: what was actually rendered or decoded. A local
 * work that has not been rendered yet (a fresh import) gets the length the
 * engine will give it — a loop is fitted to whole bars — and only a cloud or
 * v0.2 work without audio falls back to what was asked.
 */
export function projectDuration(project: Project): number {
  if (project.audioDuration !== undefined) return project.audioDuration;
  return project.provider === "local" && project.config.engine === 2
    ? fittedTiming(project.config).duration
    : project.config.duration;
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
  const words = (query.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
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

export interface VersionTag {
  /** "v3" */
  tag: string;
  /** "源自 v2", or "源自《别的名字》v2" when the parent is named differently; null for a first version */
  origin: string | null;
  /** everything, for a tooltip: "v3 · 源自《像素小游戏》v2" */
  full: string;
}

/**
 * The version of a work as a library card shows it. Versions of one piece
 * share their title, so the parent is named by its number; its title is
 * spelled out only when it differs (a renamed version).
 */
export function versionTag(
  project: Project,
  projects: readonly Project[],
): VersionTag {
  const tag = `v${project.revision}`;
  const parent = project.parentId
    ? projects.find((item) => item.id === project.parentId)
    : undefined;
  if (!parent) return { tag, origin: null, full: tag };
  const named = `源自《${parent.title}》v${parent.revision}`;
  return {
    tag,
    origin: parent.title === project.title ? `源自 v${parent.revision}` : named,
    full: `${tag} · ${named}`,
  };
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

/* ------------------------------------------------------------------ */
/* lineage: the versions that grew out of one piece                    */
/* ------------------------------------------------------------------ */

const created = (project: Project) => time(project.createdAt);

/** Newest version first: highest revision, then the most recently made. */
function newestFirst(a: Project, b: Project): number {
  return b.revision - a.revision || created(b) - created(a);
}

/**
 * Every version of the piece `project` belongs to, `project` included: works
 * linked through parentId, and works whose stored conversation shares a turn
 * (which still connects two versions after the one between them was deleted).
 */
export function lineageOf(
  project: Project,
  projects: readonly Project[],
): Project[] {
  const all = projects.some((item) => item.id === project.id)
    ? projects.map((item) => (item.id === project.id ? project : item))
    : [project, ...projects];
  const byTurn = new Map<string, Project[]>();
  const children = new Map<string, Project[]>();
  const push = (map: Map<string, Project[]>, key: string, item: Project) => {
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  };
  for (const item of all) {
    if (item.parentId) push(children, item.parentId, item);
    for (const turn of item.chat ?? []) push(byTurn, turn.id, item);
  }
  const byId = new Map(all.map((item) => [item.id, item]));
  const seen = new Set<string>([project.id]);
  const queue = [project];
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    const near = [
      ...(item.parentId ? [byId.get(item.parentId)] : []),
      ...(children.get(item.id) ?? []),
      ...(item.chat ?? []).flatMap((turn) => byTurn.get(turn.id) ?? []),
    ];
    for (const next of near)
      if (next && !seen.has(next.id)) {
        seen.add(next.id);
        queue.push(next);
      }
  }
  return queue;
}

export interface Lineage {
  /** every version of the piece, newest first */
  versions: Project[];
  /** the newest version (the loaded work itself when it is the newest) */
  latest: Project;
  /**
   * The one conversation of the piece, oldest turn first: the stored chat of
   * the version that carries the most of it. Opening an earlier version shows
   * this thread, not only the part that existed when that version was made.
   */
  thread: AgentTurn[];
}

/**
 * The lineage of the loaded work. The shared thread is taken from the
 * version whose stored chat continues the loaded work's own chat the
 * furthest; a branch that does not contain the loaded work's conversation is
 * never shown in its place.
 */
export function lineage(
  project: Project,
  projects: readonly Project[],
): Lineage {
  const versions = lineageOf(project, projects).sort(newestFirst);
  const own = project.chat ?? [];
  const last = own.at(-1)?.id;
  const continues = (item: Project) =>
    item.id === project.id ||
    (last !== undefined
      ? (item.chat ?? []).some((turn) => turn.id === last)
      : own.length === 0 && isDescendant(item, project, versions));
  const carrier =
    versions
      .filter(continues)
      .sort(
        (a, b) =>
          (b.chat?.length ?? 0) - (a.chat?.length ?? 0) || newestFirst(a, b),
      )[0] ?? project;
  const top = versions[0]?.revision ?? project.revision;
  return {
    versions,
    // an identical copy (an imported export) is not "newer" than the work itself
    latest: project.revision === top ? project : (versions[0] ?? project),
    thread: carrier.chat ?? own,
  };
}

function isDescendant(
  item: Project,
  ancestor: Project,
  versions: readonly Project[],
): boolean {
  const byId = new Map(versions.map((entry) => [entry.id, entry]));
  let cursor: Project | undefined = item;
  for (let hops = 0; cursor && hops < 200; hops++) {
    if (cursor.parentId === ancestor.id) return true;
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return false;
}

/**
 * The work an agent turn's version tag stands for: the version with that
 * number whose conversation ends closest after the turn (the work the turn
 * produced), or the only version with that number.
 */
export function versionOfTurn(
  turn: Pick<AgentTurn, "id" | "revision">,
  versions: readonly Project[],
  /** the loaded work wins a tie (an imported copy has the same conversation) */
  current?: Project | null,
): Project | undefined {
  if (turn.revision === undefined) return undefined;
  const numbered = versions.filter((item) => item.revision === turn.revision);
  const size = (item: Project) => item.chat?.length ?? 0;
  const holding = numbered
    .filter((item) => (item.chat ?? []).some((entry) => entry.id === turn.id))
    .sort(
      (a, b) =>
        size(a) - size(b) ||
        Number(b.id === current?.id) - Number(a.id === current?.id),
    );
  return holding[0] ?? (numbered.length === 1 ? numbered[0] : undefined);
}

/** One piece of music as 简单模式's list shows it: its newest version and how many there are. */
export interface Piece {
  /** the newest version: what the card plays, downloads and opens */
  latest: Project;
  /** every version of the piece, newest first */
  versions: Project[];
}

/**
 * The library as pieces instead of versions: works linked through parentId
 * or a shared conversation turn (the same relation as lineageOf) are one
 * piece. In the order of the list given (newest first): a piece stands
 * where its most recently changed version stands.
 */
export function groupPieces(projects: readonly Project[]): Piece[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    // flatten the path for the next lookups
    for (let cursor = id; cursor !== root;) {
      const next = parent.get(cursor) ?? root;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const join = (a: string, b: string) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent.set(right, left);
  };
  for (const item of projects) parent.set(item.id, item.id);
  const byTurn = new Map<string, string>();
  for (const item of projects) {
    if (item.parentId && parent.has(item.parentId))
      join(item.id, item.parentId);
    for (const turn of item.chat ?? []) {
      const other = byTurn.get(turn.id);
      if (other) join(item.id, other);
      else byTurn.set(turn.id, item.id);
    }
  }
  const groups = new Map<string, Project[]>();
  for (const item of projects) {
    const root = find(item.id);
    const list = groups.get(root);
    if (list) list.push(item);
    else groups.set(root, [item]);
  }
  return [...groups.values()].map((list) => {
    const versions = [...list].sort(newestFirst);
    return { latest: versions[0], versions };
  });
}

/**
 * Version number of the next work made from `base`: one more than the highest
 * in its lineage, so a version made from an earlier one never shares a number
 * with a later one that already exists.
 */
export function nextRevisionIn(
  base: Project | null,
  projects: readonly Project[],
): number {
  if (!base) return 1;
  let highest = base.revision;
  for (const item of lineageOf(base, projects))
    highest = Math.max(highest, item.revision);
  return highest + 1;
}
