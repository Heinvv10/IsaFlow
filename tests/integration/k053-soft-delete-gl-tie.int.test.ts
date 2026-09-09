/**
 * K-053 — soft-delete must move the LEDGER, not just the report.
 *
 * Approving a document posts a journal; cancelling reverses it. Soft-delete
 * only ever set deleted_at, so once aging and the subledger exclude the deleted
 * document its debit stays on the control account and the three stop tying —
 * a second, invisible cause of the AR control-account variance already open on
 * these books. These tests assert the tie itself:
 *
 *     aging total == subledger total == control-account movement
 *
 * before the delete, after it, and after the undo, on both sides. Every journal
 * written is checked to balance.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getARSubledger } from '@/modules/accounting/services/ar/arSubledgerService';
import { getAPSubledger } from '@/modules/accounting/services/ap/apSubledgerService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { softDelete, undoDelete } from '@/modules/accounting/services/core/softDeleteService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K053GL-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const AS_AT = '2026-06-30';
const DOC_DATE = '2026-03-15';

const SUB = 1000;
const VAT = 150;
const GROSS = SUB + VAT;

const receivable = randomUUID();
const payable = randomUUID();
const revenue = randomUUID();
const expense = randomUUID();
const vatOutput = randomUUID();
const vatInput = randomUUID();

let customer: string;
let supplier: string;
let arInvoice: string;
let apInvoice: string;
let paidInvoice: string;

/**
 * Run inside a request transaction, which is what these services assume:
 * softDelete opens a SAVEPOINT and postSupplierInvoiceToGL takes a row lock
 * that refuses to run where FOR UPDATE would be released immediately.
 */
async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const ctx = { client, userId: USER, companyId: COMPANY, claims: {} };
    const result = await als.run(ctx, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Net movement on an account across POSTED journals only. */
async function controlBalance(accountId: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(l.debit - l.credit), 0) AS net
    FROM gl_journal_lines l
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE l.company_id = ${COMPANY}::UUID AND l.gl_account_id = ${accountId}::UUID
      AND e.status = 'posted'
  `) as { net: string | number }[];
  return Number(rows[0]!.net);
}

/** Every posted journal on this company nets to zero, individually. */
async function unbalancedJournals(): Promise<number> {
  const rows = (await sql`
    SELECT e.id
    FROM gl_journal_entries e
    JOIN gl_journal_lines l ON l.journal_entry_id = e.id
    WHERE e.company_id = ${COMPANY}::UUID AND e.status = 'posted'
    GROUP BY e.id
    HAVING ROUND(SUM(l.debit)::numeric, 2) <> ROUND(SUM(l.credit)::numeric, 2)
  `) as { id: string }[];
  return rows.length;
}

async function account(id: string, code: string, name: string, type: string, normal: string, subtype: string) {
  await sql`
    INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${id}::UUID, ${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})`;
}

describeIfDb('K-053 soft-delete keeps aging, the subledger and the GL tied', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'K053GL ' + TAG}, ${TAG})`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'K053GL ' + TAG}, 1, 2026, '2026-01-01', '2026-12-31', 'open')`;
    await account(receivable, '1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account(payable, '2100', 'Trade Creditors', 'liability', 'credit', 'payable');
    await account(revenue, '4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    await account(expense, '5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account(vatOutput, '2200', 'VAT Output', 'liability', 'credit', 'vat_output');
    await account(vatInput, '1300', 'VAT Input', 'asset', 'debit', 'vat_input');

    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    const ar = (await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR'}, ${DOC_DATE},
        '2026-04-15', 'approved', ${SUB}, 15, ${VAT}, ${GROSS}, 0, ${USER}::UUID),
             (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR-PAID'}, ${DOC_DATE},
        '2026-04-15', 'partially_paid', ${SUB}, 15, ${VAT}, ${GROSS}, 500, ${USER}::UUID)
      RETURNING id`) as { id: string }[];
    arInvoice = ar[0]!.id;
    paidInvoice = ar[1]!.id;

    const ap = (await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP'}, ${DOC_DATE}, '2026-04-15',
        'approved', ${SUB}, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[];
    apInvoice = ap[0]!.id;
    // buildExpenseLines derives the debit side from the invoice's items; with
    // none the journal is unbalanced and never posts.
    await sql`
      INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
      VALUES (${apInvoice}::UUID, ${'K053 line'}, 1, ${SUB}, 15, ${VAT}, ${SUB}, ${expense}::UUID)`;

    await inTx(() => postCustomerInvoiceToGL(COMPANY, arInvoice, USER));
    await inTx(() => postSupplierInvoiceToGL(COMPANY, apInvoice, USER));
  }, 120000);

  afterAll(async () => {
    // Documents first: both invoice tables FK gl_journal_entry_id.
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN
                (SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN
                (${receivable}::UUID, ${payable}::UUID, ${revenue}::UUID, ${expense}::UUID, ${vatOutput}::UUID, ${vatInput}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
  }, 120000);

  it('AR: approved invoice is in aging, in the subledger and on the control account', async () => {
    const aged = (await getARAging(COMPANY, AS_AT)).find((b) => b.entityId === customer);
    const sub = await getARSubledger(COMPANY, AS_AT);
    // The half-paid invoice is open for 650; the one under test for 1150.
    expect(aged!.total).toBeCloseTo(GROSS + (GROSS - 500), 2);
    expect(sub.subledgerTotal).toBeCloseTo(aged!.total, 2);
    // Only the unpaid one was posted, so the control account carries 1150.
    expect(await controlBalance(receivable)).toBeCloseTo(GROSS, 2);
    expect(await unbalancedJournals()).toBe(0);
  });

  it('AR: soft-delete reverses the journal, so aging, subledger and control all drop together', async () => {
    await inTx(() => softDelete(COMPANY, 'customer_invoice', arInvoice, USER));

    const aged = (await getARAging(COMPANY, AS_AT)).find((b) => b.entityId === customer);
    const sub = await getARSubledger(COMPANY, AS_AT);
    expect(aged!.total).toBeCloseTo(GROSS - 500, 2);
    expect(sub.subledgerTotal).toBeCloseTo(aged!.total, 2);
    // The invoice's debit is gone from the control account, not merely from the report.
    expect(await controlBalance(receivable)).toBeCloseTo(0, 2);
    // Revenue and VAT Output came off with it, and the reversal balances.
    expect(await controlBalance(revenue)).toBeCloseTo(0, 2);
    expect(await controlBalance(vatOutput)).toBeCloseTo(0, 2);
    expect(await unbalancedJournals()).toBe(0);

    const reversals = (await sql`
      SELECT id FROM gl_journal_entries
      WHERE company_id = ${COMPANY}::UUID AND reversal_of_id IS NOT NULL AND status = 'posted'
    `) as { id: string }[];
    expect(reversals).toHaveLength(1);
  });

  it('AR: undo re-instates the journal, so the three tie again', async () => {
    expect(await inTx(() => undoDelete(COMPANY, 'customer_invoice', arInvoice, USER))).toBe(true);

    const aged = (await getARAging(COMPANY, AS_AT)).find((b) => b.entityId === customer);
    const sub = await getARSubledger(COMPANY, AS_AT);
    expect(aged!.total).toBeCloseTo(GROSS + (GROSS - 500), 2);
    expect(sub.subledgerTotal).toBeCloseTo(aged!.total, 2);
    expect(await controlBalance(receivable)).toBeCloseTo(GROSS, 2);
    expect(await unbalancedJournals()).toBe(0);
  });

  it('AP: soft-delete and undo move the payable control account with the report', async () => {
    expect(await controlBalance(payable)).toBeCloseTo(-GROSS, 2);

    await inTx(() => softDelete(COMPANY, 'supplier_invoice', apInvoice, USER));
    expect((await getAPAging(COMPANY, AS_AT)).find((b) => b.entityId === supplier)).toBeUndefined();
    expect((await getAPSubledger(COMPANY, AS_AT)).subledgerTotal).toBeCloseTo(0, 2);
    expect(await controlBalance(payable)).toBeCloseTo(0, 2);
    expect(await unbalancedJournals()).toBe(0);

    expect(await inTx(() => undoDelete(COMPANY, 'supplier_invoice', apInvoice, USER))).toBe(true);
    const aged = (await getAPAging(COMPANY, AS_AT)).find((b) => b.entityId === supplier);
    expect(aged!.total).toBeCloseTo(GROSS, 2);
    expect((await getAPSubledger(COMPANY, AS_AT)).subledgerTotal).toBeCloseTo(aged!.total, 2);
    expect(await controlBalance(payable)).toBeCloseTo(-GROSS, 2);
    expect(await unbalancedJournals()).toBe(0);
  });

  it('refuses to delete an invoice carrying payments, and writes nothing', async () => {
    await expect(inTx(() => softDelete(COMPANY, 'customer_invoice', paidInvoice, USER)))
      .rejects.toThrow(/with payments/i);
    const rows = (await sql`SELECT deleted_at FROM customer_invoices WHERE id = ${paidInvoice}::UUID`) as { deleted_at: unknown }[];
    expect(rows[0]!.deleted_at).toBeNull();
  });

  it('refuses to delete when the reversal has no open period, and leaves the journal posted', async () => {
    await sql`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = ${COMPANY}::UUID`;
    try {
      await expect(inTx(() => softDelete(COMPANY, 'customer_invoice', arInvoice, USER)))
        .rejects.toThrow(/period/i);
      const rows = (await sql`SELECT deleted_at FROM customer_invoices WHERE id = ${arInvoice}::UUID`) as { deleted_at: unknown }[];
      expect(rows[0]!.deleted_at).toBeNull();
      expect(await controlBalance(receivable)).toBeCloseTo(GROSS, 2);
      expect(await unbalancedJournals()).toBe(0);
    } finally {
      await sql`UPDATE fiscal_periods SET status = 'open' WHERE company_id = ${COMPANY}::UUID`;
    }
  });
});
