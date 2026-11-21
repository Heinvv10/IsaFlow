/**
 * The credit-note keys a CUSTOMER note's application takes before it reads any typed invoice's capacity (#1701 round 8
 * item 1). Every reader of a typed invoice's remaining credit holds that invoice's key: a linked approval (step 2),
 * REST / MCP apply and adjust (one key), unapply / adjust's guard (the note's invoices, sorted), and the FIFO walk,
 * which used to hold only the candidates' ROWS, so a walk and a linked approval with auto_apply 'none' on the same typed
 * invoice could both read R115 left and both consume it.
 *
 * ONE sorted set, taken once, right after the note row and before any invoice row: the linked invoice's key and, for a
 * walk, the candidates the walk can reach. Nothing is acquired later, so no request holds a key while waiting for a
 * smaller one. The walk then plans only over candidates it holds a key for; one that opened since, or one past the
 * bound below, is left out (the remainder stays on account: never more credit, only less).
 *
 * THE BOUND (round 9): not every open invoice, which for a large customer is thousands of statements. The customer's
 * open invoices in the walk's own order (oldest first) until what they can take covers `amount`: each one's outstanding,
 * capped at a typed invoice's capacity (read here, unlocked). The walk's greedy plan over the same figures stops inside
 * that prefix, so it plans what it would over every invoice; a figure moved since (a concurrent receipt) can only make
 * it stop early. So a walk takes at most 1 + the invoices its amount needs (and never more than the customer's open
 * invoices). Lock census: ar/.claude.md, limit (k).
 */
import { lockInvoiceCreditNotes } from '../ar/creditNotePostingChecks';
import { fetchOpenCustomerInvoices } from '../ar/openCustomerInvoices';
import { typedCreditCapacity } from '../ar/creditNoteTypedApplication';

const cents = (n: number): number => Math.round(n * 100);

/** The invoices whose keys a walk of `amount` (rands) takes: the linked one and the covering prefix (see the header). */
export async function walkKeyInvoices(
  companyId: string, entityId: string | null, linkedInvoiceId: string | null, walk: boolean, amount: number,
): Promise<string[]> {
  const ids: string[] = linkedInvoiceId ? [linkedInvoiceId.toLowerCase()] : [];
  if (!walk || !entityId) return ids;
  let covered = 0;
  for (const d of await fetchOpenCustomerInvoices(companyId, entityId, true, { forUpdate: false })) {
    if (covered >= cents(amount)) break;
    const id = d.invoiceId.toLowerCase();
    if (id === ids[0]) continue;
    const cap = (await typedCreditCapacity(companyId, id))?.cap ?? null;
    covered += Math.min(cents(d.outstanding), cap ?? Number.MAX_SAFE_INTEGER);
    ids.push(id);
  }
  return ids;
}

/** Takes these keys, each once, lower-cased, in id order; returns them. */
export async function lockKeys(invoiceIds: readonly string[]): Promise<Set<string>> {
  const ids = new Set(invoiceIds.map((id) => id.toLowerCase()));
  for (const id of [...ids].sort()) await lockInvoiceCreditNotes(id);
  return ids;
}

/** walkKeyInvoices, locked. */
export async function lockCustomerWalkKeys(
  companyId: string, entityId: string | null, linkedInvoiceId: string | null, walk: boolean, amount: number,
): Promise<Set<string>> {
  return lockKeys(await walkKeyInvoices(companyId, entityId, linkedInvoiceId, walk, amount));
}
