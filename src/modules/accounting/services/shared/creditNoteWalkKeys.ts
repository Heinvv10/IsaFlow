/**
 * The credit-note keys a CUSTOMER note's application takes before it reads any typed invoice's capacity (#1701 round 8
 * item 1). Every reader of a typed invoice's remaining credit now holds that invoice's key: a linked approval (step 2),
 * REST / MCP apply and adjust (one key), unapply / adjust's guard (the note's invoices, sorted), and the FIFO walk,
 * which used to hold only the candidates' ROWS, so a walk and a linked approval with auto_apply 'none' on the same typed
 * invoice could both read R115 left and both consume it.
 *
 * ONE sorted set, taken once, right after the note row and before any invoice row: the linked invoice's key and, for a
 * walk, every candidate's (the entity's open invoices, read unlocked here: the candidate set does not depend on the
 * journal). Nothing is acquired later, so no request holds a key while waiting for a smaller one (the cycle a later
 * acquisition would make). The walk then plans only over candidates it holds a key for; one that opened since is left
 * out (the remainder stays on account). Lock census: ar/.claude.md, limit (k).
 */
import { lockInvoiceCreditNotes } from '../ar/creditNotePostingChecks';
import { fetchOpenCustomerInvoices } from '../ar/openCustomerInvoices';

/** Takes, in id order, the keys of `linkedInvoiceId` and (when `walk`) of every open invoice of `entityId`; returns them. */
export async function lockCustomerWalkKeys(
  companyId: string, entityId: string | null, linkedInvoiceId: string | null, walk: boolean,
): Promise<Set<string>> {
  const ids = new Set<string>();
  if (linkedInvoiceId) ids.add(linkedInvoiceId.toLowerCase());
  if (walk && entityId) {
    for (const d of await fetchOpenCustomerInvoices(companyId, entityId, true, { forUpdate: false })) ids.add(d.invoiceId.toLowerCase());
  }
  for (const id of [...ids].sort()) await lockInvoiceCreditNotes(id);
  return ids;
}
