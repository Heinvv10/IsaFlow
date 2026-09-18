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
 * THE STATUS TEST IS "NOT draft, NOT cancelled", never a list of the statuses
 * that ought to carry credit. `applied` carries a remainder too: migration 529
 * exists because `applyCreditNoteToInvoice` credits `min(total, outstanding)`,
 * so a note worth more than the invoice owed lands in `applied` with part of
 * its value unconsumed. On isaflow_dev one such note left R230 that the
 * document leg no longer claimed and this one did not yet claim — R230 of
 * `unexplained_difference` on books that otherwise tie. A draft note has
 * posted nothing; a cancelled one has been reversed.
 *
 * WRITTEN AGAINST `credit_notes` ALONE, on purpose. A `credit_note_allocations`
 * table and a `partially_applied` status are being added on another branch; a
 * remainder of `total_amount − COALESCE(applied_amount, 0)` over every
 * non-draft, non-cancelled note is true before that merge and after it, so this
 * does not need to land in step with it.
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
          AND COALESCE(cn.status, '') NOT IN ('draft', 'cancelled')
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
          AND COALESCE(cn.status, '') NOT IN ('draft', 'cancelled')
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
