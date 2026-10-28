/**
 * One GET /api/accounting/sars/vat-exceptions per period at a time. Callers that ask for the same period while a
 * request is in flight (React StrictMode runs a mount effect twice in dev; the VAT201 panel and the period-lock form
 * both read the same report) share that request instead of each sending their own. The request is shared only
 * within one company, and an explicit reload (`fresh`) never joins a request that was already running. Each caller's
 * `failMessage` is its own wording for a refusal the server gave no message for, so it is not part of the sharing key.
 */
import { apiFetch, assertOk, ApiRequestError } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

const NO_SERVER_MESSAGE = '';
const inflight = new Map<string, Promise<unknown>>();

export interface VatExceptionsScope {
  /** The active company: a company switch must not receive the previous company's report. */
  companyId?: string;
  /** True for a person's explicit reload: send a new request even if one is in flight. */
  fresh?: boolean;
}

/** The report's `data` for [from, to]. Rejects with assertOk's error: the server's message, else `failMessage`. */
export function fetchVatExceptions(from: string, to: string, failMessage: string, caller: string, scope: VatExceptionsScope = {}): Promise<unknown> {
  const key = `${scope.companyId ?? ''}|${from}|${to}`;
  const pending = scope.fresh ? undefined : inflight.get(key);
  if (pending) return withOwnMessage(pending, failMessage);
  log.debug('GET vat-exceptions', { from, to }, caller);
  const request = (async () => {
    const res = await apiFetch(`/api/accounting/sars/vat-exceptions?from=${from}&to=${to}`, { credentials: 'include' });
    await assertOk(res, NO_SERVER_MESSAGE);
    const json = await res.json();
    return json.data;
  })().finally(() => { if (inflight.get(key) === request) inflight.delete(key); });
  inflight.set(key, request);
  return withOwnMessage(request, failMessage);
}

/** The shared request fails with an empty message when the server sent none; each caller words that its own way. */
function withOwnMessage(request: Promise<unknown>, failMessage: string): Promise<unknown> {
  return request.catch((err: unknown) => {
    throw err instanceof ApiRequestError && err.message === NO_SERVER_MESSAGE ? new ApiRequestError(failMessage, err.status) : err;
  });
}
