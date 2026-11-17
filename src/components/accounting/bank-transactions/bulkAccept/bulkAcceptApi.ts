/**
 * The three calls of the bulk-accept route (WP6): preview, confirm, undo. The route is registered as one union, so each
 * call narrows by a field only its own answer carries - a wrong shape is an error here, not a blank screen.
 */
import { apiJson, ApiEnvelopeError, ApiRequestError } from '@/lib/apiFetch';

const URL = '/api/accounting/bank-bulk-accept';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

type Answer = Awaited<ReturnType<typeof apiJson<typeof URL>>>;
export type BulkPreview = Extract<Answer, { previewToken: string | null }>;
export type BulkConfirmed = Extract<Answer, { posted: unknown[] }>;
export type BulkUndone = Extract<Answer, { reversed: number }>;
export type BulkPreviewLine = BulkPreview['lines'][number];

const wrong = (what: string) => new ApiEnvelopeError(`The bulk accept ${what} was not understood - reload the page and try again`);

export async function fetchBulkPreview(bankAccountId: string, scanAfter?: string | null): Promise<BulkPreview> {
  const query = new URLSearchParams({ bankAccountId });
  if (scanAfter) query.set('scanAfter', scanAfter);
  const out = await apiJson(`${URL}?${query}`, { credentials: 'include' }, 'Could not load the high-confidence suggestions - try again');
  if (!('previewToken' in out) || !Array.isArray(out.lines)) throw wrong('preview');
  return out as BulkPreview;
}

export async function confirmBulk(previewToken: string): Promise<BulkConfirmed> {
  const out = await apiJson(URL, {
    method: 'POST', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify({ action: 'confirm', previewToken }),
  }, 'Could not post the suggestions - try again');
  if (!('posted' in out) || !Array.isArray(out.posted)) throw wrong('result');
  return out as BulkConfirmed;
}

export async function undoBulk(runId: string): Promise<BulkUndone> {
  const out = await apiJson(URL, {
    method: 'POST', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify({ action: 'undo', runId }),
  }, 'Could not undo this batch - try again');
  if (!('reversed' in out)) throw wrong('undo result');
  return out as BulkUndone;
}

/** The server answered (a refusal or fault): nothing was left half-done. Anything else - a dropped connection, an unreadable body - is ambiguous. */
export const isDefinitiveFailure = (err: unknown): boolean => err instanceof ApiRequestError;

/**
 * The caller's OWN newest not-yet-undone batch on this account started at or after `since` (epoch ms), or null: how a confirm
 * whose answer was lost finds the batch it may have posted, so Undo stays possible. The server scopes it to the user.
 */
export async function findRecentBatch(bankAccountId: string, since: number): Promise<{ id: string; postedCount: number; totalAmount: number } | null> {
  const query = new URLSearchParams({ bankAccountId, recentSince: String(since - 60_000) }); // a minute of clock slack
  const out = await apiJson(`${URL}?${query}`, { credentials: 'include' }, 'Could not look up the batch'); // a failed look-up reads as "none found"
  if (!('batch' in out)) throw wrong('batch look-up');
  return out.batch;
}
