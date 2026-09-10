/**
 * Round 5 review, MEDIUM-1: the census stopped short. Four live read paths
 * still decided a REPORTED figure from a hardcoded literal list, so the
 * disagreement K-091 removes from the coverage report simply moved one report
 * to the left.
 *
 * This file is the rule rather than the fixture. It seeds ONE asset account per
 * raw spelling in `CASH_SUBTYPES` and asserts that every surface that prints a
 * cash figure sees the same accounts and the same money:
 *
 *   cash.balance.v1          getCashBalance
 *   cash-flow forecast       getCurrentCashBalance / getHistoricalCashFlows
 *   AFS note 11              generateNote11CashAndCashEquivalents
 *   IFRS disclosure note     noteCash
 *   bank statement coverage  getBankStatementCoverage (BANK_SUBTYPES subset)
 *
 * And the sharpest of the four: the VAT201 base box. `classifyVatJournalLine`
 * compared a RAW `account_subtype` against `['bank','cash','receivable',
 * 'payable']`, so a debtors control spelled `debtors` — a spelling
 * `accountSubtypes.ts` already enumerates — missed the settlement branch and
 * fell through to `base`. Its GROSS, VAT-INCLUSIVE amount was then counted as
 * the value of the supply, over-stating boxes 1 and 15 by the whole settlement
 * leg. That is a filed return.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  BANK_SUBTYPES,
  CASH_SUBTYPES,
  PAYABLE_SUBTYPES,
  RECEIVABLE_SUBTYPES,
} from '../../src/modules/accounting/services/gl/accountSubtypes';
import { getCashBalance } from '../../src/modules/accounting/services/bank/cashBalanceService';
import { getBankStatementCoverage } from '../../src/modules/accounting/services/bank/bankStatementCoverageService';
import {
  getCurrentCashBalance,
  getHistoricalCashFlows,
} from '../../src/modules/accounting/services/reports/cashFlowForecastDataService';
import { generateNote11CashAndCashEquivalents } from '../../src/modules/accounting/services/afs/noteGenerators/notes11to15';
import { noteCash } from '../../src/modules/accounting/services/reports/disclosureNoteGenerators';
import { getVat201Report } from '../../src/modules/accounting/services/reports/vat201ReportService';
import { generateNote27GoingConcern } from '../../src/modules/accounting/services/afs/noteGenerators/notes26to30';
import { getKpiScorecard } from '../../src/modules/accounting/services/afs/afsKpiService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Cash tenant: one asset account per CASH_SUBTYPES spelling. */
const cashCo = crypto.randomUUID();
/** VAT tenant: one settlement leg per settlement spelling. */
const vatCo = crypto.randomUUID();
/** AR/AP tenant: one control account per receivable and payable spelling. */
const arApCo = crypto.randomUUID();

const AS_AT = '2026-12-31';
/**
 * Inside fiscal year 2026 for a company on the schema-default March year start
 * (`companies.financial_year_start` defaults to 3), i.e. 2025-03-01..2026-02-28.
 * The AFS surfaces below resolve their own range through `getFiscalRange`, so a
 * June date would leave note 27 and the KPI scorecard summing nothing and the
 * assertions would pass on empty data.
 */
const POSTED_ON = '2026-01-15';

/** code → posted balance, one per cash spelling. */
const cashAccounts: Array<{ code: string; spelling: string; balance: number }> = [];

async function post(
  company: string,
  entryNumber: string,
  date: string,
  legs: Array<{ account: string; debit: number; credit: number; vatType?: string | null }>,
  opts: { source?: string } = {},
): Promise<void> {
  const { rows } = await pool.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, created_by)
     VALUES ($1,$2,$3,'k091c fixture','posted',$4,$1) RETURNING id`,
    [company, entryNumber, date, opts.source ?? 'manual'],
  );
  for (const leg of legs) {
    await pool.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, vat_type)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [company, rows[0].id, leg.account, leg.debit, leg.credit, leg.vatType ?? null],
    );
  }
}

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

// ── VAT fixture shape ────────────────────────────────────────────────────────
// One R1,000 sale at 15%: debtor R1,150 (settlement, GROSS) / revenue R1,000
// (base) / output VAT R150 (tax). Repeated once per settlement spelling, each
// with its own revenue account so the base is attributable.
const SALE_NET = 1000;
const SALE_VAT = 150;
const SALE_GROSS = SALE_NET + SALE_VAT;
let settlementSpellings: string[] = [];

// AR/AP fixture. Receivables are 100 x k so the total is not proportional to
// any single spelling's balance; payables are flat. A reader that recognises
// only `trade_receivable`/`trade_payable` therefore gets a DIFFERENT figure,
// not merely a smaller one scaled by the same factor on both sides.
const AP_EACH = 100;
const KPI_PERIOD = '2026-01';
const KPI_DAYS = 31;
const KPI_REVENUE = 10000;
const KPI_COGS = 5000;
let arTotal = 0;
let apTotal = 0;

beforeAll(async () => {
  // ── cash tenant ──
  await pool.query('INSERT INTO companies(id,name,is_active) VALUES($1,$2,true)', [cashCo, 'K091c cash']);
  const equity = await account(cashCo, 'K91C9000', 'Share Capital', 'equity', 'equity', 'credit');
  let n = 0;
  for (const spelling of CASH_SUBTYPES) {
    n += 1;
    const code = `K91C${1000 + n}`;
    const balance = 100 * n;
    const id = await account(cashCo, code, `Cash probe ${spelling}`, 'asset', spelling, 'debit');
    await post(cashCo, `k091c-cash-${n}`, POSTED_ON, [
      { account: id, debit: balance, credit: 0 },
      { account: equity, debit: 0, credit: balance },
    ]);
    cashAccounts.push({ code, spelling, balance });
  }

  // ── VAT tenant ──
  await pool.query('INSERT INTO companies(id,name,is_active) VALUES($1,$2,true)', [vatCo, 'K091c vat']);
  const vatOutput = await account(vatCo, 'K91V2200', 'VAT Output', 'liability', 'vat_output', 'credit');
  settlementSpellings = [...new Set([...CASH_SUBTYPES, ...RECEIVABLE_SUBTYPES, ...PAYABLE_SUBTYPES])];
  let m = 0;
  for (const spelling of settlementSpellings) {
    m += 1;
    // The settlement account's TYPE follows its meaning, but the classifier
    // must not need the type: it is the subtype that decides the role.
    const isPayable = (PAYABLE_SUBTYPES as readonly string[]).includes(spelling);
    const settle = await account(
      vatCo, `K91V${3000 + m}`, `Settlement ${spelling}`,
      isPayable ? 'liability' : 'asset', spelling, isPayable ? 'credit' : 'debit',
    );
    const revenue = await account(vatCo, `K91V${5000 + m}`, `Revenue ${spelling}`, 'revenue', 'revenue', 'credit');
    await post(vatCo, `k091c-vat-${m}`, POSTED_ON, [
      { account: settle, debit: SALE_GROSS, credit: 0 },
      { account: revenue, debit: 0, credit: SALE_NET, vatType: 'standard' },
      { account: vatOutput, debit: 0, credit: SALE_VAT, vatType: 'standard' },
    ], { source: 'auto_invoice' });
  }

  // ── AR/AP tenant ──
  await pool.query('INSERT INTO companies(id,name,is_active) VALUES($1,$2,true)', [arApCo, 'K091c arap']);
  const arEquity = await account(arApCo, 'K91A9000', 'Share Capital', 'equity', 'equity', 'credit');
  const arRevenue = await account(arApCo, 'K91A8000', 'Sales', 'revenue', 'revenue', 'credit');
  const arCogs = await account(arApCo, 'K91A7000', 'Cost of Sales', 'expense', 'cost_of_sales', 'debit');
  await post(arApCo, 'k091c-arap-is', '2026-01-10', [
    { account: arCogs, debit: KPI_COGS, credit: 0 },
    { account: arRevenue, debit: 0, credit: KPI_REVENUE },
    { account: arEquity, debit: KPI_REVENUE - KPI_COGS, credit: 0 },
  ]);
  let r = 0;
  for (const spelling of RECEIVABLE_SUBTYPES) {
    r += 1;
    const bal = 100 * r;
    const id = await account(arApCo, `K91A${1000 + r}`, `AR ${spelling}`, 'asset', spelling, 'debit');
    await post(arApCo, `k091c-ar-${r}`, POSTED_ON, [
      { account: id, debit: bal, credit: 0 },
      { account: arEquity, debit: 0, credit: bal },
    ]);
    arTotal += bal;
  }
  let q = 0;
  for (const spelling of PAYABLE_SUBTYPES) {
    q += 1;
    const id = await account(arApCo, `K91A${2000 + q}`, `AP ${spelling}`, 'liability', spelling, 'credit');
    await post(arApCo, `k091c-ap-${q}`, POSTED_ON, [
      { account: arEquity, debit: AP_EACH, credit: 0 },
      { account: id, debit: 0, credit: AP_EACH },
    ]);
    apTotal += AP_EACH;
  }
});

afterAll(async () => {
  try {
    for (const co of [cashCo, vatCo, arApCo]) {
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [co]);
      await pool.query('DELETE FROM companies WHERE id=$1', [co]);
    }
  } finally { await pool.end(); }
});

// ── the vocabulary itself ────────────────────────────────────────────────────

it('has more than one spelling per concept, or none of these tests discriminate', () => {
  expect(CASH_SUBTYPES.length).toBeGreaterThan(2);
  expect(BANK_SUBTYPES.length).toBeGreaterThan(1);
  expect(RECEIVABLE_SUBTYPES.length).toBeGreaterThan(1);
  expect(PAYABLE_SUBTYPES.length).toBeGreaterThan(1);
  for (const s of BANK_SUBTYPES) expect(CASH_SUBTYPES).toContain(s);
});

// ── every cash surface sees every spelling ───────────────────────────────────

const expectedTotal = (): number => cashAccounts.reduce((sum, a) => sum + a.balance, 0);

it('cash.balance.v1 sees every cash spelling', async () => {
  const cash = await getCashBalance(cashCo, AS_AT);
  const by = new Map(cash.accounts.map((a) => [a.accountCode, a.glBalance]));
  for (const { code, balance } of cashAccounts) {
    expect(by.get(code)).toBeCloseTo(balance, 2);
  }
  expect(cash.total).toBeCloseTo(expectedTotal(), 2);
});

it('the cash-flow forecast opens on the same cash as cash.balance.v1', async () => {
  // The literal IN ('bank','cash') here missed bank_account, cash_on_hand and
  // petty_cash, so the forecast opened on less money than every other report.
  const forecastOpening = await getCurrentCashBalance(cashCo);
  const cash = await getCashBalance(cashCo, AS_AT);
  expect(forecastOpening).toBeCloseTo(cash.total, 2);
  expect(forecastOpening).toBeCloseTo(expectedTotal(), 2);
});

it('the forecast history counts the movement on every cash spelling', async () => {
  const history = await getHistoricalCashFlows(cashCo, 240);
  const inflow = history.reduce((sum, h) => sum + h.inflow, 0);
  expect(inflow).toBeCloseTo(expectedTotal(), 2);
});

it('the AFS cash note lists every cash spelling and foots to the same total', async () => {
  const note = await generateNote11CashAndCashEquivalents(cashCo, 2026);
  const rows = (note.dataSnapshot.cashAccounts ?? []) as Array<Record<string, unknown>>;
  const by = new Map(rows.map((r) => [String(r.account_code), Number(r.balance)]));
  for (const { code, balance } of cashAccounts) {
    expect(by.get(code)).toBeCloseTo(balance, 2);
  }
  expect(rows.reduce((sum, r) => sum + Number(r.balance), 0)).toBeCloseTo(expectedTotal(), 2);
});

it('the IFRS disclosure cash note agrees with the AFS note', async () => {
  const note = await noteCash(cashCo, 2026);
  const table = note.tables?.[0];
  expect(table).toBeDefined();
  const codes = table!.rows.map((r) => r[1]).filter((c) => c !== '');
  for (const { code } of cashAccounts) expect(codes).toContain(code);
  // Last row is the Total; it foots to the same figure every other surface has.
  // Compared as the note's own formatted string rather than a re-parse — the
  // en-ZA group separator is not a comma and stripping it corrupts the number.
  const total = table!.rows[table!.rows.length - 1]![2]!;
  const asPrinted = new Intl.NumberFormat('en-ZA', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(expectedTotal());
  expect(total).toBe(asPrinted);
});

it('bank coverage carries exactly the BANK_SUBTYPES subset, at the same balances', async () => {
  const coverage = await getBankStatementCoverage(cashCo, { asAt: AS_AT });
  const by = new Map(coverage.accounts.map((a) => [a.accountCode, a.glBalance]));
  const bankCodes = cashAccounts
    .filter((a) => (BANK_SUBTYPES as readonly string[]).includes(a.spelling))
    .map((a) => a.code);
  const cashOnlyCodes = cashAccounts
    .filter((a) => !(BANK_SUBTYPES as readonly string[]).includes(a.spelling))
    .map((a) => a.code);

  expect([...by.keys()].sort()).toEqual([...bankCodes].sort());
  // Not a subset assertion by accident: petty cash IS cash and is NOT a bank
  // account, so the two surfaces differ by exactly those balances.
  expect(cashOnlyCodes.length).toBeGreaterThan(0);
  for (const { code, balance } of cashAccounts) {
    if (bankCodes.includes(code)) expect(by.get(code)).toBeCloseTo(balance, 2);
  }
  const cash = await getCashBalance(cashCo, AS_AT);
  const cashOnlyTotal = cashAccounts
    .filter((a) => cashOnlyCodes.includes(a.code))
    .reduce((sum, a) => sum + a.balance, 0);
  expect(cash.total - coverage.totals.glBalance).toBeCloseTo(cashOnlyTotal, 2);
});

// ── the VAT201 base box ──────────────────────────────────────────────────────

it('the VAT201 base box excludes the settlement leg however it is spelled', async () => {
  const report = await getVat201Report(vatCo, '2026-01-01', AS_AT);
  const journals = settlementSpellings.length;

  // Base is the REVENUE legs only. Counting the gross settlement legs as base
  // as well would give SALE_NET + SALE_GROSS per journal.
  expect(report.totals.standardRatedSupplies).toBeCloseTo(SALE_NET * journals, 2);
  expect(report.totals.standardRatedSupplies)
    .not.toBeCloseTo((SALE_NET + SALE_GROSS) * journals, 2);
  expect(report.totals.outputTax).toBeCloseTo(SALE_VAT * journals, 2);

  // And therefore SARS's own 15% check ties, which is the whole point of the
  // report: a base inflated by the settlement leg fails it by millions.
  expect(report.rateCheck.ties).toBe(true);
  expect(report.rateCheck.outputVariance).toBeCloseTo(0, 2);
});

// ── AR / AP control accounts, in the AFS ─────────────────────────────────────

it('note 27 counts every receivable and payable spelling in the current ratio', async () => {
  const note = await generateNote27GoingConcern(arApCo, 2026);
  const snap = note.dataSnapshot as { currentAssets: number; currentLiabilities: number };

  // The literal list recognised only trade_receivable / trade_payable, so the
  // going-concern current ratio was computed from one account per side.
  expect(snap.currentAssets).toBeCloseTo(arTotal, 2);
  expect(snap.currentLiabilities).toBeCloseTo(apTotal, 2);
  expect(RECEIVABLE_SUBTYPES.length).toBeGreaterThan(1);
  expect(snap.currentAssets).not.toBeCloseTo(100, 2);
});

it('the AFS KPI scorecard counts every receivable and payable spelling', async () => {
  const card = await getKpiScorecard(arApCo, KPI_PERIOD);
  const by = new Map(card.kpis.map((k) => [k.key, k.value]));

  // debtorDays = tradeReceivables / revenue x days; creditorDays over cogs.
  expect(by.get('debtorDays')).toBeCloseTo((arTotal / KPI_REVENUE) * KPI_DAYS, 4);
  expect(by.get('creditorDays')).toBeCloseTo((apTotal / KPI_COGS) * KPI_DAYS, 4);
});
