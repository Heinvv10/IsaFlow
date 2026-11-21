/**
 * The FIFO plan of a CUSTOMER credit note's credit with each TYPED invoice's room capped at what it has left to credit
 * (ar/creditNoteTypedApplication, #1701 round 5). ONE planner for the live walks (approve's and auto_apply_unapplied's,
 * both `creditNoteFifo.applyCreditNote`) and the back-fill's dry run (`autoApplySimulation`, probed by
 * `autoApplyBackfillService`), so the dry run plans what the live run writes (docs/mcp/CONTRACTS.md section 6).
 *
 * A typed invoice that fits partly takes what fits (round 5 L2; round 4 skipped it). Its capacity is read once per
 * walk, and only for the invoices the plan reaches: plan, read the capacity of each reached invoice not yet read, plan
 * again until none is new. Greedy planning stops when the cash is used up, so an invoice the plan never reaches cannot
 * change it, and the result equals a plan over every capacity. The note's own linked invoice is never capped. Pure but
 * for the capacity reader the caller passes.
 */
import { planGreedyAllocations, type OpenDocument, type PlannedAllocation } from './autoAllocateStrategy';
import { gated, type GateNote } from '../ar/creditNoteTypedGate';

/** invoice id -> capacity left in cents; null = no cap (a legacy invoice). */
export type CapacityCache = Map<string, number | null>;

/** The documents with each gated, capped one's room cut to its capacity. Pure. */
export function cappedDocuments<T extends OpenDocument>(
  docs: readonly T[], caps: ReadonlyMap<string, number | null>, note: Pick<GateNote, 'type' | 'customerInvoiceId'>,
): T[] {
  return docs.map((d) => {
    const cap = gated(note, d.invoiceId) ? caps.get(d.invoiceId) : null;
    return cap == null ? d : { ...d, outstanding: Math.min(d.outstanding, Math.max(cap, 0) / 100) };
  });
}

/** The planned invoices the note is gated on whose capacity is not read yet. Pure. */
export function unreadCapacities(
  planned: readonly { invoiceId: string }[], caps: ReadonlyMap<string, number | null>,
  note: Pick<GateNote, 'type' | 'customerInvoiceId'>,
): string[] {
  return planned.map((p) => p.invoiceId).filter((id) => gated(note, id) && !caps.has(id));
}

/** A typed invoice's capacity in cents, or null for a legacy one (the live reader is ar/creditNoteTypedApplication). */
export type CapacityReader = (invoiceId: string) => Promise<number | null>;

/** Reads each capacity into the cache. */
export async function readCapacities(read: CapacityReader, ids: readonly string[], caps: CapacityCache): Promise<void> {
  for (const id of ids) caps.set(id, await read(id));
}

/** The live walk's plan: planGreedyAllocations over the capped documents, capacities read as the plan reaches them. */
export async function planWithinTypedCapacity(
  read: CapacityReader, note: Pick<GateNote, 'type' | 'customerInvoiceId'>, cash: number, docs: readonly OpenDocument[], floor: number,
): Promise<PlannedAllocation[]> {
  const caps: CapacityCache = new Map();
  for (;;) {
    const planned = planGreedyAllocations(cash, cappedDocuments(docs, caps, note), floor);
    const unread = unreadCapacities(planned, caps, note);
    if (unread.length === 0) return planned;
    await readCapacities(read, unread, caps);
  }
}
