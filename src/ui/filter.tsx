// The filter of the long lists of the Accounts and Chat bots pages (C382 batch 4). The pieces are the kit's
// (accessFilter, useAccessFilter, ListFilter); this file adds the screen key and the row filter both pages use.
import { accessFilter, type FilterNoun, ListFilter, useAccessFilter } from "@opt2-tealbrick/ui";
import type { ReactNode } from "react";

/** A list shorter than this shows no filter bar, unless a remembered filter is on. */
export const FILTER_FROM = 8;

/** What this browser remembers is per app (the base path of the app) and per screen. */
export const filterKey = (page: string) => {
  try {
    return `tb-filter:${new URL(document.baseURI).pathname}:${page}`;
  } catch {
    return `tb-filter:${page}`;
  }
};

/** Does the text filter match a row? Each part alone (so ^ and $ work on a name), or all parts together. */
export const matches = (filter: { test: (text: string) => boolean }, parts: readonly string[]) => parts.some((t) => filter.test(t)) || filter.test(parts.join(" "));

/**
 * Rows that pass a remembered text filter, and the bar that says a filter is on (null for a short list). `more`: the
 * rows are only the newest of a longer record, so the bar says the filter reads only these.
 */
export function useRowFilter<T>(
  page: string,
  rows: readonly T[],
  partsOf: (row: T) => string[],
  label: string,
  noun: FilterNoun,
  options: { more?: boolean; onChange?: () => void } = {},
): { shown: T[]; bar: ReactNode; on: boolean } {
  const [query, setQuery] = useAccessFilter(filterKey(page));
  const filter = accessFilter(query);
  const shown = rows.filter((r) => matches(filter, partsOf(r)));
  const on = query.trim() !== "";
  const change = (value: string) => {
    setQuery(value);
    options.onChange?.();
  };
  const bar =
    rows.length >= FILTER_FROM || on ? (
      <ListFilter label={label} value={query} onChange={change} filter={filter} noun={noun} shown={shown.length} total={rows.length} more={options.more ?? false} onClear={() => change("")} />
    ) : null;
  return { shown, bar, on };
}
