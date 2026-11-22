/**
 * What a re-run compares of a PO that is already in the books, beyond what the PO tool compares itself. PURE.
 *
 * The PO tool answers a replay `payload_differs` from the PO number, date, total, status and item links only (that tool is not ours). A PO
 * that Sage has since moved to another supplier, given another delivery date or reference, or whose lines were restructured at the same total
 * would be reported as matching. The runner compares what it reads from the books with what it would send:
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

type PoDifferences = MigrationReport['differences']['purchaseOrders'];
interface SentLine { description?: unknown; quantity?: unknown; unit_price?: unknown }

const SUFFIX = / \[item [^\]]*\]$/;
const bare = (description: unknown): string => String(description ?? '').replace(SUFFIX, '');
/** Prices are stored to 6 decimals. */
const micro = (n: unknown): number => Math.round(Number(n) * 1e6);

export function poContentDifferences(
  plan: { purchaseOrders: ReadonlyArray<{ sageId: string; documentNumber: string; element: Record<string, unknown> }> },
  stored: ReadonlyMap<string, PoContent>,
): PoDifferences {
  const out: PoDifferences = [];
  for (const po of plan.purchaseOrders) {
    const have = stored.get(po.sageId);
    if (!have) continue;
    const sent = po.element;
    const diffs: PoDifferences[number]['differences'] = [];
    const sentOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    if (sent.supplier_id !== have.supplierId) diffs.push({ field: 'supplier', existing: have.supplierId, requested: sent.supplier_id });
    if (sentOrNull(sent.delivery_date) !== have.deliveryDate) diffs.push({ field: 'delivery_date', existing: have.deliveryDate, requested: sentOrNull(sent.delivery_date) });
    if (sentOrNull(sent.reference) !== have.reference) diffs.push({ field: 'reference', existing: have.reference, requested: sentOrNull(sent.reference) });
    const lines = (sent.lines ?? []) as SentLine[];
    if (lines.length !== have.lines.length) diffs.push({ field: 'lines', existing: have.lines.length, requested: lines.length });
    else {
      lines.forEach((l, n) => {
        const h = have.lines[n]!;
        if (bare(l.description) !== bare(h.description)) diffs.push({ field: `line ${n + 1} description`, existing: bare(h.description), requested: bare(l.description) });
        if (Number(l.quantity) !== h.quantity) diffs.push({ field: `line ${n + 1} quantity`, existing: h.quantity, requested: Number(l.quantity) });
        if (micro(l.unit_price) !== micro(h.unitPrice)) diffs.push({ field: `line ${n + 1} unit_price`, existing: h.unitPrice, requested: Number(l.unit_price) });
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
