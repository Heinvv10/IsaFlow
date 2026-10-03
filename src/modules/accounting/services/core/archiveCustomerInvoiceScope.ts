/**
 * Which customer invoices an archive run moves, for the run and its preview alike.
 *
 * R-186 (Hein, 2026-10-03): an invoice a Paystack payment request references is
 * skipped. `paystack_payment_requests.customer_invoice_id` is ON DELETE SET NULL
 * and `paystack_pr_invoice_has_invoice` requires it for purpose
 * 'customer_invoice', so deleting the invoice raises 23514 and fails the whole
 * run. Only this company's requests count: a foreign request is not this
 * tenant's to read (under app_user RLS it is invisible anyway), so such a
 * reference still fails the run whole on 23514.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';

export interface ArchivableCustomerInvoices {
  /** Paid or cancelled, dated before the cutoff, referenced by no Paystack request. */
  ids: string[];
  /** Would be archived, but a Paystack request of this company references them. */
  skipped: number;
}

export async function selectArchivableCustomerInvoices(
  companyId: string,
  cutoffDate: string,
): Promise<ArchivableCustomerInvoices> {
  const rows = (await sql`
    SELECT ci.id,
           EXISTS (
             SELECT 1 FROM paystack_payment_requests pr
             WHERE pr.company_id = ${companyId}
               AND pr.customer_invoice_id = ci.id
           ) AS paystack_referenced
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}
      AND ci.invoice_date < ${cutoffDate}::date
      AND ci.status IN ('paid', 'cancelled')
  `) as DbRow[];
  const ids = rows.filter((r) => !r.paystack_referenced).map((r) => r.id as string);
  return { ids, skipped: rows.length - ids.length };
}
