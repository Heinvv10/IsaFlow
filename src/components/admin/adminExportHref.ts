/**
 * The URL of a server-side admin CSV export, carrying the filters the page shows.
 * Empty, null, undefined and false values are left out, so an unset filter is
 * absent from the URL (the export then applies none), exactly as the list call.
 */
export function adminExportHref(path: string, params: Record<string, string | null | undefined | false>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) qs.set(key, value);
  }
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * The most rows one admin CSV export may hold. Above it the export route answers
 * 400 (narrow the filters) instead of building an unbounded file in memory or
 * silently cutting it off; a page that knows its total disables its link.
 */
export const ADMIN_EXPORT_MAX_ROWS = 100_000;

