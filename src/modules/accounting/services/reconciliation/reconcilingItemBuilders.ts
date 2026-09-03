/**
 * Turns the four readers' output into reconciling items.
 *
 * Split out of `subledgerReconciliationService` for the 300-line limit, and it
 * earns its own file: this is where the decision about WHICH BRIDGE an item
 * belongs on is made, and that decision is the substance of the endpoint. An
 * item on the wrong bridge produces a difference that does not add up while
 * every individual number in the response is correct.
 */

import type { SubledgerDocument, SubledgerSnapshot } from '../ar/subledgerTypes';
import type { UnappliedCash } from './unappliedCashService';
import type { UnpostedDocument } from './unpostedDocumentService';
import { round2 } from './reconciliationMath';
import type { CitableDocument, ReconcilingBridge, ReconcilingItem } from './reconcilingItemTypes';

export function sumBalances(docs: readonly SubledgerDocument[]): number {
  return docs.reduce((s, d) => s + d.balance, 0);
}

function item(
  bridge: ReconcilingBridge,
  type: string,
  description: string,
  amount: number,
  docs: readonly CitableDocument[],
): ReconcilingItem {
  return {
    bridge,
    type,
    description,
    amount: round2(amount),
    documentIds: docs.map((d) => d.id),
    documentNumbers: docs
      .map((d) => d.documentNumber)
      .filter((n): n is string => typeof n === 'string' && n.length > 0),
  };
}

const AFTER_AS_AT = 'document_after_as_at';

const UNPOSTED_TEXT: Record<UnpostedDocument['reason'], string> = {
  document_not_linked_to_journal:
    'open document(s) carry no link to a journal entry, so nothing ties their value to the control account. The value may still be on the account — see posting_with_no_document, which counts it from the ledger side.',
  document_not_on_control_account:
    'open document(s) have a linked journal whose effect on the control accounts differs from the document balance.',
};

export interface ItemInputs {
  snapshot: SubledgerSnapshot & { disputes?: ReadonlyMap<string, number> };
  cash: UnappliedCash;
  unposted: readonly UnpostedDocument[];
  asAtDate: string;
}

export function buildReconcilingItems({
  snapshot,
  cash,
  unposted,
  asAtDate,
}: ItemInputs): ReconcilingItem[] {
  const items: ReconcilingItem[] = [];

  // ── Bridge 1: the aged report to the subledger ────────────────────────────
  if (snapshot.unageable.length > 0) {
    items.push(
      item(
        'aged_to_subledger',
        'unageable_document',
        `${snapshot.unageable.length} document(s) have no due date and cannot be placed in an aging bucket, so the aged report omits them. They are still owed.`,
        sumBalances(snapshot.unageable),
        snapshot.unageable,
      ),
    );
  }

  const disputes = snapshot.disputes;
  if (disputes && disputes.size > 0) {
    const disputed = snapshot.ageable.filter((d) => (disputes.get(d.id) ?? 0) > 0);
    const disputedTotal = disputed.reduce(
      (s, d) => s + Math.min(disputes.get(d.id) ?? 0, d.balance),
      0,
    );
    if (disputedTotal > 0) {
      items.push(
        item(
          'aged_to_subledger',
          'disputed_amount',
          'Amounts under open dispute. The aged report subtracts these from its bucket totals; the subledger still carries them.',
          disputedTotal,
          disputed,
        ),
      );
    }
  }

  // ── Bridge 2: the subledger to the control account ────────────────────────
  if (cash.withPaymentRecord.length > 0) {
    items.push(
      item(
        'subledger_to_control',
        'unapplied_receipt',
        `${cash.withPaymentRecord.length} payment document(s) credited to the control account with nothing (or not everything) applied to a document. The GL is reduced; the subledger is not.`,
        cash.withPaymentRecord.reduce((s, i) => s + i.amount, 0),
        cash.withPaymentRecord,
      ),
    );
  }
  if (cash.withoutPaymentRecord.length > 0) {
    items.push(
      item(
        'subledger_to_control',
        'posting_with_no_document',
        `${cash.withoutPaymentRecord.length} posted journal(s) moved the control account with NO subledger document referencing them, so no cash-application or invoicing tool can see or clear them. Cash that arrived this way needs a payment document created before it can be applied.`,
        cash.withoutPaymentRecord.reduce((s, i) => s + i.amount, 0),
        cash.withoutPaymentRecord,
      ),
    );
  }

  // A document dated after the reporting date is RECLASSIFIED, never added.
  //
  // It has no control posting as at that date, so `getUnpostedSubledgerDocuments`
  // already returns it with a shortfall equal to its whole balance. Emitting a
  // separate `document_after_as_at` item over `snapshot.afterAsAt` counted the
  // same document twice and left a residual of exactly minus its balance —
  // R5,836,396.24 of AR and R1,206,462.27 of AP on production ISAFlow Demo,
  // invisible on isaflow_dev, where nothing is future-dated.
  //
  // The two partitions the reconciliation rests on (documents that claim a
  // journal, journals no document claims) must cover the control account
  // exactly once each. So the date is a LABEL applied to the unposted row, not
  // a third source of amounts: the reader still gets the reason that actually
  // explains the document, and the arithmetic still closes.
  const afterIds = new Set(snapshot.afterAsAt.map((d) => d.id));

  // Grouped by reason, because "never posted" and "posted to the wrong account"
  // need different remedies and a single lump tells a reader neither.
  const byReason = new Map<string, UnpostedDocument[]>();
  for (const doc of unposted) {
    const key = afterIds.has(doc.id) ? AFTER_AS_AT : doc.reason;
    const list = byReason.get(key);
    if (list) list.push(doc);
    else byReason.set(key, [doc]);
  }
  for (const [reason, docs] of byReason) {
    const text =
      reason === AFTER_AS_AT
        ? `open document(s) are dated after ${asAtDate}. The subledger counts them; the control-account balance stops at the reporting date and cannot.`
        : UNPOSTED_TEXT[reason as UnpostedDocument['reason']];
    items.push(
      item('subledger_to_control', reason, `${docs.length} ${text}`, docs.reduce((s, d) => s + d.amount, 0), docs),
    );
  }

  return items;
}

/**
 * The residual, emitted AS AN ITEM whenever it is non-zero so that an
 * incomplete decomposition cannot be mistaken for a complete one.
 */
export function unexplainedItem(amount: number): ReconcilingItem {
  return {
    bridge: 'subledger_to_control',
    type: 'unexplained_difference',
    description:
      'The residual this reconciliation could NOT account for. It is reported as an item so that an incomplete decomposition cannot be mistaken for a complete one.',
    amount,
    documentIds: [],
    documentNumbers: [],
  };
}
