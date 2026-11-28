/**
 * What a re-run compares of a PO that is already in the books, beyond what the PO tool compares itself. PURE.
 *
 * The PO tool answers a replay `payload_differs` from the PO number, date, total, status and item links only (that tool is not ours). A PO
 * that Sage has since changed anywhere else would be reported as matching. So the plan keeps, for every PO it sends, the COMPLETE row set
 * the tool would write (`StoredPo`: its own parse of the element, so a line's unit price is net / quantity, not the Sage price), and the
 * runner compares it, column by column, with the same columns read from the books (`PoContent`, sageSnapshot reads whole rows).
 *
 * THE COLUMN LISTS BELOW ARE THE CONTRACT. Every column of `purchase_orders` and `po_items` is in exactly one list: COMPARED, or EXCLUDED
 * with the reason. tests/integration/sage-migration-po-columns.int.test.ts reads the columns from information_schema and fails when a
 * table has one that is in neither list, or a listed one it no longer has: a new column cannot be skipped by accident.
 *
 * Nothing is changed (an existing PO is never updated); the differences go in the report's purchaseOrders list, so they count in the exit
 * code and in the live gate exactly as the tool's own do. The " [item CODE]" suffix of an unlinked line is left out on both sides, ONLY that
 * exact suffix for the line's own item code.
 */
import type { MigrationReport } from './sageMigrationTypes';

export type Scalar = string | number | boolean | null;

/** `purchase_orders` columns the PO tool writes from Sage data: compared. */
export const PO_HEADER_COMPARED = [
  'po_number', 'supplier_id', 'order_date', 'expected_delivery_date', 'status', 'subtotal', 'tax_amount', 'total', 'reference',
  'external_system', 'external_ref', 'external_document_number',
] as const;
/** `purchase_orders` columns NOT compared, and why. */
export const PO_HEADER_EXCLUDED: Readonly<Record<string, string>> = {
  id: 'surrogate key',
  company_id: 'the company scope: every read and write is already company-scoped',
  notes: 'free text people edit in IsaFlow, and the import writes the Sage status text into it ("Sage status: Pending"), which the status column already covers (named limit: a change of the Sage Comments is not detected)',
  created_by: 'the user who ran the import, not Sage data',
  updated_by: 'the user who ran the import or last edited, not Sage data',
  approved_by: 'the user who ran the import (an open PO is imported approved), not Sage data',
  approved_at: 'the clock at import time',
  created_at: 'a timestamp',
  updated_at: 'a timestamp',
  closed_from_status: 'set by IsaFlow when a bill closes the PO; the import never writes it',
  closed_by_billing: 'set by IsaFlow when a bill closes the PO; the import never writes it',
};

/** `po_items` columns the PO tool writes from Sage data: compared (by position, ordered by sort_order). */
export const PO_LINE_COMPARED = [
  'description', 'quantity', 'unit_price', 'tax_rate', 'line_total', 'tax_amount', 'item_id', 'sort_order',
] as const;
const CODING = 'IsaFlow-owned coding: Sage has no such field, a person codes the line in IsaFlow after the import (the import sets gl_account_id only on create, from --po-gl-account), so a coded line must not block a re-run';
/** `po_items` columns NOT compared, and why. */
export const PO_LINE_EXCLUDED: Readonly<Record<string, string>> = {
  id: 'surrogate key',
  purchase_order_id: 'the parent PO: lines are read through it',
  product_id: 'legacy: the import always writes NULL',
  gl_account_id: CODING,
  cc1_id: CODING,
  cc2_id: CODING,
  bu_id: CODING,
  quantity_received: 'goods received in IsaFlow after the import: IsaFlow workflow, never Sage data',
  quantity_invoiced: 'bills linked in IsaFlow after the import: IsaFlow workflow, never Sage data',
  created_at: 'a timestamp',
};

export type HeaderColumn = (typeof PO_HEADER_COMPARED)[number];
export type LineColumn = (typeof PO_LINE_COMPARED)[number];

/** What the PO tool would store for a PO: the compared columns of its header and of each line, from its own parse of the element sent. */
export interface StoredPo {
  header: Record<HeaderColumn, Scalar>;
  /** `itemCode`: the code of the item the line names (linked or not), the only suffix to strip from its description is " [item <code>]". */
  lines: Array<{ itemCode: string | null; columns: Record<LineColumn, Scalar> }>;
}

/** One PO as the books hold it: whole rows as read (to_jsonb), plus what the plan needs to word a supplier problem. */
export interface PoContent {
  header: Record<string, unknown>;
  lines: Array<Record<string, unknown>>;
  /** The booked supplier's name (null when the row is gone). */
  supplierName?: string | null;
  /** The booked supplier is deleted in IsaFlow: the PO tool answers Not found for the whole batch of a PO naming it, replay included. */
  supplierDeleted?: boolean;
}

type PoDifferences = MigrationReport['differences']['purchaseOrders'];

/** The same value written two ways compares equal: '' and absent are null, numbers to 6 decimals (prices are stored to 6), ids and the system in lower case. */
function norm(column: string, v: unknown): Scalar {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  if (typeof v === 'string') return column === 'external_system' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : v;
  return typeof v === 'boolean' ? v : String(v);
}

/** The description without the " [item CODE]" the plan appends to a line it does not link: ONLY that exact suffix, for the line's own item code. */
const bare = (description: Scalar, itemCode: string | null): Scalar => {
  if (typeof description !== 'string' || itemCode === null) return description;
  const suffix = ` [item ${itemCode}]`;
  return description.endsWith(suffix) ? description.slice(0, -suffix.length) : description;
};

export function poContentDifferences(
  plan: { purchaseOrders: ReadonlyArray<{ sageId: string; documentNumber: string; stored: StoredPo; supplierProblem?: string }> },
  books: ReadonlyMap<string, PoContent>,
): PoDifferences {
  const out: PoDifferences = [];
  for (const po of plan.purchaseOrders) {
    const have = books.get(po.sageId);
    if (!have) continue;
    const diffs: PoDifferences[number]['differences'] = [];
    for (const column of PO_HEADER_COMPARED) {
      const sent = norm(column, po.stored.header[column]);
      const held = norm(column, have.header[column]);
      if (column === 'supplier_id' && po.supplierProblem) diffs.push({ field: column, existing: held, requested: po.supplierProblem });
      else if (sent !== held) diffs.push({ field: column, existing: held, requested: sent });
    }
    const lines = po.stored.lines;
    if (lines.length !== have.lines.length) diffs.push({ field: 'lines', existing: have.lines.length, requested: lines.length });
    else {
      lines.forEach((l, n) => {
        for (const column of PO_LINE_COMPARED) {
          let sent = norm(column, l.columns[column]);
          let held = norm(column, have.lines[n]![column]);
          if (column === 'description') { sent = bare(sent, l.itemCode); held = bare(held, l.itemCode); }
          if (sent !== held) diffs.push({ field: `line ${n + 1} ${column}`, existing: held, requested: sent });
        }
      });
    }
    // Keyed by the number the books hold (as the tool keys its own entry), so a renumbered PO is one entry, not two.
    if (diffs.length > 0) out.push({ poNumber: String(have.header.po_number), differences: diffs });
  }
  return out;
}

/**
 * The tool's differences plus ours, one entry per PO (the tool's fields first). A fact the tool already reported (same field, or its
 * `lines[i].item_id` for our `line i+1 item_id`) is not listed twice.
 */
export function withContentDifferences(d: MigrationReport['differences'], extra: PoDifferences): MigrationReport['differences'] {
  if (extra.length === 0) return d;
  const byNumber = new Map(d.purchaseOrders.map((p) => [p.poNumber, { ...p, differences: [...p.differences] }]));
  for (const e of extra) {
    const have = byNumber.get(e.poNumber);
    const reported = new Set((have?.differences ?? []).map((x) => x.field.replace(/^lines\[(\d+)\]\.item_id$/, (_, i: string) => `line ${Number(i) + 1} item_id`)));
    const fresh = e.differences.filter((x) => !reported.has(x.field));
    if (have) have.differences.push(...fresh);
    else byNumber.set(e.poNumber, { poNumber: e.poNumber, differences: fresh });
  }
  return { ...d, purchaseOrders: [...byNumber.values()].filter((p) => p.differences.length > 0) };
}

/** The structure of a ParsedPo (the tool's own parse) this module reads. */
export interface ParsedPoLike {
  poNumber: string; supplierId: string; orderDate: string; deliveryDate: string | null; status: string; reference: string | null;
  ref: { system: string; ref: string; documentNumber: string | null } | null;
  totals: { subtotal: number; tax: number; total: number };
  lines: Array<{
    description: string; quantity: number; unitPrice: number; taxRate: number; cents: { net: number; tax: number };
  }>;
}

/**
 * The row set the tool writes for `parsed`. `itemOf(n)` is what the plan decided for line n: the id of the item it links to (an id, or
 * "item:CODE" when the item is not in the books yet), null when unlinked, plus the code of the item the line names (for the suffix).
 */
export function storedPoFrom(parsed: ParsedPoLike, itemOf: (n: number) => { itemId: string | null; itemCode: string | null }): StoredPo {
  const money = (cents: number): number => cents / 100;
  return {
    header: {
      po_number: parsed.poNumber, supplier_id: parsed.supplierId, order_date: parsed.orderDate, expected_delivery_date: parsed.deliveryDate, status: parsed.status,
      subtotal: money(parsed.totals.subtotal), tax_amount: money(parsed.totals.tax), total: money(parsed.totals.total), reference: parsed.reference,
      external_system: parsed.ref?.system ?? null, external_ref: parsed.ref?.ref ?? null, external_document_number: parsed.ref?.documentNumber ?? null,
    },
    lines: parsed.lines.map((l, n) => ({
      itemCode: itemOf(n).itemCode,
      columns: {
        description: l.description, quantity: l.quantity, unit_price: l.unitPrice, tax_rate: l.taxRate, line_total: money(l.cents.net), tax_amount: money(l.cents.tax),
        item_id: itemOf(n).itemId, sort_order: n,
      },
    })),
  };
}
