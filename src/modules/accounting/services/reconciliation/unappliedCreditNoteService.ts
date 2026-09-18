/**
 * Approved credit notes with credit still unconsumed.
 *
 * WHY THIS IS A CONTROL-BRIDGE ITEM AND NOT A CURIOSITY. `getAPSubledger` has
 * NO credit-note leg at all — it reads supplier invoices and nothing else — so
 * a supplier credit note debits the AP control account and the AP subledger
 * never hears about it. The control balance drops, `subledgerTotal` does not,
 * and the whole note lands in `unexplained_difference` with no name on it.
 *
 * AR IS THE OPPOSITE CASE AND MUST NOT BE COUNTED TWICE. `getARSubledger`
 * already carries UNLINKED approved notes in `snapshot.creditNotes`, at their
 * full `total_amount`, and they are already in `subledgerTotal`. Counting them
 * here as well manufactures a residual on books that tie. So the caller passes
 * the ids the snapshot already holds and they are excluded — the item is what
 * the subledger does NOT know about.
 *
 * WRITTEN AGAINST `credit_notes` ALONE, on purpose. A `credit_note_allocations`
 * table and a `partially_applied` status are being added on another branch;
 * `status IN ('approved','partially_applied')` with
 * `total_amount − COALESCE(applied_amount, 0)` is true before that merge and
 * after it, so this does not need to land in step with it.
 *
 * `applied_amount` (migration 529), never `total_amount`: a note worth more
 * than the invoice owed is only partly consumed, and the difference is real
 * credit still owing.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { round2 } from './reconciliationMath';

export interface UnappliedCreditNote {
  id: string;
  documentNumber: string | null;
  entityName: string | null;
  /** 'YYYY-MM-DD'. */
  documentDate: string;
  /** Credit still unconsumed: `total_amount − applied_amount`. Positive. */
  amount: number;
  /** The note's face value — the gross an item citing it may not exceed. */
  gross: number;
}

/**
 * @param alreadyCounted ids the subledger snapshot already carries. AR passes
 *   its unlinked approved notes; AP passes nothing, because its subledger has
 *   no credit-note leg to have counted them with.
 * @param asAtDate 'YYYY-MM-DD'. String throughout — no Date arithmetic.
 */
export async function getUnappliedCreditNotes(
  companyId: string,
  role: 'ar' | 'ap',
  asAtDate: string,
  alreadyCounted: readonly string[],
): Promise<UnappliedCreditNote[]> {
  try {
    const noteType = role === 'ar' ? 'customer' : 'supplier';
    const rows = (await (role === 'ar'
      ? sql`
        SELECT cn.id, cn.credit_note_number AS document_number, c.name AS entity_name,
               cn.credit_date AS document_date, cn.total_amount,
               COALESCE(cn.applied_amount, 0) AS applied_amount
        FROM credit_notes cn
        LEFT JOIN customers c ON c.id = cn.client_id AND c.company_id = cn.company_id
        WHERE cn.company_id = ${companyId}::UUID
          AND cn.type = ${noteType}
          AND cn.status IN ('approved', 'partially_applied')
          AND cn.credit_date <= ${asAtDate}::DATE
          AND (cn.total_amount - COALESCE(cn.applied_amount, 0)) > 0
        ORDER BY cn.credit_date, cn.id
      `
      : sql`
        SELECT cn.id, cn.credit_note_number AS document_number, s.name AS entity_name,
               cn.credit_date AS document_date, cn.total_amount,
               COALESCE(cn.applied_amount, 0) AS applied_amount
        FROM credit_notes cn
        LEFT JOIN suppliers s ON s.id = cn.supplier_id AND s.company_id = cn.company_id
        WHERE cn.company_id = ${companyId}::UUID
          AND cn.type = ${noteType}
          AND cn.status IN ('approved', 'partially_applied')
          AND cn.credit_date <= ${asAtDate}::DATE
          AND (cn.total_amount - COALESCE(cn.applied_amount, 0)) > 0
        ORDER BY cn.credit_date, cn.id
      `)) as DbRow[];

    const counted = new Set(alreadyCounted);
    const out: UnappliedCreditNote[] = [];
    for (const r of rows) {
      const id = String(r.id);
      if (counted.has(id)) continue;
      const amount = round2(Number(r.total_amount ?? 0) - Number(r.applied_amount ?? 0));
      if (amount === 0) continue;
      out.push({
        id,
        documentNumber: r.document_number == null ? null : String(r.document_number),
        entityName: r.entity_name == null ? null : String(r.entity_name),
        documentDate: fmtDate(r.document_date as string | Date),
        amount,
        gross: round2(Number(r.total_amount ?? 0)),
      });
    }
    return out;
  } catch (err) {
    log.error('Failed to read unapplied credit notes', { role, error: err }, 'accounting');
    throw err;
  }
}
