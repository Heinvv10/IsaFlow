/**
 * Round 6 review, HIGH-1/2/3, MEDIUM-1/2, LOW-1/2: `SUM(ABS(credit - debit))`
 * applies ABS to each journal LINE before summing, so a contra line — a credit
 * note, a sales return, a supplier rebate, a reversed accrual — is ADDED to the
 * figure instead of subtracted. Every affected surface therefore overstated by
 * TWICE the contra amount and still footed to its own visible rows.
 *
 * This file is the rule rather than the fixture: it seeds one contra line
 * against each band and asserts, by outcome, that every note ties to the
 * face-of-statement line it discloses.
 *
 *   note 18  Revenue Disaggregation      == getIncomeStatement().totalRevenue
 *   note 19  Other Income                == getIncomeStatement().totalOtherIncome
 *   note 20  Operating Expenses          == ....totalOperatingExpenses
 *   note 21  Finance Costs               == ....totalOtherExpenses (finance part)
 *   note 27  Going Concern net result    == getIncomeStatement().netProfit
 *   note 27  Going Concern current ratio == getKpiScorecard()'s currentRatio
 *   IFRS note 5 Revenue                  == totalRevenue + totalOtherIncome
 *   duplicate_control_accounts amount    == the contending accounts' BALANCES
 *
 * Both directions are proved on the same fixture: an account that legitimately
 * ends on the other side (contra-revenue with a net DEBIT balance) still
 * reports, with its sign, and a nil-movement account is dropped by note and
 * statement alike. The whole set is run for TWO fiscal years, because a fix
 * applied only to the current year breaks the comparative silently.
 *
 * LOW-1 rides along: migration 674 normalises `gl_accounts.account_subtype` on
 * write, so the ~90 SQL filters that compare the RAW column against
 * `rawSubtypesFor(...)` (already-normalised keys) agree with `canonicalSubtype`.
 * An account stored 'COGS' banded as cost of sales on the income statement and
 * as an OPERATING expense inside note 20 — the same pack disagreeing with
 * itself over one account.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { getIncomeStatement } from '../../src/modules/accounting/services/reports/incomeStatementService';
import { getKpiScorecard } from '../../src/modules/accounting/services/afs/afsKpiService';
import {
  generateNote17IncomeTax,
  generateNote18RevenueDisaggregation,
  generateNote19OtherIncome,
  generateNote20OperatingExpenses,
} from '../../src/modules/accounting/services/afs/noteGenerators/notes16to20';
import { generateNote11CashAndCashEquivalents } from '../../src/modules/accounting/services/afs/noteGenerators/notes11to15';
import { fetchClosingCash } from '../../src/modules/accounting/services/afs/afsKpiCash';
import { generateNote21FinanceCosts } from '../../src/modules/accounting/services/afs/noteGenerators/notes21to25';
import { generateNote27GoingConcern } from '../../src/modules/accounting/services/afs/noteGenerators/notes26to30';
import { noteCash, noteRevenue } from '../../src/modules/accounting/services/reports/disclosureNoteGenerators';
import { duplicateControlAccounts } from '../../src/modules/accounting/services/gl/integrityChecks/accountChecks';
import {
  getVatMultiYearSummary,
  getVatReconciliation,
} from '../../src/modules/accounting/services/reports/vatReconciliationService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const co = crypto.randomUUID();
/** Second tenant, so the control-account check cannot see the first one's book. */
const ctrlCo = crypto.randomUUID();
/**
 * Third tenant, for note 17 alone. The tax charge lands in the income
 * statement's OTHER EXPENSES band, which `co`'s note 21 assertion pins to the
 * finance cost exactly; seeding tax into `co` would have moved that figure and
 * note 27's net profit with it, so the tax book gets its own company.
 */
const taxCo = crypto.randomUUID();

/**
 * `companies.financial_year_start` defaults to 3, so fiscal 2026 is
 * 2025-03-01..2026-02-28 and fiscal 2025 is 2024-03-01..2025-02-28. Every AFS
 * generator resolves its own range through `getFiscalRange`, so a date outside
 * these windows leaves the notes summing nothing and every assertion passing on
 * empty data.
 */
const YEARS = [
  { fiscalYear: 2026, postedOn: '2026-01-15', start: '2025-03-01', end: '2026-02-28', kpiPeriod: '2026-02', scale: 1 },
  { fiscalYear: 2025, postedOn: '2025-01-15', start: '2024-03-01', end: '2025-02-28', kpiPeriod: '2025-02', scale: 3 },
] as const;

let entryNo = 0;

async function account(
  company: string,
  code: string,
  name: string,
  type: string,
  subtype: string | null,
  normal: 'debit' | 'credit',
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
    [id, company, code, name, type, subtype, normal],
  );
  return id;
}

async function post(
  company: string,
  date: string,
  legs: Array<{ account: string; debit: number; credit: number }>,
  source = 'manual',
): Promise<void> {
  entryNo += 1;
  const { rows } = await pool.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, created_by)
     VALUES ($1,$2,$3,'k091e fixture','posted',$4,$1) RETURNING id`,
    [company, `K091E-${entryNo}`, date, source],
  );
  for (const leg of legs) {
    await pool.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
       VALUES ($1,$2,$3,$4,$5)`,
      [company, rows[0].id, leg.account, leg.debit, leg.credit],
    );
  }
}

/** Balance-sheet ids, seeded once (as-at balances, not per-year movement). */
const bs: Record<string, string> = {};
/** Per-year P&L account ids, keyed `${fiscalYear}:${role}`. */
const pl: Record<string, string> = {};

beforeAll(async () => {
  for (const company of [co, ctrlCo, taxCo]) {
    await pool.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1,$2,true) ON CONFLICT (id) DO NOTHING`,
      [company, `k091e ${company.slice(0, 8)}`],
    );
  }

  // ── Balance sheet: the current-ratio disagreement (MEDIUM-1) ───────────────
  // Note 27 whitelisted cash + receivables + inventory; the KPI scorecard counts
  // everything that is not NON_CURRENT_SUBTYPES. Prepaid insurance and VAT input
  // are current to the KPI and invisible to the note, so the same pack printed
  // 1.11 and 1.89. A fixed asset is seeded too, so "everything not non-current"
  // is not merely "everything".
  bs.bank = await account(co, 'B100', 'Bank', 'asset', 'bank', 'debit');
  bs.prepaid = await account(co, 'B110', 'Prepaid insurance', 'asset', 'prepaid_expense', 'debit');
  bs.vatInput = await account(co, 'B120', 'VAT input', 'asset', 'vat_input', 'debit');
  bs.fixed = await account(co, 'B130', 'Vehicles', 'asset', 'fixed_asset', 'debit');
  bs.creditors = await account(co, 'B200', 'Trade creditors', 'liability', 'trade_payable', 'credit');
  bs.equity = await account(co, 'B300', 'Share capital', 'equity', 'equity', 'credit');
  // A LIABILITY carrying a bank subtype — an overdraft or a paycard. AFS note
  // 11, the IFRS cash note and the cash KPI tile print in the same export and
  // must agree that this is not cash on hand.
  bs.paycard = await account(co, 'B210', 'Fuel paycard', 'liability', 'bank', 'credit');
  // Every P&L journal below balances against retained earnings, NOT the bank:
  // routing them through a current asset would move the current ratio this
  // fixture exists to pin, and equity is neither a current asset nor a current
  // liability on either surface.
  bs.re = await account(co, 'B310', 'Retained earnings', 'equity', 'retained_earnings', 'credit');

  // Balances as at the EARLIER year end, so both fiscal years see the same
  // balance sheet and both years' ratio assertions are live.
  await post(co, '2024-06-30', [
    { account: bs.bank, debit: 1000, credit: 0 },
    { account: bs.prepaid, debit: 500, credit: 0 },
    { account: bs.vatInput, debit: 200, credit: 0 },
    { account: bs.fixed, debit: 4000, credit: 0 },
    { account: bs.creditors, debit: 0, credit: 900 },
    { account: bs.paycard, debit: 0, credit: 300 },
    { account: bs.equity, debit: 0, credit: 4500 },
  ]);

  for (const y of YEARS) {
    const k = (role: string) => `${y.fiscalYear}:${role}`;
    const s = y.scale;

    pl[k('sales')] = await account(co, `R100-${y.fiscalYear}`, `Trade sales ${y.fiscalYear}`, 'revenue', 'sales', 'credit');
    pl[k('returns')] = await account(co, `R110-${y.fiscalYear}`, `Sales returns ${y.fiscalYear}`, 'revenue', 'sales', 'credit');
    pl[k('nilRev')] = await account(co, `R120-${y.fiscalYear}`, `Nil revenue ${y.fiscalYear}`, 'revenue', 'sales', 'credit');
    pl[k('sundry')] = await account(co, `R200-${y.fiscalYear}`, `Sundry income ${y.fiscalYear}`, 'revenue', 'other_income', 'credit');
    pl[k('rent')] = await account(co, `E100-${y.fiscalYear}`, `Rent ${y.fiscalYear}`, 'expense', 'operating_expense', 'debit');
    // LOW-1: raw spellings the write path never normalised. Migration 674's
    // trigger stores them as 'cogs' and 'finance_cost'.
    pl[k('cogs')] = await account(co, `E200-${y.fiscalYear}`, `Cost of sales ${y.fiscalYear}`, 'expense', 'COGS', 'debit');
    pl[k('finance')] = await account(co, `E300-${y.fiscalYear}`, `Interest paid ${y.fiscalYear}`, 'expense', ' Finance Cost ', 'debit');
    // 'bank_charges' was absent from SUBTYPE_ALIASES, so it canonicalised to
    // NULL: `expenseBand` called it an OPERATING expense and it printed inside
    // note 20 AND note 21, and note 21's total no longer equalled the income
    // statement's finance-cost line.
    pl[k('charges')] = await account(co, `E310-${y.fiscalYear}`, `Bank charges ${y.fiscalYear}`, 'expense', 'bank_charges', 'debit');

    // Turnover R100,000s less an R8,000s credit note → net R92,000s.
    await post(co, y.postedOn, [
      { account: pl[k('sales')]!, debit: 0, credit: 100000 * s },
      { account: bs.re, debit: 100000 * s, credit: 0 },
    ]);
    await post(co, y.postedOn, [
      { account: pl[k('sales')]!, debit: 8000 * s, credit: 0 },
      { account: bs.re, debit: 0, credit: 8000 * s },
    ]);
    // Contra-revenue: a revenue-typed account that legitimately ends NET DEBIT.
    // Dropping ABS must not drop it, and must not flip its sign.
    await post(co, y.postedOn, [
      { account: pl[k('returns')]!, debit: 1500 * s, credit: 0 },
      { account: bs.re, debit: 0, credit: 1500 * s },
    ]);
    // Nil net movement: both note and statement must drop it.
    await post(co, y.postedOn, [
      { account: pl[k('nilRev')]!, debit: 0, credit: 700 * s },
      { account: bs.re, debit: 700 * s, credit: 0 },
    ]);
    await post(co, y.postedOn, [
      { account: pl[k('nilRev')]!, debit: 700 * s, credit: 0 },
      { account: bs.re, debit: 0, credit: 700 * s },
    ]);
    // Other income R3,000s less a R1,000s reversed accrual → net R2,000s.
    await post(co, y.postedOn, [
      { account: pl[k('sundry')]!, debit: 0, credit: 3000 * s },
      { account: bs.re, debit: 3000 * s, credit: 0 },
    ]);
    await post(co, y.postedOn, [
      { account: pl[k('sundry')]!, debit: 1000 * s, credit: 0 },
      { account: bs.re, debit: 0, credit: 1000 * s },
    ]);
    // Rent R6,000s less a R5,000s supplier rebate → net R1,000s.
    await post(co, y.postedOn, [
      { account: pl[k('rent')]!, debit: 6000 * s, credit: 0 },
      { account: bs.re, debit: 0, credit: 6000 * s },
    ]);
    await post(co, y.postedOn, [
      { account: pl[k('rent')]!, debit: 0, credit: 5000 * s },
      { account: bs.re, debit: 5000 * s, credit: 0 },
    ]);
    await post(co, y.postedOn, [
      { account: pl[k('cogs')]!, debit: 700 * s, credit: 0 },
      { account: bs.re, debit: 0, credit: 700 * s },
    ]);
    await post(co, y.postedOn, [
      { account: pl[k('finance')]!, debit: 400 * s, credit: 0 },
      { account: bs.re, debit: 0, credit: 400 * s },
    ]);
    await post(co, y.postedOn, [
      { account: pl[k('charges')]!, debit: 250 * s, credit: 0 },
      { account: bs.re, debit: 0, credit: 250 * s },
    ]);
  }

  // ── Note 17: a tax charge with an overprovision credited back to it ─────────
  // `SUM(debit)` with no credit side is GROSS THROUGHPUT, so the reversal of an
  // overprovision was not subtracted and the note printed more tax than the
  // income statement charged. Its own tenant, per the comment on `taxCo`.
  const taxRe = await account(taxCo, 'T300', 'Retained earnings', 'equity', 'retained_earnings', 'credit');
  for (const y of YEARS) {
    const s = y.scale;
    const current = await account(taxCo, `T100-${y.fiscalYear}`, `Income tax ${y.fiscalYear}`, 'expense', 'income_tax_expense', 'debit');
    const deferred = await account(taxCo, `T110-${y.fiscalYear}`, `Deferred tax ${y.fiscalYear}`, 'expense', 'deferred_tax_expense', 'debit');
    // Current tax: R5,000s charged, R2,000s overprovision reversed → R3,000s.
    await post(taxCo, y.postedOn, [
      { account: current, debit: 5000 * s, credit: 0 },
      { account: taxRe, debit: 0, credit: 5000 * s },
    ]);
    await post(taxCo, y.postedOn, [
      { account: current, debit: 0, credit: 2000 * s },
      { account: taxRe, debit: 2000 * s, credit: 0 },
    ]);
    // Deferred tax: R1,200s raised, R200s released → R1,000s.
    await post(taxCo, y.postedOn, [
      { account: deferred, debit: 1200 * s, credit: 0 },
      { account: taxRe, debit: 0, credit: 1200 * s },
    ]);
    await post(taxCo, y.postedOn, [
      { account: deferred, debit: 0, credit: 200 * s },
      { account: taxRe, debit: 200 * s, credit: 0 },
    ]);
  }

  // ── Control-account check: two receivable controls, one settled in full ─────
  const ctrlA = await account(ctrlCo, 'C100', 'Debtors control A', 'asset', 'trade_receivable', 'debit');
  const ctrlB = await account(ctrlCo, 'C200', 'Debtors control B', 'asset', 'trade_receivable', 'debit');
  const ctrlBank = await account(ctrlCo, 'C900', 'Bank', 'asset', 'bank', 'debit');
  // A: R50,000 invoiced, R50,000 received — nil BALANCE, R100,000 of throughput.
  await post(ctrlCo, '2026-01-10', [{ account: ctrlA, debit: 50000, credit: 0 }, { account: ctrlBank, debit: 0, credit: 50000 }], 'auto_invoice');
  await post(ctrlCo, '2026-01-11', [{ account: ctrlA, debit: 0, credit: 50000 }, { account: ctrlBank, debit: 50000, credit: 0 }], 'auto_payment');
  // B: R300 outstanding.
  await post(ctrlCo, '2026-01-12', [{ account: ctrlB, debit: 300, credit: 0 }, { account: ctrlBank, debit: 0, credit: 300 }], 'auto_invoice');
});

afterAll(async () => {
  for (const company of [co, ctrlCo, taxCo]) {
    await pool.query(
      `DELETE FROM gl_journal_lines WHERE company_id = $1`, [company]);
    await pool.query(`DELETE FROM gl_journal_entries WHERE company_id = $1`, [company]);
    await pool.query(`DELETE FROM gl_accounts WHERE company_id = $1`, [company]);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [company]);
  }
  await pool.end();
});

/**
 * `fmt` renders through Intl en-ZA: thousands are grouped with U+00A0 and the
 * DECIMAL separator is a comma — "92 000,00". Stripping separators blindly
 * turns that into 9 200 000, so the decimal point is identified as the LAST of
 * ',' or '.' rather than assumed.
 */
function parseZa(text: string): number {
  const cleaned = String(text).replace(/[^0-9.,-]/g, '');
  const decimalAt = Math.max(cleaned.lastIndexOf(','), cleaned.lastIndexOf('.'));
  if (decimalAt < 0) return Number(cleaned);
  const whole = cleaned.slice(0, decimalAt).replace(/[.,]/g, '');
  return Number(whole + '.' + cleaned.slice(decimalAt + 1));
}

/** Sum a note's table body, skipping the trailing Total row the note prints. */
function bodyTotal(rows: string[][], amountColumn: number): number {
  return rows
    .filter((r) => r[0] !== 'Total' && r[0] !== 'Total Revenue')
    .reduce((acc, r) => acc + parseZa(String(r[amountColumn])), 0);
}

function tableRows(blocks: Array<{ type: string; rows?: string[][] }>): string[][] {
  return blocks.find((b) => b.type === 'table')?.rows ?? [];
}

describe.each(YEARS)('fiscal $fiscalYear', (y) => {
  it('note 18 foots to the income statement turnover line, and excludes other income', async () => {
    const is = await getIncomeStatement(co, y.start, y.end);
    const note = await generateNote18RevenueDisaggregation(co, y.fiscalYear);
    const rows = tableRows(note.content.blocks as Array<{ type: string; rows?: string[][] }>);

    // The contra line is subtracted, not added: 100,000 - 8,000 - 1,500 net of
    // the returns account, per scale.
    expect(is.totalRevenue).toBeCloseTo((100000 - 8000 - 1500) * y.scale, 2);
    expect(bodyTotal(rows, 2)).toBeCloseTo(is.totalRevenue, 2);

    // Both directions: the net-debit contra-revenue account still reports, with
    // its sign; the nil-movement account is dropped, as the statement drops it.
    const names = rows.map((r) => r[0]);
    expect(names).toContain(`Sales returns ${y.fiscalYear}`);
    expect(names).not.toContain(`Nil revenue ${y.fiscalYear}`);
    expect(is.revenue.map((l) => l.accountName)).not.toContain(`Nil revenue ${y.fiscalYear}`);
    // MEDIUM-2: other income belongs to note 19 alone.
    expect(names).not.toContain(`Sundry income ${y.fiscalYear}`);
  });

  it('note 19 foots to the income statement other-income line', async () => {
    const is = await getIncomeStatement(co, y.start, y.end);
    const note = await generateNote19OtherIncome(co, y.fiscalYear);
    const rows = tableRows(note.content.blocks as Array<{ type: string; rows?: string[][] }>);

    expect(is.totalOtherIncome).toBeCloseTo((3000 - 1000) * y.scale, 2);
    expect(bodyTotal(rows, 2)).toBeCloseTo(is.totalOtherIncome, 2);
    expect(rows.map((r) => r[0])).toEqual([`Sundry income ${y.fiscalYear}`]);
  });

  it('notes 18 and 19 partition the revenue book with nothing counted twice', async () => {
    const is = await getIncomeStatement(co, y.start, y.end);
    const n18 = tableRows((await generateNote18RevenueDisaggregation(co, y.fiscalYear)).content.blocks as Array<{ type: string; rows?: string[][] }>);
    const n19 = tableRows((await generateNote19OtherIncome(co, y.fiscalYear)).content.blocks as Array<{ type: string; rows?: string[][] }>);

    const n18Names = new Set(n18.filter((r) => r[0] !== 'Total').map((r) => r[0]));
    for (const r of n19) expect(n18Names.has(r[0]!)).toBe(false);
    expect(bodyTotal(n18, 2) + bodyTotal(n19, 2)).toBeCloseTo(is.totalRevenue + is.totalOtherIncome, 2);
  });

  it('note 20 keeps the rebate as a REDUCTION and foots to operating expenses', async () => {
    const is = await getIncomeStatement(co, y.start, y.end);
    const note = await generateNote20OperatingExpenses(co, y.fiscalYear);
    const rows = tableRows(note.content.blocks as Array<{ type: string; rows?: string[][] }>);

    expect(is.totalOperatingExpenses).toBeCloseTo((6000 - 5000) * y.scale, 2);
    expect(bodyTotal(rows, 2)).toBeCloseTo(is.totalOperatingExpenses, 2);
    // LOW-1: 'COGS' normalised to 'cogs' bands as cost of sales on BOTH sides,
    // so it is out of note 20 and inside the statement's cost-of-sales line.
    expect(rows.map((r) => r[0])).not.toContain(`Cost of sales ${y.fiscalYear}`);
    // …and bank charges belong to note 21 alone, not to both notes at once.
    expect(rows.map((r) => r[0])).not.toContain(`Bank charges ${y.fiscalYear}`);
    expect(is.totalCostOfSales).toBeCloseTo(700 * y.scale, 2);
  });

  it('note 21 sees the finance cost the raw spelling used to hide', async () => {
    const is = await getIncomeStatement(co, y.start, y.end);
    const note = await generateNote21FinanceCosts(co, y.fiscalYear);
    const rows = tableRows(note.content.blocks as Array<{ type: string; rows?: string[][] }>);

    // Bank charges ride along: aliased to finance_cost, they are a finance
    // cost to note 21 and to `expenseBand` at once, so the note still foots.
    expect(is.totalOtherExpenses).toBeCloseTo((400 + 250) * y.scale, 2);
    expect(bodyTotal(rows, 2)).toBeCloseTo(is.totalOtherExpenses, 2);
    expect(rows.map((r) => r[0])).toContain(`Bank charges ${y.fiscalYear}`);
  });

  it('note 27 reports the income statement net profit, not twice the rebate off it', async () => {
    const is = await getIncomeStatement(co, y.start, y.end);
    const note = await generateNote27GoingConcern(co, y.fiscalYear);
    const snap = note.dataSnapshot as { netResult: number };

    expect(is.netProfit).toBeCloseTo((100000 - 8000 - 1500 + 3000 - 1000 - 6000 + 5000 - 700 - 400 - 250) * y.scale, 2);
    expect(snap.netResult).toBeCloseTo(is.netProfit, 2);
    const text = (note.content.blocks[0] as { text: string }).text;
    expect(text).toContain('profit of');
  });

  it('note 27 and the KPI scorecard print the SAME current ratio', async () => {
    const note = await generateNote27GoingConcern(co, y.fiscalYear);
    const snap = note.dataSnapshot as { currentAssets: number; currentLiabilities: number; currentRatioStr: string };
    const scorecard = await getKpiScorecard(co, y.kpiPeriod);
    const kpi = scorecard.kpis.find((k) => k.key === 'currentRatio');

    expect(kpi).toBeDefined();
    expect(snap.currentAssets / snap.currentLiabilities).toBeCloseTo(kpi!.value, 6);
    expect(snap.currentRatioStr).toBe(kpi!.formatted);
    // Prepaid insurance and VAT input ARE current; the fixed asset is not.
    expect(snap.currentAssets).toBeCloseTo(1000 + 500 + 200, 2);
  });

  it('the VAT reconciliation compares NET GL revenue against net invoiced revenue', async () => {
    const is = await getIncomeStatement(co, y.start, y.end);
    const recon = await getVatReconciliation(co, y.start, y.end);

    // Invoiced revenue is already net of credit notes; per-line ABS made the GL
    // side twice the credit note larger and the reconciliation blamed the
    // ledger for a variance the reconciliation itself had invented.
    expect(recon.totals.glRevenue).toBeCloseTo(is.totalRevenue + is.totalOtherIncome, 2);
  });

  it('note 17 nets the overprovision against the tax charge, and foots to other expenses', async () => {
    const is = await getIncomeStatement(taxCo, y.start, y.end);
    const note = await generateNote17IncomeTax(taxCo, y.fiscalYear);
    const rows = tableRows(note.content.blocks as Array<{ type: string; rows?: string[][] }>);
    const cell = (label: string) => parseZa(String(rows.find((r) => r[0] === label)![1]));

    // Gross debits printed 5,000s and 1,200s; the credits are contra lines.
    expect(cell('Current tax expense')).toBeCloseTo((5000 - 2000) * y.scale, 2);
    expect(cell('Deferred tax expense/(income)')).toBeCloseTo((1200 - 200) * y.scale, 2);
    expect(cell('Total tax expense')).toBeCloseTo((3000 + 1000) * y.scale, 2);
    // Both spellings alias to `tax_expense`, so the whole charge is the income
    // statement's Other Expenses line for this tenant.
    expect(is.totalOtherExpenses).toBeCloseTo((3000 + 1000) * y.scale, 2);
    expect(cell('Total tax expense')).toBeCloseTo(is.totalOtherExpenses, 2);
  });

  it('the cash note, the IFRS cash note and the cash KPI agree a paycard is not cash', async () => {
    const note = await generateNote11CashAndCashEquivalents(co, y.fiscalYear);
    const rows = tableRows(note.content.blocks as Array<{ type: string; rows?: string[][] }>);
    const ifrs = (await noteCash(co, y.fiscalYear)).tables?.[0]?.rows ?? [];

    // The balance sheet is seeded as at 2024-06-30, so both fiscal years close
    // on the same cash: bank 1,000, and the paycard is a LIABILITY.
    expect(await fetchClosingCash(co, y.end)).toBeCloseTo(1000, 2);
    expect(bodyTotal(rows, 2)).toBeCloseTo(await fetchClosingCash(co, y.end), 2);
    expect(bodyTotal(ifrs, 2)).toBeCloseTo(await fetchClosingCash(co, y.end), 2);
    expect(rows.map((r) => r[0])).not.toContain('Fuel paycard');
    expect(ifrs.map((r) => r[0])).not.toContain('Fuel paycard');
  });

  it('the IFRS disclosure revenue note nets the credit note too', async () => {
    const is = await getIncomeStatement(co, y.start, y.end);
    const note = await noteRevenue(co, y.fiscalYear);
    const rows = note.tables?.[0]?.rows ?? [];

    // This note has no other-income counterpart, so it discloses the whole
    // revenue book — both bands of it.
    expect(bodyTotal(rows, 2)).toBeCloseTo(is.totalRevenue + is.totalOtherIncome, 2);
    expect(rows.map((r) => r[0])).not.toContain(`Nil revenue ${y.fiscalYear}`);
  });
});

it('migration 674 normalises the subtype on write, in both directions', async () => {
  const { rows } = await pool.query(
    `SELECT account_code, account_subtype FROM gl_accounts
     WHERE company_id = $1 AND account_code LIKE 'E%' ORDER BY account_code`,
    [co],
  );
  const stored = new Map(rows.map((r) => [r.account_code, r.account_subtype]));
  expect(stored.get('E200-2026')).toBe('cogs');
  expect(stored.get('E300-2026')).toBe(' finance_cost '.trim());
  // The legitimate case is untouched: an already-normalised spelling survives.
  expect(stored.get('E100-2026')).toBe('operating_expense');

  // And on UPDATE, not only INSERT.
  await pool.query(
    `UPDATE gl_accounts SET account_subtype = 'Other Income' WHERE company_id = $1 AND account_code = $2`,
    [co, 'R200-2026'],
  );
  const after = await pool.query(
    `SELECT account_subtype FROM gl_accounts WHERE company_id = $1 AND account_code = $2`,
    [co, 'R200-2026'],
  );
  expect(after.rows[0].account_subtype).toBe('other_income');
});

it('the multi-year VAT summary nets the credit note in every year it spans', async () => {
  // The function windows on CALENDAR years back from today, so ask for enough
  // of them to reach the fixture's 2025 postings rather than hard-coding 3.
  const summary = await getVatMultiYearSummary(co, new Date().getFullYear() - 2025 + 1);
  const revenueFor = (year: number) => summary.find((r) => r.year === year);

  // Every revenue-typed account, both bands: turnover net of the credit note,
  // the net-debit returns account with its sign, and sundry income.
  for (const y of YEARS) {
    const calendarYear = Number(y.postedOn.slice(0, 4));
    const row = revenueFor(calendarYear);
    expect(row).toBeDefined();
    expect(row!.totalRevenue).toBeCloseTo((100000 - 8000 - 1500 + 3000 - 1000) * y.scale, 2);
  }
});

it('duplicate control accounts report the BALANCE at stake, not gross throughput', async () => {
  const result = await duplicateControlAccounts({ companyId: ctrlCo, asAt: '2026-12-31', limit: 10 });

  expect(result.count).toBe(2);
  // A settles in full (nil balance), B carries R300. Per-line ABS reported
  // R100,300 — the throughput — against a finding about a missing balance.
  expect(result.amount).toBeCloseTo(300, 2);
});
