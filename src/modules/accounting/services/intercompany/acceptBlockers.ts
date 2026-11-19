/** Pure: everything that stops an intercompany message being accepted, in plain sentences (the dialog shows them, the service refuses with the first). */
import type { AcceptSide } from './acceptContext';
import type { InboxItem } from './inboxTypes';
import type { MirrorPayload } from './mirrorPayload';

export const WITHDRAWN_SENTENCE = 'The sender cancelled this document, so it cannot be accepted.';

const STATUS_BLOCKER: Partial<Record<InboxItem['status'], string>> = {
  withdrawn: WITHDRAWN_SENTENCE,
  accepted: 'This message was already accepted.',
  rejected: 'This message was already rejected.',
  dismissed: 'This message was dismissed. Restore it first.',
};

export function acceptBlockers(
  item: Pick<InboxItem, 'status' | 'blocker' | 'kind' | 'sourceCancelled'>,
  payload: MirrorPayload | null,
  side: AcceptSide | null,
  duplicate: { number: string } | null,
  auto = false,
): string[] {
  const out: string[] = [];
  const handled = STATUS_BLOCKER[item.status];
  if (handled) out.push(handled);
  else if (item.sourceCancelled) out.push(WITHDRAWN_SENTENCE);
  if (item.blocker) out.push(item.blocker);
  if (!side) {
    out.push('This company has no setup for this connection. Open Settings › Intercompany.');
    return out;
  }
  if (side.status !== 'active') out.push('The connection is not active.');
  if (!side.supplierId) out.push('Link the supplier for this connection first (Settings › Intercompany), so the draft goes on the right supplier.');
  if (auto && !side.autoAccept) out.push('Automatic acceptance is off for this connection.');
  if (auto && side.kind !== 'group') out.push('Automatic acceptance is only for a group connection.');
  if (duplicate && payload) {
    out.push(`${payload.kind === 'invoice' ? 'A bill' : 'A credit note'} numbered ${duplicate.number} already exists for this supplier.`);
  }
  return out;
}
