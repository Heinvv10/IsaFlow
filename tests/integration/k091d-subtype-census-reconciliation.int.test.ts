/**
 * Round 6 review, HIGH-1: the census had been rebuilt from a grep three rounds
 * running and had missed live read paths three rounds running — the last of
 * them printing a current ratio 500x wrong.
 *
 * So this file reconciles by OUTCOME rather than by enumeration. For every
 * canonical token that has more than one raw spelling, it seeds ONE account per
 * spelling with a DISTINCT balance and asserts that the surfaces reporting that
 * quantity see all of them. A reader stuck on one spelling gets a different
 * number, not a proportionally smaller one, so no assertion can pass by luck.
 *
 * Covered here (k091c covers cash, the VAT201 base box and the AR/AP figures
 * in the AFS; this file covers everything the round-6 enumeration added):
 *
 *   current / quick ratio       getKpiScorecard          non-current exclusion
 *   note 27 going concern       generateNote27...        account_type guards
 *   AR / AP close gates         ar/apSubLedgerCheck      control-account spelling
 *   post-migration validation   validateMigration        control-account spelling
 *   AFS notes 5, 8, 9, 19, 20, 21, 22                    token spellings
 *   gross profit / EBITDA       getKpiScorecard          cost_of_sales, depreciation
 *   VAT201 settlement leg       getVat201Report          credit_card, other_current_liability
 *   note 20 vs expenseBand      generateNote20...        THE WHOLE EXPENSE BOOK
 *
 * Round 7 review, HIGH-1: note 20 and `expenseBand` disagreed about income tax
 * and other expenses — one statutory pack reporting the same R158,412.82 both
 * below the operating line and inside "Operating Expenses by Nature". Nothing
 * here caught it because the note tenant seeded no account with either token
 * and the note assertion only checked that finance costs were EXCLUDED, never
 * that the note and the income statement partition the expense book the same
 * way. `bandCo` below now seeds one account per spelling of EVERY expense token
 * and asserts exact agreement in both directions.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  NON_CURRENT_SUBTYPES,
  PAYABLE_SUBTYPES,
  RECEIVABLE_SUBTYPES,
  canonicalSubtype,
  rawSubtypesFor,
} from '../../src/modules/accounting/services/gl/accountSubtypes';
import { expenseBand } from '../../src/modules/accounting/services/gl/accountClassification';
import { getKpiScorecard } from '../../src/modules/accounting/services/afs/afsKpiService';
import { generateNote27GoingConcern } from '../../src/modules/accounting/services/afs/noteGenerators/notes26to30';
import { arSubLedgerCheck } from '../../src/modules/accounting/services/gl/closeReadinessChecks/arSubLedgerCheck';
import { apSubLedgerCheck } from '../../src/modules/accounting/services/gl/closeReadinessChecks/apSubLedgerCheck';
import { validateMigration } from '../../src/modules/accounting/services/core/migrationValidationService';
import { generateNote5IntangibleAssets } from '../../src/modules/accounting/services/afs/noteGenerators/notes1to5';
import { generateNote8FinancialAssets, generateNote9Inventories } from '../../src/modules/accounting/services/afs/noteGenerators/notes6to10';
import { generateNote19OtherIncome, generateNote20OperatingExpenses } from '../../src/modules/accounting/services/afs/noteGenerators/notes16to20';
import { generateNote21FinanceCosts, generateNote22EmployeeBenefits } from '../../src/modules/accounting/services/afs/noteGenerators/notes21to25';
import { getVat201Report } from '../../src/modules/accounting/services/reports/vat201ReportService';
import { getIncomeStatement } from '../../src/modules/accounting/services/reports/incomeStatementService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ratioCo = crypto.randomUUID();
const gateCo = crypto.randomUUID();
const noteCo = crypto.randomUUID();
const vatCo = crypto.randomUUID();
const bandCo = crypto.randomUUID();

/**
 * Every canonical token an expense account can carry. Listed rather than
 * derived because `CanonicalSubtype` spans all five account types and nothing
 * in the vocabulary records which side a token belongs to — see the limits
 * section of docs/audits/remediation/K-091/fix.md.
 */
const EXPENSE_TOKENS = [
  'cost_of_sales', 'operating_expense', 'admin_expense', 'depreciation_expense',
  'insurance_expense', 'payroll_expense', 'finance_cost', 'tax_expense', 'other_expense',
] as const;

/**
 * One entry per expense account seeded on `bandCo`: its printed name, its raw
 * spelling and its SIGNED period movement (debit - credit).
 *
 * Round 8 review, HIGH-1: this was `spelling -> amount` with every account
 * seeded `{debit: amount, credit: 0}`, so `HAVING SUM(debit - credit) > 0` was
 * a no-op on the fixture and the footing assertion could not fail. A note that
 * dropped every credit-balance operating expense — a rebate, a credit note
 * against an expense, a reversed over-accrual — passed here while overstating
 * the operating-expense line by the whole credit balance. The fixture now
 * spans the sign space: debit, credit AND net-nil, plus two distinct accounts
 * sharing one name (LOW-1).
 */
interface BandAccount { name: string; spelling: string; net: number }
const bandAccounts: BandAccount[] = [];

/** Inside fiscal 2026 for the schema-default March year start (2025-03-01..2026-02-28). */
const POSTED_ON = '2026-01-15';
const AS_AT = '2026-12-31';
const KPI_PERIOD = '2026-01';

/** Note 21's own set: the finance-cost spellings, plus its extra literal. */
const FINANCE_COST_SPELLINGS = [...rawSubtypesFor('finance_cost'), 'bank_charges'];

let seq = 0;
async function account(company: string, type: string, subtype: string | null, normal: 'debit' | 'credit', name?: string): Promise<string> {
  seq += 1;
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
    [id, company, `K91D${1000 + seq}`, name ?? `${subtype ?? 'null'} probe ${seq}`, type, subtype, normal],
  );
  return id;
}

let entry = 0;
async function post(company: string, legs: Array<{ account: string; debit: number; credit: number; vatType?: string | null }>, source = 'manual'): Promise<void> {
  entry += 1;
  const { rows } = await pool.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, created_by)
     VALUES ($1,$2,$3,'k091d fixture','posted',$4,$1) RETURNING id`,
    [company, `k091d-${entry}`, POSTED_ON, source],
  );
  for (const leg of legs) {
    await pool.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, vat_type)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [company, rows[0].id, leg.account, leg.debit, leg.credit, leg.vatType ?? null],
    );
  }
}

/** One account per spelling, distinct balance 100k, debit side. Returns the total. */
async function seedPerSpelling(company: string, type: string, spellings: readonly string[], equity: string, side: 'debit' | 'credit'): Promise<number> {
  let total = 0;
  let n = 0;
  for (const spelling of spellings) {
    n += 1;
    const amount = 100 * n;
    const id = await account(company, type, spelling, side);
    await post(company, side === 'debit'
      ? [{ account: id, debit: amount, credit: 0 }, { account: equity, debit: 0, credit: amount }]
      : [{ account: equity, debit: amount, credit: 0 }, { account: id, debit: 0, credit: amount }]);
    total += amount;
  }
  return total;
}

const NON_CURRENT_ASSETS = NON_CURRENT_SUBTYPES.filter((s) => {
  const c = canonicalSubtype(s);
  return c !== 'long_term_liability' && c !== 'non_current_liability';
});
const NON_CURRENT_LIABS = NON_CURRENT_SUBTYPES.filter((s) => !NON_CURRENT_ASSETS.includes(s));

const CURRENT_ASSET = 900;
const CURRENT_LIAB = 300;
const PAYCARD = 50;
/** The paycard is typed liability and is not a non-current token, so it is current. */
const CURRENT_LIABILITIES = CURRENT_LIAB + PAYCARD;
const REVENUE = 10000;
const COGS_EACH = 500;
const DEPR_EACH = 100;
let nonCurrentAssetTotal = 0;
let nonCurrentLiabTotal = 0;
let arTotal = 0;
let apTotal = 0;

beforeAll(async () => {
  // ── ratio tenant: one non-current account per spelling, on both sides ──
  await pool.query('INSERT INTO companies(id,name,is_active) VALUES($1,$2,true)', [ratioCo, 'K091d ratios']);
  const rEquity = await account(ratioCo, 'equity', 'equity', 'credit');
  nonCurrentAssetTotal = await seedPerSpelling(ratioCo, 'asset', NON_CURRENT_ASSETS, rEquity, 'debit');
  nonCurrentLiabTotal = await seedPerSpelling(ratioCo, 'liability', NON_CURRENT_LIABS, rEquity, 'credit');
  const curAsset = await account(ratioCo, 'asset', 'bank', 'debit');
  const curLiab = await account(ratioCo, 'liability', 'payable', 'credit');
  await post(ratioCo, [{ account: curAsset, debit: CURRENT_ASSET, credit: 0 }, { account: rEquity, debit: 0, credit: CURRENT_ASSET }]);
  await post(ratioCo, [{ account: rEquity, debit: CURRENT_LIAB, credit: 0 }, { account: curLiab, debit: 0, credit: CURRENT_LIAB }]);
  // A paycard: typed liability, spelled `bank_account`. Note 27 counted it as a
  // current ASSET at a negative balance before the account_type guard.
  const paycard = await account(ratioCo, 'liability', 'bank_account', 'credit');
  await post(ratioCo, [{ account: rEquity, debit: PAYCARD, credit: 0 }, { account: paycard, debit: 0, credit: PAYCARD }]);
  // Income statement, so the KPI scorecard has a revenue base: one COGS
  // account per cost_of_sales spelling and one per depreciation spelling.
  const rev = await account(ratioCo, 'revenue', 'revenue', 'credit');
  await post(ratioCo, [{ account: rEquity, debit: REVENUE, credit: 0 }, { account: rev, debit: 0, credit: REVENUE }]);
  for (const spelling of rawSubtypesFor('cost_of_sales')) {
    const id = await account(ratioCo, 'expense', spelling, 'debit');
    await post(ratioCo, [{ account: id, debit: COGS_EACH, credit: 0 }, { account: rEquity, debit: 0, credit: COGS_EACH }]);
  }
  for (const spelling of rawSubtypesFor('depreciation_expense')) {
    const id = await account(ratioCo, 'expense', spelling, 'debit');
    await post(ratioCo, [{ account: id, debit: DEPR_EACH, credit: 0 }, { account: rEquity, debit: 0, credit: DEPR_EACH }]);
  }

  // ── gate tenant: control accounts on every receivable / payable spelling ──
  await pool.query('INSERT INTO companies(id,name,is_active) VALUES($1,$2,true)', [gateCo, 'K091d gates']);
  const gEquity = await account(gateCo, 'equity', 'equity', 'credit');
  arTotal = await seedPerSpelling(gateCo, 'asset', RECEIVABLE_SUBTYPES, gEquity, 'debit');
  apTotal = await seedPerSpelling(gateCo, 'liability', PAYABLE_SUBTYPES, gEquity, 'credit');

  // ── note tenant: one account per spelling of each note's token ──
  await pool.query('INSERT INTO companies(id,name,is_active) VALUES($1,$2,true)', [noteCo, 'K091d notes']);
  const nEquity = await account(noteCo, 'equity', 'equity', 'credit');
  for (const token of ['intangible_asset', 'investment', 'inventory'] as const) {
    await seedPerSpelling(noteCo, 'asset', rawSubtypesFor(token), nEquity, 'debit');
  }
  await seedPerSpelling(noteCo, 'revenue', rawSubtypesFor('other_income'), nEquity, 'credit');
  for (const token of ['finance_cost', 'payroll_expense'] as const) {
    await seedPerSpelling(noteCo, 'expense', rawSubtypesFor(token), nEquity, 'debit');
  }

  // ── VAT tenant: the two settlement subtypes round 6 left out ──
  await pool.query('INSERT INTO companies(id,name,is_active) VALUES($1,$2,true)', [vatCo, 'K091d vat']);
  const vatInput = await account(vatCo, 'asset', 'vat_input', 'debit');
  for (const spelling of ['credit_card', 'other_current_liability']) {
    const settle = await account(vatCo, 'liability', spelling, 'credit');
    const expense = await account(vatCo, 'expense', 'operating_expense', 'debit');
    await post(vatCo, [
      { account: expense, debit: 1000, credit: 0, vatType: 'standard' },
      { account: vatInput, debit: 150, credit: 0, vatType: 'standard' },
      { account: settle, debit: 0, credit: 1150 },
    ], 'auto_supplier_invoice');
  }

  // ── band tenant: one expense account per spelling of every expense token ──
  await pool.query('INSERT INTO companies(id,name,is_active) VALUES($1,$2,true)', [bandCo, 'K091d bands']);
  const bEquity = await account(bandCo, 'equity', 'equity', 'credit');
  /** Seed one account and record what the income statement will band it as. */
  const bandAccount = async (spelling: string, debit: number, credit: number, name = `${spelling} probe`) => {
    const id = await account(bandCo, 'expense', spelling, 'debit', name);
    // `chk_debit_or_credit` forbids both sides on one line, so a net-nil
    // account is an accrual and its reversal — two journals, as in the books.
    if (debit > 0) await post(bandCo, [{ account: id, debit, credit: 0 }, { account: bEquity, debit: 0, credit: debit }]);
    if (credit > 0) await post(bandCo, [{ account: bEquity, debit: credit, credit: 0 }, { account: id, debit: 0, credit }]);
    bandAccounts.push({ name, spelling, net: debit - credit });
  };
  let bandAmount = 0;
  for (const token of EXPENSE_TOKENS) {
    for (const spelling of rawSubtypesFor(token)) {
      bandAmount += 13;
      await bandAccount(spelling, bandAmount, 0);
    }
  }
  // The sign space, so no assertion below can pass because the fixture only
  // ever produces the shape that passes:
  //   a supplier rebate — an operating expense with a NET CREDIT balance;
  //   a nil-movement account, which neither statement prints;
  //   two DISTINCT accounts sharing one name and subtype, whose movements
  //   cancel — invisible to a note that groups by account_name.
  await bandAccount('operating_expense', 0, 5000, 'Rebates received');
  await bandAccount('admin_expense', 700, 700, 'Nil movement');
  await bandAccount('insurance_expense', 300, 0, 'Shared name');
  await bandAccount('insurance_expense', 0, 300, 'Shared name');
  // Note 21 carried the same one-sided HAVING as note 20. An interest rebate
  // or a reversed finance charge is a net-credit finance cost, and `foot()`
  // below takes an absolute value per row, so no existing assertion could see
  // the difference. Seeded here, asserted SIGNED.
  await bandAccount(FINANCE_COST_SPELLINGS[0], 0, 450, 'Interest rebate');
  await bandAccount(FINANCE_COST_SPELLINGS[0], 900, 900, 'Nil finance charge');
}, 120_000);

afterAll(async () => {
  const ids = [ratioCo, gateCo, noteCo, vatCo, bandCo];
  try {
    // One statement per table across all four tenants: four round trips, not
    // sixteen, so a slow box cannot cut the cleanup off half done.
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id = ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [ids]);
  } finally { await pool.end(); }
}, 60_000);

// ── the fixture must be able to discriminate ─────────────────────────────────

it('every token under test has more than one spelling', () => {
  expect(NON_CURRENT_ASSETS.length).toBeGreaterThan(3);
  expect(NON_CURRENT_LIABS.length).toBeGreaterThan(1);
  for (const token of ['cost_of_sales', 'depreciation_expense', 'finance_cost', 'payroll_expense', 'other_income', 'investment', 'inventory', 'intangible_asset'] as const) {
    expect(rawSubtypesFor(token).length).toBeGreaterThan(1);
  }
});

// ── the current and quick ratios ─────────────────────────────────────────────

it('the KPI current ratio excludes every non-current spelling, on both sides', async () => {
  const card = await getKpiScorecard(ratioCo, KPI_PERIOD);
  const by = new Map(card.kpis.map((k) => [k.key, k.value]));

  // NOT IN ('fixed_asset','accumulated_depreciation') recognised two spellings
  // of the seven non-current asset tokens, so the rest were counted as current.
  expect(nonCurrentAssetTotal).toBeGreaterThan(CURRENT_ASSET);
  expect(by.get('currentRatio')).toBeCloseTo(CURRENT_ASSET / CURRENT_LIABILITIES, 4);
  expect(by.get('currentRatio')).not.toBeCloseTo((CURRENT_ASSET + nonCurrentAssetTotal) / CURRENT_LIABILITIES, 2);
  // Nothing seeded is inventory on this tenant, so quick == current.
  expect(by.get('quickRatio')).toBeCloseTo(CURRENT_ASSET / CURRENT_LIABILITIES, 4);
});

it('the KPI current ratio denominator excludes long-term debt', async () => {
  const card = await getKpiScorecard(ratioCo, KPI_PERIOD);
  const by = new Map(card.kpis.map((k) => [k.key, k.value]));
  expect(nonCurrentLiabTotal).toBeGreaterThan(0);
  // The paycard is a current liability: typed liability, spelled bank_account,
  // and not a non-current token.
  expect(by.get('currentRatio')).toBeCloseTo(CURRENT_ASSET / CURRENT_LIABILITIES, 4);
  expect(by.get('currentRatio'))
    .not.toBeCloseTo(CURRENT_ASSET / (CURRENT_LIABILITIES + nonCurrentLiabTotal), 2);
});

it('an asset with NO subtype is still a current asset', async () => {
  const co = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name,is_active) VALUES($1,$2,true)', [co, 'K091d null subtype']);
  try {
    const eq = await account(co, 'equity', 'equity', 'credit');
    const unclassified = await account(co, 'asset', null, 'debit');
    const liab = await account(co, 'liability', 'payable', 'credit');
    await post(co, [{ account: unclassified, debit: 400, credit: 0 }, { account: eq, debit: 0, credit: 400 }]);
    await post(co, [{ account: eq, debit: 200, credit: 0 }, { account: liab, debit: 0, credit: 200 }]);
    const card = await getKpiScorecard(co, KPI_PERIOD);
    const by = new Map(card.kpis.map((k) => [k.key, k.value]));
    // `NOT IN (...)` is NULL for a NULL subtype, which dropped the account out
    // of current assets entirely and reported a ratio of 0.
    expect(by.get('currentRatio')).toBeCloseTo(2, 4);
  } finally {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [co]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [co]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [co]);
    await pool.query('DELETE FROM companies WHERE id=$1', [co]);
  }
});

it('gross profit and EBITDA see every cost-of-sales and depreciation spelling', async () => {
  const card = await getKpiScorecard(ratioCo, KPI_PERIOD);
  const by = new Map(card.kpis.map((k) => [k.key, k.value]));
  const cogs = COGS_EACH * rawSubtypesFor('cost_of_sales').length;
  expect(by.get('grossMarginPct')).toBeCloseTo(((REVENUE - cogs) / REVENUE) * 100, 4);
  expect(by.get('grossMarginPct')).not.toBeCloseTo(((REVENUE - COGS_EACH) / REVENUE) * 100, 2);
  // EBITDA adds depreciation back; every spelling of it must be found.
  const depreciation = DEPR_EACH * rawSubtypesFor('depreciation_expense').length;
  const expenses = cogs + depreciation;
  expect(by.get('ebitdaMarginPct')).toBeCloseTo(((REVENUE - expenses + depreciation) / REVENUE) * 100, 4);
});

// ── note 27's account_type guard ─────────────────────────────────────────────

it('note 27 does not count a liability paycard as a current asset', async () => {
  const note = await generateNote27GoingConcern(ratioCo, 2026);
  const snap = note.dataSnapshot as { currentAssets: number; currentLiabilities: number };
  // Without the guard the paycard's credit balance lands in current assets as
  // -PAYCARD, understating the going-concern ratio.
  expect(snap.currentAssets).toBeCloseTo(CURRENT_ASSET, 2);
  expect(snap.currentAssets).not.toBeCloseTo(CURRENT_ASSET - PAYCARD, 2);
  // The paycard IS a current liability — it is a liability with a subtype that
  // is not non-current — and note 27 now reads the same `fetchBalanceSnapshot`
  // split the KPI scorecard reads, so it counts it on the liability side and
  // NOT on the asset side. This assertion pinned the old three-token whitelist
  // (CURRENT_LIAB alone), which is exactly the divergence that made the same
  // AFS pack print two different current ratios. `CURRENT_LIABILITIES` is the
  // constant the scorecard assertions above already use.
  expect(snap.currentLiabilities).toBeCloseTo(CURRENT_LIABILITIES, 2);
});

// ── the close gates and the migration validator ──────────────────────────────

it('the AR and AP close gates read a control account however it is spelled', async () => {
  const ar = await arSubLedgerCheck(gateCo, { endDate: AS_AT });
  const ap = await apSubLedgerCheck(gateCo, { endDate: AS_AT });
  // No invoices on this tenant, so the sub-ledger is 0 and the GL is not:
  // the gate must report the WHOLE control balance as the difference. With the
  // literal it read 0 on both sides and passed a company it should have failed.
  expect(arTotal).toBeGreaterThan(0);
  expect(ar.reason).toContain(arTotal.toFixed(2));
  expect(ap.reason).toContain(apTotal.toFixed(2));
  expect(ar.status).toBe('fail');
  expect(ap.status).toBe('fail');
});

it('post-migration validation reads the same control accounts', async () => {
  const results = await validateMigration(gateCo, crypto.randomUUID());
  const ar = results.find((r) => r.check === 'AR vs GL');
  const ap = results.find((r) => r.check === 'AP vs GL');
  expect(ar?.detail).toContain(arTotal.toFixed(2));
  expect(ap?.detail).toContain(apTotal.toFixed(2));
});

// ── the AFS notes ────────────────────────────────────────────────────────────

function foot(snapshot: Record<string, unknown>, key: string): number {
  const rows = (snapshot[key] ?? []) as Array<Record<string, unknown>>;
  return rows.reduce((sum, r) => sum + Math.abs(Number(r.balance ?? r.amount ?? r.net_amount ?? 0)), 0);
}

function expectedFor(token: 'intangible_asset' | 'investment' | 'inventory' | 'other_income' | 'finance_cost' | 'payroll_expense'): number {
  return rawSubtypesFor(token).reduce((sum, _s, i) => sum + 100 * (i + 1), 0);
}

it('the AFS notes list every spelling of their own token', async () => {
  const [intangibles, financial, inventories, otherIncome, finance, employees] = await Promise.all([
    generateNote5IntangibleAssets(noteCo, 2026),
    generateNote8FinancialAssets(noteCo, 2026),
    generateNote9Inventories(noteCo, 2026),
    generateNote19OtherIncome(noteCo, 2026),
    generateNote21FinanceCosts(noteCo, 2026),
    generateNote22EmployeeBenefits(noteCo, 2026),
  ]);

  expect(foot(intangibles.dataSnapshot, 'intangibles')).toBeCloseTo(expectedFor('intangible_asset'), 2);
  expect(foot(financial.dataSnapshot, 'financialAssets')).toBeCloseTo(expectedFor('investment'), 2);
  expect(foot(inventories.dataSnapshot, 'inventory')).toBeCloseTo(expectedFor('inventory'), 2);
  expect(foot(otherIncome.dataSnapshot, 'otherIncome')).toBeCloseTo(expectedFor('other_income'), 2);
  expect(foot(finance.dataSnapshot, 'financeCosts')).toBeCloseTo(expectedFor('finance_cost'), 2);
  expect(foot(employees.dataSnapshot, 'employeeBenefits')).toBeCloseTo(expectedFor('payroll_expense'), 2);
});

it('note 20 excludes every finance-cost spelling it must not double-count', async () => {
  const note = await generateNote20OperatingExpenses(noteCo, 2026);
  const rows = (note.dataSnapshot.operatingExpenses ?? []) as Array<Record<string, unknown>>;
  const subtypes = rows.map((r) => String(r.account_subtype ?? ''));
  // A finance cost spelled `finance_costs` appeared in note 21 AND here.
  for (const spelling of rawSubtypesFor('finance_cost')) expect(subtypes).not.toContain(spelling);
  // The employee-benefit accounts are operating expenses and DO belong here,
  // so the exclusion is not simply swallowing the whole expense book.
  expect(subtypes).toContain(rawSubtypesFor('payroll_expense')[0]);
});

/** Every seeded account the income statement bands as an operating expense. */
function operatingBandAccounts(): BandAccount[] {
  return bandAccounts.filter((a) => expenseBand(a.spelling) === 'operating_expense');
}

it('the band fixture spans the sign space, so the note assertions can fail', () => {
  const operating = operatingBandAccounts();
  // A fixture that only ever produces the passing shape makes the assertion
  // below decorative — the same failure as a mutation that stays green.
  expect(operating.some((a) => a.net > 0)).toBe(true);
  expect(operating.some((a) => a.net < 0)).toBe(true);
  expect(operating.some((a) => a.net === 0)).toBe(true);
  const shared = operating.filter((a) => a.name === 'Shared name');
  expect(shared).toHaveLength(2);
  expect(shared.reduce((sum, a) => sum + a.net, 0)).toBe(0);
});

it('note 20 and expenseBand partition the expense book identically', async () => {
  const note = await generateNote20OperatingExpenses(bandCo, 2026);
  const rows = (note.dataSnapshot.operatingExpenses ?? []) as Array<Record<string, unknown>>;
  const printed = rows.map((r) => String(r.account_subtype ?? '')).sort();

  const operating = operatingBandAccounts();
  // Nil movement is in neither statement: the note's HAVING drops it and the
  // income statement's `Math.abs(amount) > 0.001` drops it.
  const moved = operating.filter((a) => a.net !== 0);
  expect(printed).toEqual(moved.map((a) => a.spelling).sort());
  expect(moved.length).toBeGreaterThan(5);
  // Two distinct accounts share one name and subtype; both must print, so a
  // note grouping by account_name nets them away and fails here.
  expect(rows.map((r) => String(r.account_name ?? '')).filter((n) => n === 'Shared name')).toHaveLength(2);
  for (const seeded of bandAccounts) {
    if (expenseBand(seeded.spelling) === 'operating_expense') continue;
    expect(printed).not.toContain(seeded.spelling);
  }
  const footed = rows.reduce((sum, r) => sum + Number(r.net_amount ?? 0), 0);
  expect(footed).toBeCloseTo(moved.reduce((sum, a) => sum + a.net, 0), 2);
  // A rebate is R5,000 of credit inside the operating band: a note that keeps
  // only net-debit accounts overstates the total by exactly that.
  expect(footed).not.toBeCloseTo(moved.filter((a) => a.net > 0).reduce((sum, a) => sum + a.net, 0), 2);
});

it("note 20's total IS the income statement's Operating Expenses line", async () => {
  // The surface `expenseBand` drives, named exactly: the reports-module P&L
  // (and through it the MCP figures contract), NOT the AFS pack's own
  // mapping-driven statement, which is decided per account by the editable
  // `afs_account_mappings` table and cannot agree by construction with
  // anything. Round 8 review, MEDIUM-1.
  const note = await generateNote20OperatingExpenses(bandCo, 2026);
  const rows = (note.dataSnapshot.operatingExpenses ?? []) as Array<Record<string, unknown>>;
  const footed = rows.reduce((sum, r) => sum + Number(r.net_amount ?? 0), 0);

  const is = await getIncomeStatement(bandCo, '2025-03-01', '2026-02-28');
  expect(is.totalOperatingExpenses).toBeGreaterThan(0);
  expect(footed).toBeCloseTo(is.totalOperatingExpenses, 2);
  expect(rows).toHaveLength(is.operatingExpenses.length);
});

it('note 21 keeps a net-credit finance cost, as note 22 already did', async () => {
  const note = await generateNote21FinanceCosts(bandCo, 2026);
  const rows = (note.dataSnapshot.financeCosts ?? []) as Array<Record<string, unknown>>;

  const seeded = bandAccounts.filter((a) => FINANCE_COST_SPELLINGS.includes(a.spelling));
  const moved = seeded.filter((a) => a.net !== 0);
  expect(moved.some((a) => a.net < 0)).toBe(true);
  expect(seeded.some((a) => a.net === 0)).toBe(true);

  // SIGNED, not `foot()` — `foot()` takes an absolute value per row and would
  // read the same total whether the rebate were printed as -450 or dropped.
  const footed = rows.reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
  expect(rows).toHaveLength(moved.length);
  expect(footed).toBeCloseTo(moved.reduce((sum, a) => sum + a.net, 0), 2);
  expect(footed).not.toBeCloseTo(moved.filter((a) => a.net > 0).reduce((sum, a) => sum + a.net, 0), 2);
  expect(rows.map((r) => String(r.account_name ?? ''))).toContain('Interest rebate');
});

it('every expense spelling in the vocabulary is under test', () => {
  const covered = new Set(EXPENSE_TOKENS.flatMap((t) => rawSubtypesFor(t)));
  const seeded = new Set(bandAccounts.map((a) => a.spelling));
  for (const spelling of seeded) expect(covered.has(spelling)).toBe(true);
  // Income tax by any spelling is below the operating line, not inside note 20.
  for (const spelling of rawSubtypesFor('tax_expense')) {
    expect(expenseBand(spelling)).toBe('other_expense');
    expect(seeded.has(spelling)).toBe(true);
  }
});

// ── the VAT201 settlement leg ────────────────────────────────────────────────

it('a card or sundry-creditor settlement leg is not a taxable supply', async () => {
  const report = await getVat201Report(vatCo, '2026-01-01', AS_AT);
  // Two invoices, R1,000 net each. Counting the R1,150 gross legs as base
  // produced a NEGATIVE input base of -R150 per invoice.
  expect(report.totals.standardRatedPurchases).toBeCloseTo(2000, 2);
  expect(report.totals.inputTax).toBeCloseTo(300, 2);
  expect(report.rateCheck.ties).toBe(true);
});
