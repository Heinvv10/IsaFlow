/**
 * Lock one customer invoice for the rest of the request's transaction and read what a due-date writer needs, the AR twin
 * of `ap/supplierInvoiceLock.lockSupplierInvoiceForUpdate`. The wait is bounded (`withCustomerInvoiceLock`: 5s, then
 * `CustomerInvoiceLockTimeoutError`, code CUSTOMER_INVOICE_LOCK_TIMEOUT). Write paths only; it throws outside a request
 * transaction rather than lock nothing.
 *
 * Dates come back as YYYY-MM-DD text (`to_char`), never as a `Date`: the writers compare them as strings. `customer_id`
 * is `COALESCE(client_id, customer_id)` (both columns exist and either can carry the customer).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { withCustomerInvoiceLock } from './customerInvoiceLock';

/** Null when the invoice does not exist or is another company's: callers keep their own not-found wording. */
export async function lockCustomerInvoiceForUpdate(companyId: string, invoiceId: string): Promise<DbRow | null> {
  const rows = await withCustomerInvoiceLock('lockCustomerInvoiceForUpdate', 'This invoice', async () => (await sql`
    SELECT id, invoice_number, status, deleted_at, total_amount, amount_paid, due_date_source,
           to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(due_date, 'YYYY-MM-DD') AS due_date,
           COALESCE(client_id, customer_id) AS customer_id
    FROM customer_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `) as DbRow[]);
  return rows[0] ?? null;
}
