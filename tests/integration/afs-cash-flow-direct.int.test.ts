// tests/integration/afs-cash-flow-direct.int.test.ts
//
// The direct cash flow statement must satisfy one property above all others:
//
//     closing cash == the general ledger bank balance at period end
//
// and, equivalently, the sum of every classified cash-flow group must equal
// the net bank movement over the period. A direct cash flow statement that
// does not tie to the bank account is not a cash flow statement.
//
// Two production defects broke that property, and both are pinned here:
//
//   1. FAN-OUT. `fetchGroupedAllocations` joined the bank leg to every OTHER
//      line in the same journal entry and summed the BANK leg once per contra
//      line. An entry with two contra lines therefore counted the bank
//      movement twice. In production this hit 1,668 of 4,764 matched bank legs
//      on one company and 2,150 of 4,191 on another; for company 4a159669 it
//      reported net cash of -R9,089,506.51 against a true bank movement of
//      +R381,207.22 — a R9.47m error that inverted the sign.
//
//   2. CLASSIFICATION AGAINST A VOCABULARY THAT DOES NOT EXIST. The CASE
//      matched `account_subtype IN ('revenue','receivable')`, `('payroll')`,
//      `('expense','payable','cost_of_sales')`. Real charts spell these
//      `default_revenue`, `sales`, `payroll_liability`, `operating_expense`,
//      `admin_expense`. 4,650 of 6,341 contra lines fell through to the
//      `other_operating` catch-all, so 73% of a "direct" cash flow statement
//      was a single undifferentiated line.
//
// These tests seed real journals and run the real service, so they fail if
// either defect returns. They assert the tie-out property and the apportioned
// group amounts — never the SQL text.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = '00000000-0000-0000-0000-00000000cf01';
const GL_BANK = '00000000-0000-0000-0000-00000000cfb1';
const GL_EQUITY = '00000000-0000-0000-0000-00000000cfe1';
const GL_SALES = '00000000-0000-0000-0000-00000000cfd1';
const GL_OTHER_INCOME = '00000000-0000-0000-0000-00000000cfd2';
const GL_OPEX = '00000000-0000-0000-0000-00000000cfc1';
const GL_PAYROLL = '00000000-0000-0000-0000-00000000cfa2';
const GL_VEHICLE = '00000000-0000-0000-0000-00000000cfa1';
const GL_PETTY = '00000000-0000-0000-0000-00000000cfb2';

const PERIOD_START = '2026-01-01';
const PERIOD_END = '2026-12-31';

// Opening bank balance, posted before the period.
const OPENING = 5000;

// JE1 — a receipt of 1000 split across TWO revenue contra lines (600 + 400).
// This is the fan-out trigger: the buggy query counted the 1000 bank leg twice.
// Both contras are revenue, so the whole 1000 belongs to customers.
const JE1_BANK = 1000;

// JE2 — a payment of 300 against a single operating-expense contra line.
// `operating_expense` is a spelling the old CASE did not recognise.
const JE2_BANK = -300;

// JE3 — a payment of 500 split across contra lines in DIFFERENT groups:
// 200 operating expense (suppliers) + 300 payroll liability (employees).
// This pins the apportionment rule: the 500 must be split 200/300, not
// counted as 500 against each group.
const JE3_BANK = -500;

// JE4 — purchase of a vehicle for 900, an investing outflow.
const JE4_BANK = -900;

// JE5 — the bank pays 1000: 600 settles an expense and 400 moves to petty cash.
// This is the only shape where excluding cash-equivalent contras changes the
// answer, so it is what pins that rule. Net cash movement is -600, and all of
// it is a payment to suppliers: the 400 is an internal transfer, not a cash
// flow. Weighting the bank leg across the petty-cash contra as well would
// split it -450 suppliers / -150 other, which is wrong.
const JE5_NET_CASH = -600;

// JE0b — a receipt dated exactly on the first day of the period. It belongs to
// the period's movement, NOT to opening cash. If the opening-cash cut-off
// slips from `< periodStart` to `<= periodStart` this amount is counted twice
// and closing cash stops tying to the ledger.
const JE0B_BANK = 200;

const NET_MOVEMENT =
  JE0B_BANK + JE1_BANK + JE2_BANK + JE3_BANK + JE4_BANK + JE5_NET_CASH; // -1100
const CLOSING = OPENING + NET_MOVEMENT; // 3900

const EXPECTED_CUSTOMERS = 1200; // JE1 1000 + JE0b 200
const EXPECTED_SUPPLIERS = -1100; // 300 (JE2) + 200 (JE3 share) + 600 (JE5)
const EXPECTED_EMPLOYEES = -300; // JE3 share
const EXPECTED_INVESTING = -900;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('AFS direct cash flow ties to the general ledger bank balance', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes journal fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });

    await cleanup(admin);

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'Cash Flow Fixture', true)
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY],
    );

    await admin.query(
      `INSERT INTO gl_accounts
         (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES
         ($2, $1, 'CF1000', 'Bank - Current',      'asset',     'bank',              'debit',  true),
         ($3, $1, 'CF3000', 'Share Capital',       'equity',    'equity',            'credit', true),
         ($4, $1, 'CF4000', 'Sales',               'revenue',   'sales',             'credit', true),
         ($5, $1, 'CF4100', 'Other Income',        'revenue',   'other_income',      'credit', true),
         ($6, $1, 'CF5000', 'Operating Expenses',  'expense',   'operating_expense', 'debit',  true),
         ($7, $1, 'CF2100', 'Payroll Liability',   'liability', 'payroll_liability', 'credit', true),
         ($8, $1, 'CF1500', 'Motor Vehicles',      'asset',     'fixed_assets',      'debit',  true),
         ($9, $1, 'CF1010', 'Petty Cash',          'asset',     'petty_cash',        'debit',  true)
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY, GL_BANK, GL_EQUITY, GL_SALES, GL_OTHER_INCOME, GL_OPEX, GL_PAYROLL, GL_VEHICLE, GL_PETTY],
    );

    // Opening balance, dated before the period so it lands in opening cash.
    await postEntry(admin, 'cf-open', '2025-12-31', [
      { account: GL_BANK, debit: OPENING, credit: 0 },
      { account: GL_EQUITY, debit: 0, credit: OPENING },
    ], { matchBankLeg: false });

    // JE0b: dated on the period's first day — movement, not opening cash.
    await postEntry(admin, 'cf-je0b', '2026-01-01', [
      { account: GL_BANK, debit: 200, credit: 0 },
      { account: GL_SALES, debit: 0, credit: 200 },
    ]);

    // JE1: two revenue contra lines against one bank leg — the fan-out case.
    await postEntry(admin, 'cf-je1', '2026-03-05', [
      { account: GL_BANK, debit: 1000, credit: 0 },
      { account: GL_SALES, debit: 0, credit: 600 },
      { account: GL_OTHER_INCOME, debit: 0, credit: 400 },
    ]);

    // JE2: single operating-expense contra.
    await postEntry(admin, 'cf-je2', '2026-04-10', [
      { account: GL_BANK, debit: 0, credit: 300 },
      { account: GL_OPEX, debit: 300, credit: 0 },
    ]);

    // JE3: one bank leg apportioned across two DIFFERENT groups.
    await postEntry(admin, 'cf-je3', '2026-05-01', [
      { account: GL_BANK, debit: 0, credit: 500 },
      { account: GL_OPEX, debit: 200, credit: 0 },
      { account: GL_PAYROLL, debit: 300, credit: 0 },
    ]);

    // JE4: investing outflow.
    await postEntry(admin, 'cf-je4', '2026-06-15', [
      { account: GL_BANK, debit: 0, credit: 900 },
      { account: GL_VEHICLE, debit: 900, credit: 0 },
    ]);

    // JE5: one entry carrying BOTH a classifiable contra and a cash contra.
    await postEntry(admin, 'cf-je5', '2026-07-20', [
      { account: GL_BANK, debit: 0, credit: 1000 },
      { account: GL_OPEX, debit: 600, credit: 0 },
      { account: GL_PETTY, debit: 400, credit: 0 },
    ]);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  it('opening cash is the bank balance before the period', async () => {
    const report = await getCashFlowDirect(COMPANY, PERIOD_START, PERIOD_END);
    expect(report.openingCash).toBeCloseTo(OPENING, 2);
  });

  it('closing cash equals the general ledger cash balance at period end', async () => {
    const report = await getCashFlowDirect(COMPANY, PERIOD_START, PERIOD_END);

    // Derived independently of the service, straight from the ledger.
    const { rows } = await admin.query(
      `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric AS balance
         FROM gl_journal_lines jl
         JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        WHERE jl.gl_account_id = ANY($1)
          AND jl.company_id    = $2
          AND je.status        = 'posted'
          AND je.entry_date   <= $3`,
      [[GL_BANK, GL_PETTY], COMPANY, PERIOD_END],
    );
    const ledgerCashBalance = Number(rows[0].balance);

    expect(ledgerCashBalance).toBeCloseTo(CLOSING, 2);
    expect(report.closingCash).toBeCloseTo(ledgerCashBalance, 2);
  });

  it('the classified groups sum to the net bank movement', async () => {
    const report = await getCashFlowDirect(COMPANY, PERIOD_START, PERIOD_END);

    const summed =
      report.operatingTotal + report.investingTotal + report.financingTotal;

    expect(report.netChange).toBeCloseTo(NET_MOVEMENT, 2);
    expect(summed).toBeCloseTo(NET_MOVEMENT, 2);
  });

  it('counts a bank leg once even when the entry has several contra lines', async () => {
    const report = await getCashFlowDirect(COMPANY, PERIOD_START, PERIOD_END);

    const customers = report.operatingItems.find(
      (i) => i.cashGroup === 'cash_received_from_customers',
    );
    // The fan-out reported 2000 here — the 1000 bank leg once per revenue contra.
    expect(customers?.amount).toBeCloseTo(EXPECTED_CUSTOMERS, 2);
  });

  it('apportions one bank leg across contra lines in different groups', async () => {
    const report = await getCashFlowDirect(COMPANY, PERIOD_START, PERIOD_END);

    const suppliers = report.operatingItems.find(
      (i) => i.cashGroup === 'cash_paid_to_suppliers',
    );
    const employees = report.operatingItems.find(
      (i) => i.cashGroup === 'cash_paid_to_employees',
    );

    // JE3's 500 must split 200/300, not land as 500 against each group.
    expect(suppliers?.amount).toBeCloseTo(EXPECTED_SUPPLIERS, 2);
    expect(employees?.amount).toBeCloseTo(EXPECTED_EMPLOYEES, 2);
  });

  it('classifies real chart-of-accounts subtype spellings, not just the canonical tokens', async () => {
    const report = await getCashFlowDirect(COMPANY, PERIOD_START, PERIOD_END);

    // Every fixture account uses a spelling the previous CASE did not match
    // (`sales`, `other_income`, `operating_expense`, `payroll_liability`,
    // `fixed_assets`). If classification regresses, these land in
    // `other_operating` instead.
    const other = report.operatingItems.find((i) => i.cashGroup === 'other_operating');
    expect(other?.amount ?? 0).toBeCloseTo(0, 2);

    expect(report.investingTotal).toBeCloseTo(EXPECTED_INVESTING, 2);
  });
});

// ── fixture helpers ──────────────────────────────────────────────────────────

interface Leg {
  account: string;
  debit: number;
  credit: number;
}

/**
 * Insert a posted journal entry and, unless told otherwise, match its bank leg
 * to a bank_transactions row — which is what brings the entry into the direct
 * cash flow's matched-allocation query.
 */
async function postEntry(
  admin: Pool,
  entryNumber: string,
  entryDate: string,
  legs: Leg[],
  opts: { matchBankLeg?: boolean } = {},
): Promise<void> {
  const { matchBankLeg = true } = opts;

  const { rows } = await admin.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by)
     VALUES ($1, $2, $3, 'cash flow fixture', 'posted', $4)
     RETURNING id`,
    [COMPANY, entryNumber, entryDate, COMPANY],
  );
  const entryId = rows[0].id as string;

  for (const leg of legs) {
    const inserted = await admin.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [COMPANY, entryId, leg.account, leg.debit, leg.credit],
    );

    if ((leg.account === GL_BANK || leg.account === GL_PETTY) && matchBankLeg) {
      await admin.query(
        `INSERT INTO bank_transactions
           (company_id, bank_account_id, transaction_date, amount, description, matched_journal_line_id)
         VALUES ($1, $2, $3, $4, 'cash flow fixture', $5)`,
        [COMPANY, GL_BANK, entryDate, leg.debit - leg.credit, inserted.rows[0].id],
      );
    }
  }
}

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM bank_transactions WHERE company_id = $1', [COMPANY]);
  await admin.query(
    `DELETE FROM gl_journal_lines WHERE company_id = $1`,
    [COMPANY],
  );
  await admin.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
}
