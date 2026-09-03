// tests/integration/afs-changes-in-equity.int.test.ts
//
// The statement of changes in equity has to reconcile to the two statements
// either side of it:
//
//   1. `totalClosing` must equal equity on the balance sheet at period end,
//      using the ONE equity definition in financialFiguresService.totalEquity.
//   2. `totalProfitForYear` must equal the income statement's result for the
//      period.
//
// It did neither, for two reasons.
//
//   PROFIT WAS INVENTED FROM POSTING SIGNS. `fetchMovements` classified equity
//   journal lines by the sign of (credit - debit): a credit to retained
//   earnings became "profit", a debit became "dividend". Profit for the year
//   is the income statement result, and it is not posted to retained earnings
//   at all until the year-end close runs — production holds zero `year_end`
//   entries. So the profit column read 0 while real profit sat in revenue and
//   expense accounts, and any credit to retained earnings (a reversed dividend,
//   a correction) was reported as profit the company never earned.
//
//   OPENING EQUITY DROPPED ACCUMULATED PROFIT. Opening was posted equity only.
//   No production company carries a posted retained-earnings balance, so every
//   prior year's result was missing from the opening column — the same omission
//   that left the balance sheet out by R28,356,760.75 on Velocity Fibre.
//
// Both are pinned below by asserting the reconciliations, not the mechanism.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { getChangesInEquity } from '@/modules/accounting/services/afs/changesInEquityService';
import {
  getFinancialFigures,
  totalEquity,
} from '@/modules/accounting/services/gl/financialFiguresService';

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = '00000000-0000-0000-0000-0000000000e1';
const GL_BANK = '00000000-0000-0000-0000-0000000000eb';
const GL_SHARE_CAPITAL = '00000000-0000-0000-0000-0000000000ec';
const GL_RETAINED = '00000000-0000-0000-0000-0000000000ed';
const GL_REVENUE = '00000000-0000-0000-0000-0000000000ee';
const GL_EXPENSE = '00000000-0000-0000-0000-0000000000ef';
// An equity reserve whose subtype canonicalSubtype does not recognise. Its
// movement must still reach the statement, in the otherMovements row, or the
// closing balance silently stops tying to the balance sheet.
const GL_FCTR = '00000000-0000-0000-0000-0000000000ea';

const PERIOD_START = '2026-01-01';
const PERIOD_END = '2026-12-31';

// ── Before the period ────────────────────────────────────────────────────────
const SHARE_CAPITAL_OPENING = 10000;
// Prior-year trading: 5000 revenue less 2000 expenses. Never closed to
// retained earnings — which is the normal state, since no production company
// has run a year-end close.
const PRIOR_PROFIT = 3000;

// ── Inside the period ────────────────────────────────────────────────────────
// NOTE: there is deliberately no year-end-close fixture here. yearEndService
// writes source = 'year_end', which gl_journal_entries_source_check rejects —
// the constraint is the only guard on that unvalidated INSERT-at-posted path.
// A close therefore cannot exist in any ledger, and a test that seeded one
// would be testing a state the database forbids.

const PERIOD_REVENUE = 8000;
const PERIOD_EXPENSES = 3000;
const PERIOD_PROFIT = PERIOD_REVENUE - PERIOD_EXPENSES; // 5000

// A dividend of 1000 declared, then 300 of it reversed. Net distribution 700.
// The sign-based classifier read the 300 credit as PROFIT and reported the
// gross 1000 as the dividend.
const DIVIDEND_DECLARED = 1000;
const DIVIDEND_REVERSED = 300;
const NET_DIVIDEND = -(DIVIDEND_DECLARED - DIVIDEND_REVERSED); // -700

const SHARE_ISSUE = 2000;

// Movement on the unrecognised reserve.
const OTHER_RESERVE_MOVEMENT = 400;


const EXPECTED_OPENING = SHARE_CAPITAL_OPENING + PRIOR_PROFIT; // 13000
const EXPECTED_CLOSING =
  EXPECTED_OPENING + PERIOD_PROFIT + NET_DIVIDEND + SHARE_ISSUE
  + OTHER_RESERVE_MOVEMENT; // 19700

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('AFS statement of changes in equity reconciles to the other statements', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes journal fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });

    await cleanup(admin);

    await admin.query(
      `INSERT INTO companies (id, name, is_active, financial_year_start)
       VALUES ($1, 'Equity Fixture', true, 1)
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY],
    );

    await admin.query(
      `INSERT INTO gl_accounts
         (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES
         ($2, $1, 'EQ1000', 'Bank',              'asset',   'bank',              'debit',  true),
         ($3, $1, 'EQ3000', 'Share Capital',     'equity',  'share_capital',     'credit', true),
         ($4, $1, 'EQ3100', 'Retained Earnings', 'equity',  'retained_earnings', 'credit', true),
         ($5, $1, 'EQ4000', 'Revenue',           'revenue', 'sales',             'credit', true),
         ($6, $1, 'EQ5000', 'Expenses',          'expense', 'operating_expense', 'debit',  true),
         ($7, $1, 'EQ3200', 'FCTR',              'equity',  'fc_translation_reserve', 'credit', true)
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY, GL_BANK, GL_SHARE_CAPITAL, GL_RETAINED, GL_REVENUE, GL_EXPENSE, GL_FCTR],
    );

    // Share capital subscribed before the period.
    await postEntry(admin, 'eq-cap', '2024-06-01', [
      { account: GL_BANK, debit: SHARE_CAPITAL_OPENING, credit: 0 },
      { account: GL_SHARE_CAPITAL, debit: 0, credit: SHARE_CAPITAL_OPENING },
    ]);

    // Prior-year trading, left open in revenue/expense.
    await postEntry(admin, 'eq-py-rev', '2025-05-01', [
      { account: GL_BANK, debit: 5000, credit: 0 },
      { account: GL_REVENUE, debit: 0, credit: 5000 },
    ]);
    await postEntry(admin, 'eq-py-exp', '2025-06-01', [
      { account: GL_EXPENSE, debit: 2000, credit: 0 },
      { account: GL_BANK, debit: 0, credit: 2000 },
    ]);

    // Current-period trading.
    await postEntry(admin, 'eq-cy-rev', '2026-05-01', [
      { account: GL_BANK, debit: PERIOD_REVENUE, credit: 0 },
      { account: GL_REVENUE, debit: 0, credit: PERIOD_REVENUE },
    ]);
    await postEntry(admin, 'eq-cy-exp', '2026-06-01', [
      { account: GL_EXPENSE, debit: PERIOD_EXPENSES, credit: 0 },
      { account: GL_BANK, debit: 0, credit: PERIOD_EXPENSES },
    ]);

    // Dividend declared, then partly reversed. The reversal is a CREDIT to
    // retained earnings — which the sign classifier called profit.
    await postEntry(admin, 'eq-div', '2026-03-01', [
      { account: GL_RETAINED, debit: DIVIDEND_DECLARED, credit: 0 },
      { account: GL_BANK, debit: 0, credit: DIVIDEND_DECLARED },
    ]);
    await postEntry(admin, 'eq-div-rev', '2026-04-01', [
      { account: GL_BANK, debit: DIVIDEND_REVERSED, credit: 0 },
      { account: GL_RETAINED, debit: 0, credit: DIVIDEND_REVERSED },
    ]);

    // A movement on a reserve whose subtype is not in the known vocabulary.
    await postEntry(admin, 'eq-fctr', '2026-09-01', [
      { account: GL_BANK, debit: OTHER_RESERVE_MOVEMENT, credit: 0 },
      { account: GL_FCTR, debit: 0, credit: OTHER_RESERVE_MOVEMENT },
    ]);

    // Further shares issued during the period.
    await postEntry(admin, 'eq-issue', '2026-08-01', [
      { account: GL_BANK, debit: SHARE_ISSUE, credit: 0 },
      { account: GL_SHARE_CAPITAL, debit: 0, credit: SHARE_ISSUE },
    ]);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  it('opening equity carries profit accumulated before the period', async () => {
    const report = await getChangesInEquity(COMPANY, PERIOD_START, PERIOD_END);
    // Posted equity alone is 10000; the prior year's 3000 result belongs here
    // too, and is not posted to retained earnings until year end.
    expect(report.totalOpening).toBeCloseTo(EXPECTED_OPENING, 2);
  });

  it('profit for the year equals the income statement result', async () => {
    const report = await getChangesInEquity(COMPANY, PERIOD_START, PERIOD_END);
    const figures = await getFinancialFigures(COMPANY, PERIOD_START, PERIOD_END);

    expect(report.totalProfitForYear).toBeCloseTo(figures.period.netProfit, 2);
    expect(report.totalProfitForYear).toBeCloseTo(PERIOD_PROFIT, 2);
  });

  it('reports the net distribution, not a gross dividend plus invented profit', async () => {
    const report = await getChangesInEquity(COMPANY, PERIOD_START, PERIOD_END);

    // The credit leg of the reversal is a reduced distribution, not income.
    expect(report.totalDividends).toBeCloseTo(NET_DIVIDEND, 2);
  });

  it('closing equity equals the balance sheet equity at period end', async () => {
    const report = await getChangesInEquity(COMPANY, PERIOD_START, PERIOD_END);
    const figures = await getFinancialFigures(COMPANY, PERIOD_START, PERIOD_END);

    const balanceSheetEquity = totalEquity(figures);

    expect(balanceSheetEquity).toBeCloseTo(EXPECTED_CLOSING, 2);
    expect(report.totalClosing).toBeCloseTo(balanceSheetEquity, 2);
  });

  it('every column closes on opening plus its own movements', async () => {
    const report = await getChangesInEquity(COMPANY, PERIOD_START, PERIOD_END);

    for (const col of report.columns) {
      const movements =
        col.profitForYear + col.dividends + col.shareIssue + col.revaluation + col.otherMovements;
      expect(col.closing).toBeCloseTo(col.opening + movements, 2);
    }

    // And the totals row is the sum of the columns, so the table foots.
    const summedClosing = report.columns.reduce((s, c) => s + c.closing, 0);
    expect(report.totalClosing).toBeCloseTo(summedClosing, 2);
  });

  it('share issues land in their own column, not in distributions', async () => {
    const report = await getChangesInEquity(COMPANY, PERIOD_START, PERIOD_END);
    expect(report.totalShareIssue).toBeCloseTo(SHARE_ISSUE, 2);
  });

  it('carries a movement on an unrecognised reserve instead of dropping it', async () => {
    const report = await getChangesInEquity(COMPANY, PERIOD_START, PERIOD_END);

    // If this movement is not reported anywhere, closing stops tying to the
    // balance sheet — which is exactly how an unmapped account vanishes.
    expect(report.totalOtherMovements).toBeCloseTo(OTHER_RESERVE_MOVEMENT, 2);
  });

  it('every column closes on opening plus its own movements', async () => {
    const report = await getChangesInEquity(COMPANY, PERIOD_START, PERIOD_END);

    for (const col of report.columns) {
      const movements =
        col.profitForYear + col.dividends + col.shareIssue + col.revaluation + col.otherMovements;
      expect(col.closing).toBeCloseTo(col.opening + movements, 2);
    }

    // And the totals row is the sum of the columns, so the table foots.
    const summedClosing = report.columns.reduce((s, c) => s + c.closing, 0);
    expect(report.totalClosing).toBeCloseTo(summedClosing, 2);
  });

  it('share issues land in their own column, not in distributions', async () => {
    const report = await getChangesInEquity(COMPANY, PERIOD_START, PERIOD_END);
    expect(report.totalShareIssue).toBeCloseTo(SHARE_ISSUE, 2);
  });

  it('carries a movement on an unrecognised reserve instead of dropping it', async () => {
    const report = await getChangesInEquity(COMPANY, PERIOD_START, PERIOD_END);

    // If this movement is not reported anywhere, closing stops tying to the
    // balance sheet — which is exactly how an unmapped account vanishes.
    expect(report.totalOtherMovements).toBeCloseTo(OTHER_RESERVE_MOVEMENT, 2);
  });

});

// ── fixture helpers ──────────────────────────────────────────────────────────

interface Leg {
  account: string;
  debit: number;
  credit: number;
}

async function postEntry(
  admin: Pool,
  entryNumber: string,
  entryDate: string,
  legs: Leg[],
  source = 'manual',
): Promise<void> {
  const { rows } = await admin.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by, source)
     VALUES ($1, $2, $3, 'equity fixture', 'posted', $4, $5)
     RETURNING id`,
    [COMPANY, entryNumber, entryDate, COMPANY, source],
  );
  const entryId = rows[0].id as string;

  for (const leg of legs) {
    await admin.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
       VALUES ($1, $2, $3, $4, $5)`,
      [COMPANY, entryId, leg.account, leg.debit, leg.credit],
    );
  }
}

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
}
