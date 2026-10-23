/**
 * PAYE 4a follow-ups round 2, R1: a reopen racing a later month's calculation.
 *
 * May's calculation reads its year-to-date (April approved), then is parked
 * before it writes a line; April's reopen is started meanwhile. The reopen
 * takes the company approval lock the calculation holds, so it waits and its
 * reopened_at is after May's lines: the gate then knows May saw April, and an
 * unchanged re-approval of April, then May's approval, both pass. Were the
 * reopen to commit inside the window, its time would fall before May's lines
 * and both approvals would be refused although May had seen April.
 *
 * Deterministic as in p4-termination-approval-race: parked in
 * laterPeriodsWarnings (after loadPayeYearToDate), released once the reopen is
 * seen waiting on the advisory lock, or has finished. Real routes, real PG.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const park = vi.hoisted(() => ({ hold: null as null | Promise<void>, entered: null as null | (() => void) }));
vi.mock('@/modules/accounting/services/payroll/payrollYearToDate', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/payroll/payrollYearToDate')>();
  return {
    ...actual,
    laterPeriodsWarnings: async (...a: Parameters<typeof actual.laterPeriodsWarnings>) => {
      const read = await actual.laterPeriodsWarnings(...a);
      if (park.hold) { const hold = park.hold; park.hold = null; park.entered?.(); await hold; }
      return read;
    },
  };
});

import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import createRun from '../../pages/api/payroll/runs';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import { approveRun, reopenRun, cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee } from './p4fu-cumulative.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

async function mk(f: SeveranceFixture, month: number): Promise<string> {
  const made = await f.call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month, year: 2026 } });
  if (made.statusCode !== 201) throw new Error(`create: ${made.statusCode}`);
  return String(made.body.data!.id);
}
const calc = (f: SeveranceFixture, id: string) => f.call(calculate as Route, 'POST', `/api/payroll/runs/${id}/calculate`, id);

/** 'waiting' once a backend of this database waits on a lock while running a statement matching `text`. */
async function waitsOnLock(text: string, done: () => boolean): Promise<'waiting' | 'finished'> {
  for (let i = 0; i < 500 && !done(); i += 1) {
    const r = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`, [`%${text}%`]);
    if (r.rowCount) return 'waiting';
    await new Promise((res) => setTimeout(res, 20));
  }
  if (done()) return 'finished';
  throw new Error(`nothing finished and nothing waited on a lock over ${text}`);
}

describe('R1: reopen racing a later month\'s calculation', () => {
  it('the reopen waits for the calculation; April re-approved unchanged and May are both approved', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 reopen race', 20_000);
    for (const m of [3, 4]) {
      const id = await mk(f, m);
      expect((await calc(f, id)).statusCode).toBe(200);
      expect((await approveRun(f, id)).statusCode).toBe(200);
    }
    const apr = String((await pool.query(
      'SELECT id FROM payroll_run_headers WHERE company_id = $1 AND period_month = 4', [f.company])).rows[0]!.id);
    const may = await mk(f, 5);

    let release!: () => void;
    park.hold = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { park.entered = r; });
    const calcP = calc(f, may); // reads April as approved, then parks before its lines
    await entered;
    let reopened = false;
    const reopenP = reopenRun(f, apr).then((r) => { reopened = true; return r; });
    const state = await waitsOnLock('pg_advisory_xact_lock', () => reopened);
    release();
    const [calcR, reopenR] = await Promise.all([calcP, reopenP]);

    expect(state).toBe('waiting');
    expect(calcR.statusCode).toBe(200);
    expect(reopenR.statusCode, JSON.stringify(reopenR.body).slice(0, 300)).toBe(200);
    const order = (await pool.query(
      `SELECT h.reopened_at > (SELECT MIN(l.created_at) FROM payroll_run_lines l WHERE l.run_id = $2) AS after
         FROM payroll_run_headers h WHERE h.id = $1`, [apr, may])).rows[0]!;
    expect(order.after).toBe(true);
    const aprAgain = await approveRun(f, apr);
    expect(aprAgain.statusCode, JSON.stringify(aprAgain.body).slice(0, 300)).toBe(200);
    const mayOk = await approveRun(f, may);
    expect(mayOk.statusCode, JSON.stringify(mayOk.body).slice(0, 300)).toBe(200);
  });
});
