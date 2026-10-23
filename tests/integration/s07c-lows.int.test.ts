// tests/integration/s07c-lows.int.test.ts
//
// S-07c LOWs, on the logins production has:
//   C1 (930) app_service may EXECUTE the AR matview refresh, so injected SQL
//      could loop it. It now refreshes at most once per 10 minutes and never
//      twice at once; the cron says whether it refreshed.
//   C2 the POPIA erasure's placeholder address carried only the first 8
//      characters of the user id, so a second user sharing them hit
//      users_email_key and could not be erased.
// C3 (waitlist) and C4 (verify-email): s07c-credential-writes.int.test.ts and
// tests/unit/auth/verifyEmail.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import matviewRoute from '../../pages/api/cron/ar-matview-refresh';
import dsrRoute from '../../pages/api/accounting/data-subject-rights';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { callRoute, userRow } from './s07-users-privilege-columns.helpers';
import { CRON, attempt, callCron, fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const prefix = crypto.randomUUID().slice(0, 8);
// Two ids that share their first 8 characters, as the old placeholder used.
const twins = [`${prefix}-1111-4111-8111-${crypto.randomUUID().slice(-12)}`, `${prefix}-2222-4222-8222-${crypto.randomUUID().slice(-12)}`];

beforeAll(async () => {
  await setup(ids);
  for (const id of twins) {
    await fixture.query(`INSERT INTO users (id, email, first_name, last_name, is_active, status)
      VALUES ($1, $2, 'Twin', 'Twin', true, 'active')`, [id, `${id}@test.local`]);
    await fixture.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')`, [ids.company, id]); // the route needs write access
  }
}, 60000);
afterAll(async () => {
  await fixture.query('DELETE FROM company_users WHERE user_id = ANY($1)', [twins]);
  await fixture.query('DELETE FROM users WHERE id = ANY($1)', [twins]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool()]);
});

const refreshedAt = async () => (await fixture.query(
  `SELECT refreshed_at FROM matview_refresh_state WHERE view_name = 'customer_invoice_view_summary_mv'`)).rows[0]?.refreshed_at as Date | undefined;
const refreshIfDue = async (c: PoolClient) => (await c.query('SELECT refresh_customer_invoice_view_summary_if_due() AS r')).rows[0].r as boolean;

describe('C1 (930): the matview refresh is throttled', () => {
  beforeEach(() => fixture.query('DELETE FROM matview_refresh_state'));

  it('the cron\'s first call refreshes and records when; a second call inside 10 minutes does not', async () => {
    expect(await callCron(matviewRoute, CRON)).toMatchObject({ status: 200, body: { data: { refreshed: true } } });
    const first = await refreshedAt();
    expect(first).toBeInstanceOf(Date);
    expect(await callCron(matviewRoute, CRON)).toMatchObject({ status: 200, body: { data: { refreshed: false } } });
    expect(await refreshedAt()).toEqual(first);
  });

  it('a call 9 minutes after the last does not refresh', async () => {
    await fixture.query(`INSERT INTO matview_refresh_state VALUES ('customer_invoice_view_summary_mv', clock_timestamp() - interval '9 minutes')`);
    expect(await callCron(matviewRoute, CRON)).toMatchObject({ status: 200, body: { data: { refreshed: false } } });
  });

  it('a call 10 minutes after the last refreshes again', async () => {
    await fixture.query(`INSERT INTO matview_refresh_state VALUES ('customer_invoice_view_summary_mv', clock_timestamp() - interval '11 minutes')`);
    expect(await callCron(matviewRoute, CRON)).toMatchObject({ status: 200, body: { data: { refreshed: true } } });
  });

  it('two calls at once on the migration_admin pool: one refreshes, the other returns at once without waiting', async () => {
    const [a, b] = [await migrationAdminPool().connect(), await migrationAdminPool().connect()];
    try {
      await a.query('BEGIN');
      expect(await refreshIfDue(a)).toBe(true);
      // a holds the lock until it commits: b neither waits nor refreshes.
      await b.query(`SET statement_timeout = '2s'`);
      expect(await refreshIfDue(b)).toBe(false);
      await a.query('COMMIT');
      // Committed under 10 minutes ago: still not due.
      expect(await refreshIfDue(b)).toBe(false);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('RESET statement_timeout').catch(() => undefined);
      a.release(); b.release();
    }
  });

  // Breaker rounds 1 and 2: a caller can hold the refresh's lock to the end of
  // its own transaction, and an advisory key can be held by any session.
  it.each([
    ['call the refresh', 'SELECT refresh_customer_invoice_view_summary_if_due()', 'permission denied for function refresh_customer_invoice_view_summary_if_due'],
    ['call its old name', 'SELECT refresh_customer_invoice_view_summary()', 'permission denied for function refresh_customer_invoice_view_summary'],
    ['lock its state table', 'LOCK TABLE public.matview_refresh_state IN ACCESS SHARE MODE NOWAIT', 'permission denied for table matview_refresh_state'],
  ])('an app pool cannot hold the refresh off: it may not %s', async (_, text, message) => {
    for (const pool of [getDbPool(), getAuthPool()]) {
      expect(await attempt(pool, [[text]])).toEqual({ code: '42501', message });
    }
  });

  it('an advisory lock on the old key no longer holds the refresh off', async () => {
    const c = await getDbPool().connect();
    try {
      await c.query(`SELECT pg_advisory_lock(hashtextextended('refresh_customer_invoice_view_summary', 0))`);
      expect(await callCron(matviewRoute, CRON)).toMatchObject({ status: 200, body: { data: { refreshed: true } } });
    } finally {
      await c.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      c.release(true);
    }
  });

  it('the old name is throttled the same way', async () => {
    await migrationAdminPool().query('SELECT refresh_customer_invoice_view_summary()');
    const first = await refreshedAt();
    expect(first).toBeInstanceOf(Date);
    await migrationAdminPool().query('SELECT refresh_customer_invoice_view_summary()');
    expect(await refreshedAt()).toEqual(first);
  });
});

describe('C2: the erasure placeholder carries the whole user id', () => {
  it('two users whose ids share their first 8 characters can both be erased', async () => {
    for (const id of twins) {
      const r = await callRoute(dsrRoute, { sub: id, method: 'POST', companyId: ids.company, body: { action: 'erasure' } });
      expect(r.status).toBe(200);
      expect(await userRow(id)).toMatchObject({ first_name: 'Anonymized', email: `anonymized_${id}@deleted.invalid` });
    }
  });
});
