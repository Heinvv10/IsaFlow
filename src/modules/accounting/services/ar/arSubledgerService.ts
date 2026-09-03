/**
 * The AR subledger as at a date — EVERY open customer document, including the
 * ones that cannot be aged.
 *
 * `getARAging` used to carry `AND ci.due_date IS NOT NULL` in its WHERE clause.
 * A R1,058,000 invoice therefore disappeared from the aged debtors report with
 * no error, no count and no way for a reader to tell — it was R1,058,000 of a
 * R1,429,774 reconciling difference (FINDINGS §4). The filter is the defect.
 * This service returns the row and labels it `unageable`; the aging report then
 * buckets `ageable` and reports `unageable` in `excludedRows`.
 *
 * Note there is NO date filter on the documents themselves, deliberately: an
 * invoice dated after the reporting date is still an open receivable, and
 * dropping it would hide a different break. It is labelled `afterAsAt` instead,
 * because the control-account balance (which stops at `entry_date <= as_at`)
 * genuinely cannot contain it.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { AR_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
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
    const invoiceRows = (await sql`
      SELECT ci.id,
             ci.invoice_number AS document_number,
             COALESCE(ci.client_id, ci.customer_id) AS entity_id,
             c.name AS entity_name,
             ci.invoice_date AS document_date,
             ci.due_date,
             ci.total_amount,
             COALESCE(ci.amount_paid, 0) AS amount_paid,
             (ci.total_amount - COALESCE(ci.amount_paid, 0)) AS balance,
             ci.created_at
      FROM customer_invoices ci
      JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
                      AND c.company_id = ${companyId}::UUID
      WHERE ci.company_id = ${companyId}::UUID
        AND ci.status = ANY(${Array.from(AR_OPEN_STATUSES)}::text[])
        AND (ci.total_amount - COALESCE(ci.amount_paid, 0)) > 0
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
      JOIN customers c ON c.id = cn.client_id AND c.company_id = ${companyId}::UUID
      WHERE cn.company_id = ${companyId}::UUID
        AND cn.type = 'customer'
        AND cn.status = 'approved'
        AND cn.customer_invoice_id IS NULL
      ORDER BY cn.credit_date, cn.id
    `) as DbRow[];

    const documents = invoiceRows.map(toDocument);
    // A credit note reduces what is owed, so it enters the subledger negative.
    const creditNotes: SubledgerDocument[] = creditRows.map((r) => {
      const doc = toDocument(r);
      return { ...doc, balance: -doc.balance };
    });

    const disputes = await getOpenDisputeTotals(
      companyId,
      documents.map((d) => d.id),
    );

    return {
      ...buildSnapshot(documents, creditNotes, asAtDate, [...invoiceRows, ...creditRows]),
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
