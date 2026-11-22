/**
 * Purchase order <-> bill links (migration 1006; design docs/design/mcp-po-bill-links.md): the typed refusal and the
 * shapes the planner (`purchaseOrderBillLinkPlan`, pure), the reader under lock (`purchaseOrderBillLinkRead`) and the
 * writers (`purchaseOrderBillLink`, `purchaseOrderBillUnlink`) share. Money is integer cents inside, rand on the wire.
 */
import { BILLED_STATUSES, FULLY_BILLED_TOLERANCE_CENTS, isFullyBilled } from '../budgets/poCommitStatus';

/** PO statuses a bill may be linked to: the committing ones, and closed (a Sage Invoiced PO is imported closed). */
export const LINKABLE_PO_STATUSES = ['approved', 'partially_received', 'received', 'closed'] as const;
/** The statuses a close_when_fully_billed call moves to closed (and an unlink restores). */
export const CLOSABLE_PO_STATUSES = ['approved', 'partially_received', 'received'] as const;
/** The bill statuses MCP links accept, and the ones that count as billed (approved / paid / partially_paid). */
export const LINKABLE_BILL_STATUSES: readonly string[] = BILLED_STATUSES;
/** A PO is fully billed from this many cents short of its subtotal (Hein, 19 Nov): budgets/poCommitStatus. */
export { FULLY_BILLED_TOLERANCE_CENTS, isFullyBilled };
export const MAX_LINKS_PER_CALL = 200;

export interface LinkRowRefusal { index: number; reason: string }

/** The refused rows as a sentence: every row (to 50) with its index. */
export function linkRefusalText(total: number, rows: readonly LinkRowRefusal[]): string {
  const shown = rows.slice(0, 50).map((r) => `links[${r.index}]: ${r.reason}`).join('; ');
  return `${rows.length} of ${total} links cannot be made; nothing was linked. ${shown}${rows.length > 50 ? `; and ${rows.length - 50} more` : ''}`;
}

/** A refusal decided before the first write (the whole call is refused, each bad row listed): nothing was written. */
export class PurchaseOrderBillLinkRefusal extends Error {
  readonly code = 'PURCHASE_ORDER_BILL_LINK_REFUSED';
  constructor(message: string, readonly rows: readonly LinkRowRefusal[] = []) {
    super(message);
    this.name = 'PurchaseOrderBillLinkRefusal';
  }
}

export interface LinkRequest {
  index: number;
  poId: string | null;
  poNumber: string | null;
  billId: string;
  amountCents: number | null;
  lines: { poItemId: string; billLineId: string }[];
  ref: { system: string; ref: string } | null;
}

/** `subtotalCents`: the billing basis, max(header subtotal, lines' total) (review r7 M2); `headerSubtotalCents`: the header's own. */
export interface PoFacts { id: string; poNumber: string; status: string; supplierId: string; subtotalCents: number; headerSubtotalCents: number }

export interface BillLineFacts {
  id: string;
  poItemId: string | null;
  /** The purchase order owning `poItemId` (null: no link, or a line of no PO of this company). */
  poItemPoId: string | null;
  /** What APPROVE posts for the line, ex-VAT, in cents (0 when folded away). */
  postedCents: number;
}

export interface BillFacts {
  id: string;
  invoiceNumber: string;
  status: string;
  supplierId: string;
  subtotalCents: number;
  lines: BillLineFacts[];
  /** The bill's header purchase_order_id (lower case), when set. */
  headerPoId?: string | null;
  /** The goods received note the bill carries (`grn_id`, a note of this company): its number and PO (gate finding 3 on #1697). */
  note?: { grnNumber: string; poId: string; poNumber: string } | null;
}

export interface ExistingLink {
  id: string;
  poId: string;
  billId: string;
  billStatus: string;
  /** What the pair holds by the one attribution (`budgets/billAttribution`): the lines' posted amount when lines name the PO. */
  amountCents: number;
  /** The amount stored on the row, as the link tool wrote it: what an idempotent replay is compared against (review r3 L1). */
  storedAmountCents: number;
  refSystem: string | null;
  refRef: string | null;
}

export interface PlannedLink {
  index: number;
  poId: string;
  poNumber: string;
  billId: string;
  invoiceNumber: string;
  amountCents: number;
  ref: { system: string; ref: string } | null;
  /** Bill lines whose po_item_id must be written (a line already naming the same PO line is not listed). */
  lineWrites: { poItemId: string; billLineId: string }[];
  linesLinked: number;
  /** The PO status this link's call moved the PO from to closed (recorded on the PO: closed_from_status + closed_by_billing). */
  closedFrom: string | null;
  /**
   * The rands this link takes from what the bill's header held on ANOTHER PO (a header tie is a residual, never a hold; PR #1703
   * breaker R4-4): that PO commits them again, and the reply warns, naming it. Signed: below 0 when the row grows the residual
   * (a lines link naming a negative line; breaker r12 F4).
   */
  takesFromHeader: { poId: string; poNumber: string; cents: number } | null;
  /** Set when the pair was already linked: under the same reference nothing is written; with `adopt`, the reference is set. */
  existing: ExistingLink | null;
  /** The pair was linked by a ref-less app / backfill link and this call's external_ref is set on it. */
  adopt: boolean;
}

export interface PoAfter {
  poId: string;
  statusBefore: string;
  statusAfter: string;
  billedCents: number;
  /** The billing basis fully_billed is judged against; `headerSubtotalCents` the header's own subtotal (review r8 L3). */
  subtotalCents: number;
  headerSubtotalCents: number;
  fullyBilled: boolean;
}

export interface LinkPlan {
  planned: PlannedLink[];
  poAfter: Map<string, PoAfter>;
}
