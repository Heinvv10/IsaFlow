/**
 * K-053 round 5 — the AS-AT chase surfaces ask the dated question too.
 *
 * Round 4 dated the exclusion in aging, the subledger snapshot and the close
 * checks, and deliberately left the statement surfaces on the undated
 * `deleted_at IS NULL`. The result was a NEW divergence: for every as-at date
 * between the invoice and the delete, aging and the GL control account both
 * carried the document and the statement did not — while the statement's own
 * comment claimed it ran on the same population as aging.
 *
 * These five surfaces take an as-at date (or a window with an upper bound), so
 * they take the same dated predicate:
 *
 *   - statementEmailService.fetchStatementData        (the AR statement we email)
 *   - pages/api/accounting/customer-statement          (detail AND the totals aggregate)
 *   - supplierStatementService.fetchSupplierStatementData
 *   - supplierStatementBalancesService.getSupplierStatementBalances
 *   - pages/api/accounting/reports-supplier-ledger     (running balance to dateTo)
 *   - customerLedgerService.getCustomerLedger          (round 6; the AR mirror
 *     of reports-supplier-ledger, and the sixth surface the round-5 census
 *     missed — BOTH its legs, since its opening balance was dated while its
 *     soft-delete test was not)
 *
 * dunningService, dunningCronService and smart-reminder are NOT here: they chase
 * as at NOW, never take an as-at date, and the undated predicate is correct for
 * them — at today's date the delete's reversal has already landed.
 *
 * The fixture is the ordinary production shape: a document raised in a month
 * that has since CLOSED, so reverseJournalEntry dates the delete's reversal to
 * TODAY rather than to the document.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { SignJWT } from 'jose';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { fetchStatementData } from '@/modules/accounting/services/ar/statementEmailService';
import { fetchSupplierStatementData } from '@/modules/accounting/services/ap/supplierStatementService';
import { getSupplierStatementBalances } from '@/modules/accounting/services/ap/supplierStatementBalancesService';
import { getCustomerLedger } from '@/modules/accounting/services/ar/customerLedgerService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import customerStatementRoute from '../../pages/api/accounting/customer-statement';
import supplierLedgerRoute from '../../pages/api/accounting/reports-supplier-ledger';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K053STMT-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const TODAY = fmtDate(new Date());
const CLOSED_END = shift(-60);
const OPEN_START = shift(-59);
const OPEN_END = shift(400);
const DOC_DATE = shift(-120);
const DUE_DATE = shift(-100);
/** Inside the closed period, after the document, well before the delete. */
const AS_AT_BEFORE = shift(-90);
/** After the reversal, which lands TODAY. */
const AS_AT_AFTER = shift(1);
/** Inside the window but before the document — the opening balance is zero. */
const LEDGER_FROM = shift(-150);
const PAYMENT_DATE = shift(-110);
const WINDOW_FROM = shift(-200);

const SUB = 1000;
const VAT = 150;
const GROSS = SUB + VAT;
const ON_ACCOUNT = 400;

const receivable = randomUUID();
const payable = randomUUID();
const revenue = randomUUID();
const expense = randomUUID();
const vatOutput = randomUUID();
const vatInput = randomUUID();

let customer: string;
let supplier: string;
/** A second supplier, so the on-account leg can be exercised without a payment
 *  landing on the AP statement asserted above. */
let creditSupplier: string;
let arInvoice: string;
let apInvoice: string;
let creditBill: string;
let token = '';

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

async function account(id: string, code: string, name: string, type: string, normal: string, subtype: string) {
  await sql`
    INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${id}::UUID, ${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})`;
}

type StatementBody = { data: { transactions: { reference: string }[]; summary: { totalInvoiced: number; balance: number } } };
async function customerStatement(to: string): Promise<StatementBody['data']> {
  const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
  (req as unknown as { query: unknown }).query = { customerId: customer, fromDate: WINDOW_FROM, toDate: to };
  const result = response();
  await customerStatementRoute(req, result.res);
  expect(result.state.statusCode).toBe(200);
  return (result.state.body as StatementBody).data;
}

type LedgerBody = { data: { transactions: { reference: string | null }[]; closing_balance: number } };
async function supplierLedger(dateTo?: string): Promise<LedgerBody['data']> {
  const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
  (req as unknown as { query: unknown }).query = dateTo
    ? { supplierId: supplier, dateFrom: WINDOW_FROM, dateTo }
    : { supplierId: supplier };
  const result = response();
  await supplierLedgerRoute(req, result.res);
  expect(result.state.statusCode).toBe(200);
  return (result.state.body as LedgerBody).data;
}

describeIfDb('K-053 the as-at statement surfaces are dated to the reversal', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'K053STMT ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active)
              VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role)
              VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'K053STMT prior ' + TAG}, 1, 2026, '2020-01-01', ${CLOSED_END}::date, 'open'),
                     (${COMPANY}::UUID, ${'K053STMT current ' + TAG}, 2, 2026, ${OPEN_START}::date, ${OPEN_END}::date, 'open')`;
    await account(receivable, '1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account(payable, '2100', 'Trade Creditors', 'liability', 'credit', 'payable');
    await account(revenue, '4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    await account(expense, '5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account(vatOutput, '2200', 'VAT Output', 'liability', 'credit', 'vat_output');
    await account(vatInput, '1300', 'VAT Input', 'asset', 'debit', 'vat_input');

    customer = ((await sql`INSERT INTO customers (company_id, name, email)
                           VALUES (${COMPANY}::UUID, ${'cust ' + TAG}, ${TAG + '@test.local'})
                           RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name)
                           VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    creditSupplier = ((await sql`INSERT INTO suppliers (company_id, name)
                           VALUES (${COMPANY}::UUID, ${'supp2 ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

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
    creditBill = ((await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${creditSupplier}::UUID, ${TAG + '-AP2'}, ${DOC_DATE}::date, ${DUE_DATE}::date,
        'approved', ${SUB}, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`
      INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
      VALUES (${apInvoice}::UUID, ${'K053 line'}, 1, ${SUB}, 15, ${VAT}, ${SUB}, ${expense}::UUID),
             (${creditBill}::UUID, ${'K053 line 2'}, 1, ${SUB}, 15, ${VAT}, ${SUB}, ${expense}::UUID)`;

    await inTx(() => postCustomerInvoiceToGL(COMPANY, arInvoice, USER));
    await inTx(() => postSupplierInvoiceToGL(COMPANY, apInvoice, USER));
    await inTx(() => postSupplierInvoiceToGL(COMPANY, creditBill, USER));
    await sql`UPDATE fiscal_periods SET status = 'closed'
              WHERE company_id = ${COMPANY}::UUID AND end_date = ${CLOSED_END}::date`;

    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    // Delete both. The reversal lands TODAY because the document period closed.
    await inTx(() => softDelete(COMPANY, 'customer_invoice', arInvoice, USER));
    await inTx(() => softDelete(COMPANY, 'supplier_invoice', apInvoice, USER));
    await inTx(() => softDelete(COMPANY, 'supplier_invoice', creditBill, USER));

    // A processed payment ALREADY allocated to the deleted bill. The delete
    // guard refuses to create this shape today, so it is written directly:
    // it is the population left by documents deleted before that guard existed,
    // and it is the only thing that makes the on-account leg of
    // getSupplierStatementBalances observable at all.
    const payment = ((await sql`
      INSERT INTO supplier_payments (company_id, supplier_id, payment_number, payment_date,
        total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${creditSupplier}::UUID, ${'PMT-' + TAG.slice(-12)}, ${PAYMENT_DATE}::date,
        ${ON_ACCOUNT}, 'processed', ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`
      INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
      VALUES (${payment}::UUID, ${creditBill}::UUID, ${ON_ACCOUNT})`;
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM soft_delete_journal_reversals WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM payment_allocations WHERE payment_id IN
                (SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
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
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  it('the premise: the reversal is dated TODAY, not to the document', async () => {
    const rows = (await sql`
      SELECT e.entry_date
      FROM soft_delete_journal_reversals r
      JOIN gl_journal_entries e ON e.id = r.reversal_journal_entry_id
      WHERE r.company_id = ${COMPANY}::UUID
    `) as { entry_date: unknown }[];
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(fmtDate(new Date(String(row.entry_date)))).toBe(TODAY);
    expect(await controlBalance(receivable, AS_AT_BEFORE)).toBeCloseTo(GROSS, 2);
    // Two bills on the payable side: the statement's and the on-account one.
    expect(await controlBalance(payable, AS_AT_BEFORE)).toBeCloseTo(-2 * GROSS, 2);
  });

  it('the emailed AR statement carries the invoice as at a date before the reversal', async () => {
    const before = await fetchStatementData(COMPANY, customer, AS_AT_BEFORE);
    expect(before).not.toBeNull();
    expect(before!.transactions.map((t) => t.reference)).toEqual([TAG + '-AR']);
    expect(before!.summary.totalInvoiced).toBeCloseTo(GROSS, 2);
    // And it agrees with the control account drawn to the same date.
    expect(before!.summary.balance).toBeCloseTo(await controlBalance(receivable, AS_AT_BEFORE), 2);

    const after = await fetchStatementData(COMPANY, customer, TODAY);
    expect(after!.transactions).toHaveLength(0);
    expect(after!.summary.totalInvoiced).toBeCloseTo(0, 2);
    expect(await controlBalance(receivable, TODAY)).toBeCloseTo(0, 2);
  });

  it('the customer-statement route agrees with itself: detail and the totals aggregate', async () => {
    const before = await customerStatement(AS_AT_BEFORE);
    expect(before.transactions.map((t) => t.reference)).toEqual([TAG + '-AR']);
    // The totals come from a SEPARATE aggregate query; both halves must move.
    expect(before.summary.totalInvoiced).toBeCloseTo(GROSS, 2);

    const after = await customerStatement(TODAY);
    expect(after.transactions).toHaveLength(0);
    expect(after.summary.totalInvoiced).toBeCloseTo(0, 2);
  });

  it('the AP statement carries the bill as at a date before the reversal', async () => {
    const before = await fetchSupplierStatementData(COMPANY, supplier, AS_AT_BEFORE);
    expect(before!.transactions.map((t) => t.reference)).toEqual([TAG + '-AP']);
    expect(before!.summary.totalInvoiced).toBeCloseTo(GROSS, 2);
    expect(before!.summary.balance).toBeCloseTo(GROSS, 2);
    // This supplier is one of the two bills the payable account still carries
    // at that date; the on-account supplier's bill is the other.
    expect(await controlBalance(payable, AS_AT_BEFORE)).toBeCloseTo(-2 * GROSS, 2);

    const after = await fetchSupplierStatementData(COMPANY, supplier, TODAY);
    expect(after!.transactions).toHaveLength(0);
    expect(after!.summary.totalInvoiced).toBeCloseTo(0, 2);
    expect(await controlBalance(payable, TODAY)).toBeCloseTo(0, 2);
  });

  it('supplier statement balances tie to AP aging at both dates', async () => {
    const before = (await getSupplierStatementBalances(COMPANY, AS_AT_BEFORE))
      .find((r) => r.entityId === supplier);
    expect(before?.total).toBeCloseTo(GROSS, 2);
    expect(before?.netBalance).toBeCloseTo(GROSS, 2);

    const after = (await getSupplierStatementBalances(COMPANY, TODAY))
      .find((r) => r.entityId === supplier);
    expect(after?.total ?? 0).toBeCloseTo(0, 2);
  });

  it('the ON-ACCOUNT leg asks the same dated question as the ageing it nets against', async () => {
    // The payment is allocated to the bill, so as at a date before the delete
    // it is SETTLEMENT, not on-account funds: the bill is still payable, the
    // allocation still absorbs the money, and the net is the bill in full.
    // An undated exclusion drops the bill from that sub-query, the allocation
    // stops counting, and the same R400 is reported twice — once as a payment
    // sitting on account and once as R400 off the net balance.
    const before = (await getSupplierStatementBalances(COMPANY, AS_AT_BEFORE))
      .find((r) => r.entityId === creditSupplier);
    expect(before?.total).toBeCloseTo(GROSS, 2);
    expect(before?.onAccount ?? 0).toBeCloseTo(0, 2);
    expect(before?.netBalance).toBeCloseTo(GROSS, 2);

    // As at today the bill IS out of the ledger on both sides, so the payment
    // really is unallocated funds.
    const after = (await getSupplierStatementBalances(COMPANY, TODAY))
      .find((r) => r.entityId === creditSupplier);
    expect(after?.total ?? 0).toBeCloseTo(0, 2);
    expect(after?.onAccount).toBeCloseTo(ON_ACCOUNT, 2);
  });

  /**
   * Round 6, HIGH-1. The AR customer ledger is the surface the round-5 census
   * missed. It is the document the customer is sent and asked to pay, it takes
   * dateFrom/dateTo, and it read the UNDATED `deleted_at IS NULL OR deleted_at
   * > NOW()` — so after round 5 it disagreed with the emailed statement round 5
   * had just fixed, and it was the one that disagreed with the GL.
   *
   * Three dates: before the reversal, ON it, and after it. All four surfaces
   * must answer the same number as the control account at each.
   */
  it('the AR customer ledger, both statements and the GL all foot, at every as-at date', async () => {
    for (const asAt of [AS_AT_BEFORE, TODAY, AS_AT_AFTER]) {
      const control = await controlBalance(receivable, asAt);
      const ledger = await getCustomerLedger(COMPANY, customer, { dateFrom: LEDGER_FROM, dateTo: asAt });
      const email = await fetchStatementData(COMPANY, customer, asAt);
      const screen = await customerStatement(asAt);

      expect(ledger, asAt).not.toBeNull();
      expect(ledger!.closingBalance, `ledger vs GL @ ${asAt}`).toBeCloseTo(control, 2);
      expect(email!.summary.balance, `email vs GL @ ${asAt}`).toBeCloseTo(control, 2);
      expect(screen.summary.balance, `screen vs GL @ ${asAt}`).toBeCloseTo(control, 2);
    }
    // And the movement is real, not a pair of zeroes agreeing with each other.
    expect(await controlBalance(receivable, AS_AT_BEFORE)).toBeCloseTo(GROSS, 2);
    expect(await controlBalance(receivable, AS_AT_AFTER)).toBeCloseTo(0, 2);
  });

  /**
   * The OPENING leg is the half a `dateFrom` after the document exercises, and
   * it is dated to dateTo rather than to dateFrom on purpose: this statement
   * lists documents and never the GL reversal the delete posts, so a delete
   * falling inside the window produces no row. Dating the opening to dateFrom
   * would carry the invoice into an opening balance that nothing in the window
   * then takes back out, and the closing figure would stop tying to the GL.
   */
  it('the customer ledger OPENING balance is dated too, so a delete inside the window still foots', async () => {
    // Window opens AFTER the invoice, so the invoice can only reach the
    // closing balance through the opening leg; and it closes after the
    // reversal, so the delete falls inside it.
    const inWindow = await getCustomerLedger(COMPANY, customer, {
      dateFrom: AS_AT_BEFORE, dateTo: AS_AT_AFTER,
    });
    expect(inWindow!.transactions).toHaveLength(0);
    expect(inWindow!.openingBalance).toBeCloseTo(0, 2);
    expect(inWindow!.closingBalance).toBeCloseTo(await controlBalance(receivable, AS_AT_AFTER), 2);

    // The same window ending BEFORE the reversal keeps it, on both legs.
    const beforeReversal = await getCustomerLedger(COMPANY, customer, {
      dateFrom: AS_AT_BEFORE, dateTo: shift(-1),
    });
    expect(beforeReversal!.openingBalance).toBeCloseTo(GROSS, 2);
    expect(beforeReversal!.closingBalance).toBeCloseTo(await controlBalance(receivable, shift(-1)), 2);
  });

  /**
   * dateTo is optional on this surface too. An absent one means "up to now",
   * not a NULL that would make the fragment return NULL and drop every
   * soft-deleted invoice unconditionally.
   */
  it('an unbounded customer ledger answers as at today', async () => {
    const unbounded = await getCustomerLedger(COMPANY, customer, {});
    expect(unbounded!.transactions).toHaveLength(0);
    expect(unbounded!.closingBalance).toBeCloseTo(await controlBalance(receivable, TODAY), 2);
  });

  /** LOW-2: a statement is not drawn for a customer that has been deleted. */
  it('no statement is drawn for a soft-deleted customer', async () => {
    await sql`UPDATE customers SET deleted_at = NOW()
              WHERE id = ${customer}::UUID AND company_id = ${COMPANY}::UUID`;
    try {
      expect(await fetchStatementData(COMPANY, customer, AS_AT_BEFORE)).toBeNull();
      expect(await getCustomerLedger(COMPANY, customer, {})).toBeNull();

      const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
      (req as unknown as { query: unknown }).query = { customerId: customer, toDate: AS_AT_BEFORE };
      const result = response();
      await customerStatementRoute(req, result.res);
      expect(result.state.statusCode).toBe(404);
    } finally {
      await sql`UPDATE customers SET deleted_at = NULL
                WHERE id = ${customer}::UUID AND company_id = ${COMPANY}::UUID`;
    }
  });

  it('the supplier ledger running balance is drawn to its own window end', async () => {
    const before = await supplierLedger(AS_AT_BEFORE);
    expect(before.transactions.map((t) => t.reference)).toEqual([TAG + '-AP']);
    expect(before.closing_balance).toBeCloseTo(GROSS, 2);

    const after = await supplierLedger(TODAY);
    expect(after.transactions).toHaveLength(0);
    expect(after.closing_balance).toBeCloseTo(0, 2);

    // dateTo is optional. An absent one means "up to now", NOT a NULL that
    // would make the predicate return NULL and drop the row unconditionally —
    // which happens to look the same here, so assert the shape that separates
    // them: an unbounded run answers exactly as a run bounded by today.
    const unbounded = await supplierLedger();
    expect(unbounded.transactions).toHaveLength(0);
    expect(unbounded.closing_balance).toBeCloseTo(after.closing_balance, 2);
  });
});
