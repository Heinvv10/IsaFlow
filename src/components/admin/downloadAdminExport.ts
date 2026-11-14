/**
 * Fetches an admin CSV export and saves it, for a page that cannot know the row
 * count in advance (Web Traffic). A refusal (over ADMIN_EXPORT_MAX_ROWS, a bad
 * filter) is thrown with the server's message for the page to show, never saved
 * as the file; a plain download link would save the error JSON instead.
 */
import { assertOk } from '@/lib/apiFetch';
import { adminFetch } from '@/lib/admin/adminFetch';

/** Admin exports only: the call goes out through adminFetch, as every admin UI call does. */
const ADMIN_API = '/api/admin/';

/**
 * The same-origin path + query of `href` once resolved as the browser would (dot-segments, percent-encoded
 * ones included, are collapsed; `//host` and absolute URLs keep their own origin), or a throw unless that is
 * under /api/admin/. A plain prefix test would pass `/api/admin/../auth/x`. The resolved path is what gets
 * fetched, so the URL checked is the URL sent.
 */
function adminExportPath(href: string): string {
  const base = 'http://admin-export.invalid';
  const url = new URL(href, base);
  if (url.origin !== base || !url.pathname.startsWith(ADMIN_API)) {
    throw new Error(`downloadAdminExport takes an ${ADMIN_API} URL`);
  }
  return url.pathname + url.search;
}

export async function downloadAdminExport(href: string, fallbackName: string): Promise<void> {
  const res = await adminFetch(adminExportPath(href));
  await assertOk(res, 'Could not export the CSV - try again');
  const blob = await res.blob();
  const named = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1];
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = named ?? fallbackName;
  // In the document for the click (Firefox ignores a detached anchor); the URL is revoked a tick later so the
  // download has started reading the blob before it goes.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
