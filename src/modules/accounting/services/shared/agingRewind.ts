/**
 * The settlement rewind behind point-in-time AR and AP aging.
 *
 * `asAtDate` on the aging reports used to be decorative: both services read
 * `amount_paid`, which is a CURRENT snapshot, and filtered on the CURRENT
 * outstanding balance, so an as-at date only re-bucketed today's figures by
 * age. monthEndWorkbenchService passes a historical periodEnd and the MCP
 * aged_debtors / aged_creditors tools expose as_at, so it is a live parameter.
 *
 * ANCHORED, NOT REBUILT. The balance starts from `amount_paid` — the
 * authoritative figure — and only settlement that can be DATED is undone:
 *
 *     balance(as_at) = total_amount
 *                    - LEAST(GREATEST(amount_paid - net, 0), total_amount)
 *     net            = settlement dated in (as_at, today]
 *                    - credits in force then and cancelled since
 *
 * Rebuilding what was paid from zero out of allocation history was the first
 * attempt and it was wrong: it assumes every settlement leaves a dated trail.
 * It does not. A receipt captured with no allocation row, or a balance carried
 * in by the Sage migration, reduces amount_paid with nothing to date it — and
 * such an invoice then REAPPEARED AT FULL FACE VALUE as delinquent debt the
 * customer had already settled (105 invoices for one client on dev). Anchoring
 * cannot do that: undated settlement stays in the baseline and is treated as
 * having always been there.
 *
 * THE GUARANTEE, narrowly: the report WILL NOT REPORT A SETTLED INVOICE AS
 * OUTSTANDING. It may understate a past balance. It is not a general
 * point-in-time balance, and the MCP tool descriptions say so.
 *
 * ── Every writer of amount_paid, and whether the rewind can see it ──────────
 *
 * This census has been wrong FIVE times. It first covered only the service
 * layer; the claim that it then covered src/, pages/ and scripts/ was itself
 * untrue — four importer writers were still missing. Re-derive it, do not
 * trust it.
 *
 *   DATABLE, rewound here:
 *     customerPaymentAllocationService, receiptAllocationLines,
 *     supplierAllocationLines, supplierPaymentWorkflowService,
 *     batchPaymentService            -> allocation row + payment_date
 *     creditNoteApproveService       -> credit_notes.credit_date
 *     creditNoteCancelService        -> credit_notes.cancelled_at (mig 528)
 *     writeOffService                -> customer_write_offs.write_off_date
 *
 *   NOT DATABLE, deliberately left in the baseline:
 *     pages/api/accounting/bank-match-confirm.ts — the PRIMARY bank
 *       reconciliation settlement path. Writes amount_paid with no payment row
 *       and no allocation row.
 *     pages/api/webhooks/paystack.ts
 *     pages/api/portal/payments/paystack/verify.ts
 *     scripts/import-sage-britech.ts
 *     core/sageImportService.ts, core/sageCustomerImportService.ts,
 *     core/migrationImportService.ts, ap/migrationApService.ts
 *       — all set a non-zero amount_paid on INSERT
 *
 * ── Limitations, stated rather than glossed ────────────────────────────────
 *
 *  1. A payment later CANCELLED keeps its allocation row but is excluded by
 *     the status filter, while amount_paid has already been reduced. For a
 *     date between the payment and its cancellation the invoice reads as
 *     outstanding when it was settled. Neither payment table carries a
 *     cancellation timestamp (only updated_at, which any edit touches), so it
 *     cannot be fixed without a schema change. Production exposure: 4 customer
 *     and 1 supplier payment, R5,462.50.
 *  2. The `<= today` bound means POST-DATED settlement is never rewound at any
 *     as-at date, so a historical report understates by every future-dated
 *     payment and credit note (37 supplier payments, 25 customer payments and
 *     14 credit notes in production). That is a compatibility choice — the
 *     alternative changes the DEFAULT report, which this design guarantees not
 *     to do — not a correctness one.
 *  3. total_amount is a CURRENT snapshot too. An invoice raised at 1,000 and
 *     later amended to 500 reports 500 for a date on which 1,000 was owed.
 *     Nothing in this schema dates an amendment.
 *  4. Where amount_paid has been LOWERED after the fact, the historical figure
 *     inherits the overstatement the LIVE report already carries: on 40
 *     production invoices the live report says R483,266.76 where their
 *     allocations say R358,306.39. This code reproduces the live ledger at an
 *     earlier date; it does not widen that gap and does not correct it. Root
 *     cause is bank-match-confirm writing amount_paid absolutely.
 *
 * Extracted here because the SQL and this rationale were pasted verbatim into
 * four query sites across two files, and two copies of reasoning this specific
 * will diverge. `sql` splices a nested fragment and renumbers its parameters
 * (see buildQuery in lib/neon).
 */

import { sql } from '@/lib/neon';

export type AgingSide = 'ar' | 'ap';

interface RewindInput {
  companyId: string;
  /** Inclusive as-at date, 'YYYY-MM-DD'. */
  asAtStr: string;
  /**
   * Upper bound of the rewind window, from the SAME clock as `asAtStr`.
   *
   * Not CURRENT_DATE: the database session is UTC and the business runs UTC+2,
   * so between 22:00 and midnight SAST CURRENT_DATE is the PREVIOUS day and
   * settlement dated today would drop out of the window for two hours nightly.
   * Taking both bounds from one clock makes "the window is empty when the
   * as-at is today" hold by construction rather than by two clocks agreeing.
   */
  todayStr: string;
  side: AgingSide;
}

/**
 * A correlated subquery yielding the signed settlement to unwind for the
 * invoice aliased `ci` (AR) or `si` (AP) in the surrounding query.
 *
 * Positive = settled since the as-at date, so add it back. Negative = a credit
 * that was in force then and has been cancelled since, so take it off again.
 */
export function rewindAmount({ companyId, asAtStr, todayStr, side }: RewindInput) {
  const isAr = side === 'ar';
  const invoice = isAr ? 'ci' : 'si';
  const creditLink = isAr ? 'customer_invoice_id' : 'supplier_invoice_id';
  const creditType = isAr ? 'customer' : 'supplier';

  const payments = isAr
    ? sql`
        SELECT cpa.amount_allocated AS amount
        FROM customer_payment_allocations cpa
        JOIN customer_payments cp ON cp.id = cpa.payment_id
        WHERE cpa.invoice_id = ${sql.unsafe(`${invoice}.id`)}
          AND cp.company_id = ${companyId}
          AND cp.status NOT IN ('draft', 'cancelled')
          AND cp.payment_date >  ${asAtStr}::date
          AND cp.payment_date <= ${todayStr}::date`
    : sql`
        SELECT pa.amount_allocated AS amount
        FROM payment_allocations pa
        JOIN supplier_payments sp ON sp.id = pa.payment_id
        WHERE pa.invoice_id = ${sql.unsafe(`${invoice}.id`)}
          AND sp.company_id = ${companyId}
          AND sp.status NOT IN ('draft', 'cancelled')
          AND sp.payment_date >  ${asAtStr}::date
          AND sp.payment_date <= ${todayStr}::date`;

  // applied_amount, not total_amount: approving a note applies
  // MIN(total, outstanding) and deliberately leaves the excess unapplied
  // (migration 529), so rewinding the face value credits back more than was
  // ever taken off. The column is NOT NULL DEFAULT 0, so a COALESCE fallback
  // to total_amount would be unreachable; a note sitting at 0 was never
  // applied and reduced nothing to rewind.
  const creditsApplied = sql`
        SELECT cn.applied_amount
        FROM credit_notes cn
        WHERE cn.${sql.unsafe(creditLink)} = ${sql.unsafe(`${invoice}.id`)}
          AND cn.company_id = ${companyId}
          AND cn.type   = ${creditType}
          AND cn.status IN ('approved', 'applied')
          AND cn.credit_date >  ${asAtStr}::date
          AND cn.credit_date <= ${todayStr}::date`;

  // NEGATIVE: in force on the as-at date, cancelled since. amount_paid no
  // longer reflects it but it did then, so it goes back on.
  const creditsCancelled = sql`
        SELECT -cn.applied_amount
        FROM credit_notes cn
        WHERE cn.${sql.unsafe(creditLink)} = ${sql.unsafe(`${invoice}.id`)}
          AND cn.company_id = ${companyId}
          AND cn.type   = ${creditType}
          AND cn.status = 'cancelled'
          AND cn.credit_date  <= ${asAtStr}::date
          AND cn.cancelled_at >  ${asAtStr}::date`;

  // A bad-debt write-off raises amount_paid with no allocation row and no
  // credit note. Only on approval — a draft has settled nothing. There is no
  // supplier equivalent; customer_write_offs is the only such table.
  const writeOffs = isAr
    ? sql`
        UNION ALL

        SELECT wo.amount
        FROM customer_write_offs wo
        WHERE wo.invoice_id = ${sql.unsafe(`${invoice}.id`)}
          AND wo.company_id = ${companyId}
          AND wo.status = 'approved'
          AND wo.write_off_date >  ${asAtStr}::date
          AND wo.write_off_date <= ${todayStr}::date`
    : sql.unsafe('');

  return sql`
      SELECT SUM(amount) AS amount FROM (
        ${payments}

        UNION ALL

        ${creditsApplied}
        ${writeOffs}

        UNION ALL

        ${creditsCancelled}
      ) reversed`;
}

/**
 * The effective amount settled as at the date, clamped into [0, total_amount].
 *
 * Two-sided because `net` points both ways: a positive rewind could otherwise
 * drive the figure below zero (dated settlement exceeds amount_paid on 40
 * production invoices, because bank-match-confirm writes amount_paid
 * absolutely while the allocation rows survive — unclamped, a supplier was
 * aged R50,275.55 on a R38,614.57 invoice), and a negative one could drive it
 * above the invoice and produce a negative balance.
 */
export function effectivePaidExpr(side: AgingSide): string {
  const invoice = side === 'ar' ? 'ci' : 'si';
  return `LEAST(GREATEST(COALESCE(${invoice}.amount_paid, 0)`
    + `\n             - COALESCE(unpaid.amount, 0), 0), ${invoice}.total_amount)`;
}
