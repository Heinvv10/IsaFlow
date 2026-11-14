/**
 * Fetches an admin CSV export and saves it, for a page that cannot know the row
 * count in advance (Web Traffic). A refusal (over ADMIN_EXPORT_MAX_ROWS, a bad
 * filter) is thrown with the server's message for the page to show, never saved
 * as the file; a plain download link would save the error JSON instead.
 */
import { apiFetch, assertOk } from '@/lib/apiFetch';

export async function downloadAdminExport(href: string, fallbackName: string): Promise<void> {
  const res = await apiFetch(href);
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
