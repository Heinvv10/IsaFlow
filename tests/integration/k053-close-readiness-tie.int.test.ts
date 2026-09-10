/**
 * K-053 round 3 — the period-close AR/AP tie checks must survive a soft-delete.
 *
 * arSubLedgerCheck and apSubLedgerCheck sum the open documents on one side and
 * the posted control account on the other. Round 2 reversed the journal on
 * delete but left the document side unfiltered, so every newly deleted open
 * invoice flipped the check from pass to fail by its full amount — over the
 * R100 threshold that is a hard fail on the close checklist.
 *
 * A plain `deleted_at IS NULL` would have broken the other population: a
 * document deleted BEFORE this change kept its journal posted, so the GL still
 * carries it and the document side must too. The predicate keeps a deleted
 * document exactly while its journal is still standing, which is why both eras
 * are asserted here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { softDelete, undoDelete } from '@/modules/accounting/services/core/softDeleteService';
import { arSubLedgerCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/arSubLedgerCheck';
import { apSubLedgerCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/apSubLedgerCheck';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K053TIE-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DOC_DATE = '2026-03-15';
const PERIOD = { endDate: '2026-12-31' };

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
/** Never deleted here, used for the pre-change population. */
let historicalInvoice: string;

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

async function newCustomerInvoice(number: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${number}, ${DOC_DATE},
      '2026-04-15', 'approved', ${SUB}, 15, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

describeIfDb('K-053 close-readiness tie survives a soft-delete', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'K053TIE ' + TAG}, ${TAG})`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'K053TIE ' + TAG}, 1, 2026, '2026-01-01', '2026-12-31', 'open')`;
    await account(receivable, '1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account(payable, '2100', 'Trade Creditors', 'liability', 'credit', 'payable');
    await account(revenue, '4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    await account(expense, '5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account(vatOutput, '2200', 'VAT Output', 'liability', 'credit', 'vat_output');
    await account(vatInput, '1300', 'VAT Input', 'asset', 'debit', 'vat_input');

    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    arInvoice = await newCustomerInvoice(TAG + '-AR');
    historicalInvoice = await newCustomerInvoice(TAG + '-AR-HIST');

    const ap = (await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP'}, ${DOC_DATE}, '2026-04-15',
        'approved', ${SUB}, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[];
    apInvoice = ap[0]!.id;
    await sql`
      INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
      VALUES (${apInvoice}::UUID, ${'K053 line'}, 1, ${SUB}, 15, ${VAT}, ${SUB}, ${expense}::UUID)`;

    await inTx(() => postCustomerInvoiceToGL(COMPANY, arInvoice, USER));
    await inTx(() => postCustomerInvoiceToGL(COMPANY, historicalInvoice, USER));
    await inTx(() => postSupplierInvoiceToGL(COMPANY, apInvoice, USER));
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

  it('AR ties before the delete, after it, and after the undo', async () => {
    expect((await arSubLedgerCheck(COMPANY, PERIOD)).status).toBe('pass');

    await inTx(() => softDelete(COMPANY, 'customer_invoice', arInvoice, USER));
    const deleted = await arSubLedgerCheck(COMPANY, PERIOD);
    expect(deleted.status).toBe('pass');
    // The remaining live invoice, not zero: the check still sees real money.
    expect(deleted.reason).toContain(GROSS.toFixed(2));

    expect(await inTx(() => undoDelete(COMPANY, 'customer_invoice', arInvoice, USER))).toBe(true);
    expect((await arSubLedgerCheck(COMPANY, PERIOD)).status).toBe('pass');
  });

  it('AP ties before the delete, after it, and after the undo', async () => {
    expect((await apSubLedgerCheck(COMPANY, PERIOD)).status).toBe('pass');
    await inTx(() => softDelete(COMPANY, 'supplier_invoice', apInvoice, USER));
    expect((await apSubLedgerCheck(COMPANY, PERIOD)).status).toBe('pass');
    expect(await inTx(() => undoDelete(COMPANY, 'supplier_invoice', apInvoice, USER))).toBe(true);
    expect((await apSubLedgerCheck(COMPANY, PERIOD)).status).toBe('pass');
  });

  it('a document deleted BEFORE this change, journal still standing, keeps AR tying', async () => {
    // Exactly what production carries: deleted_at set, journal never reversed.
    await sql`UPDATE customer_invoices SET deleted_at = NOW()
              WHERE id = ${historicalInvoice}::UUID AND company_id = ${COMPANY}::UUID`;
    try {
      const check = await arSubLedgerCheck(COMPANY, PERIOD);
      expect(check.status).toBe('pass');
      // Still counted on the document side, because the GL still counts it.
      expect(check.reason).toContain((GROSS * 2).toFixed(2));
    } finally {
      await sql`UPDATE customer_invoices SET deleted_at = NULL
                WHERE id = ${historicalInvoice}::UUID AND company_id = ${COMPANY}::UUID`;
    }
  });
});
