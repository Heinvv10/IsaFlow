/**
 * Budgets P6 PR C review round 1 addendum (items the breaker could not run), real PostgreSQL through
 * the real routes:
 *   7. an assumptions PUT racing a grid save and a driver write on the SAME version, all three queued
 *      behind one held version row lock and released together: no deadlock, no 5xx; the assumptions save
 *      never bumps the version token, so it succeeds, and exactly one of the two token writers wins (the
 *      other is 409 STALE); the final state holds the winners' writes and nothing of the loser's.
 *   8. derive on edge data (no history, exactly one month, a negative-turnover month, a window whose
 *      turnover is negative overall): typed defaults with their basis text, never NaN / Infinity, never 500.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import driversRoute from '../../pages/api/accounting/budget-drivers/index';
import { defaultAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsDefaults';
import type { DeriveView, ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { monthsFrom } from './helpers/budgetGridFixture';
import { budgetThreeWayFixture, dataOf, details, type RouteOut, type ThreeWayCo } from './helpers/budgetThreeWayFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const fx = budgetThreeWayFixture(pool);
const FY = monthsFrom('2026-03');
const HISTORY = monthsFrom('2025-03');
const dump = (r: RouteOut) => JSON.stringify(r.body).slice(0, 400);
const fullDoc = () => defaultAssumptions({ priorYearEnd: '2026-02', entityType: 'pty_ltd', vat: { registered: false, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' } });
const versionToken = async (v: string) => String((await pool.query(
  `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t FROM budget_versions WHERE id = $1`, [v])).rows[0].t);

/** Every number reachable in `x` is finite; with `noNulls`, no value is null either. */
function assertFinite(x: unknown, where: string, noNulls = false): void {
  if (typeof x === 'number') expect(Number.isFinite(x), where).toBe(true);
  else if (x === null) expect(noNulls, `${where} is null`).toBe(false);
  else if (Array.isArray(x)) x.forEach((v, i) => assertFinite(v, `${where}[${i}]`, noNulls));
  else if (typeof x === 'object' && x !== null) for (const [k, v] of Object.entries(x)) assertFinite(v, `${where}.${k}`, noNulls);
}

let R: ThreeWayCo;

beforeAll(async () => {
  R = await fx.company();
}, 60000);

afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
});

describe('7: assumptions PUT racing a grid save and a driver write on one version', () => {
  // Backends waiting on a lock in this database (a row-lock waiter waits on the holder's transaction id or
  // on the tuple lock, so it is counted by wait event, not by relation).
  const waiting = async () => Number((await pool.query(
    `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].count);

  it.each([1, 2, 3])('round %i: no deadlock, no 5xx; assumptions 200, one token writer 200 and one 409', async () => {
    const v = await fx.version(R, { kind: 'reforecast' });
    await fx.amount(R, v, R.acct.rent, FY[0]!, 100);
    const token = await versionToken(v);
    const holder = await pool.connect();
    let results: RouteOut[];
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM budget_versions WHERE id = $1 FOR UPDATE', [v]);
      const racing = Promise.all([
        fx.routes.put(R.owner, { version_id: v, doc: fullDoc(), expected_updated_at: null }),
        fx.call(saveRoute, '/api/accounting/budget-grid/save', R.owner, 'POST', {}, {
          versionId: v, expectedUpdatedAt: token,
          cells: [{ glAccountId: R.acct.rent, cc1Id: null, cc2Id: null, buId: null, month: FY[0], amount: 777 }],
        }),
        fx.call(driversRoute, '/api/accounting/budget-drivers', R.owner, 'PUT', {}, {
          versionId: v, expectedUpdatedAt: token, glAccountId: R.acct.cos, cc1Id: null, cc2Id: null, buId: null,
          kind: 'fixed', amount: 500, fromMonth: FY[0], toMonth: FY[11],
        }),
      ]);
      // Release only once all three wait on the held row (bounded: the writers' lock budget is 5 s).
      for (let i = 0; i < 40 && (await waiting()) < 3; i++) await new Promise((r) => { setTimeout(r, 50); });
      expect(await waiting()).toBe(3);
      await holder.query('ROLLBACK');
      results = await racing;
    } finally {
      // Never hand the pool back a connection inside the holding transaction.
      await holder.query('ROLLBACK');
      holder.release();
    }
    const [assumptions, grid, driver] = results;
    for (const r of results) expect(r.status, dump(r)).toBeLessThan(500);
    expect(assumptions!.status, dump(assumptions!)).toBe(200);
    expect([grid!.status, driver!.status].sort()).toEqual([200, 409]);
    const loser = grid!.status === 409 ? grid! : driver!;
    expect(details(loser)).toMatchObject({ code: 'BUDGET_VERSION_STALE' });

    const cells = (await pool.query(
      `SELECT gl_account_id::text AS a, to_char(month, 'YYYY-MM') AS m, amount::text AS amt FROM budget_month_amounts WHERE version_id = $1`, [v])).rows as
      Array<{ a: string; m: string; amt: string }>;
    const rent = cells.find((c) => c.a === R.acct.rent && c.m === FY[0])?.amt;
    const cosCells = cells.filter((c) => c.a === R.acct.cos);
    if (grid!.status === 200) {
      expect(rent).toBe('777.00');
      expect(cosCells).toHaveLength(0);
    } else {
      expect(rent).toBe('100.00');
      expect(cosCells.map((c) => c.amt)).toEqual(Array(12).fill('500.00'));
    }
    const s = await fx.state(v);
    expect(s.row).not.toBeNull();
    // One audit row per successful writer (the assumptions save and the token winner); the version token moved once.
    expect(s.audits).toHaveLength(2);
    expect(s.versionToken).not.toBe(token);
    const winner = grid!.status === 200 ? grid! : driver!;
    expect((winner.body.data as { updatedAt: string }).updatedAt).toBe(s.versionToken);
  }, 30000);
});

describe('8: derive on edge data', () => {
  const derive = async (c: ThreeWayCo) => {
    const v = await fx.version(c, { kind: 'reforecast' });
    const r = await fx.routes.derive(c.owner, { version_id: v });
    expect(r.status, dump(r)).toBe(200);
    const d = dataOf<DeriveView>(r);
    assertFinite(d.assumptions, 'assumptions', true);
    assertFinite(d.evidence, 'evidence');
    const run = await fx.routes.index(c.owner, { version_id: v });
    expect(run.status, dump(run)).toBe(200);
    assertFinite(dataOf<ThreeWayView>(run), 'run');
    return d;
  };

  it('no history at all: 30 / 30 / 0, insufficient history; the run answers', async () => {
    const d = await derive(await fx.company());
    expect(d.assumptions.workingCapital.debtorDays).toMatchObject({ value: 30, basis: 'insufficient history' });
    expect(d.assumptions.workingCapital.creditorDays).toMatchObject({ value: 30, basis: 'insufficient history' });
    expect(d.assumptions.workingCapital.inventoryDays).toMatchObject({ value: 0, basis: 'insufficient history' });
    expect(d.assumptions.payroll.statutoryShare).toMatchObject({ value: 0, basis: 'no payroll expense in the last 3 months' });
    expect(d.evidence).toMatchObject({ insufficientHistory: true, window: { first: null, last: null, months: 0, days: 0 } });
  });

  it('exactly one month of history: insufficient history', async () => {
    const c = await fx.company();
    await fx.journal(c, '2026-02-10', [{ acct: c.ar, debit: 10000 }, { acct: c.acct.sales, credit: 10000 }]);
    const d = await derive(c);
    expect(d.assumptions.workingCapital.debtorDays).toMatchObject({ value: 30, basis: 'insufficient history' });
    expect(d.evidence).toMatchObject({ insufficientHistory: true, window: { first: '2026-02', last: '2026-02', months: 1, days: 28 } });
  });

  it('one negative-turnover month inside a positive year: finite derived days', async () => {
    const c = await fx.company();
    for (const m of HISTORY) await fx.journal(c, `${m}-10`, [{ acct: c.ar, debit: 10000 }, { acct: c.acct.sales, credit: 10000 }]);
    await fx.journal(c, '2025-06-20', [{ acct: c.ar, credit: 25000 }, { acct: c.acct.sales, debit: 25000 }]); // a credit note: June net −15 000
    const d = await derive(c);
    // AR 120 000 − 25 000 = 95 000 over turnover 95 000 for the year: 365 days, the schema's cap.
    expect(d.evidence.trailing.turnover).toBe(9_500_000);
    expect(d.assumptions.workingCapital.debtorDays).toMatchObject({ value: 365, source: 'derived' });
  });

  it('a window whose turnover is negative overall: no basis to derive, the default with the reason', async () => {
    const c = await fx.company();
    await fx.journal(c, '2025-01-10', [{ acct: c.ar, debit: 50000 }, { acct: c.capital, credit: 50000 }]);
    for (const m of ['2025-12', '2026-01', '2026-02']) {
      await fx.journal(c, `${m}-10`, [{ acct: c.ar, credit: 4000 }, { acct: c.acct.sales, debit: 4000 }]);
    }
    const d = await derive(c);
    expect(d.evidence.trailing.turnover).toBe(-1_200_000);
    expect(d.assumptions.workingCapital.debtorDays).toMatchObject({ value: 30, basis: 'no trailing flow 2025-12..2026-02; default' });
  });
});
