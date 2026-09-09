/**
 * K-016 — RED. A VAT code on a SUPPLIER (or customer) bank allocation splits
 * the line 15% exclusive and moves the AP control account by the NET
 * (bankAllocationService.ts:242 on ebeac9ca — `debit: netAmount`), while the
 * bank leg and the supplier payment document this same call creates both carry
 * the GROSS (`amount: totalAmount`, line 458).
 *
 * The `account` arm one branch further down is the case the net split is FOR:
 * an expense with no invoice behind it, where the VAT has not been claimed yet.
 * A supplier payment is the opposite — the bill already credited AP with the
 * gross and already claimed the input tax at posting. Splitting it again
 * relieves AP by R100 for R115 of cash, strands the R15 on the control account
 * forever, and claims the input tax a second time.
 *
 * Reachable unattended too: `body.vatCode` is passed straight through by
 * pages/api/accounting/bank-transactions-action.ts:118 with
 * `allocationType: 'supplier'`, and `resolveRuleVatCode` returns the requested
 * code unchanged for every alloc type that is not 'account'
 * (gl/ruleVatResolution.ts:57) — that is K-017.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K016-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let supplier: string;
let bankAccount: string;
let bankTx: string;

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

describeIfDb('K-016 VAT code on a supplier bank allocation relieves AP net', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await sql`
      INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${COMPANY}::UUID, ${'K016 ' + TAG}, ${TAG}, NOW())`;
    supplier = ((await sql`
      INSERT INTO suppliers (name, company_id) VALUES (${'ACME ' + TAG}, ${COMPANY}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    const acct = async (code: string, name: string, type: string, subtype: string, normal: string) => {
      const rows = (await sql`
        INSERT INTO gl_accounts
          (company_id, account_code, account_name, account_type, account_subtype,
           normal_balance, is_active, is_system_account)
        VALUES (${COMPANY}::UUID, ${code}, ${name}, ${type}, ${subtype}, ${normal}, true, true)
        RETURNING id`) as { id: string }[];
      return rows[0]!.id;
    };
    await acct('6000', 'K016 Expense', 'expense', 'default_expense', 'debit');
    await acct('2100', 'K016 AP', 'liability', 'payable', 'credit');
    await acct('1140', 'K016 VAT Input', 'asset', 'vat_input', 'debit');
    bankAccount = await acct('1000', 'K016 Bank', 'asset', 'bank', 'debit');
    bankTx = ((await sql`
      INSERT INTO bank_transactions
        (company_id, bank_account_id, transaction_date, amount, description, status)
      VALUES (${COMPANY}::UUID, ${bankAccount}::UUID, '2026-06-30', -115,
              ${'EFT ACME ' + TAG}, 'imported')
      RETURNING id`) as { id: string }[])[0]!.id;
  });

  afterAll(async () => {
    await sql`DELETE FROM supplier_payment_allocations WHERE payment_id IN (
      SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM bank_transactions WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (
      SELECT id FROM gl_accounts WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await pool.end();
  }, 60000);

  it('moves the payable by the same amount the cash and the document carry', async () => {
    await inTx(() => allocateTransaction(
      COMPANY, bankTx, null, USER, undefined, 'supplier', supplier, 'standard',
    ));

    const leg = async (code: string) => {
      const rows = (await sql`
        SELECT COALESCE(SUM(jl.debit), 0)::float8 AS dr,
               COALESCE(SUM(jl.credit), 0)::float8 AS cr
        FROM gl_journal_lines jl
        JOIN gl_accounts a ON a.id = jl.gl_account_id
        WHERE jl.company_id = ${COMPANY}::UUID AND a.account_code = ${code}
      `) as { dr: number; cr: number }[];
      return rows[0]!;
    };

    const bank = await leg('1000');
    const ap = await leg('2100');
    const vat = await leg('1140');

    // The cash that left the bank.
    expect(bank.cr).toBeCloseTo(115, 2);

    // The supplier payment document created by the same call settles the GROSS.
    const doc = (await sql`
      SELECT COALESCE(SUM(total_amount), 0)::float8 AS paid
      FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`) as { paid: number }[];
    expect(doc[0]!.paid).toBeCloseTo(115, 2);

    // THE CLAIM: the control account must move by that same gross amount, and
    // the input tax must not be claimed a second time on a payment.
    expect(ap.dr).toBeCloseTo(115, 2);
    expect(vat.dr).toBeCloseTo(0, 2);
  }, 60000);
});
