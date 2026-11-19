/**
 * link_bills_to_purchase_order / unlink_bill_from_purchase_order: the arguments, parsed with no I/O. EVERY bad element is
 * listed (index and reason), not only the first, and the call is refused whole. Ownership and state are decided next,
 * under the locks (`ap/purchaseOrderBillLinkPlan`).
 */
import { UUID_RE } from '@/lib/validation';
import { toCents } from '@/modules/accounting/services/budgets/grid/cents';
import {
  MAX_LINKS_PER_CALL, type LinkRequest, type LinkRowRefusal,
} from '@/modules/accounting/services/ap/purchaseOrderBillLinkTypes';
import { parseCreateRef } from './externalRef';
import { MAX_LINES } from './invoiceCreateArgs';
import { MAX_MONEY, hasWholeCents } from './toolHelpers';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const LINK_KEYS = new Set(['po_id', 'po_number', 'bill_id', 'amount', 'lines', 'external_system', 'external_ref']);
const LINE_KEYS = new Set(['po_item_id', 'bill_line_id']);
const PO_NUMBER_MAX = 50;

function unknownKey(o: Obj, allowed: ReadonlySet<string>, label: string): string | null {
  const extra = Object.keys(o).find((k) => !allowed.has(k));
  return extra === undefined ? null : `${label}.${extra} is not a field of this tool (allowed: ${[...allowed].join(', ')})`;
}

/** po_id or po_number, exactly one. */
export function parsePoSelector(o: Obj, label: string): { poId: string | null; poNumber: string | null } | string {
  const id = o.po_id;
  const number = o.po_number;
  const hasId = id !== undefined && id !== null && id !== '';
  const hasNumber = number !== undefined && number !== null && number !== '';
  if (hasId === hasNumber) return `${label}: give exactly one of po_id and po_number`;
  if (hasId) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return `${label}.po_id must be a purchase order UUID`;
    return { poId: id.toLowerCase(), poNumber: null };
  }
  if (typeof number !== 'string' || number.trim() === '' || number.trim().length > PO_NUMBER_MAX) {
    return `${label}.po_number must be a string of at most ${PO_NUMBER_MAX} characters`;
  }
  return { poId: null, poNumber: number.trim() };
}

function parseLink(o: unknown, index: number): LinkRequest | string {
  const label = `links[${index}]`;
  if (!isObj(o)) return `${label} must be an object`;
  const extra = unknownKey(o, LINK_KEYS, label);
  if (extra) return extra;
  const po = parsePoSelector(o, label);
  if (typeof po === 'string') return po;
  if (typeof o.bill_id !== 'string' || !UUID_RE.test(o.bill_id)) return `${label}.bill_id must be a supplier invoice UUID`;
  let amountCents: number | null = null;
  if (o.amount !== undefined && o.amount !== null) {
    if (typeof o.amount !== 'number' || !Number.isFinite(o.amount) || o.amount <= 0) return `${label}.amount must be a number above zero`;
    if (o.amount > MAX_MONEY || !hasWholeCents(o.amount)) return `${label}.amount must be whole cents (at most two decimals)`;
    amountCents = toCents(o.amount);
  }
  const lines: LinkRequest['lines'] = [];
  if (o.lines !== undefined && o.lines !== null) {
    if (!Array.isArray(o.lines) || o.lines.length === 0) return `${label}.lines must be a non-empty array when given`;
    if (o.lines.length > MAX_LINES) return `${label}.lines has ${o.lines.length} lines; the maximum is ${MAX_LINES}`;
    const seen = new Set<string>();
    for (const [i, l] of o.lines.entries()) {
      const ll = `${label}.lines[${i}]`;
      if (!isObj(l)) return `${ll} must be an object`;
      const bad = unknownKey(l, LINE_KEYS, ll);
      if (bad) return bad;
      if (typeof l.po_item_id !== 'string' || !UUID_RE.test(l.po_item_id)) return `${ll}.po_item_id must be a purchase order line UUID`;
      if (typeof l.bill_line_id !== 'string' || !UUID_RE.test(l.bill_line_id)) return `${ll}.bill_line_id must be a bill line UUID`;
      const billLine = l.bill_line_id.toLowerCase();
      if (seen.has(billLine)) return `${ll}.bill_line_id is named twice in this link`;
      seen.add(billLine);
      lines.push({ poItemId: l.po_item_id.toLowerCase(), billLineId: billLine });
    }
  }
  const rawRef = typeof o.external_ref === 'number' && Number.isSafeInteger(o.external_ref) ? String(o.external_ref) : o.external_ref;
  const ref = parseCreateRef({ external_system: o.external_system, external_ref: rawRef });
  if (typeof ref === 'string') return `${label}: ${ref}`;
  return {
    index, poId: po.poId, poNumber: po.poNumber, billId: o.bill_id.toLowerCase(), amountCents, lines,
    ref: ref ? { system: ref.system, ref: ref.ref } : null,
  };
}

/** Every element parsed, or every refusal. A reference named twice is refused here; a repeated (PO, bill) pair, which may be named by id once and by number again, under lock. */
export function parseLinkBatch(raw: unknown): { links: LinkRequest[] } | { refusals: LinkRowRefusal[] } | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'links must be a non-empty array';
  if (raw.length > MAX_LINKS_PER_CALL) {
    return `links has ${raw.length} elements; the maximum is ${MAX_LINKS_PER_CALL}. Split it across several calls.`;
  }
  const links: LinkRequest[] = [];
  const refusals: LinkRowRefusal[] = [];
  const refs = new Map<string, number>();
  for (const [index, o] of raw.entries()) {
    const l = parseLink(o, index);
    if (typeof l === 'string') { refusals.push({ index, reason: l.replace(`links[${index}]`, '').replace(/^[.:]\s*/, '') }); continue; }
    if (l.ref) {
      const key = `${l.ref.system}\u0000${l.ref.ref}`;
      const seen = refs.get(key);
      if (seen !== undefined) { refusals.push({ index, reason: `external_ref ${l.ref.ref} is also links[${seen}]` }); continue; }
      refs.set(key, index);
    }
    links.push(l);
  }
  return refusals.length > 0 ? { refusals } : { links };
}
