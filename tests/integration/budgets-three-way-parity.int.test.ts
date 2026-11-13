/**
 * Budgets P6 PR C (spec §10 I5, I7, I6/T11, decision 10a), real PostgreSQL:
 *   I5  Σ ΔRE from NP = the grid's `deriveTotals(...).months.netProfit` over `readTrackingBudgets` for the
 *       same version (leaves, a legacy header's own amounts and dimension rows each counted once);
 *   I7  opening per-type totals = `getBalanceSheet`'s; the buckets balance; opening cash vs
 *       `getCashBalance(co, firstMonthStart, { exclusive: true })` compared per account, the account-set
 *       difference (cash posted to a HEADER bank account: getCashBalance counts every level, the balance
 *       sheet leaves only) reported, never forced (§13.8);
 *   the derive route's days from the trailing actuals; a future year's opening is provisional (10a).
 * A company with posted history in FY2026 (Mar 2025 - Feb 2026) and a FY2027 version.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { localISODate } from '@/lib/dateUtils';
import { getBalanceSheet, getEquityBases } from '@/modules/accounting/services/reports/balanceSheetService';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { readTrackingBudgets } from '@/modules/accounting/services/budgets/tracking/trackingBudgetRead';
import { bandOf, bandSums, deriveTotals, type Band } from '@/modules/accounting/services/budgets/grid/subtotals';
import { toCents } from '@/modules/accounting/services/budgets/grid/cents';
import type { DeriveView, ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { monthsFrom } from './helpers/budgetGridFixture';
import { budgetThreeWayFixture, dataOf, type ThreeWayCo } from './helpers/budgetThreeWayFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetThreeWayFixture(pool);
const FY = monthsFrom('2026-03');
const HISTORY = monthsFrom('2025-03');

let A: ThreeWayCo;
let version: string;
let view: ThreeWayView;

beforeAll(async () => {
  A = await fx.company();
  const a = A.acct;
  await fx.journal(A, '2025-03-05', [{ acct: A.capital, credit: 100000 }]);
  for (const m of HISTORY) {
    await fx.journal(A, `${m}-10`, [{ acct: A.ar, debit: 20000 }, { acct: a.sales, credit: 20000 }]);
    await fx.journal(A, `${m}-12`, [{ acct: a.cos, debit: 8000 }, { acct: A.ap, credit: 8000 }]);
    await fx.journal(A, `${m}-15`, [{ acct: a.rent, debit: 3000 }]);
    await fx.journal(A, `${m}-20`, [{ acct: A.ar, credit: 18000 }]);
    await fx.journal(A, `${m}-25`, [{ acct: A.ap, debit: 7000 }]);
  }
  await fx.journal(A, '2025-06-01', [{ acct: A.bank2, debit: 5000 }, { acct: A.capital, credit: 5000 }]);
  // Cash on a HEADER bank account (level 1 with a child), against a header equity account: both left out
  // of the balance sheet's leaf read (so it still balances), the cash counted by getCashBalance.
  const header = async (code: string, type: string, subtype: string) => {
    const id = String((await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
       VALUES ($1, $2, $2, $3, $4, $5, 1, true) RETURNING id`, [A.id, code, type, subtype, type === 'asset' ? 'debit' : 'credit'])).rows[0].id);
    await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active, parent_account_id)
       VALUES ($1, $2, $2, $3, $4, $5, 3, true, $6)`, [A.id, `${code}.1`, type, subtype, type === 'asset' ? 'debit' : 'credit', id]);
    return id;
  };
  const bankHeader = await header('1050', 'asset', 'bank');
  const equityHeader = await header('3900', 'equity', 'equity');
  await fx.journal(A, '2025-07-01', [{ acct: bankHeader, debit: 1500 }, { acct: equityHeader, credit: 1500 }]);
  // Never in the opening: a draft, the year-end close, a posting after the as-at.
  await fx.journal(A, '2025-09-09', [{ acct: A.ar, debit: 99999 }, { acct: a.sales, credit: 99999 }], { status: 'draft' });
  await fx.journal(A, '2026-02-28', [{ acct: a.sales, debit: 7777 }, { acct: A.capital, credit: 7777 }], { source: YEAR_END_JOURNAL_SOURCE });
  await fx.journal(A, '2026-03-10', [{ acct: A.ar, debit: 4444 }, { acct: a.sales, credit: 4444 }]);

  version = await fx.version(A, { kind: 'original', name: 'TW plan' });
  await fx.amounts(A, version, a.sales, FY, 25000);
  await fx.amounts(A, version, a.cos, FY, 10000.55);
  await fx.amounts(A, version, a.rent, FY, 3000);
  await fx.amount(A, version, a.otherIncome, FY[0]!, 500);
  await fx.amount(A, version, a.header, FY[1]!, 700); // a legacy header's own amount counts once
  await fx.amount(A, version, a.childA, FY[2]!, 200, { cc1: A.cc1 }); // a dimension row
  await fx.amount(A, version, a.childA, FY[2]!, 50, { cc1: A.cc1b });
  const r = await fx.routes.index(A.owner, { version_id: version });
  if (r.status !== 200) throw new Error(`GET three-way: ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
  view = dataOf<ThreeWayView>(r);
}, 120000);

afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
});

describe('I5: Σ ΔRE from NP = the grid deriveTotals NP for the same version', () => {
  it('per month, from the stored amounts through readTrackingBudgets and the grid bands', async () => {
    const rows = await fx.direct(A, () => readTrackingBudgets(A.id, [{ fiscalYear: 2027, versionId: version, first: '2026-03-01', last: '2027-02-01' }]));
    const byAccount = new Map<string, { band: Band; cents: number[] }>();
    for (const row of rows) {
      const acc = byAccount.get(row.accountId) ?? { band: bandOf(row.accountType, row.accountSubtype), cents: FY.map(() => 0) };
      acc.cents[FY.indexOf(row.month)]! += toCents(row.amount);
      byAccount.set(row.accountId, acc);
    }
    const oracle = deriveTotals(bandSums([...byAccount.values()], (x) => x.cents, FY.length), FY.length).months.netProfit;
    expect(oracle[0]).toBe(toCents(25000 - 10000.55 - 3000 + 500));
    expect(oracle[1]).toBe(toCents(25000 - 10000.55 - 3000 - 700));
    expect(oracle[2]).toBe(toCents(25000 - 10000.55 - 3000 - 250));

    expect(view.pnl.map((p) => p.netProfit)).toEqual(oracle);
    let prev = view.opening.buckets.retainedEarnings;
    const fromRe = view.balanceSheet.map((m) => {
      const np = -(m.closing.retainedEarnings - prev);
      prev = m.closing.retainedEarnings;
      return np;
    });
    expect(fromRe).toEqual(oracle);
  });

  it('every month balances and the cash flow ends on the balance-sheet cash', () => {
    expect(view.checks).toMatchObject({ balanced: true, unbalancedMonths: [] });
    view.balanceSheet.forEach((m, i) => {
      expect(m.sections.check).toBe(0);
      expect(view.cashFlow.direct[i]!.closingCash).toBe(m.closing.cash);
    });
    expect(view.months).toEqual(FY);
  });
});

describe('I7: the opening against getBalanceSheet and getCashBalance', () => {
  it('as at the day before the first month, not provisional', () => {
    expect(view.opening).toMatchObject({ asAt: '2026-02-28', provisional: false });
  });

  it('per-type totals equal getBalanceSheet’s (drafts, the year-end close and later postings left out)', async () => {
    const bs = await fx.direct(A, () => getBalanceSheet(A.id, '2026-02-28'));
    expect(view.opening.totals).toEqual({
      assets: Math.round(bs.totalAssets * 100), liabilities: Math.round(bs.totalLiabilities * 100), equity: Math.round(bs.totalEquity * 100),
    });
    expect(view.opening.totals).toEqual({ assets: 22500000, liabilities: 1200000, equity: 21300000 });
  });

  it('the buckets balance, derived RE in retained earnings (posted vs derived shown)', async () => {
    expect(view.opening.balanceSheet.check).toBe(0);
    expect(view.opening.buckets).toMatchObject({ cash: 20100000, receivables: 2400000, payables: -1200000, shareCapital: -10500000, retainedEarnings: -10800000 });
    // getEquityBases counts equity accounts at every level: the header's 1 500 is in `posted`, not in the leaf buckets.
    expect(view.opening.equity).toEqual({ posted: 10650000, derivedRetainedEarnings: 10800000 });
    const bases = await fx.direct(A, () => getEquityBases(A.id, '2026-02-28'));
    expect(view.opening.equity).toEqual({ posted: Math.round(bases.posted * 100), derivedRetainedEarnings: Math.round(bases.derivedRetainedEarnings * 100) });
  });

  it('opening cash: like with like per account; the account-set difference is reported, not forced', async () => {
    const ledger = await fx.direct(A, () => getCashBalance(A.id, '2026-03-01', { exclusive: true }));
    expect(Math.round(ledger.total * 100)).toBe(20250000);
    const both = ledger.accounts.filter((x) => x.accountCode !== '1050');
    expect(Math.round(both.reduce((t, x) => t + x.glBalance, 0) * 100)).toBe(view.opening.buckets.cash);
    expect(view.checks.openingCash).toEqual({
      bucket: 20100000, ledger: 20250000, difference: -150000,
      accounts: [{ accountCode: '1050', bucket: null, ledger: 150000 }],
    });
    expect(view.warnings).toContainEqual({ code: 'opening_cash_difference', differenceCents: -150000, accounts: ['1050'] });
  });
});

describe('derive (T11) through the route, and a provisional opening (10a)', () => {
  it('days from the trailing year: AR 24 000 ÷ 240 000 × 365 = 36.5; AP 12 000 ÷ 132 000 × 365 = 33.18; no inventory', async () => {
    const r = await fx.routes.derive(A.owner, { version_id: version });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const d = dataOf<DeriveView>(r);
    expect(d.assumptions.workingCapital.debtorDays).toMatchObject({ value: 36.5, source: 'derived', derivedAsAt: '2026-02-28' });
    expect(d.assumptions.workingCapital.creditorDays.value).toBe(33.18);
    expect(d.assumptions.workingCapital.inventoryDays.value).toBe(0);
    expect(d.evidence.window).toEqual({ first: '2025-03', last: '2026-02', months: 12, days: 365 });
    expect(d.evidence.trailing).toMatchObject({ turnover: 24000000, costOfSales: 9600000, supplierPurchases: 13200000 });
    expect(d.evidence.aging).toEqual({ receivables: 0, payables: 0 });
    // Computes, never writes.
    expect((await fx.state(version)).row).toBeNull();
  });

  it('the run uses the derived days when the version stores none', () => {
    expect(view.assumptions.stored).toBeNull();
    expect(view.assumptions.resolved.workingCapital.debtorDays.value).toBe(36.5);
  });

  it('a provisional opening: postings dated after the as-at never enter the lookback', async () => {
    // FY2031 (Mar 2030 - Feb 2031): its lookback Mar 2029 - Feb 2030 lies wholly after today.
    await pool.query(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind) VALUES ($1, 2031, '2030-03-01', '2031-02-28', 'normal')`, [A.id]);
    await fx.journal(A, '2029-06-15', [{ acct: A.ar, debit: 55555 }, { acct: A.acct.sales, credit: 55555 }]);
    const v = await fx.version(A, { fy: 2031, kind: 'original', name: 'TW far' });
    const r = await fx.routes.index(A.owner, { version_id: v });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const w = dataOf<ThreeWayView>(r);
    expect(w.opening.provisional).toBe(true);
    expect(w.lookback.map((m) => m.month)).toEqual(monthsFrom('2029-03'));
    expect(w.lookback.every((m) => m.turnover === 0 && m.costOfSales === 0 && m.supplierPurchases === 0)).toBe(true);
  });

  it('a version of a future year opens at today, provisional, with the banner warning', async () => {
    const v = await fx.version(A, { fy: 2028, kind: 'original', name: 'TW next' });
    const r = await fx.routes.index(A.owner, { version_id: v });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const w = dataOf<ThreeWayView>(r);
    const today = localISODate();
    expect(w.opening).toMatchObject({ asAt: today, provisional: true });
    expect(w.warnings).toContainEqual({ code: 'opening_provisional', asAt: today });
    expect(w.months[0]).toBe('2027-03');
  });
});
