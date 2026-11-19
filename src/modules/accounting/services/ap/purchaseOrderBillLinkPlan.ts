/**
 * link_bills_to_purchase_order: the decision, with no I/O. Every request is judged against the facts read under the
 * locks (`purchaseOrderBillLinkRead`), in input order, each seeing the links the rows before it would make; every bad
 * row is listed and the call is refused whole (the planner returns the refusals, the writer writes nothing).
 *
 * Rules (design decisions 2, 4, 6, 8, 9):
 *   - PO approved / partially_received / received / closed; bill not cancelled (or deleted); one company, one supplier;
 *   - a pair is linked once: the same (external_system, external_ref) again is `existing` (already_existed, no
 *     write), any other attempt is refused; a reference already on ANOTHER pair is refused;
 *   - a line link names a line of the row's PO and a line of the row's bill; a bill line already naming ANOTHER PO line
 *     is refused (naming the same one is fine); a bill line is named once in a call;
 *   - amount: explicit; else the posted ex-VAT of the bill's lines linked to this PO (named now, or already); else the
 *     bill's subtotal less its other links. It must be above zero and take the bill's links no further than its subtotal
 *     (+1 c);
 *   - close_when_fully_billed: an approved / partially_received / received PO that the call leaves fully billed
 *     (billed = amounts of links on approved / paid / partially_paid bills, >= subtotal - 1 c) becomes closed; the
 *     LAST new link of that PO in the call records the status it came from.
 */
import {
  BILLED_BILL_STATUSES, CLOSABLE_PO_STATUSES, FULLY_BILLED_TOLERANCE_CENTS, LINKABLE_PO_STATUSES, isFullyBilled,
  type BillFacts, type ExistingLink, type LinkPlan, type LinkRequest, type LinkRowRefusal, type PlannedLink, type PoAfter,
  type PoFacts,
} from './purchaseOrderBillLinkTypes';

export interface PlanInput {
  requests: readonly LinkRequest[];
  /** The request's PO id once resolved from po_id / po_number; a missing entry is "not found". */
  resolvedPo: ReadonlyMap<number, string>;
  pos: ReadonlyMap<string, PoFacts>;
  bills: ReadonlyMap<string, BillFacts>;
  /** The PO each named PO line belongs to (this company's POs only; a line of no PO of the company is absent). */
  poItemOwner: ReadonlyMap<string, string>;
  /** Every existing link of the POs and bills involved. */
  existing: readonly ExistingLink[];
  /** The existing links carrying a reference some request names, keyed `system\u0000ref`. */
  refOwners: ReadonlyMap<string, ExistingLink>;
  closeWhenFullyBilled: boolean;
}

const refKey = (r: { system: string; ref: string }) => `${r.system}\u0000${r.ref}`;
const fmt = (cents: number) => (cents / 100).toFixed(2);

export function planLinks(input: PlanInput): { plan: LinkPlan | null; refusals: LinkRowRefusal[] } {
  const refusals: LinkRowRefusal[] = [];
  const planned: PlannedLink[] = [];
  const pairSeen = new Map<string, number>();
  const lineClaimed = new Map<string, { index: number; poItemId: string }>();
  // Per bill: cents already linked (existing, then earlier rows of this call).
  const billLinked = new Map<string, number>();
  for (const l of input.existing) billLinked.set(l.billId, (billLinked.get(l.billId) ?? 0) + l.amountCents);

  for (const r of input.requests) {
    const refuse = (reason: string) => { refusals.push({ index: r.index, reason }); };
    const poId = input.resolvedPo.get(r.index);
    const po = poId ? input.pos.get(poId) : undefined;
    const bill = input.bills.get(r.billId);
    if (!po) { refuse('purchase order not found'); continue; }
    if (!bill) { refuse('bill not found'); continue; }
    if (!(LINKABLE_PO_STATUSES as readonly string[]).includes(po.status)) {
      refuse(`purchase order ${po.poNumber} is ${po.status}; only an approved, partially received, received or closed one takes a bill`);
      continue;
    }
    if (bill.status === 'cancelled') { refuse(`bill ${bill.invoiceNumber} is cancelled`); continue; }
    if (bill.supplierId !== po.supplierId) {
      refuse(`bill ${bill.invoiceNumber} and purchase order ${po.poNumber} are of different suppliers`);
      continue;
    }
    const pair = `${po.id}\u0000${bill.id}`;
    const dup = pairSeen.get(pair);
    if (dup !== undefined) { refuse(`the same purchase order and bill as links[${dup}]`); continue; }
    pairSeen.set(pair, r.index);

    const existing = input.existing.find((l) => l.poId === po.id && l.billId === bill.id) ?? null;
    if (existing) {
      if (r.ref && existing.refSystem === r.ref.system && existing.refRef === r.ref.ref) {
        planned.push({
          index: r.index, poId: po.id, poNumber: po.poNumber, billId: bill.id, invoiceNumber: bill.invoiceNumber,
          amountCents: existing.amountCents, ref: r.ref, lineWrites: [], linesLinked: 0, closedFrom: null, existing,
        });
      } else {
        refuse(`bill ${bill.invoiceNumber} is already linked to purchase order ${po.poNumber}`
          + `${existing.refRef ? ` (external_ref ${existing.refRef})` : ''}; unlink it first to change the link`);
      }
      continue;
    }
    if (r.ref) {
      const owner = input.refOwners.get(refKey(r.ref));
      if (owner) { refuse(`external_ref ${r.ref.ref} (${r.ref.system}) is already used by another purchase order link`); continue; }
    }

    const lineBad = lineRefusal(r, po, bill, lineClaimed, input.poItemOwner);
    if (lineBad) { refuse(lineBad); continue; }
    const named = new Set(r.lines.map((l) => l.billLineId));
    const lineWrites = r.lines.filter((l) => bill.lines.find((b) => b.id === l.billLineId)!.poItemId !== l.poItemId);
    for (const l of r.lines) lineClaimed.set(l.billLineId, { index: r.index, poItemId: l.poItemId });

    const others = billLinked.get(bill.id) ?? 0;
    let amount: number;
    if (r.amountCents !== null) amount = r.amountCents;
    else {
      const linked = bill.lines.filter((b) => named.has(b.id) || b.poItemPoId === po.id);
      amount = linked.length > 0 ? linked.reduce((s, b) => s + b.postedCents, 0) : bill.subtotalCents - others;
    }
    if (amount <= 0) {
      refuse(`the amount to link is ${fmt(amount)}; give an amount above zero (bill ${bill.invoiceNumber} has ${fmt(bill.subtotalCents)} ex VAT, ${fmt(others)} already linked)`);
      continue;
    }
    if (others + amount > bill.subtotalCents + FULLY_BILLED_TOLERANCE_CENTS) {
      refuse(`bill ${bill.invoiceNumber} has ${fmt(bill.subtotalCents)} ex VAT and ${fmt(others)} is already linked; ${fmt(amount)} more would pass it`);
      continue;
    }
    billLinked.set(bill.id, others + amount);
    planned.push({
      index: r.index, poId: po.id, poNumber: po.poNumber, billId: bill.id, invoiceNumber: bill.invoiceNumber, amountCents: amount,
      ref: r.ref, lineWrites, linesLinked: r.lines.length, closedFrom: null, existing: null,
    });
  }
  if (refusals.length > 0) return { plan: null, refusals };
  return { plan: { planned, poAfter: afterState(input, planned) }, refusals };
}

function lineRefusal(
  r: LinkRequest, po: PoFacts, bill: BillFacts, claimed: Map<string, { index: number; poItemId: string }>,
  poItemOwner: ReadonlyMap<string, string>,
): string | null {
  for (const l of r.lines) {
    if (poItemOwner.get(l.poItemId) !== po.id) return `purchase order line ${l.poItemId} is not a line of purchase order ${po.poNumber}`;
    const line = bill.lines.find((b) => b.id === l.billLineId);
    if (!line) return `bill line ${l.billLineId} is not a line of bill ${bill.invoiceNumber}`;
    if (line.poItemId !== null && line.poItemId !== l.poItemId) {
      return `bill line ${l.billLineId} already names another purchase order line; unlink it first`;
    }
    const other = claimed.get(l.billLineId);
    if (other) return `bill line ${l.billLineId} is also named by links[${other.index}]`;
  }
  return null;
}

/** Billed totals and the close decision, per PO the call touches; sets `closedFrom` on the closing link. */
function afterState(input: PlanInput, planned: PlannedLink[]): Map<string, PoAfter> {
  const out = new Map<string, PoAfter>();
  const touched = new Set(planned.filter((p) => !p.existing).map((p) => p.poId));
  for (const poId of new Set(planned.map((p) => p.poId))) {
    const po = input.pos.get(poId)!;
    const counted = (status: string | undefined) => status !== undefined && BILLED_BILL_STATUSES.includes(status);
    let billed = input.existing.filter((l) => l.poId === poId && counted(l.billStatus)).reduce((s, l) => s + l.amountCents, 0);
    for (const p of planned) {
      if (p.poId === poId && !p.existing && counted(input.bills.get(p.billId)?.status)) billed += p.amountCents;
    }
    let statusAfter = po.status;
    const fully = isFullyBilled(billed, po.subtotalCents);
    if (touched.has(poId) && input.closeWhenFullyBilled && fully && (CLOSABLE_PO_STATUSES as readonly string[]).includes(po.status)) {
      statusAfter = 'closed';
      const last = [...planned].reverse().find((p) => p.poId === poId && !p.existing)!;
      last.closedFrom = po.status;
    }
    out.set(poId, { poId, statusBefore: po.status, statusAfter, billedCents: billed, subtotalCents: po.subtotalCents, fullyBilled: fully });
  }
  return out;
}
