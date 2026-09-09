/**
 * K-089 — `importARInvoices` INSERTed into `customer_invoices.balance_due`,
 * a column that exists nowhere in the schema; the real column is `balance`,
 * generated as `total_amount - amount_paid`.
 *
 * Same root cause as K-015 but a different file, table and route
 * (POST /api/accounting/migration/ar-invoices), so fixing one does not fix the
 * other. Every row raised 42703, was counted as SKIPPED, and the aborted
 * transaction made the closing `updateSession` die with 25P02 — a 500.
 *
 * These tests drive the service inside the single request transaction
 * `withAuth` supplies, which is why a per-row savepoint is required. They also
 * cover the blind review's findings: the settlement leg for an already-paid
 * amount (H1), a reason on every skip (M3), up-front rejection of amounts that
 * do not add up (M4), the source system stored alongside the reference (M5),
 * and containment of a failure that happens after the INSERT succeeded (L1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { importARInvoices } from '@/modules/accounting/services/core/migrationImportService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const OTHER_COMPANY = randomUUID();
/** Has every system account the import needs EXCEPT opening_balance_equity. */
const NO_EQUITY_COMPANY = randomUUID();
/** June 2026 is a CLOSED fiscal period here; August is open. */
const CLOSED_PERIOD_COMPANY = randomUUID();
const TAG = `K089-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let sessionId: string;
let noEquitySessionId: string;
let closedPeriodSessionId: string;

function run<T>(c: PoolClient, fn: () => Promise<T>, companyId = COMPANY): Promise<T> {
  return als.run({ client: c, userId: USER, companyId, claims: {} } as never, fn);
}

const invoice = (over: Partial<Parameters<typeof importARInvoices>[2][number]> = {}) => ({
  invoiceNumber: `${TAG}-x`,
  customerName: `ACME ${TAG}`,
  invoiceDate: '2026-06-30',
  dueDate: '2026-07-30',
  subtotal: 100,
  taxAmount: 15,
  totalAmount: 115,
  amountPaid: 0,
  ...over,
});

describeIfDb('K-089 AR migration import writes only real columns', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    const company = async (id: string, label: string, reg: string) => {
      await sql`
        INSERT INTO companies (id, name, registration_number, created_at)
        VALUES (${id}::UUID, ${label}, ${reg}, NOW())`;
    };
    await company(COMPANY, `K089 ${TAG}`, TAG);
    await company(OTHER_COMPANY, `K089 other ${TAG}`, `${TAG}-B`);
    await company(NO_EQUITY_COMPANY, `K089 no-equity ${TAG}`, `${TAG}-C`);
    await company(CLOSED_PERIOD_COMPANY, `K089 closed-period ${TAG}`, `${TAG}-D`);

    for (const c of [COMPANY, OTHER_COMPANY, NO_EQUITY_COMPANY, CLOSED_PERIOD_COMPANY]) {
      await sql`INSERT INTO customers (name, company_id) VALUES (${'ACME ' + TAG}, ${c}::UUID)`;
    }

    const acct = async (
      companyId: string, code: string, name: string,
      type: string, subtype: string, normal: string,
    ) => {
      await sql`
        INSERT INTO gl_accounts
          (company_id, account_code, account_name, account_type, account_subtype,
           normal_balance, is_active, is_system_account)
        VALUES (${companyId}::UUID, ${code}, ${name}, ${type}, ${subtype}, ${normal}, true, true)`;
    };
    for (const c of [COMPANY, NO_EQUITY_COMPANY, CLOSED_PERIOD_COMPANY]) {
      await acct(c, '4000', 'K089 Revenue', 'revenue', 'default_revenue', 'credit');
      await acct(c, '1100', 'K089 AR', 'asset', 'receivable', 'debit');
      await acct(c, '2120', 'K089 VAT Output', 'liability', 'vat_output', 'credit');
    }
    // Only COMPANY gets the clearing account the settlement leg needs.
    await acct(COMPANY, '3100', 'K089 Opening Balance Equity', 'equity', 'opening_balance_equity', 'credit');
    await acct(CLOSED_PERIOD_COMPANY, '3100', 'K089 Opening Balance Equity', 'equity', 'opening_balance_equity', 'credit');
    await sql`
      INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${CLOSED_PERIOD_COMPANY}::UUID, 'Jun 2026', 4, 2027, '2026-06-01', '2026-06-30', 'closed'),
             (${CLOSED_PERIOD_COMPANY}::UUID, 'Aug 2026', 6, 2027, '2026-08-01', '2026-08-31', 'open')`;
    clearSystemAccountCache();

    const session = async (companyId: string) => ((await sql`
      INSERT INTO migration_sessions (company_id, source_system, started_by, steps_completed, errors)
      VALUES (${companyId}::UUID, 'sage', ${USER}::UUID,
              '{"coa": true, "customers": true}'::JSONB,
              '[{"step": "customers", "row": 3, "message": "earlier failure"}]'::JSONB)
      RETURNING id`) as { id: string }[])[0]!.id;
    sessionId = await session(COMPANY);
    noEquitySessionId = await session(NO_EQUITY_COMPANY);
    closedPeriodSessionId = await session(CLOSED_PERIOD_COMPANY);
  });

  afterAll(async () => {
    for (const c of [COMPANY, OTHER_COMPANY, NO_EQUITY_COMPANY, CLOSED_PERIOD_COMPANY]) {
      await sql`UPDATE customer_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM customer_invoices WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM gl_journal_lines WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM gl_journal_entries WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM migration_sessions WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM customers WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (
        SELECT id FROM gl_accounts WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM gl_accounts WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM fiscal_periods WHERE company_id = ${c}::UUID`;
    }
    await sql`DELETE FROM companies WHERE id IN (
      ${COMPANY}::UUID, ${OTHER_COMPANY}::UUID, ${NO_EQUITY_COMPANY}::UUID, ${CLOSED_PERIOD_COMPANY}::UUID)`;
    await pool.end();
  }, 60000);

  it('imports the invoice, preserves amount_paid, and leaves the control account agreeing with the subledger', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importARInvoices(COMPANY, sessionId, [
        invoice({ invoiceNumber: `${TAG}-1`, amountPaid: 40, reference: `SRC-${TAG}` }),
      ], USER));

      expect(result.errors).toEqual([]);
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);

      // The transaction must still be usable after the import — updateSession
      // already ran inside it, and the route commits after this point.
      await c.query('SELECT 1');

      const inv = (await c.query(
        `SELECT total_amount, amount_paid, balance, status, external_ref, external_system,
                gl_journal_entry_id
           FROM customer_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-1`],
      )).rows;
      expect(inv).toHaveLength(1);
      expect(Number(inv[0].total_amount)).toBe(115);
      expect(Number(inv[0].amount_paid)).toBe(40);
      expect(Number(inv[0].balance)).toBe(75);
      expect(inv[0].status).toBe('partially_paid');
      // customer_invoices has no `reference` column; the source reference is
      // kept in external_ref, attributed to the session's source system.
      expect(inv[0].external_ref).toBe(`SRC-${TAG}`);
      expect(inv[0].external_system).toBe('sage');
      expect(inv[0].gl_journal_entry_id).toBeTruthy();

      const je = (await c.query(
        `SELECT COALESCE(SUM(debit), 0) AS dr, COALESCE(SUM(credit), 0) AS cr
           FROM gl_journal_lines
          WHERE company_id = $1 AND journal_entry_id = $2`,
        [COMPANY, inv[0].gl_journal_entry_id],
      )).rows[0];
      expect(Number(je.dr)).toBe(115);
      expect(Number(je.cr)).toBe(115);

      // Both journals together must leave the AR control account carrying the
      // OUTSTANDING balance, not the full total: the 40 was settled before the
      // cutover, so it is cleared against opening balance equity.
      const receivable = (await c.query(
        `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS net
           FROM gl_journal_lines l
           JOIN gl_accounts a ON a.id = l.gl_account_id
          WHERE l.company_id = $1 AND a.account_subtype = 'receivable'`,
        [COMPANY],
      )).rows[0];
      expect(Number(receivable.net)).toBe(75);
      expect(Number(receivable.net)).toBe(Number(inv[0].balance));

      const equity = (await c.query(
        `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS net
           FROM gl_journal_lines l
           JOIN gl_accounts a ON a.id = l.gl_account_id
          WHERE l.company_id = $1 AND a.account_subtype = 'opening_balance_equity'`,
        [COMPANY],
      )).rows[0];
      expect(Number(equity.net)).toBe(40);

      const unbalanced = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM (
           SELECT journal_entry_id FROM gl_journal_lines WHERE company_id = $1
            GROUP BY journal_entry_id
           HAVING COALESCE(SUM(debit), 0) <> COALESCE(SUM(credit), 0)) d`,
        [COMPANY],
      )).rows[0];
      expect(unbalanced.n).toBe(0);

      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('merges the step flag and supersedes only its own errors, without growing on a re-run', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const badRow = [invoice({ invoiceNumber: `${TAG}-flags`, customerName: 'Nobody Ltd Unmatched 9182736450' })];
      await run(c, () => importARInvoices(COMPANY, sessionId, badRow, USER));

      const first = (await c.query(
        `SELECT steps_completed, errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      expect(first.steps_completed).toMatchObject({ coa: true, customers: true, ar_invoices: true });
      // The earlier step's error survives, and this run's is recorded.
      expect(first.errors.map((e: { step: string }) => e.step)).toEqual(['customers', 'ar_invoices']);

      // Re-running the step must replace its own errors, not append them again.
      await run(c, () => importARInvoices(COMPANY, sessionId, badRow, USER));
      const second = (await c.query(
        `SELECT errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      expect(second.errors.map((e: { step: string }) => e.step)).toEqual(['customers', 'ar_invoices']);

      // And a clean re-run clears what the failed attempt left behind.
      await run(c, () => importARInvoices(COMPANY, sessionId, [invoice({ invoiceNumber: `${TAG}-flags-ok` })], USER));
      const third = (await c.query(
        `SELECT errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      expect(third.errors.map((e: { step: string }) => e.step)).toEqual(['customers']);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('a failing row is skipped without poisoning the rest of the run', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importARInvoices(COMPANY, sessionId, [
        invoice({ invoiceNumber: `${TAG}-good-1` }),
        // 22007: invalid input syntax for type date — raised by the INSERT.
        invoice({ invoiceNumber: `${TAG}-bad`, invoiceDate: 'not-a-date' }),
        invoice({ invoiceNumber: `${TAG}-good-2` }),
      ], USER));

      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.row).toBe(1);

      const sess = (await c.query(
        `SELECT ar_invoices_imported FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      expect(Number(sess.ar_invoices_imported)).toBe(2);

      const rows = (await c.query(
        `SELECT invoice_number FROM customer_invoices
          WHERE company_id = $1 AND invoice_number LIKE $2 ORDER BY invoice_number`,
        [COMPANY, `${TAG}-good-%`],
      )).rows;
      expect(rows.map(r => r.invoice_number)).toEqual([`${TAG}-good-1`, `${TAG}-good-2`]);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('a failure after the INSERT rolls the whole row back, invoice and journal alike', async () => {
    // June 2026 is a CLOSED period for this company, so postJournalEntry
    // refuses AFTER the invoice row has already been written. Nothing of that
    // row may survive. August is open, so the row after it must still import.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importARInvoices(CLOSED_PERIOD_COMPANY, closedPeriodSessionId, [
        invoice({ invoiceNumber: `${TAG}-late-fail`, invoiceDate: '2026-06-30', dueDate: '2026-09-30' }),
        invoice({ invoiceNumber: `${TAG}-after`, invoiceDate: '2026-08-31', dueDate: '2026-09-30' }),
      ], USER), CLOSED_PERIOD_COMPANY);

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.row).toBe(0);
      expect(result.errors[0]!.message).toContain('closed fiscal period');

      const survivors = (await c.query(
        `SELECT invoice_number FROM customer_invoices WHERE company_id = $1 ORDER BY invoice_number`,
        [CLOSED_PERIOD_COMPANY],
      )).rows;
      expect(survivors.map(r => r.invoice_number)).toEqual([`${TAG}-after`]);

      const strayJournal = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM gl_journal_entries
          WHERE company_id = $1 AND description LIKE $2`,
        [CLOSED_PERIOD_COMPANY, `%${TAG}-late-fail%`],
      )).rows[0];
      expect(strayJournal.n).toBe(0);
      await c.query('SELECT 1');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('fails the whole step once, before writing anything, when the clearing account is missing', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await expect(run(c, () => importARInvoices(NO_EQUITY_COMPANY, noEquitySessionId, [
        invoice({ invoiceNumber: `${TAG}-noeq-1`, amountPaid: 40 }),
        invoice({ invoiceNumber: `${TAG}-noeq-2`, amountPaid: 40 }),
      ], USER), NO_EQUITY_COMPANY)).rejects.toThrow(/opening_balance_equity/);

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM customer_invoices WHERE company_id = $1`,
        [NO_EQUITY_COMPANY],
      )).rows[0];
      expect(rows.n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('still imports unpaid invoices for a company with no clearing account', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importARInvoices(NO_EQUITY_COMPANY, noEquitySessionId, [
        invoice({ invoiceNumber: `${TAG}-noeq-unpaid`, amountPaid: 0 }),
      ], USER), NO_EQUITY_COMPANY);
      expect(result.imported).toBe(1);
      expect(result.errors).toEqual([]);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('aborts the run with a named error when the arbiter index is absent', async () => {
    // Same failure mode as the AP side: 42P10 inside the per-row savepoint is
    // contained, so without this guard the step answers 200 with imported: 0
    // and a raw Postgres message on every row.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await c.query('DROP INDEX uq_customer_invoices_company_number');

      await expect(run(c, () => importARInvoices(COMPANY, sessionId, [
        invoice({ invoiceNumber: `${TAG}-no-index` }),
      ], USER))).rejects.toThrow(/uq_customer_invoices_company_number/);

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM customer_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-no-index`],
      )).rows[0];
      expect(rows.n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('says why a row was skipped when the invoice number already exists', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const first = await run(c, () => importARInvoices(COMPANY, sessionId, [
        invoice({ invoiceNumber: `${TAG}-rerun` }),
      ], USER));
      expect(first.imported).toBe(1);

      const second = await run(c, () => importARInvoices(COMPANY, sessionId, [
        invoice({ invoiceNumber: `${TAG}-rerun` }),
      ], USER));
      expect(second.imported).toBe(0);
      expect(second.skipped).toBe(1);
      expect(second.errors).toHaveLength(1);
      expect(second.errors[0]!.field).toBe('invoiceNumber');
      expect(second.errors[0]!.message).toContain(`${TAG}-rerun`);

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM customer_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-rerun`],
      )).rows[0];
      expect(rows.n).toBe(1);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('rejects a row whose amounts do not add up, naming all three', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importARInvoices(COMPANY, sessionId, [
        invoice({ invoiceNumber: `${TAG}-round`, subtotal: 33.33, taxAmount: 5, totalAmount: 38.34 }),
      ], USER));

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors[0]!.field).toBe('totalAmount');
      expect(result.errors[0]!.message).toContain('33.33');
      expect(result.errors[0]!.message).toContain('5.00');
      expect(result.errors[0]!.message).toContain('38.34');

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM customer_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-round`],
      )).rows[0];
      expect(rows.n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('resolves the customer within the importing tenant only', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      // Both companies own a customer with the identical name.
      const mine = (await c.query(
        `SELECT id FROM customers WHERE company_id = $1 AND name = $2`,
        [COMPANY, `ACME ${TAG}`],
      )).rows[0].id;

      const result = await run(c, () => importARInvoices(COMPANY, sessionId, [
        invoice({ invoiceNumber: `${TAG}-tenant` }),
      ], USER));
      expect(result.imported).toBe(1);

      const row = (await c.query(
        `SELECT customer_id FROM customer_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-tenant`],
      )).rows[0];
      expect(row.customer_id).toBe(mine);

      const foreign = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM customer_invoices WHERE company_id = $1`,
        [OTHER_COMPANY],
      )).rows[0];
      expect(foreign.n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('skips a row whose customer does not exist in this tenant', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importARInvoices(COMPANY, sessionId, [
        invoice({ invoiceNumber: `${TAG}-missing`, customerName: 'Nobody Ltd Unmatched 9182736450' }),
      ], USER));

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors[0]!.field).toBe('customerName');

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM customer_invoices WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-missing`],
      )).rows[0];
      expect(rows.n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);
});
