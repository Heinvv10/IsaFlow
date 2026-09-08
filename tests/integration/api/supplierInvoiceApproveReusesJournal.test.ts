/**
 * A draft that already carries a journal is APPROVED, not posted a second time.
 *
 * Adversarial review, 2026-09-08. `postSupplierInvoiceToGL` posts the
 * Expense/VAT/AP journal and sets `gl_journal_entry_id` WITHOUT touching
 * `status`, and it is exposed to operators as the "Post to GL" bulk action
 * (pages/api/accounting/supplier-invoices-bulk-action.ts), which accepts drafts.
 * So "post 40 drafts to GL, then approve them" is a two-click sequence that
 * leaves 40 bills with a journal and status still 'draft'.
 *
 * Guarding on status alone — which is all `approveSupplierInvoice` did —
 * a second journal is built and posted for each: AP credited twice, expenses
 * and input VAT doubled, and `gl_journal_entry_id` overwritten with the new id,
 * stranding the first journal where `cancelSupplierInvoiceInner` (which reverses
 * only the id on the row) can never reach it.
 *
 * No race is required. The two calls are sequential, and
 * `bulk_approve_supplier_invoices` is what turns this into 100 of them.
 *
 * The AR twin has always been immune — `postCustomerInvoiceToGL` early-returns
 * on `if (inv.gl_journal_entry_id)`. This pins the AP side of that guarantee,
 * against a real database, because the claim is about what two real services do
 * to one row in sequence.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import {
  approveSupplierInvoice,
  postSupplierInvoiceToGL,
} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';

const COMPANY = '00000000-0000-0000-0000-000000000ab3';
const USER = '00000000-0000-0000-e2e0-000000000001';
const TAG = `SIREUSE-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let supplier: string;
let expenseAccount: string;

async function makeInvoice(number: string): Promise<string> {
  const rows = await sql`
    INSERT INTO supplier_invoices
      (company_id, supplier_id, invoice_number, invoice_date, subtotal,
       tax_rate, tax_amount, total_amount, status, created_by)
    VALUES
      (${COMPANY}::UUID, ${supplier}::UUID, ${number}, '2026-06-30', 100,
       15, 15, 115, 'draft', ${USER}::UUID)
    RETURNING id` as { id: string }[];
  const id = rows[0]!.id;
  await sql`
    INSERT INTO supplier_invoice_items
      (supplier_invoice_id, description, quantity, unit_price, tax_rate,
       tax_amount, line_total, gl_account_id)
    VALUES (${id}::UUID, 'Test line', 1, 100, 15, 15, 100, ${expenseAccount}::UUID)`;
  return id;
}

/** Every write path here requires a request transaction (the locks assert it). */
async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const c: PoolClient = await pool.connect();
  await c.query('BEGIN');
  try {
    const out = await als.run(
      { client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn,
    );
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

async function journalCountFor(invoiceNumber: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS n FROM gl_journal_entries
    WHERE company_id = ${COMPANY}::UUID
      AND description = ${`Supplier invoice ${invoiceNumber}`}
  `) as { n: number }[];
  return rows[0]!.n;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${COMPANY}::UUID, 'SI Reuse Test', 'SIREUSE-TEST', NOW())
    ON CONFLICT (id) DO NOTHING`;
  supplier = (await sql`
    INSERT INTO suppliers (name, company_id) VALUES (${'REUSE ' + TAG}, ${COMPANY}::UUID)
    RETURNING id` as { id: string }[])[0]!.id;
  // The three system-account roles the AP journal needs.
  const acct = async (
    code: string, name: string, type: string, subtype: string, normal: string,
  ) => {
    // Idempotent: a run that failed in afterAll leaves these behind, and a bare
    // INSERT would then collide on uq_gl_accounts_company_code and fail every
    // later run — a test that can only pass once is not a test.
    await sql`
      INSERT INTO gl_accounts
        (company_id, account_code, account_name, account_type, account_subtype,
         normal_balance, is_active, is_system_account)
      VALUES (${COMPANY}::UUID, ${code}, ${name}, ${type}, ${subtype}, ${normal}, true, true)
      ON CONFLICT (company_id, account_code) DO NOTHING`;
    const rows = (await sql`
      SELECT id FROM gl_accounts
      WHERE company_id = ${COMPANY}::UUID AND account_code = ${code}` as { id: string }[]);
    return rows[0]!.id;
  };
  expenseAccount = await acct('6000', 'Test Expense', 'expense', 'default_expense', 'debit');
  await acct('2100', 'Test AP', 'liability', 'payable', 'credit');
  await acct('2200', 'Test VAT Input', 'asset', 'vat_input', 'debit');
});

afterAll(async () => {
  // Release the invoice -> journal FK before the entries go, or the DELETE below
  // is refused by supplier_invoices.gl_journal_entry_id still pointing at them.
  await sql`
    UPDATE supplier_invoices SET gl_journal_entry_id = NULL
    WHERE supplier_id = ${supplier}::UUID`;
  await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
    SELECT id FROM supplier_invoices WHERE supplier_id = ${supplier}::UUID)`;
  await sql`DELETE FROM supplier_invoices WHERE supplier_id = ${supplier}::UUID`;
  await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
  await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
  await sql`DELETE FROM suppliers WHERE id = ${supplier}::UUID`;
  // gl_account_balances FKs gl_accounts, so it goes first or the DELETE is refused.
  await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (
    SELECT id FROM gl_accounts WHERE company_id = ${COMPANY}::UUID)`;
  await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
  await pool.end();
});

describe('approveSupplierInvoice on a draft that already carries a journal', () => {
  it('posts ONE journal, not two, and keeps the original', async () => {
    const number = `${TAG}-A`;
    const id = await inTx(() => makeInvoice(number));

    // Step 1 — the operator's "Post to GL" bulk action. Journal posted, status
    // deliberately untouched: this is the state the guard exists for.
    const posted = await inTx(() => postSupplierInvoiceToGL(COMPANY, id, USER));
    expect(posted.alreadyPosted).toBe(false);
    expect(await journalCountFor(number)).toBe(1);
    const stillDraft = (await sql`
      SELECT status, gl_journal_entry_id FROM supplier_invoices WHERE id = ${id}::UUID
    `) as { status: string; gl_journal_entry_id: string }[];
    expect(stillDraft[0]!.status).toBe('draft');
    expect(stillDraft[0]!.gl_journal_entry_id).toBe(posted.journalEntryId);

    // Step 2 — the agent approves the same bill.
    const approved = await inTx(() => approveSupplierInvoice(COMPANY, id, USER));

    // The whole point: still ONE journal, and it is the ORIGINAL one.
    expect(await journalCountFor(number)).toBe(1);
    expect(approved.status).toBe('approved');
    expect(approved.glJournalEntryId).toBe(posted.journalEntryId);
  });

  /** The ordinary path must be untouched by the guard. */
  it('still posts a journal for a draft that has none', async () => {
    const number = `${TAG}-B`;
    const id = await inTx(() => makeInvoice(number));
    expect(await journalCountFor(number)).toBe(0);

    const approved = await inTx(() => approveSupplierInvoice(COMPANY, id, USER));

    expect(await journalCountFor(number)).toBe(1);
    expect(approved.status).toBe('approved');
    expect(approved.glJournalEntryId).toBeTruthy();
  });
});
