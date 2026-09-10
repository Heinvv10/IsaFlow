/**
 * Customer invoice dispute service — PRD-06 Phase 3.
 *
 * Dispute lifecycle: open → resolved | rejected | withdrawn.
 * Re-raising a dispute after resolution creates a NEW row; history is kept.
 * Only one OPEN dispute per (invoice, line) is allowed — enforced by partial
 * unique indexes in mig 428.
 *
 * Resolution modes (user-choice, per Hein 2026-04-23):
 *   resolve_with_credit → auto-creates a customer credit note for
 *                         disputed_amount and stores the id on the dispute.
 *   resolve_no_credit   → status=resolved, no credit, AR aging re-includes
 *                         the amount in overdue.
 *   rejected            → status=rejected, no credit, amount re-ages.
 *   withdrawn           → status=withdrawn (used by withdrawDispute).
 */

import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { ArRequestError } from './arErrors';
import {
  ELIGIBLE_STATUSES,
  mapRow,
  type Dispute,
  type ListDisputesFilters,
  type ListDisputesResult,
  type RaiseDisputeInput,
} from './disputeTypes';

export * from './disputeTypes';
export { ArRequestError } from './arErrors';
export { resolveDispute, withdrawDispute } from './disputeResolution';

export async function raiseDispute(
  companyId: string,
  input: RaiseDisputeInput,
): Promise<Dispute> {
  if (!Number.isFinite(input.disputedAmount) || input.disputedAmount <= 0) {
    throw new ArRequestError('Disputed amount must be greater than zero');
  }
  if (!input.reason || input.reason.trim().length === 0) {
    throw new ArRequestError('Dispute reason is required');
  }

  const invoiceRows = (await sql`
    SELECT id, company_id, status, client_id, total_amount, amount_paid, invoice_number
    FROM customer_invoices
    WHERE id = ${input.customerInvoiceId}::uuid
      AND company_id = ${companyId}::uuid
      AND status = ANY(${ELIGIBLE_STATUSES as unknown as string[]}::text[])
      AND deleted_at IS NULL
    LIMIT 1
  `) as DbRow[];

  if (!invoiceRows[0]) {
    throw new ArRequestError(
      `Invoice not found or not eligible for dispute: ${input.customerInvoiceId}`,
      400,
      'DISPUTE_INVOICE_INELIGIBLE',
    );
  }

  const invoice = invoiceRows[0];
  const outstanding = Number(invoice.total_amount) - Number(invoice.amount_paid ?? 0);
  if (input.disputedAmount > outstanding + 0.01) {
    throw new ArRequestError(
      `Disputed amount ${input.disputedAmount} exceeds outstanding balance ${outstanding}`,
      400,
      'DISPUTE_AMOUNT_EXCEEDS_OUTSTANDING',
    );
  }

  try {
    const rows = (await sql`
      INSERT INTO customer_invoice_disputes (
        company_id,
        customer_invoice_id,
        customer_invoice_line_id,
        reason,
        raised_by,
        disputed_amount,
        source_document_id,
        ip_address,
        user_agent
      ) VALUES (
        ${companyId}::uuid,
        ${input.customerInvoiceId}::uuid,
        ${input.customerInvoiceLineId ?? null},
        ${input.reason.trim()},
        ${input.raisedBy},
        ${input.disputedAmount},
        ${input.sourceDocumentId ?? null},
        ${input.ipAddress ?? null}::inet,
        ${input.userAgent ?? null}
      ) RETURNING *
    `) as DbRow[];

    log.info(
      'Dispute raised',
      {
        disputeId: String(rows[0]!.id),
        invoiceId: input.customerInvoiceId,
        disputedAmount: input.disputedAmount,
        raisedBy: input.raisedBy,
      },
      'dispute',
    );

    return mapRow(rows[0]!);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw new ArRequestError(
        'There is already an open dispute on this invoice or line',
        409,
        'DISPUTE_EXISTS',
      );
    }
    throw err;
  }
}

export async function listDisputes(
  companyId: string,
  filters: ListDisputesFilters = {},
): Promise<ListDisputesResult> {
  const limit = Math.min(Math.max(1, filters.limit ?? 50), 200);
  const offset = Math.max(0, filters.offset ?? 0);
  const statusFilter = filters.status ?? null;
  const invoiceFilter = filters.customerInvoiceId ?? null;

  // One query with NULL-guarded predicates rather than four hand-written
  // branches: the count below has to repeat these predicates exactly, and four
  // copies is four chances for the page and the count to drift apart.
  const rows = (await sql`
    SELECT d.*, ci.invoice_number, COALESCE(ci.client_id, ci.customer_id) AS client_id,
           c.name AS client_name
    FROM customer_invoice_disputes d
    JOIN customer_invoices ci
      ON ci.id = d.customer_invoice_id AND ci.company_id = d.company_id
    LEFT JOIN customers c
      ON c.id = COALESCE(ci.client_id, ci.customer_id) AND c.company_id = d.company_id
    WHERE d.company_id = ${companyId}::uuid
      AND (${statusFilter}::text IS NULL OR d.status = ${statusFilter})
      AND (${invoiceFilter}::uuid IS NULL OR d.customer_invoice_id = ${invoiceFilter}::uuid)
    ORDER BY d.raised_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `) as DbRow[];

  const disputes = rows.map((r) => ({
    ...mapRow(r),
    invoiceNumber: r.invoice_number != null ? String(r.invoice_number) : null,
    clientName: r.client_name != null ? String(r.client_name) : null,
  })) as Dispute[];

  // Deliberately a second round trip and not COUNT(*) OVER () on the page
  // query: a window count is computed over the rows the page returns, so a page
  // past the end (offset >= total) would report total 0 and break the caller's
  // pagination. The open_* aggregates ignore `status` on purpose — the queue
  // header shows what is open however the list is filtered.
  const aggRows = (await sql`
    SELECT
      COUNT(*) FILTER (
        WHERE ${statusFilter}::text IS NULL OR d.status = ${statusFilter}
      )::int AS cnt,
      COUNT(*) FILTER (WHERE d.status = 'open')::int AS open_cnt,
      COALESCE(SUM(d.disputed_amount) FILTER (WHERE d.status = 'open'), 0)::numeric
        AS open_amount
    FROM customer_invoice_disputes d
    JOIN customer_invoices ci
      ON ci.id = d.customer_invoice_id AND ci.company_id = d.company_id
    WHERE d.company_id = ${companyId}::uuid
      AND (${invoiceFilter}::uuid IS NULL OR d.customer_invoice_id = ${invoiceFilter}::uuid)
  `) as DbRow[];

  return {
    disputes,
    total: Number(aggRows[0]?.cnt ?? 0),
    openTotal: Number(aggRows[0]?.open_cnt ?? 0),
    openDisputedAmount: Number(aggRows[0]?.open_amount ?? 0),
  };
}

export async function getDispute(
  companyId: string,
  id: string,
): Promise<Dispute | null> {
  const rows = (await sql`
    SELECT * FROM customer_invoice_disputes
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    LIMIT 1
  `) as DbRow[];

  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Per-invoice totals for the disputes that were OPEN at `asAtDate`, keyed by
 * customer_invoice_id. Used by AR aging to split the "disputed" bucket out of
 * "overdue", and through it by the year-end receivables notes.
 *
 * R-059. Without a date this read `status = 'open'` — TODAY's disputes — so a
 * dispute raised after a past as-at date moved money out of that date's age
 * bucket, and one that was open then but has since been resolved was missing
 * from its Disputed column. A dispute was open at a date when it had been
 * raised by then and had not yet been closed:
 *
 *     raised_at <= asAt AND (still open, OR closed after asAt)
 *
 * Both columns are TIMESTAMPTZ and the as-at date is a SAST calendar date, so
 * each is converted to the Africa/Johannesburg day before the comparison; the
 * session runs UTC, where a bare `::date` names the previous day for anything
 * struck in the first two hours of the SAST day.
 *
 * A dispute that is closed but carries no `resolved_at` cannot be dated and is
 * treated as never having been open, which is what the undated read already
 * did with it. Every transition in disputeResolution.ts sets the column, so
 * this can only be a row predating that code; the effect is that its amount
 * stays in an age bucket instead of the Disputed column, and `gross` — what
 * the notes total — is the same either way.
 *
 * @param asAtDate 'YYYY-MM-DD'. Omitted means today's open disputes, the
 *   original behaviour, which the rewind reproduces exactly at today.
 */
export async function getOpenDisputeTotals(
  companyId: string,
  invoiceIds: string[],
  asAtDate?: string,
): Promise<Map<string, number>> {
  if (invoiceIds.length === 0) return new Map();

  const asAt = asAtDate ?? null;
  const rows = (await sql`
    SELECT customer_invoice_id, SUM(disputed_amount) AS total
    FROM customer_invoice_disputes
    WHERE company_id = ${companyId}::uuid
      AND customer_invoice_id = ANY(${invoiceIds}::uuid[])
      AND CASE WHEN ${asAt}::date IS NULL THEN status = 'open' ELSE
            (raised_at AT TIME ZONE 'Africa/Johannesburg')::date <= ${asAt}::date
            AND (
              status = 'open'
              OR (resolved_at IS NOT NULL
                  AND (resolved_at AT TIME ZONE 'Africa/Johannesburg')::date > ${asAt}::date)
            )
          END
    GROUP BY customer_invoice_id
  `) as DbRow[];

  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(String(r.customer_invoice_id), Number(r.total ?? 0));
  }
  return map;
}
