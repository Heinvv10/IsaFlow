/**
 * D7 round 2 — the VAT201 pre-filing exception "journal_reversed" reads the
 * reversal CHAIN as at the period end, not one link of it.
 *
 * `findUnpostedInvoiceVat` blocks a period on an issued invoice / approved bill
 * whose linked journal has a posted reversal dated on or before the period
 * end. A soft-delete that is UNDONE inside an open period leaves exactly that
 * shape on a live document: reverseJournalEntry dates both the delete's
 * reversal R and the undo's R2 to the original's date while its period is
 * open, so O <- R <- R2 all sit in the document's own period. The chain nets
 * back to standing and the VAT IS in the filed ledger, yet O "has a posted
 * reversal", so the document blocked the period as journal_reversed. The
 * fixture checks the other direction as well: a live document whose journal
 * is reversed and stays reversed must still block.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { findUnpostedInvoiceVat } from '@/modules/accounting/services/reports/vatUnpostedInvoices';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { softDelete, undoDelete } from '@/modules/accounting/services/core/softDeleteService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `D7VATU-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
/** Mid-month, a month back: an open period the reversals are dated into. */
const DOC_DATE = (() => { const d = new Date(); d.setMonth(d.getMonth() - 1, 15); return fmtDate(d); })();
const PERIOD_START = `${DOC_DATE.slice(0, 7)}-01`;
const PERIOD_END = (() => { const d = new Date(DOC_DATE); d.setMonth(d.getMonth() + 1, 0); return fmtDate(d); })();

const SUB = 1000;
const VAT = 150;

const receivable = randomUUID();
const payable = randomUUID();
const revenue = randomUUID();
const expense = randomUUID();
const vatOutput = randomUUID();
const vatInput = randomUUID();

let customer: string;
let supplier: string;

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId: USER, companyId: COMPANY, claims: {} }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function account(id: string, code: string, name: string, type: string, normal: string, subtype: string) {
  await sql`
    INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${id}::UUID, ${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})`;
}

async function postPair(suffix: string): Promise<{ ar: string; ap: string }> {
  const ar = ((await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR' + suffix}, ${DOC_DATE}::date,
      ${DOC_DATE}::date, 'approved', ${SUB}, 15, ${VAT}, ${SUB + VAT}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  const ap = ((await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP' + suffix}, ${DOC_DATE}::date, ${DOC_DATE}::date,
      'approved', ${SUB}, ${VAT}, ${SUB + VAT}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  await sql`
    INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
    VALUES (${ap}::UUID, ${'D7 line'}, 1, ${SUB}, 15, ${VAT}, ${SUB}, ${expense}::UUID)`;
  await inTx(() => postCustomerInvoiceToGL(COMPANY, ar, USER));
  await inTx(() => postSupplierInvoiceToGL(COMPANY, ap, USER));
  return { ar, ap };
}

async function headOf(id: string): Promise<string> {
  // The un-reversed, posted entry of the document's chain.
  return ((await sql`
    WITH RECURSIVE chain AS (
      SELECT je.id, je.reversed_at FROM gl_journal_entries je
      WHERE je.company_id = ${COMPANY}::UUID AND je.id = (
        SELECT gl_journal_entry_id FROM customer_invoices WHERE company_id = ${COMPANY}::UUID AND id = ${id}::UUID
        UNION ALL
        SELECT gl_journal_entry_id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID AND id = ${id}::UUID)
      UNION ALL
      SELECT j.id, j.reversed_at FROM gl_journal_entries j JOIN chain c ON j.reversal_of_id = c.id
      WHERE j.company_id = ${COMPANY}::UUID AND j.status = 'posted')
    SELECT id FROM chain WHERE reversed_at IS NULL`) as { id: string }[])[0]!.id;
}

async function blocking(): Promise<string[]> {
  const rows = await findUnpostedInvoiceVat(COMPANY, PERIOD_START, PERIOD_END);
  return rows.map((r) => `${String(r.invoice_number).replace(TAG, '')} ${String(r.reason)}`).sort();
}

describeIfDb('D7 VAT201 journal_reversed reads the chain, not one link', () => {
  let restored: { ar: string; ap: string };

  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'D7VATU ' + TAG}, ${TAG})`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'D7VATU open ' + TAG}, 1, 2026, '2020-01-01', ${shift(400)}::date, 'open')`;
    await account(receivable, '1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account(payable, '2100', 'Trade Creditors', 'liability', 'credit', 'payable');
    await account(revenue, '4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    await account(expense, '5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account(vatOutput, '2200', 'VAT Output', 'liability', 'credit', 'vat_output');
    await account(vatInput, '1300', 'VAT Input', 'asset', 'debit', 'vat_input');
    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    restored = await postPair('-RESTORED');
  }, 180000);

  afterAll(async () => {
    await sql`DELETE FROM soft_delete_journal_reversals WHERE company_id = ${COMPANY}::UUID`;
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

  it('a document deleted and restored inside its open period does not block', async () => {
    for (const [type, id] of [['customer_invoice', restored.ar], ['supplier_invoice', restored.ap]] as const) {
      await inTx(() => softDelete(COMPANY, type, id, USER));
      await inTx(() => undoDelete(COMPANY, type, id, USER));
    }
    // The premise: O <- R <- R2, all three posted and dated in the period.
    const inPeriod = (await sql`
      SELECT COUNT(*)::int AS n FROM gl_journal_entries
      WHERE company_id = ${COMPANY}::UUID AND status = 'posted'
        AND entry_date BETWEEN ${PERIOD_START}::date AND ${PERIOD_END}::date`) as { n: number }[];
    expect(inPeriod[0]!.n).toBe(6);
    expect(await blocking()).toEqual([]);
  });

  it('the restored document reversed again by hand blocks — its chain is out of the ledger', async () => {
    await inTx(async () => reverseJournalEntry(COMPANY, await headOf(restored.ar), USER));
    await inTx(async () => reverseJournalEntry(COMPANY, await headOf(restored.ap), USER));
    expect(await blocking()).toEqual(['-AP-RESTORED journal_reversed', '-AR-RESTORED journal_reversed']);
  });

  it('the mirror: a live document reversed once by hand still blocks', async () => {
    const live = await postPair('-LIVE');
    await inTx(async () => reverseJournalEntry(COMPANY, await headOf(live.ar), USER));
    await inTx(async () => reverseJournalEntry(COMPANY, await headOf(live.ap), USER));
    expect(await blocking()).toEqual([
      '-AP-LIVE journal_reversed', '-AP-RESTORED journal_reversed',
      '-AR-LIVE journal_reversed', '-AR-RESTORED journal_reversed',
    ]);
  });
});
