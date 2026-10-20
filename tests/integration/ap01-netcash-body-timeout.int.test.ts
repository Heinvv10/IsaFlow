/**
 * AP-01: a Netcash response whose headers arrive and whose body then stalls must not hold the send open past the
 * timeout (and so past SEND_WINDOW_MS). The whole exchange is bounded; a stalled body settles the claim 'unknown'
 * (the batch may have been accepted), never 'failed', and the batch stays closed. Real route, real netcashService
 * (only the network is stubbed, and the timeout shortened to 150 ms). Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

vi.mock('@/modules/accounting/services/ap/netcashTimeouts', () => ({ REQUEST_TIMEOUT_MS: 150, SEND_WINDOW_MS: 120_000 }));

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, plantBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';
const realFetch = globalThis.fetch;
const netcashCalls: string[] = [];

/** Netcash answers headers at once, then stalls its body until aborted; anything else goes to the real fetch. */
function stubNetcash(status: number) {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes('api.netcash.co.za')) return realFetch(url, init);
    netcashCalls.push(String(url));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('This operation was aborted', 'AbortError')));
      },
    });
    return new Response(body, { status });
  }));
}

beforeAll(async () => { user = await createUser(pool, tokens); });
afterAll(async () => { vi.unstubAllGlobals(); await cleanupPr5(pool, companies, [user]); });

const submit = (c: string, batchId: string) => callRoute(netcashSubmit, tokens[user]!, c, 'POST',
  { batchPaymentId: batchId }, '/api/accounting/netcash/submit');

describe('netcash/submit: a response body that stalls (AP-01)', () => {
  it.each([200, 400])('headers %i then a stalled body: claim settled unknown (not failed), batch stays closed', async (status) => {
    netcashCalls.length = 0;
    const { company: c, bank } = await payCompany(pool, [[user, 'admin']], companies);
    await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
    const b = await plantBatch(pool, c, user, bank);
    stubNetcash(status);
    const res = await submit(c, b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(JSON.stringify(res.state.body)).toMatch(/NETCASH_OUTCOME_UNKNOWN/);
    expect((await pool.query('SELECT status FROM netcash_submissions WHERE company_id = $1', [c])).rows.map((r) => r.status)).toEqual(['unknown']);
    expect((await submit(c, b.id)).state.statusCode).toBe(409);
    expect(netcashCalls).toHaveLength(1);
    vi.unstubAllGlobals();
  }, 8000);
});
