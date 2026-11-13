/**
 * Budgets P6 PR C, real PostgreSQL through the real routes: what the engine and the chain resolver
 * refuse on real data is a TYPED 4xx, never a 500 (422 BUDGET_THREE_WAY_RANGE for figures past the
 * engine's caps, 422 BUDGET_THREE_WAY_ENGINE_INPUT for another refused input, 400 for a stored document
 * or a chain that cannot resolve), and an existing 60-month loan's FULL-LIFE `previewSchedule` reaches
 * the engine, which applies only the lines inside the version.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { previewSchedule } from '@/modules/accounting/services/loans/loanScheduleService';
import { defaultAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsDefaults';
import type { ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { monthsFrom } from './helpers/budgetGridFixture';
import { budgetThreeWayFixture, code, dataOf, details, type RouteOut, type ThreeWayCo } from './helpers/budgetThreeWayFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetThreeWayFixture(pool);
const FY = monthsFrom('2026-03');
const dump = (r: RouteOut) => JSON.stringify(r.body).slice(0, 400);
const fullDoc = () => defaultAssumptions({ priorYearEnd: '2026-02', entityType: 'pty_ltd', vat: { registered: false, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' } });

let R: ThreeWayCo;
let loanId: string;

beforeAll(async () => {
  R = await fx.company();
  const loanAcct = String((await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
     VALUES ($1, '2500', 'Vehicle loan', 'liability', 'credit', 3, true) RETURNING id`, [R.id])).rows[0].id);
  await fx.journal(R, '2025-12-31', [{ acct: loanAcct, credit: 120000 }]); // the bank leg debits 120 000
  loanId = String((await pool.query(
    `INSERT INTO loans (company_id, gl_account_id, principal, start_date, term_months, rate_mode, fixed_rate, reference)
     VALUES ($1, $2, 120000, '2025-12-01', 60, 'FIXED', 10, 'TW-60') RETURNING id`, [R.id, loanAcct])).rows[0].id);
}, 60000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM loans WHERE company_id = $1', [R.id]);
    await fx.cleanup();
  } finally { await pool.end(); }
});

describe('engine refusals are typed 4xx', () => {
  it('a budget figure past the engine cap (1e13 cents) is 422 BUDGET_THREE_WAY_RANGE through index and compare', async () => {
    const v = await fx.version(R, { kind: 'reforecast' });
    await fx.amount(R, v, R.acct.sales, FY[0]!, 200_000_000_000);
    const r = await fx.routes.index(R.owner, { version_id: v });
    expect(r.status, dump(r)).toBe(422);
    expect(details(r)).toMatchObject({ code: 'BUDGET_THREE_WAY_RANGE', reason: 'RANGE' });
    const c = await fx.routes.compare(R.owner, v);
    expect(c.status).toBe(422);
    expect(code(c)).toBe('BUDGET_THREE_WAY_RANGE');
  });

  it('a planned loan reusing an included loan’s id is 422 BUDGET_THREE_WAY_ENGINE_INPUT (LOAN_SCHEDULE)', async () => {
    const v = await fx.version(R, { kind: 'reforecast' });
    const doc = fullDoc();
    doc.loans.existing = [{ loanId, include: true }];
    doc.loans.planned = [{ id: loanId, description: 'dup', drawdownMonth: '2026-04', principal: 100000, annualRatePct: 10, termMonths: 12, firstRepaymentMonth: '2026-05' }];
    // The schema stores it (ids are unique per list); the engine refuses the clash when it runs.
    const put = await fx.routes.put(R.owner, { version_id: v, doc, expected_updated_at: null });
    expect(put.status, dump(put)).toBe(200);
    const r = await fx.routes.index(R.owner, { version_id: v });
    expect(r.status, dump(r)).toBe(422);
    expect(details(r)).toMatchObject({ code: 'BUDGET_THREE_WAY_ENGINE_INPUT', reason: 'LOAN_SCHEDULE' });
  });

  it('a stored document that no longer validates is 400 BUDGET_ASSUMPTIONS_INVALID (index and GET assumptions)', async () => {
    const v = await fx.version(R, { kind: 'reforecast' });
    await pool.query(`INSERT INTO budget_three_way_assumptions (company_id, version_id, doc) VALUES ($1, $2, '{"schemaVersion": 1}')`, [R.id, v]);
    for (const r of [await fx.routes.index(R.owner, { version_id: v }), await fx.routes.getAssumptions(R.owner, v)]) {
      expect(r.status, dump(r)).toBe(400);
      expect(code(r)).toBe('BUDGET_ASSUMPTIONS_INVALID');
    }
  });

  it('stored overrides over a base in another year are 400 BUDGET_SCENARIO_CHAIN CROSS_YEAR on read', async () => {
    const base = await fx.version(R, { fy: 2026, kind: 'original' });
    const s = await fx.version(R, { kind: 'scenario', basedOn: base });
    await pool.query(`INSERT INTO budget_three_way_assumptions (company_id, version_id, doc) VALUES ($1, $2, '{"schemaVersion": 1, "overrides": {}}')`, [R.id, s]);
    const r = await fx.routes.index(R.owner, { version_id: s });
    expect(r.status, dump(r)).toBe(400);
    expect(details(r)).toMatchObject({ code: 'BUDGET_SCENARIO_CHAIN', reason: 'CROSS_YEAR' });
  });
});

describe('an existing 60-month loan: the whole-life schedule is passed, only in-version lines apply', () => {
  it('principal repaid each version month = the schedule’s, the opening loan from its GL account', async () => {
    const v = await fx.version(R, { kind: 'reforecast' });
    const doc = fullDoc();
    doc.loans.existing = [{ loanId, include: true }];
    expect((await fx.routes.put(R.owner, { version_id: v, doc, expected_updated_at: null })).status).toBe(200);
    const rows = await fx.direct(R, () => previewSchedule(R.id, loanId));
    expect(rows).toHaveLength(60);
    const principalIn = (m: string) => rows.filter((x) => x.date.slice(0, 7) === m)
      .reduce((s, x) => s + Math.round((x.principal + x.lump) * 100), 0);

    const r = await fx.routes.index(R.owner, { version_id: v });
    expect(r.status, dump(r)).toBe(200);
    const w = dataOf<ThreeWayView>(r);
    expect(w.opening.buckets.loans).toBe(-12_000_000);
    expect(w.warnings.some((x) => x.code === 'loan_schedule_missing')).toBe(false);
    let prev = w.opening.buckets.loans;
    for (const [i, m] of FY.entries()) {
      const loans = w.balanceSheet[i]!.closing.loans;
      expect([m, loans - prev]).toEqual([m, principalIn(m)]);
      prev = loans;
    }
    const inside = FY.reduce((s, m) => s + principalIn(m), 0);
    const life = rows.reduce((s, x) => s + Math.round((x.principal + x.lump) * 100), 0);
    expect(inside).toBeGreaterThan(0);
    expect(inside).toBeLessThan(life);
    expect(w.balanceSheet[FY.length - 1]!.closing.loans).toBe(-12_000_000 + inside);
    expect(w.checks.balanced).toBe(true);
  });
});
