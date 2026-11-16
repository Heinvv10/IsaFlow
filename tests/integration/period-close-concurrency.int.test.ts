/**
 * Two connections over the same periods (review of PR #1451, 2026-11-15).
 *
 *   Q9  Close vs Reopen, and Bulk Close (click order) vs Close Year (period
 *       order), serialise: the second waits on the first's row locks and then
 *       succeeds. No deadlock, because every period locker takes its rows in
 *       (fiscal_year, period_number, id) order.
 *   B4  A Bulk Close that loses a lock wait part-way never answers ok:true for
 *       a period the database did not keep: 503, and every period it had
 *       already closed in that request is rolled back.
 *   B2  A period reopened while the year-end close is in flight is seen by the
 *       close's locked re-read and refuses it; nothing is locked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { members } from './entity-changes.helpers';
import { cleanupAudit } from './audit-snapshots.helpers';
import { gateFixture } from './helpers/periodCloseGateFixture';
import { als, type RequestContext } from '../../src/lib/als';
import { closePeriod, closeYear, reopenPeriod } from '../../src/modules/accounting/services/gl/fiscalPeriodService';
import { runBulkPeriodAction } from '../../src/modules/accounting/services/gl/fiscalPeriodBulk';
import { getCloseReadiness } from '../../src/modules/accounting/services/gl/periodCloseReadinessService';
import { runInPeriodLockBudget } from '../../src/modules/accounting/services/gl/periodLockBudgetScope';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const fx = gateFixture(pool, companies, tokens);

beforeAll(async () => { [fx.owner] = await members(pool, tokens, 1); });
afterAll(() => cleanupAudit(pool, companies, [fx.owner]));

/** A request transaction held open by the test: app_user, the owner's claims, the company GUC. */
async function request(c: string) {
  const client: PoolClient = await pool.connect();
  const claims = { sub: fx.owner, role: 'authenticated', company_id: c };
  const ctx = { client, userId: fx.owner, companyId: c, claims, afterCommit: [] } as unknown as RequestContext;
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await client.query("SELECT set_config('app.current_company_id', $1, true)", [c]);
  return {
    run: <T>(fn: () => Promise<T>) => als.run(ctx, fn),
    end: async (how: 'COMMIT' | 'ROLLBACK') => { try { await client.query(how); } finally { client.release(); } },
  };
}

/** Resolves once some backend is waiting on a row lock (the second request is queued, not refused). */
async function someoneWaitsOnALock(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
    if (rows[0].n > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('nobody waited on a lock');
}

const settledWithin = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), ms))]);

describe('Q9: period lockers serialise instead of deadlocking', () => {
  it('a Reopen waits for the Close in flight, then reopens the closed period', async () => {
    const b = await fx.books();
    const a = await request(b.c);
    await a.run(() => closePeriod(b.c, b.periods[0]!, fx.owner));
    const r = await request(b.c);
    const reopen = r.run(() => reopenPeriod(b.c, b.periods[0]!));
    await someoneWaitsOnALock();
    expect(await settledWithin(reopen, 200)).toBe(false);
    await a.end('COMMIT');
    await expect(reopen).resolves.toMatchObject({ status: 'open' });
    await r.end('COMMIT');
    expect((await fx.statuses(b.c))[0]).toBe('open');
  });

  it('Bulk Close in click order and Close Year over the same periods: one waits, both finish, no 40P01', async () => {
    const b = await fx.books();
    const a = await request(b.c);
    const bulk = await a.run(() => runBulkPeriodAction(b.c, 'bulk_close', [b.periods[1]!, b.periods[0]!], fx.owner));
    expect(bulk.okCount).toBe(2);
    const y = await request(b.c);
    const year = y.run(() => closeYear(b.c, 2026, fx.owner));
    await someoneWaitsOnALock();
    await a.end('COMMIT');
    await expect(year).resolves.toHaveLength(10);
    await y.end('COMMIT');
    expect(new Set(await fx.statuses(b.c))).toEqual(new Set(['closed']));
  });
});

describe('B4: a lost lock wait is never reported as success', () => {
  it('Bulk Close of the whole year whose last period cannot take the year row: 503, all twelve rolled back', async () => {
    const b = await fx.books();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      // Closing the twelfth period moves the year's derived status, so that UPDATE needs the fiscal_years row.
      await holder.query('SELECT 1 FROM fiscal_years WHERE company_id = $1 AND fiscal_year = 2026 FOR UPDATE', [b.c]);
      const res = await fx.action(b.c, { action: 'bulk_close', ids: [...b.periods].reverse(), confirm: true });
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(503);
      expect(JSON.stringify(res.state.body)).not.toContain('"ok":true');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(new Set(await fx.statuses(b.c))).toEqual(new Set(['open']));
  }, 30_000);

  it('a period row another request holds: the up-front lock times out, 503, nothing closed', async () => {
    const b = await fx.books();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM fiscal_periods WHERE id = $1 FOR UPDATE', [b.periods[1]]);
      const res = await fx.action(b.c, { action: 'bulk_close', ids: [b.periods[0], b.periods[1]], confirm: true });
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(503);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await fx.statuses(b.c)).slice(0, 2)).toEqual(['open', 'open']);
  }, 30_000);
});

describe('B2: a period reopened while the year-end close runs', () => {
  it('is seen by the locked re-read: open_periods, named, nothing locked', async () => {
    const b = await fx.books();
    await fx.retainedEarnings(b.c);
    await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE id = ANY($1)", [b.periods]);
    const reopener = await pool.connect();
    try {
      await reopener.query('BEGIN');
      await reopener.query("UPDATE fiscal_periods SET status = 'open' WHERE id = $1", [b.periods[11]]);
      const close = fx.yearEndClose(b.c); // its early read still sees P12 closed
      await someoneWaitsOnALock();
      await reopener.query('COMMIT');
      const res = await close;
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
      expect(JSON.stringify(res.state.body)).toContain('1 period is not closed yet (P12 2026)');
    } finally {
      reopener.release();
    }
    expect(await fx.statuses(b.c)).not.toContain('locked');
  }, 30_000);
});

describe('F: a readiness check that waits on a held lock', () => {
  /** getCloseReadiness for January on its own request, with a short lock_timeout, optionally inside a period lock budget. */
  async function readiness(c: string, period: string, inBudget: boolean) {
    const r = await request(c);
    try {
      return await r.run(async () => {
        await als.getStore()!.client.query("SET LOCAL lock_timeout = '300ms'");
        const run = () => getCloseReadiness(c, period);
        return await (inBudget ? runInPeriodLockBudget(run) : run()).then((x) => x!.items, (e) => (e as { code?: string }).code);
      });
    } finally { await r.end('ROLLBACK'); }
  }

  it('advisory (no lock budget): one busy row and the rest of the checklist; inside a close\'s budget: rethrown (55P03)', async () => {
    const b = await fx.books();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE bank_transactions IN ACCESS EXCLUSIVE MODE');
      const advisory = await readiness(b.c, b.periods[0]!, false);
      expect(Array.isArray(advisory) && advisory.length).toBe(8);
      expect((advisory as Array<Record<string, string>>)[0]).toMatchObject({
        key: 'bank_reconciled', status: 'warn', reason: expect.stringMatching(/^Could not compute — busy/) });
      expect(await readiness(b.c, b.periods[0]!, true)).toBe('55P03');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }, 30_000);
});
