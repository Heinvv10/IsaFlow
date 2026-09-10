/**
 * K-053 round 8 (H-1) — the delete's reversal is not a reconciling item, and
 * excluding it does not blind the partition it sits in.
 *
 * `unappliedCashService` mechanism 2 reports every posted control movement that
 * NO subledger document references. The reversal a soft-delete posts is exactly
 * such a movement — the invoice deliberately keeps pointing at the ORIGINAL
 * entry so the undo can find it — so before this fix every soft-deleted invoice
 * left a permanent orphan line for its full gross value on the AR reconciler
 * and on the AP reconciler.
 *
 * A guard fails in both directions, so this fixture carries BOTH shapes on one
 * control account: the delete's reversal, which must NOT be reported, and a
 * bare journal that credits the debtor with no document behind it — mechanism
 * 2's original reason for existing (FINDINGS B24) — which must still be.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getUnappliedControlCash } from '@/modules/accounting/services/reconciliation/unappliedCashService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K053ORPH-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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
/** Inside the closed period, after the document, well before the delete. */
const AS_AT_BEFORE = shift(-90);
/** The bare journal sits in the closed period too, so both dates see it. */
const ORPHAN_DATE = shift(-100);

const SUB = 1000;
const VAT = 150;
const GROSS = SUB + VAT;
const ORPHAN = 500;

const receivable = randomUUID();
const revenue = randomUUID();
const vatOutput = randomUUID();
const bank = randomUUID();

let customer: string;
let invoice: string;
let orphanEntry: string;

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

describeIfDb('K-053 a soft-delete reversal is not an unapplied-cash orphan', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'K053ORPH ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active)
              VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role)
              VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'K053ORPH prior ' + TAG}, 1, 2026, '2020-01-01', ${CLOSED_END}::date, 'open'),
                     (${COMPANY}::UUID, ${'K053ORPH current ' + TAG}, 2, 2026, ${OPEN_START}::date, ${OPEN_END}::date, 'open')`;
    await account(receivable, '1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account(revenue, '4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    await account(vatOutput, '2200', 'VAT Output', 'liability', 'credit', 'vat_output');
    await account(bank, '1010', 'Bank', 'asset', 'debit', 'bank');

    customer = ((await sql`INSERT INTO customers (company_id, name)
                           VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    invoice = ((await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR'}, ${DOC_DATE}::date,
        ${DOC_DATE}::date, 'approved', ${SUB}, 15, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await inTx(() => postCustomerInvoiceToGL(COMPANY, invoice, USER));

    // Mechanism 2's own case: cash on the control account with no payment row
    // behind it, because allocateTransaction skipped its INSERT (FINDINGS B24).
    orphanEntry = randomUUID();
    await sql`
      INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description,
        status, source, created_by)
      VALUES (${orphanEntry}::UUID, ${COMPANY}::UUID, ${'JE-ORPH-' + TAG}, ${ORPHAN_DATE}::date,
        ${'Receipt with no payment row ' + TAG}, 'posted', 'manual', ${USER}::UUID)`;
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
      VALUES (${COMPANY}::UUID, ${orphanEntry}::UUID, ${bank}::UUID, ${ORPHAN}, 0, ${'receipt'}),
             (${COMPANY}::UUID, ${orphanEntry}::UUID, ${receivable}::UUID, 0, ${ORPHAN}, ${'receipt'})`;

    await sql`UPDATE fiscal_periods SET status = 'closed'
              WHERE company_id = ${COMPANY}::UUID AND end_date = ${CLOSED_END}::date`;
    await inTx(() => softDelete(COMPANY, 'customer_invoice', invoice, USER));
  }, 180000);

  afterAll(async () => {
    await sql`DELETE FROM soft_delete_journal_reversals WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN
                (${receivable}::UUID, ${revenue}::UUID, ${vatOutput}::UUID, ${bank}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  it('the premise: the delete reversed the approval journal, dated TODAY', async () => {
    const rows = (await sql`
      SELECT e.id, e.entry_date
      FROM soft_delete_journal_reversals r
      JOIN gl_journal_entries e ON e.id = r.reversal_journal_entry_id
      WHERE r.company_id = ${COMPANY}::UUID
    `) as { id: string; entry_date: unknown }[];
    expect(rows).toHaveLength(1);
    expect(fmtDate(new Date(String(rows[0]!.entry_date)))).toBe(TODAY);
    // And no document points at it — which is why it reached mechanism 2.
    const claimed = (await sql`
      SELECT COUNT(*)::int AS n FROM customer_invoices
      WHERE company_id = ${COMPANY}::UUID AND gl_journal_entry_id = ${rows[0]!.id}::UUID
    `) as { n: number }[];
    expect(claimed[0]!.n).toBe(0);
  });

  it('reports the bare journal and NOT the delete reversal, at both dates', async () => {
    for (const asAt of [AS_AT_BEFORE, TODAY]) {
      const cash = await getUnappliedControlCash(COMPANY, 'ar', asAt, [receivable]);
      // Both directions in one assertion: the genuine orphan is still found...
      expect(cash.withoutPaymentRecord.map((i) => i.id)).toEqual([orphanEntry]);
      expect(cash.withoutPaymentRecord[0]!.amount).toBeCloseTo(ORPHAN, 2);
      // ...and the reversal, worth the whole document, never appears.
      expect(cash.total).toBeCloseTo(ORPHAN, 2);
    }
  });
});
