/**
 * The three calls of the bulk-accept route (WP6): preview, confirm, undo. The route is registered as one union, so each
 * call narrows by a field only its own answer carries - a wrong shape is an error here, not a blank screen.
 */
import { apiFetch, apiJson, assertOk, ApiEnvelopeError } from '@/lib/apiFetch';

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

/** Thrown when a write could not be resolved either way: it may or may not have happened. */
export class WriteUnresolvedError extends Error {
  constructor(message: string) { super(message); this.name = 'WriteUnresolvedError'; }
}
const CONFIRM_UNRESOLVED = 'This batch may have posted. Check the Auto-post runs panel, then refresh the preview.';
const UNDO_UNRESOLVED = 'This undo may have gone through. Check the Auto-post runs panel before trying again.';

/** The client's patience for one send, and the waits between resends of the SAME request (same Idempotency-Key). Mutable for tests. */
export const CONFIRM_RETRY = { timeoutMs: 60_000, backoffMs: [1_000, 3_000] as number[] };

/** The server never answered, or a proxy/gateway did instead: the request may have committed. A 4xx refusal is definitive. */
const AMBIGUOUS_STATUS = new Set([408, 502, 503, 504]);
const STILL_RUNNING = /still being processed/i; // the idempotency wrapper's 409 for a first request that has not finished

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function send(body: unknown, key: string): Promise<Response | 'ambiguous'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIRM_RETRY.timeoutMs);
  try {
    return await apiFetch(URL, {
      method: 'POST', credentials: 'include', signal: controller.signal,
      headers: { ...JSON_HEADERS, 'Idempotency-Key': key }, body: JSON.stringify(body),
    });
  } catch {
    return 'ambiguous'; // a dropped connection, or our own timeout: the first send may have committed
  } finally { clearTimeout(timer); }
}

/**
 * POST under an Idempotency-Key, which the SERVER stores with the answer: a resend after a lost answer replays the first
 * answer (the same runId, the same undo result) instead of acting twice, or runs fresh if the first never committed. So an
 * ambiguous failure (network error, timeout, 408/502/503/504, "still being processed", a 200 whose body cannot be read) is
 * resent with the same key after a short backoff; a refusal (4xx) is definitive. `onRetry` fires before each resend.
 * @throws WriteUnresolvedError when every try was ambiguous.
 */
async function postUnderKey(body: unknown, key: string, fallback: string, unresolved: string, onRetry?: () => void): Promise<unknown> {
  const tries = CONFIRM_RETRY.backoffMs.length + 1;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (attempt > 0) { onRetry?.(); await pause(CONFIRM_RETRY.backoffMs[attempt - 1]!); }
    const res = await send(body, key);
    if (res === 'ambiguous' || AMBIGUOUS_STATUS.has(res.status)) continue;
    if (res.status === 409 && STILL_RUNNING.test(await res.clone().text())) continue;
    await assertOk(res, fallback);
    let data: unknown;
    try { data = (JSON.parse(await res.text()) as { data?: unknown }).data; } catch { continue; } // a body cut short: ambiguous
    if (data === undefined) continue;
    return data;
  }
  throw new WriteUnresolvedError(unresolved);
}

export async function confirmBulk(previewToken: string, key: string, onRetry?: () => void): Promise<BulkConfirmed> {
  const out = await postUnderKey({ action: 'confirm', previewToken }, key, 'Could not post the suggestions - try again', CONFIRM_UNRESOLVED, onRetry) as BulkConfirmed;
  if (!out || !Array.isArray(out.posted)) throw wrong('result');
  return out;
}

/** Undo exactly one batch, under its own key: a resend after a lost answer replays the answer instead of reading "already undone". */
export async function undoBulk(runId: string, key: string, onRetry?: () => void): Promise<BulkUndone> {
  const out = await postUnderKey({ action: 'undo', runId }, key, 'Could not undo this batch - try again', UNDO_UNRESOLVED, onRetry) as BulkUndone;
  if (!out || !('reversed' in out)) throw wrong('undo result');
  return out;
}
