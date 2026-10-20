/**
 * AP-01: submitEftBatch says whether Netcash DEFINITELY rejected a batch or
 * whether the outcome is unknown. A rejection lets the user resubmit; an
 * unknown outcome must not (the batch may have been accepted and paid).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: vi.fn().mockResolvedValue(undefined) }));

import { submitEftBatch, type NetcashPayment } from '@/modules/accounting/services/ap/netcashService';

const PAYMENTS: NetcashPayment[] = [
  { accountHolder: 'Acme', bankCode: '250655', accountNumber: '62000000001', amount: 115000, reference: 'R1' },
];
const send = () => submitEftBatch('service-key', 'payouts-key', PAYMENTS);
const reply = (status: number, body: string) => vi.fn().mockResolvedValue(new Response(body, { status }));

describe('submitEftBatch outcome', () => {
  beforeEach(() => { vi.stubGlobal('fetch', reply(200, '{"batchReference":"NC-1"}')); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('a 2xx JSON answer is accepted, with its reference', async () => {
    expect(await send()).toMatchObject({ success: true, outcome: 'accepted', batchReference: 'NC-1' });
  });

  // K-132: a missing secret is an error, never a sandbox. Nothing is sent, so the refusal is definite.
  it.each([['', ''], ['service-key', ''], ['', 'payouts-key'], ['  ', 'payouts-key'], ['service-key', ' \t ']])('keys (%j, %j): refused, not a mock success, and nothing is sent', async (service, payouts) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await submitEftBatch(service, payouts, PAYMENTS)).toEqual({
      success: false, outcome: 'rejected', error: 'Netcash credentials are not configured',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([400, 422])('a %i JSON answer (field validation) is a definite rejection, carrying Netcash\'s message', async (status) => {
    vi.stubGlobal('fetch', reply(status, '{"message":"Invalid account number"}'));
    expect(await send()).toEqual({ success: false, outcome: 'rejected', error: 'Invalid account number' });
  });

  // Only a validation refusal proves nothing was queued. Auth, routing, conflict, throttling and gateway-style 4xx
  // do not: a 409 may mean "already received", a 408/429 says nothing of the batch.
  it.each([401, 403, 404, 405, 408, 409, 413, 425, 429, 499])('a %i JSON answer is unknown, not a rejection', async (status) => {
    vi.stubGlobal('fetch', reply(status, '{"message":"nope"}'));
    expect(await send()).toMatchObject({ success: false, outcome: 'unknown', error: 'nope' });
  });

  it('a 2xx answer that is not JSON is unknown, not a failure', async () => {
    vi.stubGlobal('fetch', reply(200, '<html>OK</html>'));
    expect(await send()).toMatchObject({ success: false, outcome: 'unknown' });
  });

  it('a 5xx answer is unknown: the batch may have been processed before the error', async () => {
    vi.stubGlobal('fetch', reply(500, '{"message":"Internal error"}'));
    expect(await send()).toMatchObject({ success: false, outcome: 'unknown' });
    vi.stubGlobal('fetch', reply(502, '<html>Bad gateway</html>'));
    expect(await send()).toMatchObject({ success: false, outcome: 'unknown' });
  });

  it('a 4xx answer that is not JSON is unknown (not Netcash\'s own answer)', async () => {
    vi.stubGlobal('fetch', reply(403, '<html>Forbidden</html>'));
    expect(await send()).toMatchObject({ success: false, outcome: 'unknown' });
  });

  it('a timeout (abort) is unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('This operation was aborted', 'AbortError')));
    expect(await send()).toMatchObject({ success: false, outcome: 'unknown', error: 'This operation was aborted' });
  });

  it('a network error is unknown: the request may have left', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(await send()).toMatchObject({ success: false, outcome: 'unknown' });
  });
});
