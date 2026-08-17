/**
 * Runtime behaviour of `apiJson` — the typed API client.
 *
 * The TYPE guarantees live in `src/lib/apiRoutes.typeproof.ts` (enforced by
 * `bun run type-check`). This file covers only what types cannot: envelope
 * unwrapping, error propagation, and the failure modes that previously let a
 * bad response reach a component as `undefined`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiJson, ApiRequestError, ApiEnvelopeError } from '@/lib/apiFetch';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiJson', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockFetch(res: Response) {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(res);
  }

  it('unwraps the data envelope rather than returning the whole body', async () => {
    mockFetch(jsonResponse({ success: true, data: { session: { id: 'sess-1' } }, meta: {} }));

    const result = await apiJson('/api/accounting/migration/session');

    // The live bug read `data.id` off the envelope and got undefined; the
    // caller must receive the inner payload, with `session` intact.
    expect(result).toEqual({ session: { id: 'sess-1' } });
  });

  it('returns a bare array payload unchanged', async () => {
    // `apiResponse.success(res, currencies)` sends the array AS `data` — there
    // is no `data.currencies` wrapper. This is what emptied the currency list.
    mockFetch(jsonResponse({ success: true, data: [{ code: 'ZAR' }], meta: {} }));

    await expect(apiJson('/api/accounting/currencies')).resolves.toEqual([{ code: 'ZAR' }]);
  });

  it('throws ApiRequestError carrying the server message on a 4xx', async () => {
    mockFetch(jsonResponse({ success: false, error: { code: 'BAD_REQUEST', message: 'Period required' } }, 400));

    await expect(apiJson('/api/accounting/currencies')).rejects.toThrow(ApiRequestError);
  });

  it('surfaces the server message, not a generic fallback', async () => {
    mockFetch(jsonResponse({ success: false, error: { code: 'BAD_REQUEST', message: 'Period required' } }, 400));

    await expect(apiJson('/api/accounting/currencies')).rejects.toThrow('Period required');
  });

  it('preserves the HTTP status on the thrown error so callers can branch on it', async () => {
    mockFetch(jsonResponse({ success: false, error: { code: 'FORBIDDEN', message: 'Nope' } }, 403));

    await expect(apiJson('/api/accounting/currencies')).rejects.toMatchObject({ status: 403 });
  });

  it('throws ApiEnvelopeError when a 2xx body has no data envelope', async () => {
    // e.g. a proxy or a handler that bypasses apiResponse. Failing loudly here
    // beats handing the component an `undefined` that breaks three lines later.
    mockFetch(jsonResponse({ session: { id: 'sess-1' } }));

    await expect(apiJson('/api/accounting/migration/session')).rejects.toThrow(ApiEnvelopeError);
  });

  it('throws ApiEnvelopeError on a non-JSON 2xx body', async () => {
    mockFetch(new Response('<html>gateway error</html>', { status: 200 }));

    await expect(apiJson('/api/accounting/currencies')).rejects.toThrow(ApiEnvelopeError);
  });

  it('treats 204 No Content as success with no payload', async () => {
    mockFetch(new Response(null, { status: 204 }));

    await expect(apiJson('/api/accounting/currencies')).resolves.toBeUndefined();
  });

  it('does not confuse a null data payload with a missing envelope', async () => {
    // `{ session: null }` is a legitimate "no active session" answer.
    mockFetch(jsonResponse({ success: true, data: { session: null }, meta: {} }));

    await expect(apiJson('/api/accounting/migration/session')).resolves.toEqual({ session: null });
  });
});
