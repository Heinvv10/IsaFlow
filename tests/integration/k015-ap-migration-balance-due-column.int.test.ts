/**
 * K-015 — `importAPInvoices` INSERTed into `supplier_invoices.balance_due`,
 * a column that exists nowhere in the schema; the real column is `balance`,
 * generated as `total_amount - amount_paid`.
 *
 * Two consequences, both covered here:
 *   1. every row raised 42703, was counted as SKIPPED, and the wizard reported
 *      a clean run that imported nothing;
 *   2. the 42703 aborted the surrounding request transaction, so the
 *      `updateSession` at the end of the loop died with 25P02 and
 *      POST /api/accounting/migration/ap-invoices returned 500.
 *
 * The route wraps the service in `withAuth`, which supplies exactly one
 * transaction for the request, so the per-row `try/catch` cannot save it —
 * a caught SQL error still poisons the transaction unless the row runs inside
 * its own savepoint. These tests drive the service inside that same single
 * request transaction.
 *
 * K-089 is the same defect on the AR side (migrationImportService.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { importAPInvoices } from '@/modules/accounting/services/ap/migrationApService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const OTHER_COMPANY = randomUUID();
const TAG = `K015-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let sessionId: string;

function run<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
}

describeIfDb('K-015 AP migration import writes only real columns', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await sql`
      INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${COMPANY}::UUID, ${'K015 ' + TAG}, ${TAG}, NOW())`;
    await sql`INSERT INTO suppliers (name, company_id) VALUES (${'ACME ' + TAG}, ${COMPANY}::UUID)`;
    await sql`
      INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${OTHER_COMPANY}::UUID, ${'K015 other ' + TAG}, ${TAG + '-B'}, NOW())`;
    await sql`INSERT INTO suppliers (name, company_id) VALUES (${'ACME ' + TAG}, ${OTHER_COMPANY}::UUID)`;
    const acct = async (code: string, name: string, type: string, subtype: string, normal: string) => {
      await sql`
        INSERT INTO gl_accounts
          (company_id, account_code, account_name, account_type, account_subtype,
           normal_balance, is_active, is_system_account)
        VALUES (${COMPANY}::UUID, ${code}, ${name}, ${type}, ${subtype}, ${normal}, true, true)`;
    };
    await acct('6000', 'K015 Expense', 'expense', 'default_expense', 'debit');
    await acct('2100', 'K015 AP', 'liability', 'payable', 'credit');
    await acct('2200', 'K015 VAT Input', 'asset', 'vat_input', 'debit');
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
    await sql`DELETE FROM suppliers WHERE company_id = ${OTHER_COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id IN (${COMPANY}::UUID, ${OTHER_COMPANY}::UUID)`;
    await pool.end();
  }, 60000);

  it('imports the bill, preserves amount_paid, and derives balance from the schema', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [{
        invoiceNumber: `${TAG}-1`,
        supplierName: `ACME ${TAG}`,
        invoiceDate: '2026-06-30',
        dueDate: '2026-07-30',
        subtotal: 100,
        taxAmount: 15,
        totalAmount: 115,
        amountPaid: 40,
        reference: `SRC-${TAG}`,
      }], USER));

      expect(result.errors).toEqual([]);
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);

      // The transaction must still be usable after the import — updateSession
      // already ran inside it, and the route commits after this point.
      await c.query('SELECT 1');

      const inv = (await c.query(
        `SELECT total_amount, amount_paid, balance, status, reference, gl_journal_entry_id
           FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-1`],
      )).rows;
      expect(inv).toHaveLength(1);
      expect(Number(inv[0].total_amount)).toBe(115);
      expect(Number(inv[0].amount_paid)).toBe(40);
      expect(Number(inv[0].balance)).toBe(75);
      expect(inv[0].status).toBe('partially_paid');
      expect(inv[0].reference).toBe(`SRC-${TAG}`);
      expect(inv[0].gl_journal_entry_id).toBeTruthy();

      // The posted journal balances and agrees with the bill it was raised for.
      const je = (await c.query(
        `SELECT COALESCE(SUM(debit), 0) AS dr, COALESCE(SUM(credit), 0) AS cr
           FROM gl_journal_lines
          WHERE company_id = $1 AND journal_entry_id = $2`,
        [COMPANY, inv[0].gl_journal_entry_id],
      )).rows[0];
      expect(Number(je.dr)).toBe(115);
      expect(Number(je.cr)).toBe(115);

      const payable = (await c.query(
        `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS net
           FROM gl_journal_lines l
           JOIN gl_accounts a ON a.id = l.gl_account_id
          WHERE l.company_id = $1 AND l.journal_entry_id = $2
            AND a.account_subtype = 'payable'`,
        [COMPANY, inv[0].gl_journal_entry_id],
      )).rows[0];
      expect(Number(payable.net)).toBe(115);

      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('a failing row is skipped without poisoning the rest of the run', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const base = {
        supplierName: `ACME ${TAG}`,
        dueDate: '2026-07-30',
        subtotal: 100,
        taxAmount: 15,
        totalAmount: 115,
        amountPaid: 0,
      };
      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        { ...base, invoiceNumber: `${TAG}-good-1`, invoiceDate: '2026-06-30' },
        // 22007: invalid input syntax for type date — raised by the INSERT.
        { ...base, invoiceNumber: `${TAG}-bad`, invoiceDate: 'not-a-date' },
        { ...base, invoiceNumber: `${TAG}-good-2`, invoiceDate: '2026-06-30' },
      ], USER));

      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.row).toBe(1);

      // updateSession already ran on this connection; it must have survived.
      const sess = (await c.query(
        `SELECT ap_invoices_imported FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      expect(Number(sess.ap_invoices_imported)).toBe(2);

      const rows = (await c.query(
        `SELECT invoice_number FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number LIKE $2 ORDER BY invoice_number`,
        [COMPANY, `${TAG}-good-%`],
      )).rows;
      expect(rows.map(r => r.invoice_number)).toEqual([`${TAG}-good-1`, `${TAG}-good-2`]);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('resolves the supplier within the importing tenant only', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      // Both companies own a supplier with the identical name.
      const mine = (await c.query(
        `SELECT id FROM suppliers WHERE company_id = $1 AND name = $2`,
        [COMPANY, `ACME ${TAG}`],
      )).rows[0].id;

      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [{
        invoiceNumber: `${TAG}-tenant`,
        supplierName: `ACME ${TAG}`,
        invoiceDate: '2026-06-30',
        dueDate: '2026-07-30',
        subtotal: 100,
        taxAmount: 15,
        totalAmount: 115,
        amountPaid: 0,
      }], USER));

      expect(result.imported).toBe(1);

      const row = (await c.query(
        `SELECT supplier_id, company_id FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-tenant`],
      )).rows[0];
      expect(row.supplier_id).toBe(mine);

      const foreign = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices WHERE company_id = $1`,
        [OTHER_COMPANY],
      )).rows[0];
      expect(foreign.n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('skips a row whose supplier does not exist in this tenant', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [{
        invoiceNumber: `${TAG}-missing`,
        supplierName: 'Nobody Ltd Unmatched 9182736450',
        invoiceDate: '2026-06-30',
        dueDate: '2026-07-30',
        subtotal: 100,
        taxAmount: 15,
        totalAmount: 115,
        amountPaid: 0,
      }], USER));

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors[0]!.field).toBe('supplierName');

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-missing`],
      )).rows[0];
      expect(rows.n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);
});
