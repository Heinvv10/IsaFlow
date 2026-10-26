/**
 * Budgets P2 PR-B, prior-year actuals for the grid (spec 4.2 priorActuals, 4.3 GET prior-actuals):
 * the SAME CALENDAR MONTH one year earlier (so a 14-month transition year maps correctly), posted
 * entries only, natural sign (revenue Cr-Dr, expense Dr-Cr), an optional dimension from the
 * journal lines, parity with trendRowsService.getMonthlyMovements at company grain, and tenant
 * isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import priorRoute from '../../pages/api/accounting/budget-grid/prior-actuals';
import { als } from '@/lib/als';
import { loadPriorActuals, type PriorActuals } from '@/modules/accounting/services/budgets/priorActuals';
import { getMonthlyMovements } from '@/modules/accounting/services/reports/trendRowsService';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, clearBudgetRateCounters, monthsFrom, type GridCo } from './helpers/budgetGridFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
const URL = '/api/accounting/budget-grid/prior-actuals';
const get = (c: GridCo, query: Record<string, string>, who: 'owner' | 'viewer' = 'owner') => fx.call(priorRoute, URL, c[who], 'GET', query);
const data = (r: { body: { data?: unknown } }) => r.body.data as PriorActuals;

let A: GridCo, B: GridCo, T: GridCo;

/** amount for an account, dimension (null = untagged) and budget-year month, or undefined when absent. */
const cell = (p: PriorActuals, acct: string, month: string, dim: string | null = null) =>
  p.cells.find((c) => c.glAccountId === acct && c.month === month && c.dimensionId === dim)?.amount;

beforeAll(async () => {
  A = await fx.company();
  B = await fx.company();
  T = await fx.company({ transition: true });
  const s = A.acct.sales, r = A.acct.rent;

  // Prior year of FY2027 (Mar 2026 - Feb 2027) is Mar 2025 - Feb 2026.
  await fx.journal(A, '2025-03-10', [{ acct: s, credit: 1000, cc1: A.cc1 }]);
  await fx.journal(A, '2025-03-11', [{ acct: s, credit: 500, cc1: A.cc1b }]);
  await fx.journal(A, '2025-03-12', [{ acct: s, credit: 200 }]);
  await fx.journal(A, '2025-03-13', [{ acct: s, debit: 50, cc1: A.cc1 }]); // a credit note: revenue is Cr - Dr
  await fx.journal(A, '2025-03-14', [{ acct: s, credit: 40, bu: A.bu }]);
  await fx.journal(A, '2025-04-02', [{ acct: r, debit: 300, cc2: A.cc2 }]);
  await fx.journal(A, '2025-04-03', [{ acct: r, credit: 20 }]); // expense is Dr - Cr
  await fx.journal(A, '2026-02-28', [{ acct: r, debit: 77 }]); // the last prior month
  // Never counted: a draft, a reversed entry, the year-end close.
  await fx.journal(A, '2025-03-15', [{ acct: s, credit: 9999 }], { status: 'draft' });
  await fx.journal(A, '2025-03-16', [{ acct: s, credit: 8888 }], { status: 'posted', source: YEAR_END_JOURNAL_SOURCE });
  const reversed = await fx.journal(A, '2025-03-17', [{ acct: s, credit: 7777 }]);
  await pool.query("UPDATE gl_journal_entries SET status = 'reversed' WHERE id = $1", [reversed]);
  // Outside the prior year of FY2027: in FY2027 itself (it is FY2028's prior year), and before Mar 2025.
  await fx.journal(A, '2026-03-05', [{ acct: s, credit: 600 }]);
  await fx.journal(A, '2025-02-27', [{ acct: s, credit: 5000 }]);

  // Another tenant posting in the same months on its own accounts.
  await fx.journal(B, '2025-03-10', [{ acct: B.acct.sales, credit: 123456 }]);

  // Transition company: FY2027 = Jan 2026 - Feb 2027 (14 months), so its prior year is Jan 2025 - Feb 2026.
  const ts = T.acct.sales;
  await fx.journal(T, '2025-01-15', [{ acct: ts, credit: 100 }]);
  await fx.journal(T, '2025-02-15', [{ acct: ts, credit: 200 }]);
  await fx.journal(T, '2025-12-15', [{ acct: ts, credit: 600 }]);
  await fx.journal(T, '2026-01-15', [{ acct: ts, credit: 700 }]); // prior of month 13 (Jan 2027)
  await fx.journal(T, '2026-02-15', [{ acct: ts, credit: 800 }]); // prior of month 14 (Feb 2027)
}, 120000);

afterAll(async () => {
  try {
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 60000);

async function direct(c: GridCo, fiscalYear: number, grain: 'company' | 'cc1' | 'cc2' | 'bu'): Promise<PriorActuals> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await als.run({ client, companyId: c.id, userId: c.user, claims: {} } as never, () => loadPriorActuals(c.id, fiscalYear, grain));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('budget-grid prior actuals: company grain', () => {
  let p: PriorActuals;
  beforeAll(async () => {
    const r = await get(A, { fiscal_year: '2027', grain: 'company' });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    p = data(r);
  });

  it('answers the budget year\'s months and the calendar months a year earlier, aligned', () => {
    expect(p.fiscalYear).toBe(2027);
    expect(p.grain).toBe('company');
    expect(p.months).toEqual(monthsFrom('2026-03'));
    expect(p.priorMonths).toEqual(monthsFrom('2025-03'));
  });

  it('keys each cell by the BUDGET month the actual maps to, in natural sign', () => {
    // Mar 2025 sales: 1000 + 500 + 200 + 40 - 50 = 1690 (revenue Cr - Dr), keyed 2026-03.
    expect(cell(p, A.acct.sales, '2026-03')).toBe(1690);
    // Apr 2025 rent: 300 - 20 = 280 (expense Dr - Cr), keyed 2026-04.
    expect(cell(p, A.acct.rent, '2026-04')).toBe(280);
    expect(cell(p, A.acct.rent, '2027-02')).toBe(77);
  });

  it('counts posted entries only: no draft, reversed or year-end journal', () => {
    expect(cell(p, A.acct.sales, '2026-03')).toBe(1690);
    expect(p.cells.some((c) => c.amount >= 7777)).toBe(false);
  });

  it('leaves out months outside the prior year and accounts that are not revenue or expense', () => {
    // Mar 2026 (R600) is the prior year of FY2028, not of FY2027; Feb 2025 (R5000) is before the window.
    expect(p.cells.some((c) => c.glAccountId === A.acct.sales && c.month !== '2026-03')).toBe(false);
    expect(p.cells.some((c) => c.glAccountId === A.acct.bank)).toBe(false);
    expect(p.cells.every((c) => p.months.includes(c.month))).toBe(true);
  });

  it('the next year maps its own prior year: Mar 2026 becomes 2027-03', async () => {
    const next = await get(A, { fiscal_year: '2028', grain: 'company' });
    expect(cell(data(next), A.acct.sales, '2027-03')).toBe(600);
  });

  it('agrees with trendRowsService.getMonthlyMovements for every revenue/expense account and month', async () => {
    // The twelve months ending 2026-02-28 are exactly the prior year of FY2027.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const trend = await als.run({ client, companyId: A.id, userId: A.user, claims: {} } as never, () => getMonthlyMovements(A.id, '2026-02-28'));
      const codes: Record<string, string> = { '4000': A.acct.sales, '6000': A.acct.rent };
      expect(Object.keys(trend.byAccountCode).sort()).toEqual(Object.keys(codes).sort());
      for (const [code, id] of Object.entries(codes)) {
        trend.months.forEach((_, i) => {
          const expected = trend.byAccountCode[code]![i]!;
          expect(cell(p, id, p.months[i]!) ?? 0, `${code} month ${i}`).toBeCloseTo(expected, 2);
        });
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('budget-grid prior actuals: calendar months, not positions (14-month transition year)', () => {
  it('maps each month of the 14-month year to the same calendar month one year earlier', async () => {
    const r = await get(T, { fiscal_year: '2027', grain: 'company' });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const p = data(r);
    expect(p.months).toEqual(monthsFrom('2026-01', 14));
    expect(p.priorMonths).toEqual(monthsFrom('2025-01', 14));
    expect(cell(p, T.acct.sales, '2026-01')).toBe(100);
    expect(cell(p, T.acct.sales, '2026-02')).toBe(200);
    expect(cell(p, T.acct.sales, '2026-12')).toBe(600);
    // The two extra months have a prior year too: Jan 2026 and Feb 2026 (which sit in the transition year itself).
    expect(cell(p, T.acct.sales, '2027-01')).toBe(700);
    expect(cell(p, T.acct.sales, '2027-02')).toBe(800);
  });
});

describe('budget-grid prior actuals: dimension grain', () => {
  it('cc1: one cell per member, and the untagged remainder under dimensionId null', async () => {
    const p = data(await get(A, { fiscal_year: '2027', grain: 'cc1' }));
    expect(p.grain).toBe('cc1');
    expect(cell(p, A.acct.sales, '2026-03', A.cc1)).toBe(950); // 1000 - 50
    expect(cell(p, A.acct.sales, '2026-03', A.cc1b)).toBe(500);
    expect(cell(p, A.acct.sales, '2026-03', null)).toBe(240); // 200 + the BU-tagged 40: no CC1
  });

  it('cc2 and bu read their own journal-line column', async () => {
    const cc2 = data(await get(A, { fiscal_year: '2027', grain: 'cc2' }));
    expect(cell(cc2, A.acct.rent, '2026-04', A.cc2)).toBe(300);
    expect(cell(cc2, A.acct.rent, '2026-04', null)).toBe(-20);
    const bu = data(await get(A, { fiscal_year: '2027', grain: 'bu' }));
    expect(cell(bu, A.acct.sales, '2026-03', A.bu)).toBe(40);
    expect(cell(bu, A.acct.sales, '2026-03', null)).toBe(1650);
  });

  it('a dimension grain sums back to the company figure', async () => {
    const cc1 = data(await get(A, { fiscal_year: '2027', grain: 'cc1' }));
    const total = cc1.cells.filter((c) => c.glAccountId === A.acct.sales && c.month === '2026-03').reduce((s, c) => s + c.amount, 0);
    expect(total).toBe(1690);
  });
});

describe('budget-grid prior actuals: input and tenants', () => {
  it('refuses a missing or bad year, a bad grain, and a label no year carries', async () => {
    expect((await get(A, { grain: 'company' })).status).toBe(400);
    expect((await get(A, { fiscal_year: 'x', grain: 'company' })).status).toBe(400);
    expect((await get(A, { fiscal_year: '2027', grain: 'project' })).status).toBe(400);
    expect((await get(A, { fiscal_year: '1', grain: 'company' })).status).toBe(404);
  });

  it('a user whose prior-actuals bucket is full is 429 with Retry-After', async () => {
    await pool.query(`INSERT INTO rate_limit_counters (key, count, window_start) VALUES ($1, 60, now())
                      ON CONFLICT (key) DO UPDATE SET count = 60, window_start = now()`, [`budget-prior-actuals:${A.viewer.userId}`]);
    try {
      const r = await get(A, { fiscal_year: '2027' }, 'viewer');
      expect([r.status, r.body.error?.code]).toEqual([429, 'RATE_LIMIT']);
    } finally {
      await clearBudgetRateCounters(pool, [A.viewer.userId]);
    }
  });

  it('defaults to the company grain; a viewer may read', async () => {
    expect(data(await get(A, { fiscal_year: '2027' })).grain).toBe('company');
    expect((await get(A, { fiscal_year: '2027', grain: 'company' }, 'viewer')).status).toBe(200);
  });

  it('never returns another tenant\'s postings (the service alone, no RLS)', async () => {
    const own = await direct(B, 2027, 'company');
    expect(own.cells.map((c) => [c.glAccountId, c.amount])).toEqual([[B.acct.sales, 123456]]);
    const mine = await direct(A, 2027, 'company');
    expect(mine.cells.some((c) => c.amount === 123456)).toBe(false);
    expect(mine.cells.every((c) => !Object.values(B.acct).includes(c.glAccountId))).toBe(true);
  });
});
