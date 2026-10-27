/**
 * One GET /api/accounting/sars/vat-exceptions per period at a time. Callers that ask for the same period while a
 * request is in flight (React StrictMode runs a mount effect twice in dev; the VAT201 panel and the period-lock form
 * both read the same report) share that request instead of each sending their own.
 */
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

const inflight = new Map<string, Promise<unknown>>();

/** The report's `data` for [from, to]. Rejects with assertOk's error carrying `failMessage` when the server refuses. */
export function fetchVatExceptions(from: string, to: string, failMessage: string, caller: string): Promise<unknown> {
  const key = `${from}|${to}|${failMessage}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  log.debug('GET vat-exceptions', { from, to }, caller);
  const request = (async () => {
    const res = await apiFetch(`/api/accounting/sars/vat-exceptions?from=${from}&to=${to}`, { credentials: 'include' });
    await assertOk(res, failMessage);
    const json = await res.json();
    return json.data;
  })().finally(() => { inflight.delete(key); });
  inflight.set(key, request);
  return request;
}
