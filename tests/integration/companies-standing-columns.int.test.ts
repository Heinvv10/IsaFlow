// tests/integration/companies-standing-columns.int.test.ts
//
// Migration 936: app_user (and app_service, which inherits it) held INSERT,
// UPDATE and DELETE on every column of companies. RLS admits an UPDATE of any
// company the caller administers, forged claims administer any company, and
// the service pool's mirror policy (app_service_update) is USING (true). So a
// tenant could un-suspend or un-delete a company, extend its trial, move its
// plan, turn PAYG on, or set the platform's flags and billing contact. Each is
// now refused by privilege on the logins production has (s07b helpers). The
// legitimate app-pool writers: companies-standing-columns.paths. The admin
// site and signup: companies-standing-columns.admin. The migration and its
// rule: companies-standing-columns.migration.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import chaseSettingsRoute from '../../pages/api/accounting/chase-settings';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { attempt, fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const { company } = ids;
const suspended = crypto.randomUUID(); // suspended by the platform; `tenant` is its admin
const deleted = crypto.randomUUID(); // soft-deleted by the platform; `tenant` is its admin
const tenant = crypto.randomUUID(); // also a viewer of `company`, whose requests carry the injected SQL
const plan = crypto.randomUUID();

beforeAll(async () => {
  await setup(ids);
  await fixture.query(`INSERT INTO plans (id, code, name) VALUES ($1, $2, '936 enterprise')`, [plan, `p936-${plan.slice(0, 8)}`]);
  await fixture.query(`INSERT INTO companies (id, name, is_active, status, suspended_at, suspended_reason)
    VALUES ($1, '936 suspended', true, 'suspended', NOW(), 'unpaid'), ($2, '936 deleted', true, 'deleted', NULL, NULL)`,
  [suspended, deleted]);
  await fixture.query(`INSERT INTO users (id, email, role, is_active, status) VALUES ($1, $2, 'viewer', true, 'active')`,
    [tenant, `${tenant}@test.local`]);
  await fixture.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES
    ($1, $4, 'admin', true), ($2, $4, 'admin', false), ($3, $4, 'viewer', false)`, [suspended, deleted, company, tenant]);
}, 60000);

afterAll(async () => {
  await fixture.query('DELETE FROM company_users WHERE user_id = $1', [tenant]);
  await fixture.query('DELETE FROM users WHERE id = $1', [tenant]);
  await fixture.query(`DELETE FROM companies WHERE id = ANY($1::uuid[]) OR name = '936 forged'`, [[suspended, deleted]]);
  await fixture.query('DELETE FROM plans WHERE id = $1', [plan]);
  await teardown(ids, [getAuthPool(), getDbPool()]);
});

const denied = { code: '42501', message: 'permission denied for table companies' };

// Each statement fails with division_by_zero when it touches no row, so on a
// database without 936 an attack that "succeeds" by matching nothing is not
// mistaken for a refusal or for a write.
const hit = (dml: string) => `WITH w AS (${dml} RETURNING 1) SELECT 1 / count(*) FROM w`;

/** [what it would do, statement, params] */
type Attack = [string, string, () => unknown[]];
const ATTACKS: Attack[] = [
  ['un-suspend a suspended company', hit(`UPDATE companies SET status = 'active', suspended_at = NULL, suspended_reason = NULL
    WHERE id = $1`), () => [suspended]],
  ['un-delete a deleted company', hit(`UPDATE companies SET status = 'active' WHERE id = $1`), () => [deleted]],
  ['extend a trial', hit(`UPDATE companies SET trial_ends_at = NOW() + interval '10 years' WHERE id = $1`), () => [suspended]],
  ['move to another plan', hit('UPDATE companies SET plan_id = $2 WHERE id = $1'), () => [suspended, plan]],
  ['turn PAYG eligibility on', hit('UPDATE companies SET payg_eligible = true WHERE id = $1'), () => [suspended]],
  ['switch foreign-currency documents on', hit('UPDATE companies SET fx_documents_enabled = true WHERE id = $1'), () => [suspended]],
  ['mark itself a demo company', hit('UPDATE companies SET is_demo = true WHERE id = $1'), () => [suspended]],
  ['rewrite the platform metadata', hit(`UPDATE companies SET metadata = '{"forged": true}' WHERE id = $1`), () => [suspended]],
  ['re-point the billing email', hit(`UPDATE companies SET billing_email = 'attacker@evil.test' WHERE id = $1`), () => [suspended]],
  ['re-point the billing contact', hit(`UPDATE companies SET billing_contact = 'attacker' WHERE id = $1`), () => [suspended]],
  ['flip is_active', hit('UPDATE companies SET is_active = true WHERE id = $1'), () => [suspended]],
  ['clear a customer reference', hit('UPDATE companies SET stripe_customer_id = NULL WHERE id = $1'), () => [suspended]],
  ['re-key a company', hit('UPDATE companies SET id = gen_random_uuid() WHERE id = $1'), () => [deleted]],
  ['backdate a company', hit(`UPDATE companies SET created_at = '2000-01-01' WHERE id = $1`), () => [suspended]],
  ['insert a company carrying a locked column', hit(`INSERT INTO companies (name, status, payg_eligible)
    VALUES ('936 forged', 'active', true)`), () => []],
  ['insert a company with only unlocked columns', hit(`INSERT INTO companies (name) VALUES ('936 forged')`), () => []],
  ['delete a company', hit('DELETE FROM companies WHERE id = $1'), () => [deleted]],
];

const pools: Array<[string, () => Pool, Parameters<typeof attempt>[2]]> = [
  ['isaflow_app, the suspended company\'s admin on another company\'s request', getAuthPool,
    { asRequest: { sub: tenant, companyId: company } }],
  ['isaflow_service with no claims', getDbPool, {}],
  ['isaflow_service under the tenant\'s claims', getDbPool, { claims: { sub: tenant, companyId: company } }],
];

describe.each(pools)('936: %s', (_, pool, opts) => {
  it.each(ATTACKS)('cannot %s', async (_what, text, params) => {
    expect(await attempt(pool(), [[text, params()]], opts)).toEqual(denied);
  });

  it.each(ATTACKS)('cannot %s after set_config(role, none) either', async (_what, text, params) => {
    expect(await attempt(pool(), [[`SELECT set_config('role', 'none', true)`], [text, params()]], opts)).toEqual(denied);
  });
});

describe('936: what stays readable and writable on the app pools', () => {
  it('a company admin still updates an unlocked column and reads the locked ones', async () => {
    expect(await attempt(getAuthPool(), [
      [hit(`UPDATE companies SET trading_name = '936 renamed', annual_turnover_cents = 1 WHERE id = $1`), [suspended]],
      [`SELECT 1 / count(*) FROM companies WHERE id = $1 AND status = 'suspended' AND suspended_at IS NOT NULL
        AND payg_eligible = false AND plan_id IS NULL AND metadata IS NOT NULL`, [suspended]],
    ], { asRequest: { sub: tenant, companyId: company } })).toBeNull();
  });
});

describe('936: the breaker\'s repro, end to end', () => {
  const status = async (companyId: string) => (await callRoute(chaseSettingsRoute,
    { sub: tenant, method: 'GET', companyId })).status;

  it('a suspended company\'s admin cannot un-suspend it by injected SQL, and withAuth keeps refusing it', async () => {
    expect(await status(suspended)).toBe(403);
    expect(await status(company)).toBe(200);
    // Committed, as a successful injection would be: the request's own transaction.
    const c = await getAuthPool().connect();
    let outcome: unknown = null;
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: tenant })]);
      await c.query(`SELECT set_config('app.current_company_id', $1, true)`, [company]);
      await c.query(`UPDATE companies SET status = 'active', suspended_at = NULL, suspended_reason = NULL WHERE id = $1`,
        [suspended]);
      await c.query('COMMIT');
    } catch (err) {
      outcome = { code: (err as { code?: string }).code, message: (err as Error).message };
      await c.query('ROLLBACK');
    } finally {
      c.release(true);
    }
    try {
      // One assertion, so a database without 936 shows both halves: the write commits AND withAuth admits.
      expect({ outcome, after: await status(suspended) }).toEqual({ outcome: denied, after: 403 });
    } finally {
      await fixture.query(`UPDATE companies SET status = 'suspended', suspended_at = NOW(), suspended_reason = 'unpaid'
        WHERE id = $1`, [suspended]);
    }
  });
});
