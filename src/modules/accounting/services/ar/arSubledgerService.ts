/**
 * The AR subledger AS AT a date — every open customer document, including the
 * ones that cannot be bucketed.
 *
 * POINT IN TIME, on the same basis as the aging report. `amount_paid` is a
 * CURRENT snapshot, so reading it made `asAtDate` decorative: `subledgerTotal`
 * stayed at today's figure while `getControlAccountBalances` correctly moved
 * with the date, and `reconcile_subledger` closed the resulting gap with a
 * `document_after_as_at` item worth R72,867,375.59 of Velocity AR at
 * 2025-12-31. The rewind — and every one of its four documented limitations —
 * lives in `services/shared/agingRewind.ts`. It is imported rather than
 * reimplemented: one answer to "what was owed on a date", consumed by the
 * aging reports and by the reconciliation.
 *
 * The population is master's aging population exactly, and deliberately so:
 * `reconcile_subledger` reports the aged total beside the subledger total, and
 * two populations would make that comparison meaningless.
 *
 *  - `status NOT IN ('draft', 'cancelled')`, NOT the open-status set. An
 *    invoice settled TODAY was outstanding on an earlier date, and filtering it
 *    out is what erased settled debt from historical aging.
 *  - `COALESCE(invoice_date, created_at::date) <= as_at`. A document raised
 *    after the reporting date is not in the subledger at that date, which is
 *    also why no `afterAsAt` set survives.
 *  - No due-date filter. `getARAging` used to carry `AND ci.due_date IS NOT
 *    NULL`, so a R1,058,000 invoice vanished with no error and no count
 *    (FINDINGS §4). The row is returned and marked `unageable`; since #303 the
 *    aging report buckets it from `invoice_date` rather than dropping it.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { effectivePaidExpr, rewindAmount } from '../shared/agingRewind';
import { documentInLedgerAsAtFragment } from '../shared/softDeleteLedgerPresence';
import { getOpenDisputeTotals } from './disputeService';
import type { SubledgerDocument, SubledgerSnapshot } from './subledgerTypes';
import { buildSnapshot, toDocument } from './subledgerShared';

export interface ARSubledgerSnapshot extends SubledgerSnapshot {
  /** Open-dispute amount per document id. AR only. */
  disputes: ReadonlyMap<string, number>;
}

/**
 * @param asAtDate 'YYYY-MM-DD'. A string throughout — SAST is UTC+2 and this
 *   repo has a live UTC-rollback defect class, so no Date arithmetic happens
 *   anywhere on this path.
 */
export async function getARSubledger(
  companyId: string,
  asAtDate: string,
): Promise<ARSubledgerSnapshot> {
  try {
    // Both bounds of the rewind window come from the SAME clock, never
    // CURRENT_DATE: the session is UTC and the business runs UTC+2, so for two
    // hours every night CURRENT_DATE is the previous day and settlement dated
    // today would silently drop out of the window.
    const todayStr = fmtDate(new Date());
    const paid = effectivePaidExpr('ar');

    const invoiceRows = (await sql`
      SELECT ci.id,
             ci.invoice_number AS document_number,
             COALESCE(ci.client_id, ci.customer_id) AS entity_id,
             c.name AS entity_name,
             COALESCE(ci.invoice_date, ci.created_at::date) AS document_date,
             ci.due_date,
             ci.total_amount,
             ${sql.unsafe(paid)} AS amount_paid,
             (ci.total_amount - ${sql.unsafe(paid)}) AS balance,
             ci.created_at
      FROM customer_invoices ci
      -- LEFT, and scoped: an inner join would DROP an invoice whose customer
      -- row belongs to another company, which is a data defect this report
      -- exists to surface rather than to hide. The name is all that is taken
      -- from it, so a null one costs nothing.
      LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
                           AND c.company_id = ${companyId}::UUID
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr: asAtDate, todayStr, side: 'ar' })}
      ) unpaid ON TRUE
      WHERE ci.company_id = ${companyId}::UUID
        AND ci.status NOT IN ('draft', 'cancelled')
        -- Same population as arAgingService, deliberately: a soft-deleted
        -- document leaves that report when its delete reversal reaches the
        -- ledger, and two populations would make reconcile_subledger's
        -- aged-versus-subledger comparison meaningless.
        AND ${documentInLedgerAsAtFragment('ci', asAtDate, companyId)}
        AND COALESCE(ci.invoice_date, ci.created_at::date) <= ${asAtDate}::DATE
        AND (ci.total_amount - ${sql.unsafe(paid)}) > 0
      ORDER BY ci.due_date NULLS LAST, ci.id
    `) as DbRow[];

    const creditRows = (await sql`
      SELECT cn.id,
             cn.credit_note_number AS document_number,
             cn.client_id AS entity_id,
             c.name AS entity_name,
             cn.credit_date AS document_date,
             cn.credit_date AS due_date,
             cn.total_amount,
             0 AS amount_paid,
             cn.total_amount AS balance,
             cn.created_at
      FROM credit_notes cn
      LEFT JOIN customers c ON c.id = cn.client_id AND c.company_id = ${companyId}::UUID
      WHERE cn.company_id = ${companyId}::UUID
        AND cn.type = 'customer'
        AND cn.status = 'approved'
        AND cn.customer_invoice_id IS NULL
        -- A credit note granted after the reporting date had not reduced what
        -- the customer owed on that date.
        AND cn.credit_date <= ${asAtDate}::DATE
      ORDER BY cn.credit_date, cn.id
    `) as DbRow[];

    const documents = invoiceRows.map(toDocument);
    // A credit note reduces what is owed, so it enters the subledger negative.
    const creditNotes: SubledgerDocument[] = creditRows.map((r) => {
      const doc = toDocument(r);
      return { ...doc, balance: -doc.balance };
    });

    // As at the reporting date, like every balance above it (R-059): a
    // dispute raised after asAtDate was not in force on it.
    const disputes = await getOpenDisputeTotals(
      companyId,
      documents.map((d) => d.id),
      asAtDate,
    );

    return {
      ...buildSnapshot(documents, creditNotes, [...invoiceRows, ...creditRows]),
      disputes,
    };
  } catch (err) {
    log.error('Failed to read the AR subledger', { error: err }, 'accounting');
    throw err;
  }
}

/** Re-exported so callers need one import for the shape and the reader. */
export type { SubledgerDocument, SubledgerSnapshot };
export { fmtDate };
