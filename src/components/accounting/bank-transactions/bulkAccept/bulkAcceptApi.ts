/**
 * The three calls of the bulk-accept route (WP6): preview, confirm, undo. The route is registered as one union, so each
 * call narrows by a field only its own answer carries - a wrong shape is an error here, not a blank screen.
 */
import { apiJson, ApiEnvelopeError } from '@/lib/apiFetch';

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
