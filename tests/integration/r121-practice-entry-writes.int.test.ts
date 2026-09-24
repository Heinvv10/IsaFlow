/**
 * R-121 — practice time capture writes columns not every database has.
 *
 * createPracticeEntry / updatePracticeEntry write time_entries.amount (no
 * migration creates it), and createClientRateOverride / resolveRate / migration
 * 626's trigger use practice_client_rate_overrides.user_id and .rate, which a
 * table predating migration 372 lacks. The r112 fixture is a DEV schema dump,
 * and on it every one of these raised 42703. Migration 625b adds the missing
 * columns (ordered before 626, which needs them). Migration 699 grants the
 * table and replaces 395's company_id-claim policy with tenant_isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import rateOverridesRoute from '../../pages/api/accounting/practice/clients/[id]/rate-overrides';
import { createPracticeEntry, updatePracticeEntry } from '@/modules/accounting/services/practice/practiceTimeEntryService';
import { createClientRateOverride } from '@/modules/accounting/services/practice/practiceClientRateOverrideService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = randomUUID();
const user = randomUUID();
const client = randomUUID();
const category = randomUUID();
const workItem = randomUUID();
const otherCompany = randomUUID();
const otherClient = randomUUID();
// GoTrue owns auth.users and it does not ship in the schema fixture; the
// override service joins it. Same stub and lock as k-039 (they share it).
const AUTH_USERS_STUB_LOCK = 39039039;
let createdAuthUsers = false;
let lockClient: import('pg').PoolClient;

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await als.run({ client: c, userId: user, companyId: company, claims: {} } as never, fn);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally { c.release(); }
}

beforeAll(async () => {
  lockClient = await pool.connect();
  await lockClient.query('SELECT pg_advisory_lock($1)', [AUTH_USERS_STUB_LOCK]);
  createdAuthUsers = (await pool.query("SELECT to_regclass('auth.users') AS reg")).rows[0].reg === null;
  if (createdAuthUsers) {
    await pool.query('CREATE TABLE auth.users(id UUID PRIMARY KEY, email TEXT, raw_user_meta_data JSONB)');
    await pool.query('GRANT SELECT ON auth.users TO app_user');
  }
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [company, 'R121 company', otherCompany, 'R121 other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    "INSERT INTO practice_clients(id,company_id,legal_name,billing_model,status) VALUES($1,$2,'R121 client','hourly','active')",
    [client, company]);
  await pool.query(
    "INSERT INTO practice_clients(id,company_id,legal_name,billing_model,status) VALUES($1,$2,'R121 other client','hourly','active')",
    [otherClient, otherCompany]);
  await pool.query('INSERT INTO practice_job_categories(id,company_id,name) VALUES($1,$2,$3)', [category, company, 'R121 cat']);
  await pool.query('INSERT INTO practice_work_items(id,company_id,category_id,name) VALUES($1,$2,$3,$4)',
    [workItem, company, category, 'R121 item']);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query("INSERT INTO practice_staff_rates(company_id,user_id,rate,effective_from) VALUES($1,$2,850,'2020-01-01')",
    [company, user]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM time_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM practice_staff_rates WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM practice_client_rate_overrides WHERE company_id = ANY($1)', [[company, otherCompany]]);
    await pool.query('DELETE FROM practice_work_items WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM practice_job_categories WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM practice_clients WHERE company_id = ANY($1)', [[company, otherCompany]]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[company, otherCompany]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
    if (createdAuthUsers) await pool.query('DROP TABLE auth.users');
    await lockClient.query('SELECT pg_advisory_unlock($1)', [AUTH_USERS_STUB_LOCK]);
    lockClient.release();
  } finally { await pool.end(); }
});

describe('R-121: practice time capture runs on a repo-built schema', () => {
  it('creates and then edits a practice entry, keeping line_total = hours × rate', async () => {
    const created = await inTx(() => createPracticeEntry(company, user, {
      entryDate: '2026-01-05', hours: 2, practiceClientId: client, jobCategoryId: category,
      workItemId: workItem, taskDescription: 'R121 work',
    }));
    expect(created.lineTotal).toBe(1700);

    const updated = await inTx(() => updatePracticeEntry(company, created.id, { hours: 3 }));
    expect(updated.lineTotal).toBe(2550);
    const row = (await pool.query('SELECT hours, applied_rate, line_total FROM time_entries WHERE id=$1', [created.id])).rows[0];
    expect(row).toMatchObject({ hours: '3.00', line_total: '2550.00' });
  });

  it('records a client rate override, and a new entry bills at it', async () => {
    await inTx(() => createClientRateOverride(company, client, {
      staffUserId: user, ratePerHour: 1200, effectiveFrom: '2026-01-01',
    }));
    const entry = await inTx(() => createPracticeEntry(company, user, {
      entryDate: '2026-01-06', hours: 1.5, practiceClientId: client, jobCategoryId: category,
      workItemId: workItem, taskDescription: 'R121 override work',
    }));
    expect(entry.lineTotal).toBe(1800);
    const row = (await pool.query(
      'SELECT user_id, rate, staff_user_id, rate_per_hour FROM practice_client_rate_overrides WHERE company_id=$1', [company])).rows[0];
    expect(row).toMatchObject({ user_id: user, rate: '1200.00', staff_user_id: user, rate_per_hour: '1200.00' });
  });

  it('the rate-overrides route works through withAuth (app_user, RLS, a GoTrue token with no company_id claim)', async () => {
    const token = await new SignJWT({ sub: user, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const call = async (method: string, body: Record<string, unknown> = {}) => {
      const req = request({ 'sb-access-token': token, active_company_id: company }, method) as never as
        { body: unknown; query: Record<string, string>; url: string };
      req.body = body;
      req.query = { id: client };
      req.url = `/api/accounting/practice/clients/${client}/rate-overrides`;
      const out = response();
      await rateOverridesRoute(req as never, out.res as never);
      return out.state as { statusCode: number; body: { data?: unknown; error?: { message?: string } } };
    };
    const created = await call('POST', { staffUserId: user, ratePerHour: 990, effectiveFrom: '2026-03-01' });
    expect(created.statusCode, JSON.stringify(created.body)).toBeLessThan(300);
    const listed = await call('GET');
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.body.data)).toContain('990');
  });

  // Tenant isolation under the new policy, as withAuth runs it: app_user, the
  // user's `sub`, and app.current_company_id — no company_id claim.
  async function asAppUser<T>(fn: (c: import('pg').PoolClient) => Promise<T>, active = company): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [active]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  it('app_user cannot see another company\'s override', async () => {
    await pool.query(
      `INSERT INTO practice_client_rate_overrides (company_id, client_id, staff_user_id, user_id, rate_per_hour, rate, effective_from)
       VALUES ($1, $2, $3, $3, 777, 777, '2026-01-01')`, [otherCompany, otherClient, user]);
    const seen = await asAppUser((c) => c.query(
      'SELECT id FROM practice_client_rate_overrides WHERE company_id = $1', [otherCompany]));
    expect(seen.rows).toHaveLength(0);
  });

  it('app_user cannot insert an override into another company (WITH CHECK)', async () => {
    const err = await asAppUser((c) => c.query(
      `INSERT INTO practice_client_rate_overrides (company_id, client_id, staff_user_id, user_id, rate_per_hour, rate, effective_from)
       VALUES ($1, $2, $3, $3, 555, 555, '2026-02-01')`, [otherCompany, otherClient, user])).catch((e: unknown) => e);
    expect(String((err as Error)?.message)).toMatch(/row-level security/);
  });

  // No RETURNING: it would be refused by USING and hide a WITH CHECK that lacks membership.
  it('a non-member cannot write into a company even when it is the active one', async () => {
    const err = await asAppUser((c) => c.query(
      `INSERT INTO practice_client_rate_overrides (company_id, client_id, staff_user_id, user_id, rate_per_hour, rate, effective_from)
       VALUES ($1, $2, $3, $3, 333, 333, '2026-02-03')`, [otherCompany, otherClient, user]), otherCompany).catch((e: unknown) => e);
    expect(String((err as Error)?.message)).toMatch(/row-level security/);
  });

  it('a member of two companies cannot write into the one that is not active', async () => {
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [otherCompany, user]);
    try {
      const err = await asAppUser((c) => c.query(
        `INSERT INTO practice_client_rate_overrides (company_id, client_id, staff_user_id, user_id, rate_per_hour, rate, effective_from)
         VALUES ($1, $2, $3, $3, 444, 444, '2026-02-02')`, [otherCompany, otherClient, user])).catch((e: unknown) => e);
      expect(String((err as Error)?.message)).toMatch(/row-level security/);
    } finally {
      await pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2', [otherCompany, user]);
    }
  });
});
