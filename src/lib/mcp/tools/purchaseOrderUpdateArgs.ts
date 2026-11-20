/**
 * update_purchase_order: the arguments, parsed with no I/O (design docs/design/mcp-po-maintenance.md, decision 1). Every refusal
 * names the field (and line). Lines are shaped here and PRICED later (`purchaseOrderUpdatePrepare`): a line that names an item
 * and no tax_rate takes its VAT from the item, which is read first.
 */
import { UUID_RE } from '@/lib/validation';
import type { DimensionRefs } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import type { ExpectedTotals } from '@/modules/accounting/services/ap/purchaseOrderImportAmounts';
import { parseDimensionRefs } from './dimensionArgs';
import { MAX_LINES } from './invoiceCreateArgs';
import { parsePoSelector } from './poBillLinkArgs';
import { PO_TEXT_LIMITS, date, err, isObj, num, text, unknownKey, type Obj } from './purchaseOrderImportArgs';
import { MAX_MONEY, hasWholeCents } from './toolHelpers';

export interface UpdateLine {
  description: string;
  quantity: number;
  unitPrice: number;
  /** Undefined: the item's VAT type, else 15. */
  taxRate: number | undefined;
  lineTotal: number | undefined;
  taxAmount: number | undefined;
  glAccountId: string | null;
  dims: DimensionRefs | undefined;
  itemId: string | null;
  itemCode: string | null;
}

export interface ParsedUpdate {
  poId: string | null;
  poNumber: string | null;
  header: { supplierId?: string; orderDate?: string; deliveryDate?: string | null; reference?: string | null; notes?: string | null };
  /** null: the lines (and totals) stay. */
  lines: UpdateLine[] | null;
  inclusive: boolean;
  expected: ExpectedTotals | undefined;
  dryRun: boolean;
}

const TOP_KEYS = new Set(['po_id', 'po_number', 'supplier_id', 'order_date', 'delivery_date', 'reference', 'notes', 'lines', 'inclusive',
  'expected_totals', 'dry_run', 'idempotency_key']);
const LINE_KEYS = new Set(['description', 'quantity', 'unit_price', 'tax_rate', 'line_total', 'tax_amount', 'gl_account_id', 'cc1', 'cc2', 'bu',
  'item_id', 'item_code']);
const TOTAL_KEYS = new Set(['subtotal', 'tax_amount', 'total']);

function parseLine(o: unknown, label: string): UpdateLine | string {
  if (!isObj(o)) return `${label} must be an object`;
  const extra = unknownKey(o, LINE_KEYS, label);
  if (extra) return extra;
  const description = text(o, 'description', PO_TEXT_LIMITS.description, label, true);
  if (err(description)) return description.error;
  const quantity = num(o, 'quantity', label, { min: 0, max: 1e9, exclusiveMin: true });
  if (err(quantity)) return quantity.error;
  if (quantity === undefined) return `${label}.quantity is required`;
  if (!hasWholeCents(quantity)) return `${label}.quantity has at most two decimals`;
  const unitPrice = num(o, 'unit_price', label, { min: 0, max: MAX_MONEY });
  if (err(unitPrice)) return unitPrice.error;
  if (unitPrice === undefined) return `${label}.unit_price is required (ex-VAT)`;
  const taxRate = num(o, 'tax_rate', label, { min: 0, max: 100 });
  if (err(taxRate)) return taxRate.error;
  const lineTotal = num(o, 'line_total', label, { min: 0, max: MAX_MONEY, cents: true });
  if (err(lineTotal)) return lineTotal.error;
  const taxAmount = num(o, 'tax_amount', label, { min: 0, max: MAX_MONEY, cents: true });
  if (err(taxAmount)) return taxAmount.error;
  let glAccountId: string | null = null;
  const acc = o.gl_account_id;
  if (acc !== undefined && acc !== null && acc !== '') {
    if (typeof acc !== 'string' || !UUID_RE.test(acc)) return `${label}.gl_account_id must be a UUID`;
    glAccountId = acc.toLowerCase();
  }
  const dims = parseDimensionRefs(o, label);
  if (typeof dims === 'string') return dims;
  let itemId: string | null = null;
  if (o.item_id !== undefined && o.item_id !== null && o.item_id !== '') {
    if (typeof o.item_id !== 'string' || !UUID_RE.test(o.item_id)) return `${label}.item_id must be an item UUID`;
    itemId = o.item_id.toLowerCase();
  }
  const itemCode = text(o, 'item_code', 100, label, false);
  if (err(itemCode)) return itemCode.error;
  if (itemId && itemCode) return `${label}: give item_id or item_code, not both`;
  return { description: description as string, quantity, unitPrice, taxRate, lineTotal, taxAmount, glAccountId, dims, itemId, itemCode: itemCode as string | null };
}

function parseExpected(o: Obj): ExpectedTotals | undefined | string {
  const e = o.expected_totals;
  if (e === undefined || e === null) return undefined;
  if (!isObj(e)) return 'expected_totals must be an object';
  const extra = unknownKey(e, TOTAL_KEYS, 'expected_totals');
  if (extra) return extra;
  const out: ExpectedTotals = {};
  for (const [key, field] of [['subtotal', 'subtotal'], ['tax_amount', 'taxAmount'], ['total', 'total']] as const) {
    const v = num(e, key, 'expected_totals', { min: 0, max: MAX_MONEY, cents: true });
    if (err(v)) return v.error;
    if (v !== undefined) out[field] = v;
  }
  return out;
}

export function parseUpdateArgs(args: Obj): ParsedUpdate | string {
  const extra = unknownKey(args, TOP_KEYS, 'arguments');
  if (extra) return extra;
  const po = parsePoSelector(args, 'arguments');
  if (typeof po === 'string') return po;
  const header: ParsedUpdate['header'] = {};
  if (args.supplier_id !== undefined) {
    if (typeof args.supplier_id !== 'string' || !UUID_RE.test(args.supplier_id)) return 'supplier_id must be a supplier UUID';
    header.supplierId = args.supplier_id.toLowerCase();
  }
  if (args.order_date !== undefined) {
    if (args.order_date === null) return 'order_date cannot be cleared';
    const d = date(args, 'order_date', 'arguments', true);
    if (err(d)) return d.error;
    header.orderDate = d as string;
  }
  for (const [key, field, max] of [['reference', 'reference', PO_TEXT_LIMITS.reference], ['notes', 'notes', PO_TEXT_LIMITS.notes]] as const) {
    if (args[key] === undefined) continue;
    const v = text(args, key, max, 'arguments', false);
    if (err(v)) return v.error;
    header[field] = v as string | null;
  }
  if (args.delivery_date !== undefined) {
    const d = date(args, 'delivery_date', 'arguments', false);
    if (err(d)) return d.error;
    header.deliveryDate = d as string | null;
  }
  if (args.inclusive !== undefined && typeof args.inclusive !== 'boolean') return 'inclusive must be true or false';
  if (args.dry_run !== undefined && typeof args.dry_run !== 'boolean') return 'dry_run must be true or false';
  let lines: UpdateLine[] | null = null;
  if (args.lines !== undefined) {
    if (!Array.isArray(args.lines) || args.lines.length === 0) return 'lines must be a non-empty array (it replaces every line); leave it out to keep the lines';
    if (args.lines.length > MAX_LINES) return `lines has ${args.lines.length} lines; the maximum is ${MAX_LINES}`;
    lines = [];
    for (const [i, l] of args.lines.entries()) {
      const line = parseLine(l, `lines[${i}]`);
      if (typeof line === 'string') return line;
      lines.push(line);
    }
  }
  const expected = parseExpected(args);
  if (typeof expected === 'string') return expected;
  if (expected && !lines) return 'expected_totals checks the totals the new lines add up to: send lines with it';
  if (args.inclusive !== undefined && !lines) return 'inclusive only changes how the new lines are priced: send lines with it';
  if (Object.keys(header).length === 0 && !lines) return 'nothing to update: send a header field or lines';
  return { poId: po.poId, poNumber: po.poNumber, header, lines, inclusive: args.inclusive === true, expected, dryRun: args.dry_run === true };
}
