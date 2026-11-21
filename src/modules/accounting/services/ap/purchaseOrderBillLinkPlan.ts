/**
 * link_bills_to_purchase_order: the decision, with no I/O. Every request is judged against the facts read under the
 * locks (`purchaseOrderBillLinkRead`), in input order, each seeing the links the rows before it would make; every bad
 * row is listed and the call is refused whole (the planner returns the refusals, the writer writes nothing).
 *
 * Rules (design decisions 2, 4, 6, 8, 9):
 *   - PO approved / partially_received / received / closed; bill approved / paid / partially_paid (R3, Hein 19 Nov:
 *     a draft or cancelled bill is not billed); one company, one supplier;
 *   - a pair is linked once: the same (external_system, external_ref) again is `existing` (already_existed, no write)
 *     when the amount / lines agree, else refused `payload_differs`; a ref-less link (app / backfill) re-sent WITH a
 *     reference adopts it under the same test; any other attempt is refused; a reference on ANOTHER pair is refused;
 *   - a line link names a line of the row's PO and a line of the row's bill; a bill line already naming ANOTHER PO line
 *     is refused (naming the same one is fine); a bill line is named once in a call;
 *   - amount: when lines of the bill name this PO (named now, or already), the posted ex-VAT of those lines, and an explicit
 *     amount must be that within a cent (PR #1703 breaker BRK-A: else the lines net one figure and the link holds another) and
 *     lines that post nothing are refused (BRK-C); else explicit; else the bill's subtotal less what it attributes to its
 *     other POs (lines when its lines name that PO, else that PO's link: one rand to one PO, BRK-B). It must be above zero and
 *     take the bill no further than its subtotal (+1 c). A header tie is a residual, never a hold (breaker R4-4): a link by amount
 *     never takes a header tie's rands silently: with no amount it is refused, naming the header's PO ("give an amount or unlink it
 *     first"), with an amount it may take them and reports what it took (`takesFromHeader`, warned in the reply); a link by lines
 *     does take them, because lines win (review r4 L1). A header PO the same call links is no header tie (review r4 M1);
 *   - close_when_fully_billed: an approved / partially_received / received PO that the call leaves fully billed
 *     (billed = the attributed amounts of links on approved / paid / partially_paid bills, plus the bills that tie the PO
 *     with no link row, by header or by lines, as `budgets/billAttribution` and get_purchase_order count them, >= subtotal - 1 c)
 *     becomes closed; the
 *     LAST new link of that PO in the call records the status it came from.
 */
import { COMMITTING_PO_STATUSES } from '../budgets/remainingCommitted';
import {
  CLOSABLE_PO_STATUSES, FULLY_BILLED_TOLERANCE_CENTS, LINKABLE_BILL_STATUSES, LINKABLE_PO_STATUSES, isFullyBilled,
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
  /** Per PO, the approved / paid / partially_paid bills that tie it with NO link row (by header, or by lines): what each holds. */
  unlinkedBilled?: ReadonlyMap<string, ReadonlyArray<{ billId: string; cents: number }>>;
  /** Per bill of the call, the POs it ties ONLY by its header (no link row, no lines) and what each holds (breaker R3-4). */
  heldByHeader?: ReadonlyMap<string, ReadonlyArray<{ poId: string; poNumber: string; status: string; cents: number }>>;
}

const refKey = (r: { system: string; ref: string }) => `${r.system}\u0000${r.ref}`;
const fmt = (cents: number) => (cents / 100).toFixed(2);

export function planLinks(input: PlanInput): { plan: LinkPlan | null; refusals: LinkRowRefusal[] } {
  const refusals: LinkRowRefusal[] = [];
  const planned: PlannedLink[] = [];
  const pairSeen = new Map<string, number>();
  const callLinks = new Set(input.requests.map((r) => `${input.resolvedPo.get(r.index) ?? ''}\u0000${r.billId}`));
  const lineClaimed = new Map<string, { index: number; poItemId: string }>();
  // Per bill, what it attributes to each PO: its links (the read gives a line-linked pair its lines' amount), then, for a PO its
  // lines name, those lines (positive only); then earlier rows of this call.
  const attributed = new Map<string, Map<string, number>>();
  const att = (billId: string) => { if (!attributed.has(billId)) attributed.set(billId, new Map()); return attributed.get(billId)!; };
  for (const l of input.existing) att(l.billId).set(l.poId, l.amountCents);
  for (const b of input.bills.values()) {
    const byPo = new Map<string, number>();
    for (const l of b.lines) if (l.poItemPoId) byPo.set(l.poItemPoId, (byPo.get(l.poItemPoId) ?? 0) + l.postedCents);
    for (const [p, c] of byPo) att(b.id).set(p, Math.max(0, c));
  }

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
    if (!LINKABLE_BILL_STATUSES.includes(bill.status)) {
      refuse(`bill ${bill.invoiceNumber} is ${bill.status}; only an approved, paid or partially paid bill can be linked`);
      continue;
    }
    if (bill.supplierId !== po.supplierId) {
      refuse(`bill ${bill.invoiceNumber} and purchase order ${po.poNumber} are of different suppliers`);
      continue;
    }
    const pair = `${po.id}\u0000${bill.id}`;
    const dup = pairSeen.get(pair);
    if (dup !== undefined) { refuse(`the same purchase order and bill as links[${dup}]`); continue; }
    pairSeen.set(pair, r.index);

    const existing = input.existing.find((l) => l.poId === po.id && l.billId === bill.id) ?? null;
    const owner = r.ref ? input.refOwners.get(refKey(r.ref)) : undefined;
    if (owner && owner.id !== existing?.id) {
      refuse(`external_ref ${r.ref!.ref} (${r.ref!.system}) is already used by another purchase order link`);
      continue;
    }
    if (existing) {
      const sameRef = r.ref !== null && existing.refSystem === r.ref.system && existing.refRef === r.ref.ref;
      const adopt = r.ref !== null && existing.refRef === null;
      if (!sameRef && !adopt) {
        refuse(`bill ${bill.invoiceNumber} is already linked to purchase order ${po.poNumber}`
          + `${existing.refRef ? ` (external_ref ${existing.refRef})` : ''}; unlink it first to change the link`);
        continue;
      }
      const differs = payloadDifference(r, existing, po, bill);
      if (differs) {
        refuse(`bill ${bill.invoiceNumber} is already linked to purchase order ${po.poNumber}, but this call differs (payload_differs): ${differs}; unlink it first to change the link`);
        continue;
      }
      planned.push({
        index: r.index, poId: po.id, poNumber: po.poNumber, billId: bill.id, invoiceNumber: bill.invoiceNumber,
        amountCents: existing.amountCents, ref: r.ref, lineWrites: [], linesLinked: 0, closedFrom: null, existing, adopt, takesFromHeader: null,
      });
      continue;
    }

    const lineBad = lineRefusal(r, po, bill, lineClaimed, input.poItemOwner);
    if (lineBad) { refuse(lineBad); continue; }
    const named = new Set(r.lines.map((l) => l.billLineId));
    const lineWrites = r.lines.filter((l) => bill.lines.find((b) => b.id === l.billLineId)!.poItemId !== l.poItemId);
    for (const l of r.lines) lineClaimed.set(l.billLineId, { index: r.index, poItemId: l.poItemId });

    // Firm: what the bill's links and lines (and this call's earlier rows) hold on its other POs. A header tie is a RESIDUAL, never
    // a hold (PR #1703 breaker R4-4): the PO the bill's header alone names holds what the firm ties leave, so a link takes from it only
    // by an explicit amount or by lines (lines win, review r4 L1), and the reply says what it took. A header PO this call also links
    // is no header tie at all (review r4 M1).
    const firm = [...att(bill.id).entries()].filter(([p]) => p !== po.id).reduce((s, [, c]) => s + c, 0);
    const header = (input.heldByHeader?.get(bill.id) ?? []).find((h) => h.poId !== po.id && !callLinks.has(`${h.poId}\u0000${bill.id}`));
    const headerHolds = header ? Math.max(0, bill.subtotalCents - firm) : 0;
    // Review r5 H1: an amount may take a header residual only from a COMMITTING PO; one closed or cancelled would be left
    // under-billed, so it is refused (unlink it from that PO first: the unlink re-judges it). Lines still win (they posted there).
    const headerOpen = !header || (COMMITTING_PO_STATUSES as readonly string[]).includes(header.status);
    const headerShut = header ? `the bill's header names purchase order ${header.poNumber}, which is ${header.status.replace(/_/g, ' ')}; unlink it from that purchase order first` : '';
    const linked = bill.lines.filter((b) => named.has(b.id) || b.poItemPoId === po.id);
    let amount: number;
    if (linked.length > 0) {
      const fromLines = linked.reduce((s, b) => s + b.postedCents, 0);
      if (fromLines <= 0) {
        refuse(`the bill lines named for purchase order ${po.poNumber} post ${fmt(fromLines)}; a link needs an amount above zero (link the bill without lines, or name lines that post)`);
        continue;
      }
      if (r.amountCents !== null && Math.abs(r.amountCents - fromLines) > FULLY_BILLED_TOLERANCE_CENTS) {
        refuse(`amount ${fmt(r.amountCents)} is not what the bill lines named for purchase order ${po.poNumber} post (${fmt(fromLines)}); send that amount, or no amount`);
        continue;
      }
      amount = fromLines;
    } else if (r.amountCents === null && header && headerHolds > 0) {
      refuse(headerOpen ? `the bill's header names purchase order ${header.poNumber}; give an amount or unlink it first` : headerShut);
      continue;
    } else amount = r.amountCents ?? bill.subtotalCents - firm;
    if (amount <= 0) {
      refuse(`the amount to link is ${fmt(amount)}; give an amount above zero (bill ${bill.invoiceNumber} has ${fmt(bill.subtotalCents)} ex VAT, ${fmt(firm)} already linked)`);
      continue;
    }
    if (firm + amount > bill.subtotalCents + FULLY_BILLED_TOLERANCE_CENTS) {
      refuse(`bill ${bill.invoiceNumber} has ${fmt(bill.subtotalCents)} ex VAT and ${fmt(firm)} is already linked; ${fmt(amount)} more would pass it`);
      continue;
    }
    const taken = headerHolds - Math.max(0, bill.subtotalCents - firm - amount);
    if (taken > 0 && !headerOpen && linked.length === 0) { refuse(headerShut); continue; }
    const takesFromHeader = header && taken > 0 ? { poId: header.poId, poNumber: header.poNumber, cents: taken } : null;
    att(bill.id).set(po.id, amount);
    planned.push({
      index: r.index, poId: po.id, poNumber: po.poNumber, billId: bill.id, invoiceNumber: bill.invoiceNumber, amountCents: amount,
      ref: r.ref, lineWrites, linesLinked: r.lines.length, closedFrom: null, existing: null, adopt: false, takesFromHeader,
    });
  }
  if (refusals.length > 0) return { plan: null, refusals };
  return { plan: { planned, poAfter: afterState(input, planned) }, refusals };
}

/** What a re-sent call says that the stored link does not (explicit amount, named lines); null when they agree. */
function payloadDifference(r: LinkRequest, existing: ExistingLink, po: PoFacts, bill: BillFacts): string | null {
  // The STORED amount (review r3 L1): a link written before the lines check, re-sent exactly as it was, still replays.
  if (r.amountCents !== null && r.amountCents !== existing.storedAmountCents) {
    return `amount ${fmt(r.amountCents)} against ${fmt(existing.storedAmountCents)} stored`;
  }
  if (r.lines.length > 0) {
    const stored = bill.lines.filter((l) => l.poItemPoId === po.id && l.poItemId).map((l) => `${l.poItemId}|${l.id}`).sort();
    const sent = r.lines.map((l) => `${l.poItemId}|${l.billLineId}`).sort();
    if (stored.length !== sent.length || stored.some((k, i) => k !== sent[i])) return 'the lines named are not the lines linked';
  }
  return null;
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
    const counted = (status: string | undefined) => status !== undefined && LINKABLE_BILL_STATUSES.includes(status);
    let billed = input.existing.filter((l) => l.poId === poId && counted(l.billStatus)).reduce((s, l) => s + l.amountCents, 0);
    for (const p of planned) {
      if (p.poId === poId && !p.existing && counted(input.bills.get(p.billId)?.status)) billed += p.amountCents;
    }
    const linkedNow = new Set(planned.filter((p) => p.poId === poId).map((p) => p.billId));
    // Breaker B5-2: what this call takes from a bill's header tie on THIS PO no longer bills it (never close on a rand twice).
    const takenHere = (billId: string) => planned.filter((p) => p.billId === billId && p.takesFromHeader?.poId === poId)
      .reduce((s, p) => s + p.takesFromHeader!.cents, 0);
    for (const h of input.unlinkedBilled?.get(poId) ?? []) if (!linkedNow.has(h.billId)) billed += Math.max(0, h.cents - takenHere(h.billId));
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
