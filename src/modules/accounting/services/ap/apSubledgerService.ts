/**
 * The AP subledger as at a date — every open supplier bill, including the ones
 * that cannot be aged.
 *
 * Same contract and the same reasoning as `arSubledgerService`: the due-date
 * filter that used to sit in `getAPAging`'s WHERE clause dropped rows silently,
 * and a bill with no due date is still money owed. See `subledgerTypes.ts`.
 *
 * AP has no unallocated-credit-note leg in this schema, so `creditNotes` is
 * always empty here. The field exists so both subledgers answer with the same
 * shape and a caller need not branch.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { AP_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import type { SubledgerSnapshot } from '../ar/subledgerTypes';
import { buildSnapshot, toDocument } from '../ar/subledgerShared';

export async function getAPSubledger(
  companyId: string,
  asAtDate: string,
): Promise<SubledgerSnapshot> {
  try {
    const rows = (await sql`
      SELECT si.id,
             si.invoice_number AS document_number,
             si.supplier_id AS entity_id,
             s.name AS entity_name,
             si.invoice_date AS document_date,
             si.due_date,
             si.total_amount,
             COALESCE(si.amount_paid, 0) AS amount_paid,
             (si.total_amount - COALESCE(si.amount_paid, 0)) AS balance,
             si.created_at
      FROM supplier_invoices si
      JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = ${companyId}::UUID
      WHERE si.company_id = ${companyId}::UUID
        AND si.status = ANY(${Array.from(AP_OPEN_STATUSES)}::text[])
        AND (si.total_amount - COALESCE(si.amount_paid, 0)) > 0
      ORDER BY si.due_date NULLS LAST, si.id
    `) as DbRow[];

    return buildSnapshot(rows.map(toDocument), [], asAtDate, rows);
  } catch (err) {
    log.error('Failed to read the AP subledger', { error: err }, 'accounting');
    throw err;
  }
}
