/**
 * Open subledger documents whose value never reached a control account.
 *
 * Found by running the reconciliation over real books and looking at what it
 * could not explain: on isaflow_dev, 169 of ISAFlow Demo's open customer
 * invoices carry no `gl_journal_entry_id` at all — R10,664,575.43 the subledger
 * counts and the ledger has never heard of. As a residual that is a number;
 * here it is a list of invoice numbers.
 *
 * EVERY document is scanned — every status, cancelled included, because a
 * cancelled invoice's journal and its reversal both sit on the control account
 * and only cancel each other if both are counted — and the control amount a
 * document is credited with includes the postings of the PAYMENTS ALLOCATED TO
 * IT and of the CREDIT NOTES APPLIED TO IT, both learned the hard way. A
 * settled invoice has a balance of zero and a pair of postings that cancel;
 * scanning only open documents counts the payment leg without the invoice leg.
 *
 * NONE OF THOSE LEGS MAY BE CANCELLED. A cancelled payment, credit note or
 * write-off has had its journal REVERSED, so its value is no longer on the
 * control account; counting the original against the document understates the
 * document by that value. On a production copy 22 bills carried R878,993.57 of
 * this against documents worth R390,110.35 — an item claiming more than the
 * documents it named were worth, which `item_within_cited_gross` caught.
 *
 * TWO reasons, kept apart because the remedy differs:
 *   `document_not_linked_to_journal`  — the document carries no
 *       `gl_journal_entry_id`. It names exactly that and NOT "never posted":
 *       385 `auto_supplier_invoice` journals exist on isaflow_dev while the
 *       bills carry no link back, so the value IS on the control account and
 *       the document cannot say which journal put it there. Those are picked up
 *       from the ledger side as `posting_with_no_document`; the two partitions
 *       do not overlap.
 *   `document_not_on_control_account`  — a journal IS linked, and the amount it
 *       put on a control account differs from the document's balance.
 *
 * The control amount is computed in a CORRELATED SUBQUERY, not in a
 * `LEFT JOIN … ON`. A predicate in an outer join's ON clause restricts nothing:
 * unmatched rows survive with NULLs and get summed anyway, which is how
 * `kpiChartsService` came to chart every transaction in the company.
 */

import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import type { SubledgerRole } from '../gl/controlAccountService';
import { readUnpostedDocumentRows } from './unpostedDocumentQueries';
import { round2 } from './reconciliationMath';

export interface UnpostedDocument {
  id: string;
  documentNumber: string | null;
  entityName: string | null;
  documentDate: string;
  /**
   * The document's balance MINUS what its journal put on a control account.
   * Signed: positive when the ledger is short of the document, negative when
   * the ledger carries more than the document does. Both directions have to be
   * reported or the decomposition cannot close.
   */
  amount: number;
  /** The document's face value — the gross an item citing it may not exceed. */
  gross: number;
  reason: 'document_not_linked_to_journal' | 'document_not_on_control_account';
}

/**
 * @param controlAccountIds every candidate control account. An EMPTY array
 *   short-circuits — with no control account, "not on the control account" is
 *   not a finding about the document, and `no_control_account` already says so.
 */
export async function getUnpostedSubledgerDocuments(
  companyId: string,
  role: SubledgerRole,
  asAtDate: string,
  controlAccountIds: readonly string[],
): Promise<UnpostedDocument[]> {
  if ((role !== 'ar' && role !== 'ap') || controlAccountIds.length === 0) return [];

  try {
    const ids = [...controlAccountIds];
    const isAr = role === 'ar';
    // The document's contribution must be the SAME NUMBER the subledger
    // snapshot counted for it, on the same population and the same
    // point-in-time basis — the rewind, the status rule and the as-at cutoff.
    // Drift between the two definitions lands in `unexplained_difference` and
    // reads as a finding about the books rather than about this code.
    const todayStr = fmtDate(new Date());

    const rows = await readUnpostedDocumentRows(isAr, { companyId, asAtDate, todayStr, ids });

    const out: UnpostedDocument[] = [];
    for (const r of rows) {
      const shortfall = round2(Number(r.balance ?? 0) - Number(r.control_amount ?? 0));
      // A document exactly represented on a control account is not a finding.
      // A document the ledger OVER-states is, so both signs are kept.
      if (shortfall === 0) continue;
      out.push({
        id: String(r.id),
        documentNumber: r.document_number == null ? null : String(r.document_number),
        entityName: r.entity_name == null ? null : String(r.entity_name),
        documentDate: fmtDate(r.document_date as string | Date),
        amount: shortfall,
        gross: round2(Number(r.gross ?? 0)),
        reason:
          r.has_journal === true ? 'document_not_on_control_account' : 'document_not_linked_to_journal',
      });
    }
    return out;
  } catch (err) {
    log.error('Failed to find unposted subledger documents', { role, error: err }, 'accounting');
    throw err;
  }
}
