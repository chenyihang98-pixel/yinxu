/** The work library: list, damaged records, soft-deleted works, storage use. */
import { useMemo, useState, useSyncExternalStore } from "react";
import type { Project } from "../types";
import type { AppCore } from "./core";
import type { LibraryView } from "./types";
import { queryProjects } from "./works";
import type { LibraryQuery, LibrarySort } from "./works";

export function useLibrary(core: AppCore): LibraryView {
  return useSyncExternalStore(core.subscribe, () => core.getState().library);
}

export interface LibraryFilter {
  search: string;
  favouritesOnly: boolean;
  sort: LibrarySort;
  setSearch(value: string): void;
  setFavouritesOnly(value: boolean): void;
  setSort(value: LibrarySort): void;
  /** the works that match, in the chosen order */
  results: Project[];
}

/** 搜索 / 收藏 / 排序 for a library page; the query is local to that page. */
export function useLibraryFilter(projects: readonly Project[]): LibraryFilter {
  const [query, setQuery] = useState<Required<LibraryQuery>>({
    search: "",
    favouritesOnly: false,
    sort: "recent",
  });
  const results = useMemo(
    () => queryProjects(projects, query),
    [projects, query],
  );
  return useMemo(
    () => ({
      ...query,
      results,
      setSearch: (search) => setQuery((value) => ({ ...value, search })),
      setFavouritesOnly: (favouritesOnly) =>
        setQuery((value) => ({ ...value, favouritesOnly })),
      setSort: (sort) => setQuery((value) => ({ ...value, sort })),
    }),
    [query, results],
  );
}
