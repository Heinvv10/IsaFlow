/**
 * Turns the readers' output into reconciling items.
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

const UNPOSTED_TEXT: Record<UnpostedDocument['reason'], string> = {
  document_not_linked_to_journal:
    'open document(s) carry no link to a journal entry, so nothing ties their value to the control account. The value may still be on the account — see posting_with_no_document, which counts it from the ledger side.',
  document_not_on_control_account:
    'open document(s) have a linked journal whose effect on the control accounts as at the reporting date differs from the document balance. A journal dated AFTER the reporting date lands here, which is what it is: the document is in the subledger and its posting is not yet in the ledger balance.',
};

export interface ItemInputs {
  snapshot: SubledgerSnapshot & { disputes?: ReadonlyMap<string, number> };
  cash: UnappliedCash;
  unposted: readonly UnpostedDocument[];
}

/**
 * Bridge 1 — the AGED REPORT to the subledger.
 *
 * These do NOT explain any GL difference: the documents' own journals are
 * already in the control account. They explain why the aged report's total is
 * not the subledger's, which is a different question, and adding the two
 * bridges together produces a number that reconciles to nothing.
 *
 * There are exactly two mechanisms, both of them properties of
 * `calculateAgingBuckets` rather than of the data:
 *
 *   `disputed_amount`        AR bucket totals are net of open disputes.
 *   `unallocated_credit_note`  a row with a balance <= 0 never reaches a
 *                            bucket, so unallocated credit never nets off the
 *                            aged total. The subledger carries it.
 *
 * `unageable_document` USED to be a third. It was removed: it claimed the aged
 * report drops invoices with no due date, which was true before #303 and is
 * not true now — they are aged from `invoice_date`. It was R12,730,757.43 of
 * Velocity AR and R1,058,000 of Brightsphere, attributed to a mechanism that
 * had been fixed. `snapshot.unageable` is still populated, because "this
 * invoice has no due date" remains worth knowing; it is no longer a difference.
 */
export function buildAgedBridgeItems({
  snapshot,
  agedTotal,
}: {
  snapshot: SubledgerSnapshot & { disputes?: ReadonlyMap<string, number> };
  agedTotal: number | null;
}): ReconcilingItem[] {
  const items: ReconcilingItem[] = [];

  const disputes = snapshot.disputes;
  if (disputes && disputes.size > 0) {
    const disputed = snapshot.ageable.filter((d) => (disputes.get(d.id) ?? 0) > 0);
    // Capped at the document's own balance: a dispute recorded for more than
    // is outstanding cannot remove more than the bucket ever held.
    const disputedTotal = disputed.reduce(
      (s, d) => s + Math.min(disputes.get(d.id) ?? 0, d.balance),
      0,
    );
    if (round2(disputedTotal) !== 0) {
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

  const creditTotal = sumBalances(snapshot.creditNotes);
  if (round2(creditTotal) !== 0) {
    items.push(
      item(
        'aged_to_subledger',
        'unallocated_credit_note',
        `${snapshot.creditNotes.length} approved credit note(s) are not applied to any document. The subledger nets them off what is owed; the aged report cannot, because a row with a balance of zero or less never reaches an aging bucket.`,
        creditTotal,
        snapshot.creditNotes,
      ),
    );
  }

  // The residual on THIS bridge, emitted as an item for the same reason as on
  // the other one: an incomplete decomposition must not be mistakable for a
  // complete one. It is the check that catches the next mechanism nobody has
  // noticed yet — which is exactly how `unageable_document` came to be wrong
  // without anything going red.
  if (agedTotal !== null) {
    const explained = round2(items.reduce((s, i) => s + i.amount, 0));
    const residual = round2(snapshot.subledgerTotal - agedTotal - explained);
    if (residual !== 0) {
      items.push({
        bridge: 'aged_to_subledger',
        type: 'aged_unexplained_difference',
        description:
          'The part of the gap between the aged report total and the subledger total that this reconciliation could NOT account for. Reported as an item so an incomplete decomposition cannot be mistaken for a complete one.',
        amount: residual,
        documentIds: [],
        documentNumbers: [],
      });
    }
  }

  return items;
}

/**
 * Bridge 2 — the SUBLEDGER to the control account. This is the reconciliation
 * proper: unapplied cash, postings no document claims, documents whose value
 * never reached a control account.
 */
export function buildControlBridgeItems({ cash, unposted }: ItemInputs): ReconcilingItem[] {
  const items: ReconcilingItem[] = [];

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

  // Grouped by reason, because "never posted" and "posted to the wrong account"
  // need different remedies and a single lump tells a reader neither.
  const byReason = new Map<UnpostedDocument['reason'], UnpostedDocument[]>();
  for (const doc of unposted) {
    const list = byReason.get(doc.reason);
    if (list) list.push(doc);
    else byReason.set(doc.reason, [doc]);
  }
  for (const [reason, docs] of byReason) {
    items.push(
      item(
        'subledger_to_control',
        reason,
        `${docs.length} ${UNPOSTED_TEXT[reason]}`,
        docs.reduce((s, d) => s + d.amount, 0),
        docs,
      ),
    );
  }

  return items;
}

/**
 * The residual on the control bridge, emitted AS AN ITEM whenever it is
 * non-zero so that an incomplete decomposition cannot be mistaken for a
 * complete one.
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
