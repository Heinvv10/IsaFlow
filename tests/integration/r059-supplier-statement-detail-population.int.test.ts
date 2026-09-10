/**
 * R-059 round 7 (MEDIUM-1) — supplier-statement-detail ties to the ageing and
 * the payable control on a NULL-status bill, through the real route.
 *
 * The route's own comment says it asks "the same dated question the ageing it
 * must tie to now asks", and K-053 pins its balance to the payable control. Its
 * two bill queries kept the bare status NOT IN, which is NULL for a NULL
 * status, so the bill dropped out of the statement while its payment stayed:
 * invoiced 0, paid 400, balance −400, against an ageing and a control of 750.
 * Round 4 had already moved the ageing onto the GL; this sibling was the one
 * left behind, and no census table listed it.
 *
 * Fixture, through the real posting services: bill B of 1150 posted with
 * postSupplierInvoiceToGL, a payment of 400 allocated to it and processed with
 * processSupplierPayment, then B's status set to NULL. Asserted at a date
 * before the payment (1150) and at today (750): the statement's balance equals
 * the ageing's total and the negated payable control, and its invoiced figure
 * is the bill's 1150 at both — the headline aggregate AND the row list.
 *
 * Round 8 (LOW-4) adds D, an unposted DRAFT bill of 300 for the same supplier.
 * The shared rule excludes drafts as well as cancelled bills, and until D
 * existed a mutation re-admitting drafts at either site stayed green here and in
 * k053-figure-surfaces. D must appear in neither the headline nor the rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { SignJWT } from 'jose';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { processSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import supplierStatementDetailRoute from '../../pages/api/accounting/supplier-statement-detail';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R59D${Math.floor(Math.random() * 1e8)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const TODAY = fmtDate(new Date());
const BEFORE_PAYMENT = shift(-30);
const GROSS = 1150;

let supplier = '';
let payable = '';
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

async function account(code: string, name: string, type: string, normal: string, subtype: string): Promise<string> {
  return ((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})
    RETURNING id`) as { id: string }[])[0]!.id;
}

/** What we owe on the payable control at the date: credits less debits. */
async function owedOnControl(asAt: string): Promise<number> {
  const [r] = (await sql`
    SELECT COALESCE(SUM(l.credit - l.debit), 0) AS owed
    FROM gl_journal_lines l
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id AND e.company_id = ${COMPANY}::UUID
    WHERE l.company_id = ${COMPANY}::UUID AND l.gl_account_id = ${payable}::UUID
      AND e.status = 'posted' AND e.entry_date <= ${asAt}::date
  `) as { owed: string | number }[];
  return Number(r!.owed);
}

type Body = { transactions: { type: string; debit: number }[]; summary: { totalInvoiced: number; balance: number } };
async function statement(asAt: string): Promise<Body> {
  const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
  (req as unknown as { query: unknown }).query = { supplier_id: supplier, as_at_date: asAt };
  const result = response();
  await (supplierStatementDetailRoute as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
  expect(result.state.statusCode).toBe(200);
  return (result.state.body as { data: Body }).data;
}

describeIfDb('R-059 supplier-statement-detail ties on a NULL-status bill', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'R059D ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'R059D ' + TAG}, 1, 2026, '2026-01-01', '2026-12-31', 'open')`;
    payable = await account('2100', 'Trade Creditors', 'liability', 'credit', 'payable');
    await account('1000', 'Bank', 'asset', 'debit', 'bank');
    const expense = await account('5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account('1300', 'VAT Input', 'asset', 'debit', 'vat_input');
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    const bill = ((await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-B'}, ${shift(-60)}::date, ${shift(-40)}::date,
        'approved', 1000, 150, ${GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`
      INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
      VALUES (${bill}::UUID, ${'R059 line'}, 1, 1000, 15, 150, 1000, ${expense}::UUID)`;
    await inTx(() => postSupplierInvoiceToGL(COMPANY, bill, USER));
    const pay = ((await sql`
      INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date, total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${TAG + '-P'}, ${supplier}::UUID, ${shift(-20)}::date, 400, 'approved', ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${pay}::UUID, ${bill}::UUID, 400)`;
    await inTx(() => processSupplierPayment(COMPANY, pay, USER));
    await sql`UPDATE supplier_invoices SET status = NULL WHERE id = ${bill}::UUID AND company_id = ${COMPANY}::UUID`;
    // D: a draft, never posted, raised before both dates.
    await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-D'}, ${shift(-50)}::date, ${shift(-40)}::date,
        'draft', 300, 0, 300, 0, ${USER}::UUID)`;

    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 180000);

  afterAll(async () => {
    await sql`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 180000);

  it('the premise: the bill is posted, part-paid and carries a NULL status', async () => {
    const [r] = (await sql`
      SELECT status IS NULL AS null_status, gl_journal_entry_id IS NOT NULL AS posted, amount_paid::numeric AS paid
      FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID AND invoice_number = ${TAG + '-B'}
    `) as { null_status: boolean; posted: boolean; paid: string }[];
    expect({ ...r!, paid: Number(r!.paid) }).toEqual({ null_status: true, posted: true, paid: 400 });
  });

  for (const [label, asAt, owed] of [['before the payment', BEFORE_PAYMENT, GROSS], ['today', TODAY, GROSS - 400]] as const) {
    it(`${label}: statement balance == ageing == payable control == ${owed}`, async () => {
      const body = await statement(asAt);
      const aged = (await getAPAging(COMPANY, asAt)).reduce((s, b) => s + b.total, 0);
      expect({
        invoiced: body.summary.totalInvoiced,
        balance: body.summary.balance,
        aged,
        control: await owedOnControl(asAt),
      }).toEqual({ invoiced: GROSS, balance: owed, aged: owed, control: owed });
      // The row list carries the bill as well as the headline aggregate — and
      // the 300 draft is in neither (invoiced above is 1150, not 1450).
      expect(body.transactions.filter(t => t.type === 'invoice').map(t => Number(t.debit))).toEqual([GROSS]);
    });
  }
});
