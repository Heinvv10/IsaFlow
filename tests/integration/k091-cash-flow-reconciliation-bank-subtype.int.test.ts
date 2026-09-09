// tests/integration/k091-cash-flow-reconciliation-bank-subtype.int.test.ts
//
// K-091. `cashFlowReconciliationService` defines "cash" as the SQL literal
// `account_subtype = 'bank'`, in BOTH `fetchIndirectClosingCash` and
// `fetchBankBalance`. The direct statement it reconciles against
// (`cashFlowDirectService` -> `getCashBalance`) defines cash as CASH_SUBTYPES,
// which spans the `bank` AND `cash` canonical tokens and every raw spelling
// that maps to them (`bank_account`, `petty_cash`, `cash_on_hand`, ...).
//
// The two definitions therefore disagree on any company that holds a petty
// cash balance, or whose bank account is spelled `bank_account` rather than
// `bank`. The reconciliation reports a variance equal to that balance and
// `isReconciled` goes false, on books that are correct.
//
// This test seeds a company whose ONLY discrepancy is a petty-cash balance,
// and asserts the reconciliation ties. It fails today for exactly that reason.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getCashFlowReconciliation } from '@/modules/accounting/services/afs/cashFlowReconciliationService';

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = randomUUID();
const GL_BANK = randomUUID();
const GL_PETTY = randomUUID();
const GL_EQUITY = randomUUID();
const GL_SALES = randomUUID();
const GL_OPEX = randomUUID();
const GL_CREDIT_CARD = randomUUID();

// A second tenant, seeded with its own bank balance, to prove the widened
// predicate stays scoped by company_id.
const OTHER_COMPANY = randomUUID();
const OTHER_GL_BANK = randomUUID();
const OTHER_GL_EQUITY = randomUUID();

const PERIOD_START = '2026-01-01';
const PERIOD_END = '2026-12-31';

const OPENING_BANK = 5000;   // posted 2025-12-31
const PETTY_FLOAT = 400;     // bank -> petty cash, inside the period
const SALES_RECEIPT = 1000;  // into bank
const PETTY_SPEND = 150;     // petty cash -> operating expense
const CARD_SPEND = 900;      // credit card -> operating expense (NOT cash)
const OTHER_CASH = 7777;     // the second tenant's bank balance

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('K-091 cash flow reconciliation must not hardcode the bank subtype', () => {
  let admin: Pool;

  beforeAll(async () => {
    // Local guard: this suite runs against the disposable remediation schema
    // fixture, which the shared assertNotProductionDb allow-list does not name.
    // Refuse the production database by name either way.
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'K091 Reconciliation Fixture', true)`,
      [COMPANY],
    );

    await admin.query(
      `INSERT INTO gl_accounts
         (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES
         ($2, $1, 'K0911000', 'Bank - Current',     'asset',   'bank',              'debit',  true),
         ($3, $1, 'K0911010', 'Petty Cash',         'asset',   'petty_cash',        'debit',  true),
         ($4, $1, 'K0913000', 'Share Capital',      'equity',  'equity',            'credit', true),
         ($5, $1, 'K0914000', 'Sales',              'revenue', 'sales',             'credit', true),
         ($6, $1, 'K0915000', 'Operating Expenses', 'expense', 'operating_expense', 'debit',  true),
         -- A credit card. Its subtype is a raw spelling that canonicalises
         -- to bank, so a predicate on subtype alone would sum this liability
         -- into cash. account_type is what keeps it out.
         ($7, $1, 'K0912000', 'Credit Card',        'liability', 'bank_account',    'credit', true)`,
      [COMPANY, GL_BANK, GL_PETTY, GL_EQUITY, GL_SALES, GL_OPEX, GL_CREDIT_CARD],
    );

    await postEntry(admin, 'k091-open', '2025-12-31', [
      { account: GL_BANK, debit: OPENING_BANK, credit: 0 },
      { account: GL_EQUITY, debit: 0, credit: OPENING_BANK },
    ], { matchBankLeg: false });

    await postEntry(admin, 'k091-sale', '2026-03-01', [
      { account: GL_BANK, debit: SALES_RECEIPT, credit: 0 },
      { account: GL_SALES, debit: 0, credit: SALES_RECEIPT },
    ]);

    // Bank funds the petty cash float. Cash does not leave the entity, so this
    // is not a cash flow — but it DOES move balance out of subtype `bank` and
    // into subtype `petty_cash`.
    await postEntry(admin, 'k091-float', '2026-04-01', [
      { account: GL_PETTY, debit: PETTY_FLOAT, credit: 0 },
      { account: GL_BANK, debit: 0, credit: PETTY_FLOAT },
    ]);

    // Petty cash buys stationery. A real operating outflow, from a cash
    // account the reconciliation cannot see.
    await postEntry(admin, 'k091-petty-spend', '2026-05-01', [
      { account: GL_OPEX, debit: PETTY_SPEND, credit: 0 },
      { account: GL_PETTY, debit: 0, credit: PETTY_SPEND },
    ]);

    // Stationery bought on the credit card. Neither leg is cash.
    await postEntry(admin, 'k091-card-spend', '2026-06-01', [
      { account: GL_OPEX, debit: CARD_SPEND, credit: 0 },
      { account: GL_CREDIT_CARD, debit: 0, credit: CARD_SPEND },
    ]);

    // Second tenant, same period, its own bank balance.
    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'K091 Other Tenant', true)`,
      [OTHER_COMPANY],
    );
    await admin.query(
      `INSERT INTO gl_accounts
         (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES
         ($2, $1, 'K0911000', 'Bank - Current', 'asset',  'bank',   'debit',  true),
         ($3, $1, 'K0913000', 'Share Capital',  'equity', 'equity', 'credit', true)`,
      [OTHER_COMPANY, OTHER_GL_BANK, OTHER_GL_EQUITY],
    );
    const other = await admin.query(
      `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by)
       VALUES ($1, 'k091-other-open', '2026-02-01', 'k091 fixture', 'posted', $1) RETURNING id`,
      [OTHER_COMPANY],
    );
    await admin.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
       VALUES ($1, $2, $3, $4, 0), ($1, $2, $5, 0, $4)`,
      [OTHER_COMPANY, other.rows[0].id, OTHER_GL_BANK, OTHER_CASH, OTHER_GL_EQUITY],
    );
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  it('ties when the company holds petty cash alongside its bank account', async () => {
    // Closing cash and cash equivalents, straight from the ledger.
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
    const ledgerCash = Number(rows[0].balance); // 5000 + 1000 - 150 = 5850

    const recon = await getCashFlowReconciliation(COMPANY, PERIOD_START, PERIOD_END);

    // The direct statement's closing cash is the ledger cash balance.
    expect(recon.directClosing).toBeCloseTo(ledgerCash, 2);

    // The reconciliation's own two figures must agree with it. Both are
    // computed with `account_subtype = 'bank'`, so today they come back as
    // 5600 — short by the R250 sitting in petty cash.
    expect(recon.bankBalance).toBeCloseTo(ledgerCash, 2);
    expect(recon.indirectClosing).toBeCloseTo(ledgerCash, 2);

    // The books are correct, so the statement must reconcile.
    expect(recon.variance).toBeCloseTo(0, 2);
    expect(recon.isReconciled).toBe(true);
  });

  it('excludes a credit card whose subtype canonicalises to bank', async () => {
    const recon = await getCashFlowReconciliation(COMPANY, PERIOD_START, PERIOD_END);

    // Cash is 5850. The card carries a R900 credit balance; widening the
    // subtype predicate without the `account_type = 'asset'` half would pull
    // it in and report 4950.
    expect(recon.bankBalance).toBeCloseTo(5850, 2);
    expect(recon.indirectClosing).toBeCloseTo(5850, 2);
  });

  it('does not read the other tenant\'s cash', async () => {
    const mine = await getCashFlowReconciliation(COMPANY, PERIOD_START, PERIOD_END);
    expect(mine.bankBalance).toBeCloseTo(5850, 2);

    const theirs = await getCashFlowReconciliation(OTHER_COMPANY, PERIOD_START, PERIOD_END);
    expect(theirs.bankBalance).toBeCloseTo(OTHER_CASH, 2);
    expect(theirs.indirectClosing).toBeCloseTo(OTHER_CASH, 2);
  });
});

interface Leg { account: string; debit: number; credit: number }

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
     VALUES ($1, $2, $3, 'k091 fixture', 'posted', $4)
     RETURNING id`,
    [COMPANY, entryNumber, entryDate, COMPANY],
  );
  const entryId = rows[0].id as string;

  for (const leg of legs) {
    const inserted = await admin.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [COMPANY, entryId, leg.account, leg.debit, leg.credit],
    );

    if ((leg.account === GL_BANK || leg.account === GL_PETTY) && matchBankLeg) {
      await admin.query(
        `INSERT INTO bank_transactions
           (company_id, bank_account_id, transaction_date, amount, description, matched_journal_line_id)
         VALUES ($1, $2, $3, $4, 'k091 fixture', $5)`,
        [COMPANY, GL_BANK, entryDate, leg.debit - leg.credit, inserted.rows[0].id],
      );
    }
  }
}

async function cleanup(admin: Pool): Promise<void> {
  const ids = [COMPANY, OTHER_COMPANY];
  await admin.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [ids]);
  await admin.query('DELETE FROM gl_journal_lines WHERE company_id = ANY($1)', [ids]);
  await admin.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)', [ids]);
  await admin.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [ids]);
  await admin.query('DELETE FROM companies WHERE id = ANY($1)', [ids]);
}
