/**
 * What a re-run compares of a PO that is already in the books, beyond what the PO tool compares itself. PURE.
 *
 * The PO tool answers a replay `payload_differs` from the PO number, date, total, status and item links only (that tool is not ours). A PO
 * that Sage has since moved to another supplier, given another delivery date or reference, or whose lines were restructured at the same total
 * would be reported as matching. The runner compares what it reads from the books with what the tool would STORE for the element it sends
 * (the plan keeps the tool's own parse of it: a line's stored unit price is net / quantity to 6 dp, not the Sage price):
 *   supplier, delivery date, reference, the line count, and per line (by position) description, quantity and unit price.
 * Nothing is changed (an existing PO is never updated); the differences go in the report's purchaseOrders list, so they count in the exit
 * code and in the live gate exactly as the tool's own do. The " [item CODE]" suffix of an unlinked line is left out on both sides: whether
 * a line is linked depends on the item's state at the time, which the tool already compares.
 */
import type { MigrationReport } from './sageMigrationTypes';

/** One PO as the books hold it (read by sageSnapshot). */
export interface PoContent {
  supplierId: string;
  deliveryDate: string | null;
  reference: string | null;
  lines: Array<{ description: string; quantity: number; unitPrice: number }>;
}

/** What the PO tool would store for a PO: its own parse of the element the plan sends (so a line's unit price is net / quantity, not the Sage price). */
export interface StoredPo {
  supplierId: string;
  deliveryDate: string | null;
  reference: string | null;
  /** itemCode: the code of the item the line names (linked or not): the only suffix to strip from its description is " [item <code>]". */
  lines: Array<{ description: string; quantity: number; unitPrice: number; itemCode?: string | null }>;
}

type PoDifferences = MigrationReport['differences']['purchaseOrders'];

/** The description without the " [item CODE]" the plan appends to a line it does not link: ONLY that exact suffix, for the line's own item code. */
const bare = (description: string, itemCode: string | null | undefined): string => {
  const suffix = itemCode ? ` [item ${itemCode}]` : null;
  return suffix !== null && description.endsWith(suffix) ? description.slice(0, -suffix.length) : description;
};
/** Prices are stored to 6 decimals. */
const micro = (n: number): number => Math.round(n * 1e6);

export function poContentDifferences(
  plan: { purchaseOrders: ReadonlyArray<{ sageId: string; documentNumber: string; stored: StoredPo }> },
  stored: ReadonlyMap<string, PoContent>,
): PoDifferences {
  const out: PoDifferences = [];
  for (const po of plan.purchaseOrders) {
    const have = stored.get(po.sageId);
    if (!have) continue;
    const sent = po.stored;
    const diffs: PoDifferences[number]['differences'] = [];
    if (sent.supplierId !== have.supplierId) diffs.push({ field: 'supplier', existing: have.supplierId, requested: sent.supplierId });
    if (sent.deliveryDate !== have.deliveryDate) diffs.push({ field: 'delivery_date', existing: have.deliveryDate, requested: sent.deliveryDate });
    if (sent.reference !== have.reference) diffs.push({ field: 'reference', existing: have.reference, requested: sent.reference });
    if (sent.lines.length !== have.lines.length) diffs.push({ field: 'lines', existing: have.lines.length, requested: sent.lines.length });
    else {
      sent.lines.forEach((l, n) => {
        const h = have.lines[n]!;
        const code = l.itemCode; // the stored line has no code of its own: it is read against the same item the plan names for it
        if (bare(l.description, code) !== bare(h.description, code)) diffs.push({ field: `line ${n + 1} description`, existing: bare(h.description, code), requested: bare(l.description, code) });
        if (l.quantity !== h.quantity) diffs.push({ field: `line ${n + 1} quantity`, existing: h.quantity, requested: l.quantity });
        if (micro(l.unitPrice) !== micro(h.unitPrice)) diffs.push({ field: `line ${n + 1} unit_price`, existing: h.unitPrice, requested: l.unitPrice });
      });
    }
    if (diffs.length > 0) out.push({ poNumber: po.documentNumber, differences: diffs });
  }
  return out;
}

/** The tool's differences plus ours, one entry per PO (the tool's fields first). */
export function withContentDifferences(d: MigrationReport['differences'], extra: PoDifferences): MigrationReport['differences'] {
  if (extra.length === 0) return d;
  const byNumber = new Map(d.purchaseOrders.map((p) => [p.poNumber, { ...p, differences: [...p.differences] }]));
  for (const e of extra) {
    const have = byNumber.get(e.poNumber);
    if (have) have.differences.push(...e.differences);
    else byNumber.set(e.poNumber, { poNumber: e.poNumber, differences: [...e.differences] });
  }
  return { ...d, purchaseOrders: [...byNumber.values()] };
}
