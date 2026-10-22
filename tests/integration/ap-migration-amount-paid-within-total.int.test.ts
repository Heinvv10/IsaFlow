/**
 * AP migration import: a supplier bill is never stored paid beyond its total.
 *
 * `importAPInvoices` wrote the file's `amountPaid` as given. The AR importer
 * refuses a row paid beyond its total (migration 899 backs that with a CHECK);
 * the AP one had no such guard and no CHECK, so a file row paid R100.04 on a
 * R100.00 bill stored `amount_paid > total_amount` and a negative `balance`
 * that every AP aggregate then summed. The excess is a credit the supplier
 * owes the company, not part of this bill.
 *
 * Compared in whole cents with no tolerance, as every other supplier-side
 * over-payment guard is (`billAllocatable.toCents`).
 *
 * Outcome-based: after the import, no bill of the company has
 * `amount_paid > total_amount`, and the row that would have broken that is
 * reported against its file row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { importAPInvoices } from '@/modules/accounting/services/ap/migrationApService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `APPAID-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let sessionId: string;

function run<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
}

const apRow = (number: string, amountPaid: number, totalAmount = 100) => ({
  invoiceNumber: `${TAG}-${number}`,
  supplierName: `ACME ${TAG}`,
  invoiceDate: '2026-06-30',
  dueDate: '2026-07-30',
  subtotal: totalAmount,
  taxAmount: 0,
  totalAmount,
  amountPaid,
}) as Parameters<typeof importAPInvoices>[2][number];

/** Every stored bill of this company paid beyond its total, as the importer left it. */
async function overPaid(c: PoolClient): Promise<{ invoice_number: string; amount_paid: string; total_amount: string }[]> {
  return (await c.query(
    `SELECT invoice_number, amount_paid, total_amount FROM supplier_invoices
      WHERE company_id = $1 AND amount_paid > total_amount`,
    [COMPANY],
  )).rows;
}

async function stored(c: PoolClient, number: string): Promise<{ amount_paid: string; status: string } | undefined> {
  return (await c.query(
    `SELECT amount_paid, status FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2`,
    [COMPANY, `${TAG}-${number}`],
  )).rows[0];
}

describeIfDb('AP migration import: amount paid within total', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await sql`
      INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${COMPANY}::UUID, ${'APPAID ' + TAG}, ${TAG}, NOW())`;
    await sql`INSERT INTO suppliers (name, company_id) VALUES (${'ACME ' + TAG}, ${COMPANY}::UUID)`;
    const acct = async (code: string, name: string, type: string, subtype: string, normal: string) => {
      await sql`
        INSERT INTO gl_accounts
          (company_id, account_code, account_name, account_type, account_subtype,
           normal_balance, is_active, is_system_account)
        VALUES (${COMPANY}::UUID, ${code}, ${name}, ${type}, ${subtype}, ${normal}, true, true)`;
    };
    await acct('2100', 'AP', 'liability', 'payable', 'credit');
    await acct('3100', 'Opening Balance Equity', 'equity', 'opening_balance_equity', 'credit');
    clearSystemAccountCache();
    sessionId = ((await sql`
      INSERT INTO migration_sessions (company_id, source_system, started_by)
      VALUES (${COMPANY}::UUID, 'sage', ${USER}::UUID) RETURNING id`) as { id: string }[])[0]!.id;
  });

  afterAll(async () => {
    await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM migration_sessions WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (
      SELECT id FROM gl_accounts WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await pool.end();
  }, 60000);

  it.each([
    ['four cents over', 100.04],
    ['one cent over', 100.01],
    ['far over', 250],
  ])('refuses a bill paid %s its total and stores nothing for it', async (_label, paid) => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const r = await run(c, () => importAPInvoices(COMPANY, sessionId, [apRow('over', paid)], USER));

      expect(await overPaid(c)).toEqual([]);
      expect(await stored(c, 'over')).toBeUndefined();
      expect(r.imported).toBe(0);
      expect(r.skipped).toBe(1);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatchObject({ step: 'ap_invoices', field: 'amountPaid' });
      expect(r.errors[0]!.message).toContain('exceeds its total');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('imports the rows around a refused one, and a bill paid exactly its total', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const r = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        apRow('ok-open', 0),
        apRow('over', 100.04),
        apRow('ok-exact', 100),
        apRow('ok-part', 99.99),
        // Whole cents on a total that is not a whole rand; float dust must not refuse it.
        apRow('ok-dust', 0.1 + 0.2, 0.3),
      ], USER));

      expect(await overPaid(c)).toEqual([]);
      expect(r.imported).toBe(4);
      expect(r.errors.filter((e) => e.severity !== 'warning')).toHaveLength(1);
      expect(await stored(c, 'over')).toBeUndefined();
      expect(Number((await stored(c, 'ok-exact'))!.amount_paid)).toBe(100);
      expect((await stored(c, 'ok-exact'))!.status).toBe('paid');
      expect(Number((await stored(c, 'ok-part'))!.amount_paid)).toBe(99.99);
      expect((await stored(c, 'ok-part'))!.status).toBe('partially_paid');
      expect((await stored(c, 'ok-dust'))!.status).toBe('paid');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);
});
