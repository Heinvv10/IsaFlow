// Admin audit 2026-11-14, item 1.12 (code-4 F-10): webhook "Redeliver" sent
// nothing. It cloned the old payload into a new webhook_deliveries row with
// success=false (nothing consumes such rows) and answered "Delivery queued for
// retry". The source delivery was read by id alone, so any delivery's payload
// (another tenant's) could be cloned into this webhook's log.
// Now it re-sends through the tenant sender (webhookService, safeFetch): signed,
// recorded with the endpoint's real answer, scoped to its own webhook, and
// refused for a disabled endpoint. Outbound HTTP is stubbed: nothing leaves the box.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto, { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import redeliverRoute from '../../pages/api/admin/webhooks/[id]/redeliver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callAdmin, createAdmin, dropAdmin } from './wp11-admin-route.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const companyA = randomUUID();
const companyB = randomUUID();
const URL_A = 'https://93.184.216.34/wp11-hook-a'; // public IP literal: no DNS
const URL_B = 'https://93.184.216.35/wp11-hook-b';
const SIGNING = 'wp11-legacy-plain-signing-value'; // a legacy plaintext row (not a credential)
const outbound = { status: 200, calls: [] as Array<{ url: string; body: string; headers: Record<string, string> }> };
let admin = { id: '', token: '' };
let hookA = '';
let hookB = '';

const q = (text: string, params: unknown[] = []) => pool.query(text, params);
const deliveries = async (webhookId: string) => (await q(
  `SELECT id, event, payload, success, response_status FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY delivered_at, id`,
  [webhookId])).rows as Array<{ id: string; event: string; payload: unknown; success: boolean; response_status: number | null }>;

async function failedDelivery(webhookId: string, event: string, payload: Record<string, unknown>): Promise<string> {
  return String((await q(`INSERT INTO webhook_deliveries (webhook_id, event, payload, response_status, success)
    VALUES ($1, $2, $3, 503, false) RETURNING id`, [webhookId, event, JSON.stringify(payload)])).rows[0].id);
}

const redeliver = (webhookId: string, body: Record<string, unknown> = {}) =>
  callAdmin(redeliverRoute, admin.token, { query: { id: webhookId }, body });

beforeAll(async () => {
  admin = await createAdmin(pool, 'wp11-hooks');
  await q(`INSERT INTO companies (id, name, status) VALUES ($1, 'WP11 hooks A', 'active'), ($2, 'WP11 hooks B', 'active')`,
    [companyA, companyB]);
  hookA = String((await q(`INSERT INTO webhook_endpoints (company_id, name, url, secret, events)
    VALUES ($1, 'A', $2, $3, ARRAY['invoice.created']) RETURNING id`, [companyA, URL_A, SIGNING])).rows[0].id);
  hookB = String((await q(`INSERT INTO webhook_endpoints (company_id, name, url, events)
    VALUES ($1, 'B', $2, ARRAY['invoice.created']) RETURNING id`, [companyB, URL_B])).rows[0].id);
});

afterAll(async () => {
  try {
    await q('DELETE FROM webhook_endpoints WHERE company_id = ANY($1)', [[companyA, companyB]]);
    await q('DELETE FROM companies WHERE id = ANY($1)', [[companyA, companyB]]);
    await dropAdmin(pool, admin.id);
  } finally { await pool.end(); }
});

beforeEach(async () => {
  await q('DELETE FROM webhook_deliveries WHERE webhook_id = ANY($1)', [[hookA, hookB]]);
  await q('UPDATE webhook_endpoints SET is_active = true, failure_count = 0 WHERE id = ANY($1)', [[hookA, hookB]]);
  outbound.calls.length = 0;
  outbound.status = 200;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url !== URL_A && url !== URL_B) throw new Error(`unexpected outbound fetch in test: ${url}`);
    outbound.calls.push({ url, body: String(init?.body), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response('received', { status: outbound.status });
  });
});
afterEach(() => vi.restoreAllMocks());

describe('admin webhook Redeliver', () => {
  it('re-sends the last failed delivery to its endpoint, signed, and records the real answer', async () => {
    await failedDelivery(hookA, 'invoice.created', { invoice: 'INV-1', amount: 100 });
    const r = await redeliver(hookA);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ delivered: true, responseStatus: 200 });

    expect(outbound.calls).toHaveLength(1);
    const sent = outbound.calls[0]!;
    expect(sent.url).toBe(URL_A);
    expect(JSON.parse(sent.body)).toEqual({ invoice: 'INV-1', amount: 100 });
    expect(sent.headers['X-Webhook-Event']).toBe('invoice.created');
    expect(sent.headers['X-Webhook-Signature']).toBe(crypto.createHmac('sha256', SIGNING).update(sent.body).digest('hex'));

    const rows = await deliveries(hookA);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ event: 'invoice.created', success: true, response_status: 200 });
    expect(String(r.body.data?.deliveryId)).toBe(rows[1]!.id);
  });

  it('says so when the endpoint refuses the redelivery', async () => {
    await failedDelivery(hookA, 'invoice.created', { invoice: 'INV-2' });
    outbound.status = 500;
    const r = await redeliver(hookA);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ delivered: false, responseStatus: 500 });
    expect(r.body.message).toMatch(/500/);
    expect(outbound.calls).toHaveLength(1);
    expect((await deliveries(hookA)).at(-1)).toMatchObject({ success: false, response_status: 500 });
  });

  it("refuses another webhook's delivery: nothing is sent, nothing is copied", async () => {
    const foreign = await failedDelivery(hookB, 'invoice.created', { tenant: 'B', secretish: 'B-only' });
    const r = await redeliver(hookA, { deliveryId: foreign });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(outbound.calls).toHaveLength(0);
    expect(await deliveries(hookA)).toHaveLength(0);
    expect(await deliveries(hookB)).toHaveLength(1);
  });

  it('refuses a disabled endpoint without sending', async () => {
    await failedDelivery(hookA, 'invoice.created', { invoice: 'INV-3' });
    await q('UPDATE webhook_endpoints SET is_active = false WHERE id = $1', [hookA]);
    const r = await redeliver(hookA);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(outbound.calls).toHaveLength(0);
    expect(await deliveries(hookA)).toHaveLength(1);
  });
});
