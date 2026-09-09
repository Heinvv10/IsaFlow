/**
 * K-017 — RED. The bank-rule sweep reproduces K-016's net/gross split with no
 * human in the loop. `buildAutoCreateLines` debits Accounts Payable with
 * `netAmount` for a supplier rule (bankRulesMatchingHelpers.ts:132 on
 * ebeac9ca) while the bank leg and the supplier payment document
 * `autoPostRuleLine` creates both carry the gross
 * (bankRuleAutoPostLine.ts:245).
 *
 * Nothing coerces the code away on this path: `resolveRuleVatCode` returns the
 * rule's `vat_code` verbatim for every alloc type that is not 'account'
 * (gl/ruleVatResolution.ts:57), so the s17(2)(a) denial and non-supply guards
 * that protect the account arm never run for a supplier or customer rule.
 *
 * One rule, one sweep, and every line the rule matches carries the error —
 * which is what separates this from K-016. This test drives the real entry
 * point, `applyRules`, over two matching statement lines.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { applyRules } from '@/modules/accounting/services/bank/bankRulesMatchingService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K017-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let supplier: string;
let bankAccount: string;

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

describeIfDb('K-017 bank rule sweep splits a supplier payment net/gross', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await sql`
      INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${COMPANY}::UUID, ${'K017 ' + TAG}, ${TAG}, NOW())`;
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
    await acct('6000', 'K017 Expense', 'expense', 'default_expense', 'debit');
    await acct('2100', 'K017 AP', 'liability', 'payable', 'credit');
    await acct('1140', 'K017 VAT Input', 'asset', 'vat_input', 'debit');
    bankAccount = await acct('1000', 'K017 Bank', 'asset', 'bank', 'debit');

    // The sweep pre-flights the period and skips when none covers the date; it
    // does not auto-create one the way allocateTransaction does.
    await sql`
      INSERT INTO fiscal_periods
        (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${COMPANY}::UUID, 'K017 Jun 2026', 6, 2026, '2026-06-01', '2026-06-30', 'open')`;

    for (const n of [1, 2]) {
      await sql`
        INSERT INTO bank_transactions
          (company_id, bank_account_id, transaction_date, amount, description, status)
        VALUES (${COMPANY}::UUID, ${bankAccount}::UUID, '2026-06-30', -115,
                ${`ACME PAYMENT ${TAG} ${n}`}, 'imported')`;
    }

    await sql`
      INSERT INTO bank_categorisation_rules
        (company_id, rule_name, match_field, match_type, match_pattern,
         supplier_id, vat_code, auto_create_entry, is_active, priority)
      VALUES (${COMPANY}::UUID, ${'ACME rule ' + TAG}, 'description', 'contains',
              ${`ACME PAYMENT ${TAG}`}, ${supplier}::UUID, 'standard', true, true, 1)`;
  });

  afterAll(async () => {
    await sql`DELETE FROM supplier_payment_allocations WHERE payment_id IN (
      SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM bank_categorisation_rules WHERE company_id = ${COMPANY}::UUID`;
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

  it('relieves the payable by what the sweep actually paid, on every line', async () => {
    const result = await inTx(() => applyRules(COMPANY, bankAccount, USER));
    expect(result.entries.length).toBe(2);

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

    // R230 of cash left the bank on two lines.
    expect((await leg('1000')).cr).toBeCloseTo(230, 2);

    // The payment documents the sweep created settle the gross.
    const doc = (await sql`
      SELECT COALESCE(SUM(total_amount), 0)::float8 AS paid
      FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`) as { paid: number }[];
    expect(doc[0]!.paid).toBeCloseTo(230, 2);

    // THE CLAIM: the control account must move by the same R230, and no input
    // tax is claimable on settling a bill that already claimed it.
    expect((await leg('2100')).dr).toBeCloseTo(230, 2);
    expect((await leg('1140')).dr).toBeCloseTo(0, 2);
  }, 60000);
});
