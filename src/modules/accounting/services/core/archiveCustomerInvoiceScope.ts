/**
 * Which customer invoices an archive run moves, and the move itself.
 *
 * R-186 (the r183-r187 goal file's default, 2026-10-03; not put to Hein): an
 * invoice a Paystack or Stitch payment request references is skipped. Both
 * requests' `customer_invoice_id` is ON DELETE SET NULL, and
 * `paystack_pr_invoice_has_invoice` / `stitch_pr_invoice_has_invoice` require it
 * for purpose 'customer_invoice', so deleting the invoice raises 23514 and fails
 * the whole run. Only this company's requests count: the RLS policy admits every
 * company the user belongs to, so the predicate, not RLS, keeps another
 * company's request from deciding. Such a cross-tenant reference still fails the
 * run whole on 23514.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';

/** The invoices the run selected are not the ones it could move: the run must roll back whole. */
export class ArchiveSetChangedError extends Error {
  readonly code = 'ARCHIVE_SET_CHANGED';
}

export interface ArchivableCustomerInvoices {
  /** Paid or cancelled, dated before the cutoff, referenced by no payment request. */
  ids: string[];
  /** Would be archived, but a Paystack or Stitch request of this company references them. */
  skipped: number;
}

export async function selectArchivableCustomerInvoices(
  companyId: string,
  cutoffDate: string,
): Promise<ArchivableCustomerInvoices> {
  const rows = (await sql`
    SELECT ci.id,
           (EXISTS (SELECT 1 FROM paystack_payment_requests pr
                    WHERE pr.company_id = ${companyId} AND pr.customer_invoice_id = ci.id)
            OR EXISTS (SELECT 1 FROM stitch_payment_requests sr
                       WHERE sr.company_id = ${companyId} AND sr.customer_invoice_id = ci.id)
           ) AS gateway_referenced
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}
      AND ci.invoice_date < ${cutoffDate}::date
      AND ci.status IN ('paid', 'cancelled')
  `) as DbRow[];
  const ids = rows.filter((r) => !r.gateway_referenced).map((r) => r.id as string);
  return { ids, skipped: rows.length - ids.length };
}

/** The preview's counts: the same predicate as the selection above, counted in SQL. */
export async function countArchivableCustomerInvoices(
  companyId: string,
  cutoffDate: string,
): Promise<{ archivable: number; skipped: number }> {
  const rows = (await sql`
    SELECT COUNT(*) FILTER (WHERE NOT s.gateway_referenced)::int AS archivable,
           COUNT(*) FILTER (WHERE s.gateway_referenced)::int AS skipped
    FROM (
      SELECT (EXISTS (SELECT 1 FROM paystack_payment_requests pr
                      WHERE pr.company_id = ${companyId} AND pr.customer_invoice_id = ci.id)
              OR EXISTS (SELECT 1 FROM stitch_payment_requests sr
                         WHERE sr.company_id = ${companyId} AND sr.customer_invoice_id = ci.id)
             ) AS gateway_referenced
      FROM customer_invoices ci
      WHERE ci.company_id = ${companyId}
        AND ci.invoice_date < ${cutoffDate}::date
        AND ci.status IN ('paid', 'cancelled')
    ) s
  `) as DbRow[];
  return { archivable: Number(rows[0]?.archivable ?? 0), skipped: Number(rows[0]?.skipped ?? 0) };
}

/**
 * Deletes the selected invoices and copies exactly the deleted rows into the
 * archive, in one statement. The eligibility predicate is applied again, because
 * the selection was an unlocked read: an invoice reopened since (say an
 * allocation unwind put it back to 'approved') must stay. If fewer rows moved
 * than were selected, or fewer were archived than deleted (an id already in the
 * archive), it throws, so the run rolls back whole.
 */
export async function moveCustomerInvoicesToArchive(
  companyId: string,
  cutoffDate: string,
  ids: string[],
): Promise<number> {
  const rows = (await sql`
    WITH moved AS (
      DELETE FROM customer_invoices
      WHERE company_id = ${companyId}
        AND id = ANY(${ids}::uuid[])
        AND invoice_date < ${cutoffDate}::date
        AND status IN ('paid', 'cancelled')
      RETURNING *
    ), archived AS (
      -- No currency: archive_customer_invoices has the column and
      -- customer_invoices does not (selecting it raised 42703 on every run).
      INSERT INTO archive_customer_invoices
        (id, invoice_number, customer_id, client_id, billing_period_start, billing_period_end,
         subtotal, tax_rate, tax_amount, total_amount, amount_paid, status,
         invoice_date, due_date, sent_at, paid_at, notes, internal_notes,
         project_id, gl_journal_entry_id, created_by, approved_by, approved_at,
         created_at, updated_at, company_id)
      SELECT id, invoice_number, customer_id, client_id, billing_period_start, billing_period_end,
             subtotal, tax_rate, tax_amount, total_amount, amount_paid, status,
             invoice_date, due_date, sent_at, paid_at, notes, internal_notes,
             project_id, gl_journal_entry_id, created_by, approved_by, approved_at,
             created_at, updated_at, company_id
      FROM moved
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM moved)::int AS moved,
           (SELECT COUNT(*) FROM archived)::int AS archived
  `) as DbRow[];
  const moved = Number(rows[0]?.moved ?? 0);
  const archived = Number(rows[0]?.archived ?? 0);
  if (moved !== ids.length || archived !== moved) {
    throw new ArchiveSetChangedError(
      `Customer invoices changed during the archive run: selected ${ids.length}, deleted ${moved}, archived ${archived}`,
    );
  }
  return archived;
}
