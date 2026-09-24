/**
 * The fixture the L1 FIFO tests are written against: one company, one supplier,
 * one customer, a bank account, an open fiscal year and whatever bills,
 * invoices and bank lines a test asks for.
 *
 * Shared because the two L1 files assert different halves of ONE behaviour —
 * what a FIFO allocation writes, and what its reversal takes back — and a
 * second copy of the seed would let them drift into testing two different
 * ledgers.
 */
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';

export interface Fixture {
  pool: Pool;
  companyId: string;
  userId: string;
  supplierId: string;
  customerId: string;
  bankAccountId: string;
  tag: string;
}

/** Runs `fn` with an ALS context bound to `client`, as every service expects. */
export function runOn<T>(
  fx: Fixture, client: PoolClient, fn: () => Promise<T>,
): Promise<T> {
  return als.run(
    { client, userId: fx.userId, companyId: fx.companyId, claims: {} } as never,
    fn,
  );
}

/** One committed transaction on its own connection, the shape a request has. */
export async function inTx<T>(fx: Fixture, fn: () => Promise<T>): Promise<T> {
  const c = await fx.pool.connect();
  await c.query('BEGIN');
  try {
    const out = await runOn(fx, c, fn);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

export async function seedFixture(prefix: string, databaseUrl: string): Promise<Fixture> {
  const companyId = randomUUID();
  const userId = randomUUID();
  const tag = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });

  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${companyId}::UUID, ${`${prefix} ${tag}`}, ${tag}, NOW())`;
  // No `users` row: the actor id is already uuid-shaped, so `resolveUserUuid`
  // returns it untouched and nothing here reads the table.
  const supplierId = ((await sql`
    INSERT INTO suppliers (name, company_id) VALUES (${`SUP ${tag}`}, ${companyId}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  const customerId = ((await sql`
    INSERT INTO customers (name, company_id) VALUES (${`CUS ${tag}`}, ${companyId}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;

  const acct = async (
    code: string, name: string, type: string, subtype: string, normal: string,
  ): Promise<string> => ((await sql`
    INSERT INTO gl_accounts
      (company_id, account_code, account_name, account_type, account_subtype,
       normal_balance, is_active, is_system_account)
    VALUES (${companyId}::UUID, ${code}, ${`${name} ${tag}`}, ${type}, ${subtype},
            ${normal}, true, true)
    RETURNING id`) as { id: string }[])[0]!.id;

  await acct('2100', 'AP', 'liability', 'payable', 'credit');
  await acct('1100', 'AR', 'asset', 'receivable', 'debit');
  await acct('6000', 'Expense', 'expense', 'default_expense', 'debit');
  await acct('1140', 'VAT Input', 'asset', 'vat_input', 'debit');
  await acct('2120', 'VAT Output', 'liability', 'vat_output', 'credit');
  const bankAccountId = await acct('1000', 'Bank', 'asset', 'bank', 'debit');

  // A journal must land in an OPEN fiscal period, and a bill must not be
  // marked paid off a journal that is in none at all
  // (shared/journalPeriodVisibility) — so the whole of 2026 is one open period.
  await sql`
    INSERT INTO fiscal_periods
      (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
    VALUES (${companyId}::UUID, ${`FY26 ${tag}`}, 1, 2026, '2026-01-01', '2026-12-31', 'open')`;

  return { pool, companyId, userId, supplierId, customerId, bankAccountId, tag };
}

/**
 * A supplier of this test's own.
 *
 * Every test in these files allocates cash with no bill named, which consumes
 * whatever that supplier still has open — including what an earlier test left
 * behind. One supplier per test is what keeps each assertion about its own
 * fixture rather than about the order the file happens to run in.
 */
export async function seedSupplier(fx: Fixture, name: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO suppliers (name, company_id)
    VALUES (${`${name} ${fx.tag}`}, ${fx.companyId}::UUID)
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

/** One open supplier bill. Returns its id. */
export async function seedBill(
  fx: Fixture,
  args: {
    number: string; date: string; total: number; status?: string; dueDate?: string;
    supplierId?: string;
  },
): Promise<string> {
  const rows = (await sql`
    INSERT INTO supplier_invoices
      (company_id, supplier_id, invoice_number, invoice_date, due_date,
       subtotal, total_amount, amount_paid, status, created_by)
    VALUES (${fx.companyId}::UUID, ${args.supplierId ?? fx.supplierId}::UUID,
            ${`${args.number}-${fx.tag}`},
            ${args.date}::DATE, ${args.dueDate ?? args.date}::DATE,
            ${args.total}, ${args.total}, 0, ${args.status ?? 'approved'}, ${fx.userId}::UUID)
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

/** One open customer invoice. Returns its id. */
export async function seedInvoice(
  fx: Fixture,
  args: { number: string; date: string; total: number; status?: string },
): Promise<string> {
  const rows = (await sql`
    INSERT INTO customer_invoices
      (company_id, customer_id, invoice_number, invoice_date, due_date,
       subtotal, total_amount, amount_paid, status, created_by)
    VALUES (${fx.companyId}::UUID, ${fx.customerId}::UUID, ${`${args.number}-${fx.tag}`},
            ${args.date}::DATE, ${args.date}::DATE,
            ${args.total}, ${args.total}, 0, ${args.status ?? 'sent'}, ${fx.userId}::UUID)
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

/**
 * One imported bank line. A NEGATIVE amount is money out.
 *
 * `id` is settable because `bulk_allocate_bank_transactions` posts its lines
 * SORTED BY TRANSACTION ID (so two overlapping batches cannot deadlock), and a
 * test about what a batch does in order cannot leave that order to
 * `gen_random_uuid()`.
 */
export async function seedBankTx(
  fx: Fixture,
  args: { date: string; amount: number; description: string; id?: string },
): Promise<string> {
  const rows = (await sql`
    INSERT INTO bank_transactions
      (id, company_id, bank_account_id, transaction_date, amount, description, status)
    VALUES (${args.id ?? randomUUID()}::UUID, ${fx.companyId}::UUID,
            ${fx.bankAccountId}::UUID, ${args.date}::DATE,
            ${args.amount}, ${`${args.description} ${fx.tag}`}, 'imported')
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

export interface BillState {
  status: string;
  amountPaid: number;
  paymentMatched: boolean;
}

export async function billState(fx: Fixture, billId: string): Promise<BillState> {
  const rows = (await sql`
    SELECT status, amount_paid, payment_matched FROM supplier_invoices
    WHERE id = ${billId}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  const r = rows[0]!;
  return {
    status: String(r.status),
    amountPaid: Number(r.amount_paid),
    paymentMatched: Boolean(r.payment_matched),
  };
}

/** Every company row this fixture created, in FK-safe order. */
export async function dropFixture(fx: Fixture): Promise<void> {
  const c = fx.companyId;
  await sql`DELETE FROM payment_allocations WHERE payment_id IN (
    SELECT id FROM supplier_payments WHERE company_id = ${c}::UUID)`;
  await sql`DELETE FROM customer_payment_allocations WHERE payment_id IN (
    SELECT id FROM customer_payments WHERE company_id = ${c}::UUID)`;
  await sql`DELETE FROM supplier_payments WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM customer_payments WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM supplier_invoices WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM customer_invoices WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM bank_allocation_batch_lines WHERE batch_id IN (
    SELECT id FROM bank_allocation_batches WHERE company_id = ${c}::UUID)`;
  await sql`DELETE FROM bank_allocation_batches WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM bank_transactions WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM gl_journal_lines WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM gl_journal_entries WHERE company_id = ${c}::UUID`;
  // After the bills and journals that may name them (source_document_id).
  await sql`DELETE FROM captured_documents WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM suppliers WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM customers WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (
    SELECT id FROM gl_accounts WHERE company_id = ${c}::UUID)`;
  await sql`DELETE FROM gl_accounts WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM fiscal_periods WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM companies WHERE id = ${c}::UUID`;
  await fx.pool.end();
}
