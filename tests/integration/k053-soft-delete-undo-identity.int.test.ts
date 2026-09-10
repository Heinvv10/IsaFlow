/**
 * K-053 round 3 — the delete/undo round trip must be IDENTITY on the ledger,
 * and the close-readiness tie must survive a soft-delete.
 *
 * Round 2 inferred what to re-instate from the reversal chain, which cannot
 * tell a chain head this delete killed from one a user reversed on the GL
 * screen. The undo then posted a fresh journal re-instating revenue and VAT
 * output somebody had deliberately reversed. The reversal id is now recorded
 * (soft_delete_journal_reversals, migration 653) and the undo reverses that
 * entry or nothing.
 *
 * Also covered here: the full cancel-strength payments guard, the refusals
 * that used to be silent, the 400 on the undo path, and the journal-row lock.
 * The close-readiness tie has its own file, k053-close-readiness-tie.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { SignJWT } from 'jose';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { softDelete, undoDelete } from '@/modules/accounting/services/core/softDeleteService';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import softDeleteRoute from '../../pages/api/accounting/soft-delete';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K053ID-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
/** Approved, posted, then reversed BY HAND before any delete. */
let manuallyReversed: string;
/** Approved, posted; the ordinary delete/undo and the lock case. */
let arInvoice: string;
let apInvoice: string;
/** Approved, amount_paid = 0, but carrying a DRAFT payment allocation. */
let allocatedInvoice: string;
let allocatedBill: string;
/** Its gl_journal_entry_id points at another company's entry. */
let crossTenantLinked: string;
let token = '';

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

async function postedEntryCount(): Promise<number> {
  const rows = (await sql`
    SELECT count(*) AS n FROM gl_journal_entries
    WHERE company_id = ${COMPANY}::UUID AND status = 'posted'
  `) as { n: string | number }[];
  return Number(rows[0]!.n);
}

async function recordedReversals(entityId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*) AS n FROM soft_delete_journal_reversals
    WHERE company_id = ${COMPANY}::UUID AND entity_id = ${entityId}::UUID
  `) as { n: string | number }[];
  return Number(rows[0]!.n);
}

async function account(id: string, code: string, name: string, type: string, normal: string, subtype: string) {
  await sql`
    INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${id}::UUID, ${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})`;
}

async function newCustomerInvoice(number: string, status = 'approved'): Promise<string> {
  const rows = (await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${number}, ${DOC_DATE},
      '2026-04-15', ${status}, ${SUB}, 15, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

async function newSupplierBill(number: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${number}, ${DOC_DATE}, '2026-04-15',
      'approved', ${SUB}, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[];
  const id = rows[0]!.id;
  await sql`
    INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
    VALUES (${id}::UUID, ${'K053 line'}, 1, ${SUB}, 15, ${VAT}, ${SUB}, ${expense}::UUID)`;
  return id;
}

describeIfDb('K-053 delete/undo is identity on the ledger', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'K053ID ' + TAG}, ${TAG}),
                     (${OTHER_COMPANY}::UUID, ${'K053ID-B ' + TAG}, ${TAG + '-B'})`;
    await sql`INSERT INTO users (id, email, role, is_active)
              VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role)
              VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'K053ID ' + TAG}, 1, 2026, '2026-01-01', '2026-12-31', 'open')`;

    await account(receivable, '1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account(payable, '2100', 'Trade Creditors', 'liability', 'credit', 'payable');
    await account(revenue, '4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    await account(expense, '5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account(vatOutput, '2200', 'VAT Output', 'liability', 'credit', 'vat_output');
    await account(vatInput, '1300', 'VAT Input', 'asset', 'debit', 'vat_input');

    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    manuallyReversed = await newCustomerInvoice(TAG + '-AR-MANUAL');
    arInvoice = await newCustomerInvoice(TAG + '-AR');
    allocatedInvoice = await newCustomerInvoice(TAG + '-AR-ALLOC');
    crossTenantLinked = await newCustomerInvoice(TAG + '-AR-XT');
    apInvoice = await newSupplierBill(TAG + '-AP');
    allocatedBill = await newSupplierBill(TAG + '-AP-ALLOC');

    await inTx(() => postCustomerInvoiceToGL(COMPANY, manuallyReversed, USER));
    await inTx(() => postCustomerInvoiceToGL(COMPANY, arInvoice, USER));
    await inTx(() => postSupplierInvoiceToGL(COMPANY, apInvoice, USER));

    // A DRAFT payment allocated to the invoice. amount_paid stays 0, which is
    // exactly the state cancel refuses and round 2's guard let through.
    const payment = ((await sql`
      INSERT INTO customer_payments (company_id, client_id, payment_date, total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${customer}::UUID, ${DOC_DATE}, 300, 'draft', ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
              VALUES (${payment}::UUID, ${allocatedInvoice}::UUID, 300)`;

    const supplierPayment = ((await sql`
      INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${DOC_DATE}, 300, 'draft', ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO supplier_payment_allocations (payment_id, invoice_id, amount_allocated)
              VALUES (${supplierPayment}::UUID, ${allocatedBill}::UUID, 300)`;

    // Point one invoice at an entry that exists but belongs to another company,
    // which is what a link this company cannot reason about looks like.
    const foreignEntry = ((await sql`
      INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by)
      VALUES (${OTHER_COMPANY}::UUID, ${TAG + '-FOREIGN'}, ${DOC_DATE}, 'foreign', 'posted', ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`UPDATE customer_invoices SET gl_journal_entry_id = ${foreignEntry}::UUID
              WHERE id = ${crossTenantLinked}::UUID AND company_id = ${COMPANY}::UUID`;

    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM soft_delete_journal_reversals WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_payment_allocations WHERE payment_id IN
                (SELECT id FROM customer_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_payment_allocations WHERE payment_id IN
                (SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM customer_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN
                (SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id IN (${COMPANY}::UUID, ${OTHER_COMPANY}::UUID)`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id IN (${COMPANY}::UUID, ${OTHER_COMPANY}::UUID)`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN
                (${receivable}::UUID, ${payable}::UUID, ${revenue}::UUID, ${expense}::UUID, ${vatOutput}::UUID, ${vatInput}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id IN (${COMPANY}::UUID, ${OTHER_COMPANY}::UUID)`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  it('a journal reversed by hand is not re-instated by a delete/undo round trip', async () => {
    // The user reverses the approval journal from the GL screen. Unlike cancel,
    // that path leaves the invoice pointing at the reversed original.
    const entry = ((await sql`
      SELECT gl_journal_entry_id AS id FROM customer_invoices
      WHERE id = ${manuallyReversed}::UUID AND company_id = ${COMPANY}::UUID
    `) as { id: string }[])[0]!.id;
    await inTx(() => reverseJournalEntry(COMPANY, entry, USER));

    const receivableAfterManual = await controlBalance(receivable);
    const revenueAfterManual = await controlBalance(revenue);
    const vatAfterManual = await controlBalance(vatOutput);
    const entriesAfterManual = await postedEntryCount();

    await inTx(() => softDelete(COMPANY, 'customer_invoice', manuallyReversed, USER));
    // The delete found nothing live to reverse, so it recorded nothing.
    expect(await recordedReversals(manuallyReversed)).toBe(0);
    expect(await controlBalance(receivable)).toBeCloseTo(receivableAfterManual, 2);

    expect(await inTx(() => undoDelete(COMPANY, 'customer_invoice', manuallyReversed, USER))).toBe(true);

    // Identity: no journal posted, and the user's reversal still stands.
    expect(await postedEntryCount()).toBe(entriesAfterManual);
    expect(await controlBalance(receivable)).toBeCloseTo(receivableAfterManual, 2);
    expect(await controlBalance(revenue)).toBeCloseTo(revenueAfterManual, 2);
    expect(await controlBalance(vatOutput)).toBeCloseTo(vatAfterManual, 2);
  });

  it('a delete records its reversal and the undo consumes exactly that row', async () => {
    const before = await controlBalance(receivable);
    await inTx(() => softDelete(COMPANY, 'customer_invoice', arInvoice, USER));
    expect(await recordedReversals(arInvoice)).toBe(1);
    expect(await controlBalance(receivable)).toBeCloseTo(before - GROSS, 2);

    expect(await inTx(() => undoDelete(COMPANY, 'customer_invoice', arInvoice, USER))).toBe(true);
    expect(await recordedReversals(arInvoice)).toBe(0);
    expect(await controlBalance(receivable)).toBeCloseTo(before, 2);

    // A second delete records a FRESH reversal, not the stale one.
    await inTx(() => softDelete(COMPANY, 'customer_invoice', arInvoice, USER));
    expect(await recordedReversals(arInvoice)).toBe(1);
    expect(await inTx(() => undoDelete(COMPANY, 'customer_invoice', arInvoice, USER))).toBe(true);
    expect(await controlBalance(receivable)).toBeCloseTo(before, 2);
  });

  it('a bill delete records its reversal and the undo consumes exactly that row', async () => {
    const before = await controlBalance(payable);
    await inTx(() => softDelete(COMPANY, 'supplier_invoice', apInvoice, USER));
    expect(await recordedReversals(apInvoice)).toBe(1);
    expect(await controlBalance(payable)).toBeCloseTo(before + GROSS, 2);

    expect(await inTx(() => undoDelete(COMPANY, 'supplier_invoice', apInvoice, USER))).toBe(true);
    expect(await recordedReversals(apInvoice)).toBe(0);
    expect(await controlBalance(payable)).toBeCloseTo(before, 2);
  });

  it('refuses to delete an invoice carrying a DRAFT payment allocation', async () => {
    const paid = (await sql`SELECT amount_paid FROM customer_invoices WHERE id = ${allocatedInvoice}::UUID`) as { amount_paid: string }[];
    expect(Number(paid[0]!.amount_paid)).toBe(0);
    await expect(inTx(() => softDelete(COMPANY, 'customer_invoice', allocatedInvoice, USER)))
      .rejects.toThrow(/with payments/i);
  });

  it('refuses to delete a bill carrying a DRAFT payment allocation', async () => {
    await expect(inTx(() => softDelete(COMPANY, 'supplier_invoice', allocatedBill, USER)))
      .rejects.toThrow(/with payments/i);
  });

  it('refuses, rather than silently skipping, when the journal link is unreachable', async () => {
    await expect(inTx(() => softDelete(COMPANY, 'customer_invoice', crossTenantLinked, USER)))
      .rejects.toThrow(/does not exist in this company/i);
    const rows = (await sql`SELECT deleted_at FROM customer_invoices WHERE id = ${crossTenantLinked}::UUID`) as { deleted_at: unknown }[];
    expect(rows[0]!.deleted_at).toBeNull();
  });

  it('the undo route answers 400, not 500, when the period closed since the delete', async () => {
    await inTx(() => softDelete(COMPANY, 'customer_invoice', arInvoice, USER));
    await sql`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = ${COMPANY}::UUID`;
    try {
      const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'PUT');
      (req as unknown as { body: unknown }).body = { entityType: 'customer_invoice', entityId: arInvoice };
      const result = response();
      await softDeleteRoute(req, result.res);
      expect(result.state.statusCode).toBe(400);
    } finally {
      await sql`UPDATE fiscal_periods SET status = 'open' WHERE company_id = ${COMPANY}::UUID`;
    }
    expect(await inTx(() => undoDelete(COMPANY, 'customer_invoice', arInvoice, USER))).toBe(true);
  });

  it('blocks on the journal row, so a concurrent GL reversal cannot land mid-delete', async () => {
    const entry = ((await sql`
      SELECT gl_journal_entry_id AS id FROM customer_invoices
      WHERE id = ${arInvoice}::UUID AND company_id = ${COMPANY}::UUID
    `) as { id: string }[])[0]!.id;

    const holder: PoolClient = await getPoolForTests().connect();
    let settled = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM gl_journal_entries WHERE id = $1 FOR UPDATE', [entry]);

      const deleting = inTx(() => softDelete(COMPANY, 'customer_invoice', arInvoice, USER))
        .then(() => { settled = true; }, () => { settled = true; });

      await new Promise((resolve) => setTimeout(resolve, 700));
      // The delete cannot have decided anything while the entry is locked.
      expect(settled).toBe(false);

      await holder.query('ROLLBACK');
      await deleting;
      expect(settled).toBe(true);
    } finally {
      holder.release();
    }
    expect(await inTx(() => undoDelete(COMPANY, 'customer_invoice', arInvoice, USER))).toBe(true);
  });

  it('cancelling a soft-deleted document is refused as not found, not a 500', async () => {
    // The delete reverses the approval journal but deliberately KEEPS
    // gl_journal_entry_id pointing at the original so the undo can find it.
    // Cancel used to lock the row with no deleted_at filter and then reverse
    // that same entry, which is already reversed_at-stamped: reverseJournalEntry
    // threw 'Journal entry already reversed', an uncaught fault the cancel route
    // and the MCP cancel tools both map to 500. Refusing on the lock read is the
    // fix; the document is not found because the delete already removed it.
    await inTx(() => softDelete(COMPANY, 'customer_invoice', arInvoice, USER));
    await inTx(() => softDelete(COMPANY, 'supplier_invoice', apInvoice, USER));

    await expect(inTx(() => cancelCustomerInvoice(COMPANY, arInvoice, USER)))
      .rejects.toThrow(/not found/i);
    await expect(inTx(() => cancelSupplierInvoice(COMPANY, apInvoice, USER)))
      .rejects.toThrow(/not found/i);

    // And the refusal changed nothing: still deleted, still one recorded
    // reversal each, and the undo still round-trips the ledger.
    expect(await recordedReversals(arInvoice)).toBe(1);
    expect(await recordedReversals(apInvoice)).toBe(1);
    const statuses = (await sql`
      SELECT status FROM customer_invoices WHERE id = ${arInvoice}::UUID
    `) as { status: string }[];
    expect(statuses[0]!.status).not.toBe('cancelled');

    expect(await inTx(() => undoDelete(COMPANY, 'customer_invoice', arInvoice, USER))).toBe(true);
    expect(await inTx(() => undoDelete(COMPANY, 'supplier_invoice', apInvoice, USER))).toBe(true);
  });

  it('the route decides 400 vs 500 by TYPE: refusals are 400, data faults stay 500', async () => {
    // Round 3 decided with `message.includes('not found')`, which also matched
    // reverseJournalEntry's `Journal entry <id> not found` and getSystemAccount's
    // "... account not found" — genuine faults, answered as a 400 carrying the
    // raw internal message and never reaching the log.error branch.
    const post = async (entityId: string) => {
      const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'POST');
      (req as unknown as { body: unknown }).body = { entityType: 'customer_invoice', entityId };
      const result = response();
      await softDeleteRoute(req, result.res);
      return result.state;
    };

    // A refusal: nothing by that id in this company.
    expect((await post(randomUUID())).statusCode).toBe(400);

    // A fault: the link points at another company's entry. Not something the
    // caller can fix, so it must NOT come back as a 400 with internals in it.
    expect((await post(crossTenantLinked)).statusCode).toBe(500);

    // A refusal again, and the one MEDIUM-3 named: the walk follows posted rows
    // only, so a reversal left un-posted empties the chain. That is reachable
    // without corruption and used to be an opaque 500 that blocked the delete
    // for good.
    const reversal = ((await sql`
      SELECT id FROM gl_journal_entries
      WHERE company_id = ${COMPANY}::UUID AND reversal_of_id = (
        SELECT gl_journal_entry_id FROM customer_invoices WHERE id = ${manuallyReversed}::UUID
      )
    `) as { id: string }[])[0]!.id;
    await sql`UPDATE gl_journal_entries SET status = 'draft'
              WHERE id = ${reversal}::UUID AND company_id = ${COMPANY}::UUID`;
    try {
      const state = await post(manuallyReversed);
      expect(state.statusCode).toBe(400);
      expect(JSON.stringify(state.body)).toMatch(/unexpected reversal chain/i);
    } finally {
      await sql`UPDATE gl_journal_entries SET status = 'posted'
                WHERE id = ${reversal}::UUID AND company_id = ${COMPANY}::UUID`;
    }
  });
});
