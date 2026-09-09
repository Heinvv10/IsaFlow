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
 * Also covers the findings from the blind review of the first fix: the
 * settlement leg for an already-paid amount (H1), the duplicate guard that
 * `ON CONFLICT DO NOTHING` never provided (H2), a reason on every skip (M3),
 * up-front rejection of amounts that do not add up (M4), and containment of a
 * failure that happens after the INSERT has already succeeded (L1).
 *
 * K-089 is the same defect on the AR side (migrationImportService.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { importAPInvoices } from '@/modules/accounting/services/ap/migrationApService';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { updateSession } from '@/modules/accounting/services/core/migrationService';
import { insertNamingDuplicate } from '@/modules/accounting/services/capture/captureDeduplicationService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const OTHER_COMPANY = randomUUID();
/** Has every system account the import needs EXCEPT opening_balance_equity. */
const NO_EQUITY_COMPANY = randomUUID();
/** June 2026 is a CLOSED fiscal period here; August is open. */
const CLOSED_PERIOD_COMPANY = randomUUID();
const TAG = `K015-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let sessionId: string;
let noEquitySessionId: string;
let closedPeriodSessionId: string;

function run<T>(c: PoolClient, fn: () => Promise<T>, companyId = COMPANY): Promise<T> {
  return als.run({ client: c, userId: USER, companyId, claims: {} } as never, fn);
}

const bill = (over: Partial<Parameters<typeof importAPInvoices>[2][number]> = {}) => ({
  invoiceNumber: `${TAG}-x`,
  supplierName: `ACME ${TAG}`,
  invoiceDate: '2026-06-30',
  dueDate: '2026-07-30',
  subtotal: 100,
  taxAmount: 15,
  totalAmount: 115,
  amountPaid: 0,
  ...over,
});

describeIfDb('K-015 AP migration import writes only real columns', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    const company = async (id: string, label: string, reg: string) => {
      await sql`
        INSERT INTO companies (id, name, registration_number, created_at)
        VALUES (${id}::UUID, ${label}, ${reg}, NOW())`;
    };
    await company(COMPANY, `K015 ${TAG}`, TAG);
    await company(OTHER_COMPANY, `K015 other ${TAG}`, `${TAG}-B`);
    await company(NO_EQUITY_COMPANY, `K015 no-equity ${TAG}`, `${TAG}-C`);
    await company(CLOSED_PERIOD_COMPANY, `K015 closed-period ${TAG}`, `${TAG}-D`);

    await sql`INSERT INTO suppliers (name, company_id) VALUES (${'ACME ' + TAG}, ${COMPANY}::UUID)`;
    await sql`INSERT INTO suppliers (name, company_id) VALUES (${'ACME ' + TAG}, ${OTHER_COMPANY}::UUID)`;
    await sql`INSERT INTO suppliers (name, company_id) VALUES (${'ACME ' + TAG}, ${NO_EQUITY_COMPANY}::UUID)`;
    await sql`INSERT INTO suppliers (name, company_id) VALUES (${'ACME ' + TAG}, ${CLOSED_PERIOD_COMPANY}::UUID)`;
    // A second VAT-less supplier in the SAME company: computeFingerprint folds
    // a missing VAT number to the literal 'no-vat', so this one shares a
    // fingerprint with ACME for any identical invoice number and amount.
    await sql`INSERT INTO suppliers (name, company_id) VALUES (${'BETA ' + TAG}, ${COMPANY}::UUID)`;

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
      await acct(c, '6000', 'K015 Expense', 'expense', 'default_expense', 'debit');
      await acct(c, '2100', 'K015 AP', 'liability', 'payable', 'credit');
      await acct(c, '2200', 'K015 VAT Input', 'asset', 'vat_input', 'debit');
    }
    // Only COMPANY gets the clearing account the settlement leg needs.
    await acct(COMPANY, '3100', 'K015 Opening Balance Equity', 'equity', 'opening_balance_equity', 'credit');
    await acct(CLOSED_PERIOD_COMPANY, '3100', 'K015 Opening Balance Equity', 'equity', 'opening_balance_equity', 'credit');
    await sql`
      INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${CLOSED_PERIOD_COMPANY}::UUID, 'Jun 2026', 4, 2027, '2026-06-01', '2026-06-30', 'closed'),
             (${CLOSED_PERIOD_COMPANY}::UUID, 'Aug 2026', 6, 2027, '2026-08-01', '2026-08-31', 'open')`;
    clearSystemAccountCache();

    const session = async (companyId: string) => ((await sql`
      INSERT INTO migration_sessions (company_id, source_system, started_by, steps_completed, errors)
      VALUES (${companyId}::UUID, 'sage', ${USER}::UUID,
              '{"coa": true, "suppliers": true}'::JSONB,
              '[{"step": "suppliers", "row": 3, "message": "earlier failure"}]'::JSONB)
      RETURNING id`) as { id: string }[])[0]!.id;
    sessionId = await session(COMPANY);
    noEquitySessionId = await session(NO_EQUITY_COMPANY);
    closedPeriodSessionId = await session(CLOSED_PERIOD_COMPANY);
  });

  afterAll(async () => {
    const companies = [COMPANY, OTHER_COMPANY, NO_EQUITY_COMPANY, CLOSED_PERIOD_COMPANY];
    for (const c of companies) {
      await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
        SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM supplier_invoices WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM gl_journal_lines WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM gl_journal_entries WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM migration_sessions WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM suppliers WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (
        SELECT id FROM gl_accounts WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM gl_accounts WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM fiscal_periods WHERE company_id = ${c}::UUID`;
    }
    await sql`DELETE FROM companies WHERE id IN (
      ${COMPANY}::UUID, ${OTHER_COMPANY}::UUID, ${NO_EQUITY_COMPANY}::UUID, ${CLOSED_PERIOD_COMPANY}::UUID)`;
    await pool.end();
  }, 60000);

  it('imports the bill, preserves amount_paid, and leaves the control account agreeing with the subledger', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-1`, amountPaid: 40, reference: `SRC-${TAG}` }),
      ], USER));

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

      // The origination journal balances and agrees with the bill it raised.
      const je = (await c.query(
        `SELECT COALESCE(SUM(debit), 0) AS dr, COALESCE(SUM(credit), 0) AS cr
           FROM gl_journal_lines
          WHERE company_id = $1 AND journal_entry_id = $2`,
        [COMPANY, inv[0].gl_journal_entry_id],
      )).rows[0];
      expect(Number(je.dr)).toBe(115);
      expect(Number(je.cr)).toBe(115);

      // Both journals together must leave the AP control account carrying the
      // OUTSTANDING balance, not the full total: the 40 was settled before the
      // cutover, so it is cleared against opening balance equity.
      const payable = (await c.query(
        `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS net
           FROM gl_journal_lines l
           JOIN gl_accounts a ON a.id = l.gl_account_id
          WHERE l.company_id = $1 AND a.account_subtype = 'payable'`,
        [COMPANY],
      )).rows[0];
      expect(Number(payable.net)).toBe(75);
      expect(Number(payable.net)).toBe(Number(inv[0].balance));

      const equity = (await c.query(
        `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS net
           FROM gl_journal_lines l
           JOIN gl_accounts a ON a.id = l.gl_account_id
          WHERE l.company_id = $1 AND a.account_subtype = 'opening_balance_equity'`,
        [COMPANY],
      )).rows[0];
      expect(Number(equity.net)).toBe(40);

      // Every posted entry balances.
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
      const badRow = [bill({ invoiceNumber: `${TAG}-flags`, supplierName: 'Nobody Ltd Unmatched 9182736450' })];
      await run(c, () => importAPInvoices(COMPANY, sessionId, badRow, USER));

      const first = (await c.query(
        `SELECT steps_completed, errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      expect(first.steps_completed).toMatchObject({ coa: true, suppliers: true, ap_invoices: true });
      // The earlier step's error survives, and this run's is recorded.
      expect(first.errors.map((e: { step: string }) => e.step)).toEqual(['suppliers', 'ap_invoices']);

      // Re-running the step must replace its own errors, not append them again.
      await run(c, () => importAPInvoices(COMPANY, sessionId, badRow, USER));
      const second = (await c.query(
        `SELECT errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      expect(second.errors.map((e: { step: string }) => e.step)).toEqual(['suppliers', 'ap_invoices']);

      // And a clean re-run clears what the failed attempt left behind.
      await run(c, () => importAPInvoices(COMPANY, sessionId, [bill({ invoiceNumber: `${TAG}-flags-ok` })], USER));
      const third = (await c.query(
        `SELECT errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      expect(third.errors.map((e: { step: string }) => e.step)).toEqual(['suppliers']);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('keeps the other steps\' errors when a new error carries no step key', async () => {
    // The supersede filter used a negated IN. An incoming error without a
    // `step` key put a NULL in that list, which made the predicate NULL for
    // every non-matching row and deleted every other step's errors — the exact
    // loss the expression exists to prevent.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await run(c, () => updateSession(sessionId, COMPANY, {
        // No stepsCompleted, and the error has no `step`.
        errors: [{ row: 2, message: 'a caller that omitted the step' } as never],
      }));

      const sess = (await c.query(
        `SELECT errors FROM migration_sessions WHERE id = $1 AND company_id = $2`,
        [sessionId, COMPANY],
      )).rows[0];
      const steps = sess.errors.map((e: { step?: string }) => e.step ?? null);
      expect(steps).toContain('suppliers');
      expect(steps).toContain(null);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('names the duplicate for the other paths that stamp a fingerprint', async () => {
    // recurringTransactionService and sageImportService INSERT a fingerprint
    // directly. Migration 625 can now refuse them, and they went through the
    // same translator so the operator gets the message, not a bare 23505.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const supplierId = (await c.query(
        `SELECT id FROM suppliers WHERE company_id = $1 AND name = $2`,
        [COMPANY, `ACME ${TAG}`],
      )).rows[0].id;

      const insert = () => c.query(
        `INSERT INTO supplier_invoices
           (company_id, supplier_id, invoice_number, invoice_date, due_date,
            subtotal, tax_amount, total_amount, status, created_by, duplicate_fingerprint)
         VALUES ($1, $2, $3, '2026-06-30', '2026-07-30', 100, 15, 115, 'draft', $4, $5)`,
        [COMPANY, supplierId, `${TAG}-rec`, USER, `no-vat|${TAG}-rec|115`],
      );

      await run(c, () => insertNamingDuplicate(`${TAG}-rec`, insert));
      await expect(run(c, () => insertNamingDuplicate(`${TAG}-rec`, insert)))
        .rejects.toThrow(/already has an invoice/);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('a failing row is skipped without poisoning the rest of the run', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-good-1` }),
        // 22007: invalid input syntax for type date — raised by the INSERT.
        bill({ invoiceNumber: `${TAG}-bad`, invoiceDate: 'not-a-date' }),
        bill({ invoiceNumber: `${TAG}-good-2` }),
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

  it('a failure after the INSERT rolls the whole row back, invoice and journal alike', async () => {
    // June 2026 is a CLOSED period for this company, so postJournalEntry
    // refuses AFTER the invoice row has already been written. Nothing of that
    // row may survive. August is open, so the row after it must still import.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importAPInvoices(CLOSED_PERIOD_COMPANY, closedPeriodSessionId, [
        bill({ invoiceNumber: `${TAG}-late-fail`, invoiceDate: '2026-06-30', dueDate: '2026-09-30' }),
        bill({ invoiceNumber: `${TAG}-after`, invoiceDate: '2026-08-31', dueDate: '2026-09-30' }),
      ], USER), CLOSED_PERIOD_COMPANY);

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.row).toBe(0);
      expect(result.errors[0]!.message).toContain('closed fiscal period');

      const survivors = (await c.query(
        `SELECT invoice_number FROM supplier_invoices WHERE company_id = $1 ORDER BY invoice_number`,
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
      await expect(run(c, () => importAPInvoices(NO_EQUITY_COMPANY, noEquitySessionId, [
        bill({ invoiceNumber: `${TAG}-noeq-1`, amountPaid: 40 }),
        bill({ invoiceNumber: `${TAG}-noeq-2`, amountPaid: 40 }),
      ], USER), NO_EQUITY_COMPANY)).rejects.toThrow(/opening_balance_equity/);

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices WHERE company_id = $1`,
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
      const result = await run(c, () => importAPInvoices(NO_EQUITY_COMPANY, noEquitySessionId, [
        bill({ invoiceNumber: `${TAG}-noeq-unpaid`, amountPaid: 0 }),
      ], USER), NO_EQUITY_COMPANY);
      expect(result.imported).toBe(1);
      expect(result.errors).toEqual([]);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('aborts the run with a named error when migration 625 has not been applied', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      // Dropping inside the transaction is local to this connection.
      await c.query('DROP INDEX uq_supplier_invoices_supplier_fingerprint');

      await expect(run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-no-index` }),
      ], USER))).rejects.toThrow(/migration 625/);

      // The old behaviour was 200 with imported: 0 and a raw Postgres message
      // on every row; the run must stop instead.
      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-no-index`],
      )).rows[0];
      expect(rows.n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('lets two VAT-less suppliers hold the same invoice number and amount', async () => {
    // computeFingerprint folds a missing VAT number to 'no-vat', so both rows
    // carry an identical fingerprint. Keying the unique index on supplier_id is
    // what stops that being a false duplicate — for the wizard and for the five
    // other paths that stamp this column on a plain INSERT.
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const suppliers = (await c.query(
        `SELECT id, name FROM suppliers WHERE company_id = $1 ORDER BY name`,
        [COMPANY],
      )).rows;
      expect(suppliers).toHaveLength(2);

      const insert = (supplierId: string, n: string) => c.query(
        `INSERT INTO supplier_invoices
           (company_id, supplier_id, invoice_number, invoice_date, due_date,
            subtotal, tax_amount, total_amount, status, created_by, duplicate_fingerprint)
         VALUES ($1, $2, $3, '2026-06-30', '2026-07-30', 100, 15, 115, 'approved', $4, $5)
         RETURNING id`,
        [COMPANY, supplierId, n, USER, `no-vat|${TAG}-shared|115`],
      );

      await insert(suppliers[0].id, `${TAG}-shared-a`);
      await insert(suppliers[1].id, `${TAG}-shared-b`);

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices
          WHERE company_id = $1 AND duplicate_fingerprint = $2`,
        [COMPANY, `no-vat|${TAG}-shared|115`],
      )).rows[0];
      expect(rows.n).toBe(2);

      // The same supplier twice is still refused, by the named constraint.
      await expect(insert(suppliers[0].id, `${TAG}-shared-c`))
        .rejects.toMatchObject({ code: '23505', constraint: 'uq_supplier_invoices_supplier_fingerprint' });
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('the ordinary create path names the duplicate instead of raising a bare 23505', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const supplierId = (await c.query(
        `SELECT id FROM suppliers WHERE company_id = $1 AND name = $2`,
        [COMPANY, `ACME ${TAG}`],
      )).rows[0].id;

      const input = {
        invoiceNumber: `${TAG}-ordinary`,
        supplierId,
        invoiceDate: '2026-06-30',
        items: [{ description: 'Consulting', quantity: 1, unitPrice: 100, taxRate: 15 }],
      };

      const created = await run(c, () => createSupplierInvoice(COMPANY, input, USER));
      expect(created.invoiceNumber).toBe(`${TAG}-ordinary`);

      await expect(run(c, () => createSupplierInvoice(COMPANY, input, USER)))
        .rejects.toThrow(/already has an invoice/);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('re-running the same file does not import the bill a second time', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const first = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-rerun` }),
      ], USER));
      expect(first.imported).toBe(1);

      const second = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-rerun` }),
      ], USER));
      expect(second.imported).toBe(0);
      expect(second.skipped).toBe(1);
      expect(second.errors).toHaveLength(1);
      expect(second.errors[0]!.field).toBe('invoiceNumber');
      expect(second.errors[0]!.message).toContain(`${TAG}-rerun`);

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-rerun`],
      )).rows[0];
      expect(rows.n).toBe(1);

      const journals = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM gl_journal_entries
          WHERE company_id = $1 AND description LIKE $2`,
        [COMPANY, `%${TAG}-rerun%`],
      )).rows[0];
      expect(journals.n).toBe(1);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 60000);

  it('rejects a row whose amounts do not add up, naming all three', async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-round`, subtotal: 33.33, taxAmount: 5, totalAmount: 38.34 }),
      ], USER));

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors[0]!.field).toBe('totalAmount');
      expect(result.errors[0]!.message).toContain('33.33');
      expect(result.errors[0]!.message).toContain('5.00');
      expect(result.errors[0]!.message).toContain('38.34');

      const rows = (await c.query(
        `SELECT COUNT(*)::INT AS n FROM supplier_invoices
          WHERE company_id = $1 AND invoice_number = $2`,
        [COMPANY, `${TAG}-round`],
      )).rows[0];
      expect(rows.n).toBe(0);
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

      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-tenant` }),
      ], USER));
      expect(result.imported).toBe(1);

      const row = (await c.query(
        `SELECT supplier_id FROM supplier_invoices
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
      const result = await run(c, () => importAPInvoices(COMPANY, sessionId, [
        bill({ invoiceNumber: `${TAG}-missing`, supplierName: 'Nobody Ltd Unmatched 9182736450' }),
      ], USER));

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
