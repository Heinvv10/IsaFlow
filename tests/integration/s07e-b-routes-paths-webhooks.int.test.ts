// tests/integration/s07e-b-routes-paths-webhooks.int.test.ts
//
// S-07e part B (migration 946): no app role may write webhook_endpoints at all
// (the delivery stamps included, since review round 5); the code makes those
// writes on migration_admin (the settings on migrationAdminTx, a delivery's stamp
// and auto-disable on routeAdminQuery). This proves each legitimate path still works end to
// end through its real route, on the production logins (s07b helpers), and that
// another tenant's endpoint cannot be changed. Outbound HTTP is stubbed.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import webhooksRoute from '../../pages/api/accounting/webhooks';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool, billingAdminPool } from '@/lib/auth/migrationAdminPool';
import { routeAdminPool } from '@/lib/auth/routeAdminPool';
import { decryptToken } from '@/lib/encryption';
import { fireWebhook, createWebhook } from '@/modules/accounting/services/core/webhookService';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

// Two signing values to round-trip through encryption (not credentials).
const [S1, S2] = ['one', 'two'].map((n) => `hook-signing-${n}`);
const ids = newIds();
const { owner, company, other } = ids;
const URL_A = 'https://93.184.216.34/hook-a'; // public IP literal: no DNS
const URL_B = 'https://93.184.216.35/hook-b';
const realFetch = globalThis.fetch;
const outbound = { status: 200, calls: [] as Array<{ url: string; signature: string | null }> };

const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
const row = async (id: string) => (await q('SELECT * FROM webhook_endpoints WHERE id = $1', [id])).rows[0] as Record<string, unknown> | undefined;
const call = (method: string, opts: { body?: unknown; query?: Record<string, string> } = {}, companyId = company) =>
  callRoute(webhooksRoute, { sub: owner, method, companyId, ...opts });
const data = (r: { body: unknown }) => (r.body as { data: Record<string, unknown> & unknown[] }).data;

beforeAll(async () => {
  await setup(ids);
  vi.stubEnv('ENCRYPTION_KEY', 'disposable-s07e-b-encryption-key-over-32-characters');
  await q(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')
    ON CONFLICT (company_id, user_id) DO UPDATE SET role = 'owner'`, [company, owner]);
}, 60000);

afterAll(async () => {
  await q('DELETE FROM webhook_endpoints WHERE company_id = ANY($1)', [[company, other]]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool(), billingAdminPool(), routeAdminPool()]);
});

beforeEach(async () => {
  await q('DELETE FROM webhook_endpoints WHERE company_id = ANY($1)', [[company, other]]);
  outbound.calls.length = 0;
  outbound.status = 200;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://93.184.216.3')) return realFetch(input, init);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    outbound.calls.push({ url, signature: headers['X-Webhook-Signature'] ?? null });
    return new Response('ok', { status: outbound.status });
  });
});
afterEach(() => vi.restoreAllMocks());

describe('S-07e part B (946): webhook endpoints, through the route on the production logins', () => {
  it('create, list, update every field, delete; the secret is stored encrypted', async () => {
    const created = await call('POST', { body: { name: 'Hook A', url: URL_A, secret: S1, events: ['invoice.created'] } });
    expect(created.status).toBe(200);
    const id = String(data(created).id);
    expect(data(created).secret).toBe('••••••••'); // masked in the response
    const stored = await row(id);
    expect(stored).toMatchObject({ company_id: company, name: 'Hook A', url: URL_A, is_active: true, failure_count: 0 });
    expect(stored!.events).toEqual(['invoice.created']);
    expect(stored!.secret).not.toBe(S1);
    expect(String(stored!.secret).split(':')).toHaveLength(3);
    expect(decryptToken(String(stored!.secret))).toBe(S1);

    const listed = await call('GET');
    expect(listed.status).toBe(200);
    expect((data(listed) as unknown as Array<{ id: string }>).map((w) => w.id)).toContain(id);

    const updated = await call('PUT', { body: { id, name: 'Hook A2', url: URL_B, events: ['invoice.paid', 'payment.received'],
      secret: S2, isActive: false } });
    expect(updated.status).toBe(200);
    const after = await row(id);
    expect(after).toMatchObject({ name: 'Hook A2', url: URL_B, is_active: false });
    expect(after!.events).toEqual(['invoice.paid', 'payment.received']);
    expect(decryptToken(String(after!.secret))).toBe(S2);

    const cleared = await call('PUT', { body: { id, secret: null } });
    expect(cleared.status).toBe(200);
    expect((await row(id))!.secret).toBeNull();

    const removed = await call('DELETE', { query: { id } });
    expect(removed.status).toBe(200);
    expect(await row(id)).toBeUndefined();
  });

  it('a create without a signing secret stores none', async () => {
    const created = await call('POST', { body: { name: 'No secret', url: URL_A, events: ['invoice.created'] } });
    expect(created.status).toBe(200);
    expect((await row(String(data(created).id)))!.secret).toBeNull();
  });
});

describe('S-07e part B (946): fireWebhook, the delivery stamp and the auto-disable on migration_admin', () => {
  let id = '';
  beforeEach(async () => {
    id = (await createWebhook(company, { name: 'Fire', url: URL_A, secret: 'sig-secret', events: ['invoice.created'] })).id;
  });
  afterEach(async () => { await q('DELETE FROM webhook_endpoints WHERE id = $1', [id]); });

  it('a successful delivery is signed, stamps last_triggered_at and resets failure_count', async () => {
    await q('UPDATE webhook_endpoints SET failure_count = 4 WHERE id = $1', [id]);
    await fireWebhook(company, 'invoice.created', { n: 1 });
    expect(outbound.calls).toHaveLength(1);
    expect(outbound.calls[0]!.signature).toMatch(/^[0-9a-f]{64}$/);
    const r = await row(id);
    expect(r!.failure_count).toBe(0);
    expect(r!.last_triggered_at).not.toBeNull();
    expect((await q('SELECT success FROM webhook_deliveries WHERE webhook_id = $1', [id])).rows).toEqual([{ success: true }]);
  });

  it('failures count up, and the 10th switches the endpoint off', async () => {
    outbound.status = 500;
    await q('UPDATE webhook_endpoints SET failure_count = 8 WHERE id = $1', [id]);
    await fireWebhook(company, 'invoice.created', { n: 2 });
    expect(await row(id)).toMatchObject({ failure_count: 9, is_active: true });
    await fireWebhook(company, 'invoice.created', { n: 3 });
    expect(await row(id)).toMatchObject({ failure_count: 10, is_active: false });
    // Off: the next event is not delivered.
    outbound.calls.length = 0;
    await fireWebhook(company, 'invoice.created', { n: 4 });
    expect(outbound.calls).toHaveLength(0);
  });

  it('the app pool can neither stamp a delivery nor write is_active (the refusal is 42501)', async () => {
    const pool = getDbPool();
    await expect(pool.query('UPDATE webhook_endpoints SET failure_count = 3, last_triggered_at = NOW() WHERE id = $1', [id])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('UPDATE webhook_endpoints SET failure_count = 0 WHERE id = $1', [id])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('UPDATE webhook_endpoints SET is_active = false WHERE id = $1', [id])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('UPDATE webhook_endpoints SET url = $2 WHERE id = $1', [id, URL_B])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('S-07e part B (946): another tenant\'s endpoint', () => {
  it('an owner of company A cannot update or delete company B\'s endpoint', async () => {
    const theirs = (await createWebhook(other, { name: 'Theirs', url: URL_A, secret: 's', events: ['invoice.created'] })).id;
    const before = await row(theirs);
    const put = await call('PUT', { body: { id: theirs, name: 'Hijacked', url: URL_B, isActive: false, secret: 'x', events: ['x'] } });
    expect(put.status).toBe(400);
    const del = await call('DELETE', { query: { id: theirs } });
    expect(del.status).toBeLessThan(500); // the route reports a no-op delete as deleted; the row must still be there
    expect(await row(theirs)).toEqual(before);
    expect((data(await call('GET')) as unknown as Array<{ id: string }>).map((w) => w.id)).not.toContain(theirs);
  });
});
