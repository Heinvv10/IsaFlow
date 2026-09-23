/**
 * R-118 — `postSupplierInvoiceToGL` guards only `cancelled`, so the bulk
 * "Post to GL" action (supplier-invoices-bulk-action.ts, action=post_gl,
 * offered on any selection) posts an Expense/VAT/AP journal for a DRAFT bill.
 *
 * The journal then stands on the GL half of every AP-vs-GL reconciliation
 * while `documentInPopulationExpr` keeps the draft off the document half — a
 * permanent difference by the bill's full amount, which is exactly what the
 * migration validation check exists to surface.
 *
 * A draft is posted by APPROVING it (`approveSupplierInvoice` posts and moves
 * the status together). This path is the backfill for documents already in the
 * population, so it must refuse anything outside it.
 *
 * The AR mirror is the same shape: `postCustomerInvoiceToGL`, reachable from
 * pages/api/accounting/customer-invoices-gl.ts with no status filter.
 * `approveCustomerInvoice` sets the status BEFORE it posts, so the ordinary
 * approval path is unaffected on that side too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R118-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let supplier: string;
let expenseAccount: string;

function run<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
}

/** One committed request transaction, as withAuth does on success. */
async function drive<T>(fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  await c.query('BEGIN');
  let committed = false;
  try {
    const out = await run(c, fn);
    await c.query('COMMIT');
    committed = true;
    return out;
  } finally {
    if (!committed) await c.query('ROLLBACK');
    c.release();
  }
}

async function makeInvoice(number: string, status: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO supplier_invoices
      (company_id, supplier_id, invoice_number, invoice_date, subtotal,
       tax_rate, tax_amount, total_amount, status, created_by)
    VALUES
      (${COMPANY}::UUID, ${supplier}::UUID, ${number}, '2026-06-30', 100,
       15, 15, 115, ${status}, ${USER}::UUID)
    RETURNING id`) as { id: string }[];
  const id = rows[0]!.id;
  await sql`
    INSERT INTO supplier_invoice_items
      (supplier_invoice_id, description, quantity, unit_price, tax_rate,
       tax_amount, line_total, gl_account_id)
    VALUES (${id}::UUID, 'R118 line', 1, 100, 15, 15, 100, ${expenseAccount}::UUID)`;
  return id;
}

/** Journals for a bill are keyed by its NUMBER: the description carries that,
 *  never the id (supplierInvoiceWorkflowService writes `Supplier invoice <no>`). */
const journalCount = async (invoiceNumber: string): Promise<number> => Number(((await sql`
  SELECT count(*) AS n FROM gl_journal_entries
  WHERE company_id = ${COMPANY}::UUID AND description LIKE ${'%' + invoiceNumber + '%'}
`) as { n: string }[])[0]!.n);

describeIfDb('R-118 postSupplierInvoiceToGL refuses a document outside the AP population', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await sql`
      INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${COMPANY}::UUID, ${'R118 ' + TAG}, ${TAG}, NOW())`;
    supplier = ((await sql`
      INSERT INTO suppliers (name, company_id) VALUES (${'R118 ' + TAG}, ${COMPANY}::UUID)
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
    expenseAccount = await acct('6000', 'R118 Expense', 'expense', 'default_expense', 'debit');
    await acct('2100', 'R118 AP', 'liability', 'payable', 'credit');
    await acct('2200', 'R118 VAT Input', 'asset', 'vat_input', 'debit');
  });

  afterAll(async () => {
    await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
      SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
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

  it.each(['draft', 'pending_approval'])('refuses a %s bill and posts nothing', async (status) => {
    const number = `${TAG}-${status}`;
    const id = await drive(() => makeInvoice(number, status));

    await expect(drive(() => postSupplierInvoiceToGL(COMPANY, id, USER))).rejects.toThrow(/approv/i);

    const after = (await sql`
      SELECT status, gl_journal_entry_id FROM supplier_invoices WHERE id = ${id}::UUID
    `) as { status: string; gl_journal_entry_id: string | null }[];
    expect(after[0]!.status).toBe(status);
    expect(after[0]!.gl_journal_entry_id).toBeNull();
    expect(await journalCount(number)).toBe(0);
  });

  it('still posts an approved bill', async () => {
    const number = `${TAG}-approved`;
    const id = await drive(() => makeInvoice(number, 'approved'));
    const out = await drive(() => postSupplierInvoiceToGL(COMPANY, id, USER));
    expect(out.alreadyPosted).toBe(false);
    expect(await journalCount(number)).toBe(1);
    const after = (await sql`
      SELECT gl_journal_entry_id FROM supplier_invoices WHERE id = ${id}::UUID
    `) as { gl_journal_entry_id: string | null }[];
    expect(after[0]!.gl_journal_entry_id).toBe(out.journalEntryId);
  });

  it('is still an idempotent no-op for a draft that already carries a journal', async () => {
    // The pre-guard production shape: a journal posted while the status stayed
    // draft. Refusing it would turn a no-op into an error, and nothing new is
    // posted either way.
    const number = `${TAG}-legacy`;
    const id = await drive(() => makeInvoice(number, 'draft'));
    // A distinct number: journalCount matches by LIKE, so a `<number>-SRC`
    // source would be counted against the draft under test.
    const src = await drive(() => makeInvoice(`${TAG}-donor`, 'approved'));
    const posted = await drive(() => postSupplierInvoiceToGL(COMPANY, src, USER));
    await sql`
      UPDATE supplier_invoices SET gl_journal_entry_id = ${posted.journalEntryId}::UUID
      WHERE id = ${id}::UUID AND company_id = ${COMPANY}::UUID`;

    const out = await drive(() => postSupplierInvoiceToGL(COMPANY, id, USER));
    expect(out).toEqual({ journalEntryId: posted.journalEntryId, alreadyPosted: true });
    expect(await journalCount(number)).toBe(0);
  });

  it.each(['draft', 'pending_approval'])(
    'AR mirror: refuses a %s customer invoice and posts nothing', async (status) => {
      const number = `${TAG}-AR-${status}`;
      const customer = ((await sql`
        INSERT INTO customers (name, company_id) VALUES (${'R118 cust ' + number}, ${COMPANY}::UUID)
        RETURNING id`) as { id: string }[])[0]!.id;
      const id = ((await sql`
        INSERT INTO customer_invoices (
          company_id, invoice_number, customer_id, client_id, invoice_date, due_date,
          subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by
        ) VALUES (
          ${COMPANY}::UUID, ${number}, ${customer}::UUID, ${customer}::UUID,
          '2026-06-30', '2026-07-30', 100, 15, 15, 115, 0, ${status}, ${USER}::UUID
        ) RETURNING id`) as { id: string }[])[0]!.id;

      await expect(drive(() => postCustomerInvoiceToGL(COMPANY, id, USER))).rejects.toThrow(/approv/i);

      const after = (await sql`
        SELECT status, gl_journal_entry_id FROM customer_invoices WHERE id = ${id}::UUID
      `) as { status: string; gl_journal_entry_id: string | null }[];
      expect(after[0]!.status).toBe(status);
      expect(after[0]!.gl_journal_entry_id).toBeNull();
      expect(await journalCount(number)).toBe(0);
    });

  it('still refuses a cancelled bill', async () => {
    const id = await drive(() => makeInvoice(`${TAG}-cancelled`, 'cancelled'));
    await expect(drive(() => postSupplierInvoiceToGL(COMPANY, id, USER))).rejects.toThrow(/cancelled/i);
  });
});
