/**
 * Seeding helpers for the party_ledger_check integration suite. Rows are
 * inserted directly (not through the posting services) because the point is to
 * build a document whose journal is WRONG in a chosen way -- a service would
 * refuse to.
 */
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';

export const COMPANY = randomUUID();
export const USER = randomUUID();
export const TAG = `PLC${Math.floor(Math.random() * 1e8)}`;
export const DOC_DATE = '2026-03-01';
export const PAY_DATE = '2026-03-15';
export const AS_AT = '2026-06-30';

export type Leg = [account: string, debit: number, credit: number];

export async function account(
  code: string, name: string, type: string, normal: string, subtype: string | null,
): Promise<string> {
  return ((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})
    RETURNING id`) as { id: string }[])[0]!.id;
}

/** A journal entry with its lines. `reversalOf` makes it the contra of another entry. */
export async function journal(
  n: string, entryDate: string, legs: Leg[], status = 'posted', reversalOf: string | null = null,
): Promise<string> {
  const id = ((await sql`
    INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status,
      created_by, source, reversal_of_id)
    VALUES (${COMPANY}::UUID, ${TAG + n}, ${entryDate}::date, ${'plc ' + n}, ${status},
      ${USER}::UUID, 'manual', ${reversalOf}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  for (const [acct, debit, credit] of legs) {
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
      VALUES (${COMPANY}::UUID, ${id}::UUID, ${acct}::UUID, ${debit}, ${credit})`;
  }
  return id;
}

export async function bill(
  supplier: string, n: string, total: number, journalId: string | null,
  opts: { status?: string; paid?: number } = {},
): Promise<string> {
  return ((await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, gl_journal_entry_id, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + n}, ${DOC_DATE}::date, ${DOC_DATE}::date,
      ${opts.status ?? 'approved'}, ${total}, 0, ${total}, ${opts.paid ?? 0}, ${journalId}::UUID, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}

export async function invoice(
  customer: string, n: string, total: number, journalId: string | null, paid = 0,
): Promise<string> {
  return ((await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid,
      gl_journal_entry_id, created_by)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + n}, ${DOC_DATE}::date,
      ${DOC_DATE}::date, 'approved', ${total}, 0, 0, ${total}, ${paid}, ${journalId}::UUID, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}

export async function supplierPayment(
  supplier: string, n: string, total: number, journalId: string | null,
  allocate: Array<[invoiceId: string, amount: number]> = [],
): Promise<string> {
  const id = ((await sql`
    INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date, total_amount,
      status, payment_method, gl_journal_entry_id, created_by)
    VALUES (${COMPANY}::UUID, ${TAG + n}, ${supplier}::UUID, ${PAY_DATE}::date, ${total},
      'processed', 'eft', ${journalId}::UUID, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  for (const [invoiceId, amount] of allocate) {
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
              VALUES (${id}::UUID, ${invoiceId}::UUID, ${amount})`;
  }
  return id;
}

export async function receipt(
  customer: string, n: string, total: number, journalId: string | null, status = 'confirmed',
  allocate: Array<[invoiceId: string, amount: number]> = [],
): Promise<string> {
  const id = ((await sql`
    INSERT INTO customer_payments (company_id, payment_number, client_id, payment_date, total_amount,
      status, gl_journal_entry_id, created_by)
    VALUES (${COMPANY}::UUID, ${TAG + n}, ${customer}::UUID, ${PAY_DATE}::date, ${total},
      ${status}, ${journalId}::UUID, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  for (const [invoiceId, amount] of allocate) {
    await sql`INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
              VALUES (${id}::UUID, ${invoiceId}::UUID, ${amount})`;
  }
  return id;
}

export async function creditNote(
  type: 'supplier' | 'customer', party: string, n: string, total: number, journalId: string | null,
): Promise<string> {
  return ((await sql`
    INSERT INTO credit_notes (company_id, type, client_id, supplier_id, credit_note_number, credit_date,
      subtotal, tax_amount, total_amount, status, applied_amount, gl_journal_entry_id, created_by)
    VALUES (${COMPANY}::UUID, ${type}, ${type === 'customer' ? party : null}::UUID,
      ${type === 'supplier' ? party : null}::UUID, ${TAG + n}, ${PAY_DATE}::date,
      ${total}, 0, ${total}, 'approved', 0, ${journalId}::UUID, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}

export async function writeOff(
  customer: string, invoiceId: string, n: string, amount: number, journalId: string | null,
): Promise<string> {
  return ((await sql`
    INSERT INTO customer_write_offs (company_id, write_off_number, client_id, invoice_id, amount,
      reason, write_off_date, status, gl_journal_entry_id, created_by)
    VALUES (${COMPANY}::UUID, ${TAG + n}, ${customer}::UUID, ${invoiceId}::UUID, ${amount},
      'bad debt', ${PAY_DATE}::date, 'approved', ${journalId}::UUID, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}

export async function cleanup(): Promise<void> {
  await sql`DELETE FROM customer_write_offs WHERE company_id = ${COMPANY}::UUID`;
  await sql`DELETE FROM credit_notes WHERE company_id = ${COMPANY}::UUID`;
  await sql`DELETE FROM payment_allocations WHERE payment_id IN
            (SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
  await sql`DELETE FROM customer_payment_allocations WHERE payment_id IN
            (SELECT id FROM customer_payments WHERE company_id = ${COMPANY}::UUID)`;
  await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
  await sql`DELETE FROM customer_payments WHERE company_id = ${COMPANY}::UUID`;
  await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
  await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
  await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
  await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID AND reversal_of_id IS NOT NULL`;
  await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
  await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
  await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
  await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
  await sql`DELETE FROM users WHERE id = ${USER}`;
  await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
}
