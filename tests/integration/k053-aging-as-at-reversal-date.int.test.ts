/**
 * K-053 round 4 — the exclusion must be dated, because the reversal is.
 *
 * Soft-delete reverses the approval journal through reverseJournalEntry, which
 * dates the reversal to the ORIGINAL entry date only while that period is still
 * open, and otherwise to TODAY. For a document raised in a closed prior month —
 * the ordinary case — the GL therefore keeps carrying it right up to the delete.
 *
 * Round 3 excluded the document from aging, the subledger and the close checks
 * with an UNDATED predicate, so for every as-at date between the invoice and
 * the delete the sub-ledger side read zero while the control account still read
 * the full amount: a false difference, and a hard 'fail' on the close checklist
 * for exactly the periods a close is run on.
 *
 * The three dates that matter are asserted here: BEFORE the reversal, ON it,
 * and after a hand reversal of the delete's own reversal puts the document back
 * in the ledger. Every assertion compares the document side against a control
 * account bounded by the SAME date.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getARSubledger } from '@/modules/accounting/services/ar/arSubledgerService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import { arSubLedgerCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/arSubLedgerCheck';
import { apSubLedgerCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/apSubLedgerCheck';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K053ASAT-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Every date is relative to the clock reverseJournalEntry falls back to. */
function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const TODAY = fmtDate(new Date());
const YESTERDAY = shift(-1);
const CLOSED_END = shift(-60);
const OPEN_START = shift(-59);
const OPEN_END = shift(400);
const DOC_DATE = shift(-120);
const DUE_DATE = shift(-100);
/** Inside the closed period, after the invoice, well before the delete. */
const AS_AT_BEFORE = shift(-90);

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
let deleteReversalId: string;

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

/** Net movement on an account across posted journals dated on or before `asAt`. */
async function controlBalance(accountId: string, asAt: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(l.debit - l.credit), 0) AS net
    FROM gl_journal_lines l
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE l.company_id = ${COMPANY}::UUID AND l.gl_account_id = ${accountId}::UUID
      AND e.status = 'posted' AND e.entry_date <= ${asAt}::date
  `) as { net: string | number }[];
  return Number(rows[0]!.net);
}

async function agedAR(asAt: string): Promise<number> {
  return (await getARAging(COMPANY, asAt)).find((b) => b.entityId === customer)?.total ?? 0;
}
async function agedAP(asAt: string): Promise<number> {
  return (await getAPAging(COMPANY, asAt)).find((b) => b.entityId === supplier)?.total ?? 0;
}

async function account(id: string, code: string, name: string, type: string, normal: string, subtype: string) {
  await sql`
    INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${id}::UUID, ${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})`;
}

describeIfDb('K-053 the soft-delete exclusion is dated to the reversal', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'K053ASAT ' + TAG}, ${TAG})`;
    // Two periods. The document's own period is closed by the time it is
    // deleted, which is what forces the reversal onto today's date; today's
    // period is open, or the delete would simply be refused.
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'K053ASAT prior ' + TAG}, 1, 2026, '2020-01-01', ${CLOSED_END}::date, 'open'),
                     (${COMPANY}::UUID, ${'K053ASAT current ' + TAG}, 2, 2026, ${OPEN_START}::date, ${OPEN_END}::date, 'open')`;
    await account(receivable, '1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account(payable, '2100', 'Trade Creditors', 'liability', 'credit', 'payable');
    await account(revenue, '4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    await account(expense, '5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account(vatOutput, '2200', 'VAT Output', 'liability', 'credit', 'vat_output');
    await account(vatInput, '1300', 'VAT Input', 'asset', 'debit', 'vat_input');

    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    arInvoice = ((await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR'}, ${DOC_DATE}::date,
        ${DUE_DATE}::date, 'approved', ${SUB}, 15, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;

    apInvoice = ((await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP'}, ${DOC_DATE}::date, ${DUE_DATE}::date,
        'approved', ${SUB}, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`
      INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
      VALUES (${apInvoice}::UUID, ${'K053 line'}, 1, ${SUB}, 15, ${VAT}, ${SUB}, ${expense}::UUID)`;

    // Post while the prior period is still open, then close it: exactly the
    // production shape — an approved document in a month that has since closed.
    await inTx(() => postCustomerInvoiceToGL(COMPANY, arInvoice, USER));
    await inTx(() => postSupplierInvoiceToGL(COMPANY, apInvoice, USER));
    await sql`UPDATE fiscal_periods SET status = 'closed'
              WHERE company_id = ${COMPANY}::UUID AND end_date = ${CLOSED_END}::date`;
  }, 120000);

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

  it('the delete is dated TODAY because the document period is closed', async () => {
    await inTx(() => softDelete(COMPANY, 'customer_invoice', arInvoice, USER));
    await inTx(() => softDelete(COMPANY, 'supplier_invoice', apInvoice, USER));

    const rows = (await sql`
      SELECT e.id, e.entry_date
      FROM soft_delete_journal_reversals r
      JOIN gl_journal_entries e ON e.id = r.reversal_journal_entry_id
      WHERE r.company_id = ${COMPANY}::UUID AND r.entity_type = 'customer_invoice'
    `) as { id: string; entry_date: unknown }[];
    expect(rows).toHaveLength(1);
    deleteReversalId = rows[0]!.id;
    // The premise of the whole file: the reversal is NOT dated to the document.
    expect(fmtDate(new Date(String(rows[0]!.entry_date)))).toBe(TODAY);
  });

  it('AR: as at a date BEFORE the reversal the invoice is still aged and still on the control account', async () => {
    expect(await controlBalance(receivable, AS_AT_BEFORE)).toBeCloseTo(GROSS, 2);
    expect(await agedAR(AS_AT_BEFORE)).toBeCloseTo(GROSS, 2);
    expect((await getARSubledger(COMPANY, AS_AT_BEFORE)).subledgerTotal).toBeCloseTo(GROSS, 2);

    const check = await arSubLedgerCheck(COMPANY, { endDate: AS_AT_BEFORE });
    expect(check.status).toBe('pass');
    expect(check.reason).toContain(GROSS.toFixed(2));

    // And on the last day before the reversal, not only deep in the past.
    expect(await controlBalance(receivable, YESTERDAY)).toBeCloseTo(GROSS, 2);
    expect(await agedAR(YESTERDAY)).toBeCloseTo(GROSS, 2);
    expect((await arSubLedgerCheck(COMPANY, { endDate: YESTERDAY })).status).toBe('pass');
  });

  it('AP: as at a date BEFORE the reversal the bill is still aged and still on the control account', async () => {
    expect(await controlBalance(payable, AS_AT_BEFORE)).toBeCloseTo(-GROSS, 2);
    expect(await agedAP(AS_AT_BEFORE)).toBeCloseTo(GROSS, 2);
    expect((await apSubLedgerCheck(COMPANY, { endDate: AS_AT_BEFORE })).status).toBe('pass');
    expect(await agedAP(YESTERDAY)).toBeCloseTo(GROSS, 2);
    expect((await apSubLedgerCheck(COMPANY, { endDate: YESTERDAY })).status).toBe('pass');
  });

  it('ON the reversal date both sides drop together, on both ledgers', async () => {
    expect(await controlBalance(receivable, TODAY)).toBeCloseTo(0, 2);
    expect(await agedAR(TODAY)).toBeCloseTo(0, 2);
    expect((await getARSubledger(COMPANY, TODAY)).subledgerTotal).toBeCloseTo(0, 2);
    expect((await arSubLedgerCheck(COMPANY, { endDate: TODAY })).status).toBe('pass');

    expect(await controlBalance(payable, TODAY)).toBeCloseTo(0, 2);
    expect(await agedAP(TODAY)).toBeCloseTo(0, 2);
    expect((await apSubLedgerCheck(COMPANY, { endDate: TODAY })).status).toBe('pass');
  });

  it('reversing the delete reversal by hand puts the document back on BOTH sides', async () => {
    // The case softDeleteJournalService argues about but the round-3 check
    // could not see: the chain nets back to standing, so the GL carries the
    // document again and the sub-ledger side must carry it again too.
    await inTx(() => reverseJournalEntry(COMPANY, deleteReversalId, USER));

    expect(await controlBalance(receivable, TODAY)).toBeCloseTo(GROSS, 2);
    expect(await agedAR(TODAY)).toBeCloseTo(GROSS, 2);
    expect((await getARSubledger(COMPANY, TODAY)).subledgerTotal).toBeCloseTo(GROSS, 2);
    const check = await arSubLedgerCheck(COMPANY, { endDate: TODAY });
    expect(check.status).toBe('pass');
    expect(check.reason).toContain(GROSS.toFixed(2));
  });
});
