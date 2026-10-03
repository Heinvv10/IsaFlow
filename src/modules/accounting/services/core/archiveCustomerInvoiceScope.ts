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

/**
 * A skipped invoice's journals are among those the run would move. `gl_journal_entry_id` has no
 * FK, so moving them would leave the live invoice pointing at the archive (R-186 option b).
 */
export class ArchiveSkippedInvoiceJournalError extends Error {
  readonly code = 'ARCHIVE_SKIPPED_INVOICE_JOURNAL';
}

/** Said by validation before a run and stored as the refused run's error, so true for both. */
export function skippedInvoiceJournalMessage(count: number): string {
  return `${count} journal(s) of customer invoices the archive keeps (a Paystack or Stitch payment request `
    + 'refers to them) are dated before the cutoff. An archive with this cutoff is refused; choose an earlier cutoff.';
}

/**
 * The ONE definition of what the run may archive, over `customer_invoices ci`: this company, dated
 * before the cutoff, paid or cancelled. The selection, the preview count and the move splice it
 * in (a nested `sql` fragment), so they cannot drift apart.
 */
function eligibleInvoice(companyId: string, cutoffDate: string) {
  return sql`(ci.company_id = ${companyId}
    AND ci.invoice_date < ${cutoffDate}::date
    AND ci.status IN ('paid', 'cancelled'))`;
}

/**
 * The ONE definition of "the run moves this journal", over `gl_journal_entries je`: this company,
 * posted, dated before the cutoff. Steps 1, 2 and 6 of executeArchive and the kept-journal refusal
 * all splice it in.
 */
export function movedJournal(companyId: string, cutoffDate: string) {
  return sql`(je.company_id = ${companyId}
    AND je.entry_date < ${cutoffDate}::date
    AND je.status = 'posted')`;
}

/** The ONE definition of "a payment request of this company references `ci`" (R-186). */
function gatewayReferenced(companyId: string) {
  return sql`(EXISTS (SELECT 1 FROM paystack_payment_requests pr
                      WHERE pr.company_id = ${companyId} AND pr.customer_invoice_id = ci.id)
              OR EXISTS (SELECT 1 FROM stitch_payment_requests sr
                         WHERE sr.company_id = ${companyId} AND sr.customer_invoice_id = ci.id))`;
}

export interface ArchivableCustomerInvoices {
  /** Paid or cancelled, dated before the cutoff, referenced by no payment request. */
  ids: string[];
  /** Would be archived, but a Paystack or Stitch request of this company references them. */
  skippedIds: string[];
}

export async function selectArchivableCustomerInvoices(
  companyId: string,
  cutoffDate: string,
): Promise<ArchivableCustomerInvoices> {
  const rows = (await sql`
    SELECT ci.id, ${gatewayReferenced(companyId)} AS gateway_referenced
    FROM customer_invoices ci
    WHERE ${eligibleInvoice(companyId, cutoffDate)}
  `) as DbRow[];
  const ids = rows.filter((r) => !r.gateway_referenced).map((r) => r.id as string);
  const skippedIds = rows.filter((r) => r.gateway_referenced).map((r) => r.id as string);
  return { ids, skippedIds };
}

/** The preview's counts: the selection's predicates, counted in SQL. */
export async function countArchivableCustomerInvoices(
  companyId: string,
  cutoffDate: string,
): Promise<{ archivable: number; skipped: number }> {
  const rows = (await sql`
    SELECT COUNT(*) FILTER (WHERE NOT s.gateway_referenced)::int AS archivable,
           COUNT(*) FILTER (WHERE s.gateway_referenced)::int AS skipped
    FROM (
      SELECT ${gatewayReferenced(companyId)} AS gateway_referenced
      FROM customer_invoices ci
      WHERE ${eligibleInvoice(companyId, cutoffDate)}
    ) s
  `) as DbRow[];
  return { archivable: Number(rows[0]?.archivable ?? 0), skipped: Number(rows[0]?.skipped ?? 0) };
}

/**
 * Deletes the selected invoices and copies exactly the deleted rows into the
 * archive, in one statement. The eligibility and gateway predicates are applied
 * again, because the selection was an unlocked read: an invoice reopened since
 * (say an allocation unwind put it back to 'approved'), or one a payment request
 * was opened on since, must stay. If fewer rows moved
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
      DELETE FROM customer_invoices ci
      WHERE ${eligibleInvoice(companyId, cutoffDate)}
        AND NOT ${gatewayReferenced(companyId)}
        AND ci.id = ANY(${ids}::uuid[])
      RETURNING ci.*
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
  if (moved !== ids.length) {
    throw new ArchiveSetChangedError(`Customer invoices changed during the archive run: selected ${ids.length}, `
      + `${moved} still eligible (reopened, re-dated, or a payment request opened on them since)`);
  }
  if (archived !== moved) {
    throw new ArchiveSetChangedError(`${moved - archived} invoice id(s) already in the archive; nothing was moved`);
  }
  return archived;
}

/**
 * How many journals the run would move (posted, before the cutoff, this company) belong to the
 * invoices the selection skipped: each one's own journal and every journal in its reversal chain,
 * followed through `reversal_of_id` in both directions. Seeded from the selection's own ids, so an
 * invoice changed since the selection cannot escape. The run refuses when this is not 0;
 * validation reports it. UNION (not UNION ALL) ends a forged reversal cycle.
 */
export async function countSkippedInvoiceJournalsInWindow(
  companyId: string,
  cutoffDate: string,
  skippedIds: string[],
): Promise<number> {
  const rows = (await sql`
    WITH RECURSIVE chain (id, reversal_of_id) AS (
      SELECT je.id, je.reversal_of_id
      FROM customer_invoices ci
      JOIN gl_journal_entries je ON je.id = ci.gl_journal_entry_id AND je.company_id = ${companyId}
      WHERE ci.company_id = ${companyId}
        AND ci.id = ANY(${skippedIds}::uuid[])
      UNION
      SELECT je.id, je.reversal_of_id
      FROM chain c
      JOIN gl_journal_entries je ON je.reversal_of_id = c.id OR je.id = c.reversal_of_id
      WHERE je.company_id = ${companyId}
    )
    SELECT COUNT(DISTINCT je.id)::int AS n
    FROM chain c
    JOIN gl_journal_entries je ON je.id = c.id
    WHERE ${movedJournal(companyId, cutoffDate)}
  `) as DbRow[];
  return Number(rows[0]?.n ?? 0);
}
