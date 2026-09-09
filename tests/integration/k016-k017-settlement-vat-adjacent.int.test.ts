/**
 * Adjacent cases for the K-016 / K-017 fix — the boundaries of
 * `isControlAccountSettlement`.
 *
 * The fix must drop the VAT split on the two CONTROL-ACCOUNT arms and on
 * nothing else. Each case here would go green on a fix that was too wide (an
 * unconditional `hasVat = false`) or too narrow (only the `isSpent` supplier
 * branch), so together they pin the predicate from both sides:
 *
 *   1. attended `account` arm — MUST still split 15% exclusive (control).
 *   2. unattended `account` rule — same, through the sweep (control).
 *   3. customer RECEIPT — the mirror arm, deposit direction, gross AR.
 *   4. supplier REFUND — deposit against a supplier, gross AP.
 *   5. wrong tenant — the allocation must not post at all.
 *
 * Every case asserts the journal balances as well as the leg amounts: a
 * settlement that moves the control account without moving the bank by the
 * same figure is the defect wearing a different mask.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { applyRules } from '@/modules/accounting/services/bank/bankRulesMatchingService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K016A-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let supplier: string;
let customer: string;
let bankAccount: string;
let expenseAccount: string;

function run<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
}

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  await c.query('BEGIN');
  try {
    const out = await run(c, fn);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/** Debit and credit totals for one account code, in this company only. */
async function leg(code: string): Promise<{ dr: number; cr: number }> {
  const rows = (await sql`
    SELECT COALESCE(SUM(jl.debit), 0)::float8 AS dr,
           COALESCE(SUM(jl.credit), 0)::float8 AS cr
    FROM gl_journal_lines jl
    JOIN gl_accounts a ON a.id = jl.gl_account_id
    WHERE jl.company_id = ${COMPANY}::UUID AND a.account_code = ${code}
  `) as { dr: number; cr: number }[];
  return rows[0]!;
}

/** Every journal this company posted must balance. */
async function assertAllBalanced(): Promise<void> {
  const rows = (await sql`
    SELECT je.id, SUM(jl.debit)::float8 AS dr, SUM(jl.credit)::float8 AS cr
    FROM gl_journal_entries je
    JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
    WHERE je.company_id = ${COMPANY}::UUID
    GROUP BY je.id
  `) as { id: string; dr: number; cr: number }[];
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) expect(r.dr).toBeCloseTo(r.cr, 2);
}

async function acct(
  code: string, name: string, type: string, subtype: string, normal: string,
): Promise<string> {
  const rows = (await sql`
    INSERT INTO gl_accounts
      (company_id, account_code, account_name, account_type, account_subtype,
       normal_balance, is_active, is_system_account)
    VALUES (${COMPANY}::UUID, ${code}, ${name}, ${type}, ${subtype}, ${normal}, true, true)
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

async function newTx(amount: number, description: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO bank_transactions
      (company_id, bank_account_id, transaction_date, amount, description, status)
    VALUES (${COMPANY}::UUID, ${bankAccount}::UUID, '2026-06-30', ${amount},
            ${description}, 'imported')
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

describeIfDb('K-016/K-017 settlement VAT — adjacent cases', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    for (const id of [COMPANY, OTHER_COMPANY]) {
      await sql`
        INSERT INTO companies (id, name, registration_number, created_at)
        VALUES (${id}::UUID, ${'K016A ' + TAG + ' ' + id.slice(0, 8)},
                ${TAG + id.slice(0, 8)}, NOW())`;
    }
    supplier = ((await sql`
      INSERT INTO suppliers (name, company_id) VALUES (${'ACME ' + TAG}, ${COMPANY}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    customer = ((await sql`
      INSERT INTO customers (name, company_id) VALUES (${'CUST ' + TAG}, ${COMPANY}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    expenseAccount = await acct('6000', 'K016A Expense', 'expense', 'default_expense', 'debit');
    await acct('2100', 'K016A AP', 'liability', 'payable', 'credit');
    await acct('1100', 'K016A AR', 'asset', 'receivable', 'debit');
    await acct('1140', 'K016A VAT Input', 'asset', 'vat_input', 'debit');
    await acct('2120', 'K016A VAT Output', 'liability', 'vat_output', 'credit');
    bankAccount = await acct('1000', 'K016A Bank', 'asset', 'bank', 'debit');

    // The sweep pre-flights the period and skips when none covers the date.
    await sql`
      INSERT INTO fiscal_periods
        (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${COMPANY}::UUID, 'K016A Jun 2026', 6, 2026, '2026-06-01', '2026-06-30', 'open')`;
  });

  afterAll(async () => {
    await sql`DELETE FROM supplier_payment_allocations WHERE payment_id IN (
      SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM bank_categorisation_rules WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM bank_transactions WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (
      SELECT id FROM gl_accounts WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id IN (${COMPANY}::UUID, ${OTHER_COMPANY}::UUID)`;
    await pool.end();
  }, 60000);

  it('still splits an account allocation 15% exclusive — the attended control', async () => {
    const tx = await newTx(-115, `SHOP ${TAG} A`);
    await inTx(() => allocateTransaction(
      COMPANY, tx, expenseAccount, USER, undefined, 'account', undefined, 'standard',
    ));

    // No document exists behind this cash, so the VAT has NOT been claimed yet
    // and the split is the whole point of the arm.
    expect((await leg('6000')).dr).toBeCloseTo(100, 2);
    expect((await leg('1140')).dr).toBeCloseTo(15, 2);
    expect((await leg('1000')).cr).toBeCloseTo(115, 2);
    await assertAllBalanced();
  }, 60000);

  it('still splits an account RULE 15% exclusive — the unattended control', async () => {
    await newTx(-230, `SHOPRULE ${TAG} B`);
    await sql`
      INSERT INTO bank_categorisation_rules
        (company_id, rule_name, match_field, match_type, match_pattern,
         gl_account_id, vat_code, auto_create_entry, is_active, priority)
      VALUES (${COMPANY}::UUID, ${'acct rule ' + TAG}, 'description', 'contains',
              ${`SHOPRULE ${TAG}`}, ${expenseAccount}::UUID, 'standard', true, true, 1)`;

    const before = await leg('1140');
    const result = await inTx(() => applyRules(COMPANY, bankAccount, USER));
    expect(result.entries.length).toBe(1);

    // 230 / 1.15 = 200.00 net, 30.00 input tax — unchanged by the fix.
    expect((await leg('1140')).dr - before.dr).toBeCloseTo(30, 2);
    expect((await leg('6000')).dr).toBeCloseTo(300, 2); // 100 from the case above + 200
    await assertAllBalanced();
  }, 60000);

  // The transfer guard, end to end. A transfer RULE has nowhere to say it is
  // one — `bank_categorisation_rules` has no transfer column — so it stores the
  // counterparty BANK in `gl_account_id` and reaches the sweep as an ordinary
  // `account` line, the one arm that still splits. The name-based non-supply
  // guard cannot catch it, which is why this is judged on `account_subtype`
  // against a real `gl_accounts` row rather than in a mock.
  it('sweeps a transfer rule gross, touching no VAT account', async () => {
    const contraBank = await acct('1010', 'K016A FNB Cheque', 'asset', 'bank', 'debit');
    await newTx(-345, `INTERACCOUNT ${TAG} F`);
    await sql`
      INSERT INTO bank_categorisation_rules
        (company_id, rule_name, match_field, match_type, match_pattern,
         gl_account_id, vat_code, auto_create_entry, is_active, priority)
      VALUES (${COMPANY}::UUID, ${'transfer rule ' + TAG}, 'description', 'contains',
              ${`INTERACCOUNT ${TAG}`}, ${contraBank}::UUID, 'standard', true, true, 1)`;

    const vatBefore = await leg('1140');
    const result = await inTx(() => applyRules(COMPANY, bankAccount, USER));
    expect(result.entries.length).toBe(1);

    // Two lines, gross, and the counterparty bank carries the whole R345.
    expect((await leg('1010')).dr).toBeCloseTo(345, 2);
    expect((await leg('1140')).dr - vatBefore.dr).toBeCloseTo(0, 2);
    const lines = (await sql`
      SELECT COUNT(*)::int AS n FROM gl_journal_lines
      WHERE company_id = ${COMPANY}::UUID
        AND journal_entry_id = ${result.entries[0]!.journalEntryId}::UUID`) as { n: number }[];
    expect(lines[0]!.n).toBe(2);
    await assertAllBalanced();
  }, 60000);

  it('settles a customer RECEIPT gross with no output tax', async () => {
    const tx = await newTx(230, `CUSTOMER RECEIPT ${TAG} C`);
    await inTx(() => allocateTransaction(
      COMPANY, tx, null, USER, undefined, 'customer', customer, 'standard',
    ));

    // The invoice raised the output tax when it was posted. The receipt only
    // moves AR and the bank, by the same R230.
    expect((await leg('1100')).cr).toBeCloseTo(230, 2);
    expect((await leg('2120')).cr).toBeCloseTo(0, 2);
    const doc = (await sql`
      SELECT COALESCE(SUM(total_amount), 0)::float8 AS paid
      FROM customer_payments WHERE company_id = ${COMPANY}::UUID`) as { paid: number }[];
    expect(doc[0]!.paid).toBeCloseTo(230, 2);
    await assertAllBalanced();
  }, 60000);

  it('settles a supplier REFUND gross with no input tax reversal', async () => {
    const before = await leg('1140');
    const tx = await newTx(115, `ACME REFUND ${TAG} D`);
    await inTx(() => allocateTransaction(
      COMPANY, tx, null, USER, undefined, 'supplier', supplier, 'standard',
    ));

    // The deposit branch is a separate code path from the payment branch and
    // carried its own `netAmount`. The refund credits AP by the full R115 and
    // touches vat_input in neither direction.
    expect((await leg('2100')).cr).toBeCloseTo(115, 2);
    const after = await leg('1140');
    expect(after.dr - before.dr).toBeCloseTo(0, 2);
    expect(after.cr - before.cr).toBeCloseTo(0, 2);
    await assertAllBalanced();
  }, 60000);

  it('posts nothing when the transaction belongs to another tenant', async () => {
    const tx = await newTx(-115, `CROSS TENANT ${TAG} E`);
    const bankBefore = await leg('1000');

    await expect(inTx(() => allocateTransaction(
      OTHER_COMPANY, tx, null, USER, undefined, 'supplier', supplier, 'standard',
    ))).rejects.toThrow(/not found/i);

    // Untouched: still importable, and no journal moved in either company.
    const rows = (await sql`
      SELECT status FROM bank_transactions
      WHERE id = ${tx}::UUID AND company_id = ${COMPANY}::UUID`) as { status: string }[];
    expect(rows[0]!.status).toBe('imported');
    expect((await leg('1000')).cr).toBeCloseTo(bankBefore.cr, 2);
    const other = (await sql`
      SELECT COUNT(*)::int AS n FROM gl_journal_entries
      WHERE company_id = ${OTHER_COMPANY}::UUID`) as { n: number }[];
    expect(other[0]!.n).toBe(0);
  }, 60000);
});
