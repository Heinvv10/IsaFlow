// tests/integration/s07e-b-routes-paths-admin.int.test.ts
//
// S-07e part B (migration 946): the admin site still writes webhook_endpoints.
// 946 took INSERT/UPDATE/DELETE off the app pools; the admin routes
// (pages/api/admin/webhooks.ts and webhooks/[id].ts, withAdmin -> withPlatformAdmin)
// run on the platform_admin role, driven here as a real LOGIN (the fixture's
// default PLATFORM_ADMIN_DATABASE_URL is the superuser, which would prove nothing).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { getPlatformAdminPool } from '@/lib/auth/withPlatformAdmin.pools';
import listRoute from '../../pages/api/admin/webhooks';
import itemRoute from '../../pages/api/admin/webhooks/[id]';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const { admin, company } = ids;
const endpoint = crypto.randomUUID();
const doomed = crypto.randomUUID();

async function platformAdminUrl(fixtureUrl: string): Promise<string> {
  const password = crypto.randomUUID();
  await fixture.query(`ALTER ROLE platform_admin LOGIN PASSWORD '${password}'`);
  const url = new URL(fixtureUrl);
  url.username = 'platform_admin';
  url.password = password;
  return url.toString();
}

beforeAll(async () => {
  const fixtureUrl = process.env.DATABASE_URL!;
  await setup(ids);
  vi.stubEnv('PLATFORM_ADMIN_DATABASE_URL', await platformAdminUrl(fixtureUrl));
  for (const id of [endpoint, doomed]) {
    await fixture.query(`INSERT INTO webhook_endpoints (id, company_id, name, url, secret, events, is_active, failure_count)
      VALUES ($1, $2, 'admin-site endpoint', 'https://erp.s07eb.test/hook', 'enc:secret', '{invoice.sent}', true, 4)`, [id, company]);
  }
}, 60000);

afterAll(async () => {
  try {
    await fixture.query('DELETE FROM webhook_endpoints WHERE company_id = $1', [company]);
    await fixture.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await fixture.query(`DELETE FROM rate_limit_counters WHERE key LIKE 'admin:%'`);
    await fixture.query('ALTER ROLE platform_admin NOLOGIN PASSWORD NULL');
  } finally {
    await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool(), getPlatformAdminPool()]);
  }
}, 60000);

const asAdmin = (route: unknown, method: string, opts: { query?: Record<string, string>; body?: unknown } = {}) =>
  callRoute(route, { sub: admin, method, ...opts });
const ok = (r: { status: number; body: unknown }) => { expect(r.status, JSON.stringify(r.body)).toBe(200); return r; };
const row = async (id: string) => (await fixture.query('SELECT * FROM webhook_endpoints WHERE id = $1', [id])).rows[0] as Record<string, unknown> | undefined;
const audits = async (action: string, target: string) => (await fixture.query(
  'SELECT 1 FROM admin_audit_log WHERE admin_user_id = $1 AND action = $2 AND target_id = $3', [admin, action, target])).rowCount;

describe('S-07e part B (946): the admin site writes webhook endpoints as platform_admin', () => {
  it('runs as platform_admin itself, not the superuser', async () => {
    ok(await asAdmin(listRoute, 'GET', { query: { companyId: company } }));
    const who = await getPlatformAdminPool().query('SELECT session_user AS s, current_user AS c');
    expect(who.rows[0]).toEqual({ s: 'platform_admin', c: 'platform_admin' });
  });

  it('lists the endpoint (read path)', async () => {
    const r = ok(await asAdmin(listRoute, 'GET', { query: { companyId: company } }));
    expect(JSON.stringify(r.body)).toContain(endpoint);
  });

  it('disables, then re-enables an endpoint; failure_count resets', async () => {
    ok(await asAdmin(itemRoute, 'PATCH', { query: { id: endpoint }, body: { status: 'disabled' } }));
    expect(await row(endpoint)).toMatchObject({ is_active: false, failure_count: 0 });
    ok(await asAdmin(itemRoute, 'PATCH', { query: { id: endpoint }, body: { status: 'active' } }));
    expect(await row(endpoint)).toMatchObject({ is_active: true });
    expect(await audits('webhook.update', endpoint)).toBe(2);
  });

  it('changes the url and the events', async () => {
    ok(await asAdmin(itemRoute, 'PATCH', { query: { id: endpoint },
      body: { url: 'https://erp.s07eb.test/hook-v2', events: ['invoice.sent', 'payment.received'] } }));
    const r = await row(endpoint);
    expect(r!.url).toBe('https://erp.s07eb.test/hook-v2');
    expect(r!.events).toEqual(['invoice.sent', 'payment.received']);
  });

  it('deletes an endpoint', async () => {
    expect(await row(doomed)).toBeDefined();
    expect(ok(await asAdmin(itemRoute, 'DELETE', { query: { id: doomed } })).body).toMatchObject({ data: { deleted: true } });
    expect(await row(doomed)).toBeUndefined();
    expect(await audits('webhook.delete', doomed)).toBe(1);
    expect(await row(endpoint)).toBeDefined();
  });
});
