/**
 * bulk_create_purchase_orders: the arguments, parsed and priced with no I/O. Every refusal names the element (and
 * line) and is returned before anything is read or written. Ownership of the ids is checked next
 * (`purchaseOrderImportPrepare`), the writes last (`ap/purchaseOrderImport`).
 */
import { DATE_RE, UUID_RE, isRealCalendarDate } from '@/lib/validation';
import type { DimensionRefs } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import {
  cents, expectedTotalsRefusal, lineCents, poCents, storedUnitPrice, type ExpectedTotals, type LineCents, type PoCents,
} from '@/modules/accounting/services/ap/purchaseOrderImportAmounts';
import type { ImportPoStatus } from '@/modules/accounting/services/ap/purchaseOrderImport';
import { parseCreateRef, type ParsedCreateRef } from './externalRef';
import { parseDimensionRefs } from './dimensionArgs';
import { MAX_LINES } from './invoiceCreateArgs';
import { MAX_MONEY, hasWholeCents } from './toolHelpers';

export const MAX_PURCHASE_ORDERS = 100;
const MAX_CENTS = cents(MAX_MONEY);
export const PO_TEXT_LIMITS = { po_number: 50, reference: 255, notes: 2000, description: 500 } as const;

/** Accepted status words: the PO statuses an import may set, and the names a migration brief uses for them. */
export const IMPORT_STATUS_ALIASES: Record<string, ImportPoStatus> = {
  draft: 'draft',
  open: 'approved',
  approved: 'approved',
  closed: 'closed',
  billed: 'closed',
  cancelled: 'cancelled',
};

export interface ParsedPoLine {
  description: string;
  quantity: number;
  /** The unit price stored: the line's effective ex-VAT price (net / quantity, 6 decimals). */
  unitPrice: number;
  taxRate: number;
  glAccountId: string | null;
  dims: DimensionRefs | undefined;
  cents: LineCents;
}

export interface ParsedPo {
  index: number;
  poNumber: string;
  supplierId: string;
  orderDate: string;
  deliveryDate: string | null;
  reference: string | null;
  notes: string | null;
  status: ImportPoStatus;
  ref: ParsedCreateRef | null;
  totals: PoCents;
  lines: ParsedPoLine[];
}

type Obj = Record<string, unknown>;

/** The keys each object may carry: anything else (a misspelt line_total, an item_id) is refused, never ignored. */
const PO_KEYS = new Set(['po_number', 'supplier_id', 'order_date', 'delivery_date', 'reference', 'notes', 'status', 'inclusive',
  'external_ref', 'external_system', 'external_document_number', 'expected_totals', 'lines']);
const TOTAL_KEYS = new Set(['subtotal', 'tax_amount', 'total']);
const LINE_KEYS = new Set(['description', 'quantity', 'unit_price', 'tax_rate', 'line_total', 'tax_amount', 'gl_account_id', 'cc1', 'cc2', 'bu']);

function unknownKey(o: Obj, allowed: ReadonlySet<string>, label: string): string | null {
  const extra = Object.keys(o).find((k) => !allowed.has(k));
  return extra === undefined ? null : `${label}.${extra} is not a field of this tool (allowed: ${[...allowed].join(', ')})`;
}
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function text(o: Obj, key: string, max: number, label: string, required: boolean): string | null | { error: string } {
  const v = o[key];
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    return required ? { error: `${label}.${key} is required` } : null;
  }
  if (typeof v !== 'string') return { error: `${label}.${key} must be a string` };
  if (v.trim().length > max) return { error: `${label}.${key} is longer than ${max} characters` };
  return v.trim();
}

function date(o: Obj, key: string, label: string, required: boolean): string | null | { error: string } {
  const v = o[key];
  if (v === undefined || v === null || v === '') return required ? { error: `${label}.${key} is required (YYYY-MM-DD)` } : null;
  if (typeof v !== 'string' || !DATE_RE.test(v) || !isRealCalendarDate(v)) return { error: `${label}.${key} must be a real date, YYYY-MM-DD` };
  return v;
}

function num(o: Obj, key: string, label: string, opts: { min: number; max: number; exclusiveMin?: boolean; cents?: boolean }): number | undefined | { error: string } {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${label}.${key} must be a number` };
  if (opts.exclusiveMin ? v <= opts.min : v < opts.min) return { error: `${label}.${key} must be ${opts.exclusiveMin ? 'more than' : 'at least'} ${opts.min}` };
  if (v > opts.max) return { error: `${label}.${key} must be at most ${opts.max}` };
  if (opts.cents && !hasWholeCents(v)) return { error: `${label}.${key} must be whole cents (at most two decimals)` };
  return v;
}

const err = (v: unknown): v is { error: string } => isObj(v) && typeof v.error === 'string';

/** external_ref as the flat trio, or as {system, id, document_number}; a numeric Sage id is accepted. */
function refOf(o: Obj): ParsedCreateRef | null | string {
  const raw = o.external_ref;
  const flat: Obj = isObj(raw)
    ? { external_system: raw.system, external_ref: raw.id, external_document_number: raw.document_number }
    : { external_system: o.external_system, external_ref: raw, external_document_number: o.external_document_number };
  if (typeof flat.external_ref === 'number' && Number.isSafeInteger(flat.external_ref)) flat.external_ref = String(flat.external_ref);
  return parseCreateRef(flat);
}

function parseLine(o: unknown, label: string, inclusive: boolean): ParsedPoLine | string {
  if (!isObj(o)) return `${label} must be an object`;
  const extra = unknownKey(o, LINE_KEYS, label);
  if (extra) return extra;
  const description = text(o, 'description', PO_TEXT_LIMITS.description, label, true);
  if (err(description)) return description.error;
  const quantity = num(o, 'quantity', label, { min: 0, max: 1e9, exclusiveMin: true });
  if (err(quantity)) return quantity.error;
  if (quantity === undefined) return `${label}.quantity is required`;
  // po_items.quantity is NUMERIC(15,2): a third decimal would be rounded (0.004 to 0.00, refused by its CHECK).
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
  const rate = taxRate ?? 15;
  const money = lineCents({ quantity, unitPrice, taxRate: rate, lineTotal, taxAmount }, inclusive);
  if (typeof money === 'string') return `${label}: ${money}`;
  if (money.net + money.tax > MAX_CENTS) return `${label}: the line amount is more than the largest amount a document holds`;
  const stored = storedUnitPrice(quantity, money.net);
  if (stored === null) return `${label}: no unit price of 6 decimals gives line_total at this quantity; split the line`;
  return { description: description as string, quantity, unitPrice: stored, taxRate: rate, glAccountId, dims, cents: money };
}

function parseExpected(o: Obj, label: string): ExpectedTotals | undefined | string {
  const e = o.expected_totals;
  if (e === undefined || e === null) return undefined;
  if (!isObj(e)) return `${label}.expected_totals must be an object`;
  const extra = unknownKey(e, TOTAL_KEYS, `${label}.expected_totals`);
  if (extra) return extra;
  const out: ExpectedTotals = {};
  for (const [key, field] of [['subtotal', 'subtotal'], ['tax_amount', 'taxAmount'], ['total', 'total']] as const) {
    const v = num(e, key, `${label}.expected_totals`, { min: 0, max: MAX_MONEY, cents: true });
    if (err(v)) return v.error;
    if (v !== undefined) out[field] = v;
  }
  return out;
}

export function parsePurchaseOrder(o: unknown, index: number): ParsedPo | string {
  const label = `purchase_orders[${index}]`;
  if (!isObj(o)) return `${label} must be an object`;
  const extra = unknownKey(o, PO_KEYS, label);
  if (extra) return extra;
  const poNumber = text(o, 'po_number', PO_TEXT_LIMITS.po_number, label, true);
  if (err(poNumber)) return poNumber.error;
  const supplierId = o.supplier_id;
  if (typeof supplierId !== 'string' || !UUID_RE.test(supplierId)) return `${label}.supplier_id must be a supplier UUID`;
  const orderDate = date(o, 'order_date', label, true);
  if (err(orderDate)) return orderDate.error;
  const deliveryDate = date(o, 'delivery_date', label, false);
  if (err(deliveryDate)) return deliveryDate.error;
  const reference = text(o, 'reference', PO_TEXT_LIMITS.reference, label, false);
  if (err(reference)) return reference.error;
  const notes = text(o, 'notes', PO_TEXT_LIMITS.notes, label, false);
  if (err(notes)) return notes.error;
  const rawStatus = o.status ?? 'draft';
  const status = typeof rawStatus === 'string' ? IMPORT_STATUS_ALIASES[rawStatus.trim().toLowerCase()] : undefined;
  if (!status) {
    return `${label}.status must be one of ${Object.keys(IMPORT_STATUS_ALIASES).join(', ')} (partially_received / received come only from goods receipts)`;
  }
  if (o.inclusive !== undefined && typeof o.inclusive !== 'boolean') return `${label}.inclusive must be true or false`;
  const ref = refOf(o);
  if (typeof ref === 'string') return `${label}: ${ref}`;
  if (!Array.isArray(o.lines) || o.lines.length === 0) return `${label}.lines must be a non-empty array`;
  if (o.lines.length > MAX_LINES) return `${label}.lines has ${o.lines.length} lines; the maximum is ${MAX_LINES}`;
  const lines: ParsedPoLine[] = [];
  for (const [i, l] of o.lines.entries()) {
    const line = parseLine(l, `${label}.lines[${i}]`, o.inclusive === true);
    if (typeof line === 'string') return line;
    lines.push(line);
  }
  const totals = poCents(lines.map((l) => l.cents));
  if (totals.total > MAX_CENTS) return `${label}: the PO total is more than the largest amount a document holds`;
  const expected = parseExpected(o, label);
  if (typeof expected === 'string') return expected;
  const mismatch = expectedTotalsRefusal(totals, expected);
  if (mismatch) return `${label} (${poNumber as string}): ${mismatch}`;
  return {
    index, poNumber: poNumber as string, supplierId: supplierId.toLowerCase(), orderDate: orderDate as string,
    deliveryDate: deliveryDate as string | null, reference: reference as string | null, notes: notes as string | null,
    status, ref, totals, lines,
  };
}

/** The whole batch, or the first refusal. A number or reference named twice is refused: one PO, one element. */
export function parsePurchaseOrderBatch(raw: unknown): ParsedPo[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'purchase_orders must be a non-empty array';
  if (raw.length > MAX_PURCHASE_ORDERS) {
    return `purchase_orders has ${raw.length} elements; the maximum is ${MAX_PURCHASE_ORDERS}. Split it across several calls.`;
  }
  const out: ParsedPo[] = [];
  const numbers = new Map<string, number>();
  const refs = new Map<string, number>();
  for (const [index, o] of raw.entries()) {
    const po = parsePurchaseOrder(o, index);
    if (typeof po === 'string') return po;
    const seen = numbers.get(po.poNumber);
    if (seen !== undefined) return `purchase_orders[${index}]: po_number ${po.poNumber} is also purchase_orders[${seen}]; each PO may appear once`;
    numbers.set(po.poNumber, index);
    if (po.ref) {
      const key = `${po.ref.system}\u0000${po.ref.ref}`;
      const again = refs.get(key);
      if (again !== undefined) return `purchase_orders[${index}]: external_ref ${po.ref.ref} is also purchase_orders[${again}]; each PO may appear once`;
      refs.set(key, index);
    }
    out.push(po);
  }
  return out;
}
