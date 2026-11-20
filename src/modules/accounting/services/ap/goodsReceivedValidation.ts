import type { GRNInput } from './procurementService';

/** What a goods receipt (create or cancel) was refused for. The MCP tools answer with it; the app route with the message. */
export type GoodsReceivedRefusalCode =
  | 'invalid' | 'not_found' | 'po_not_receivable' | 'over_receipt' | 'line_not_on_po' | 'duplicate_line'
  | 'duplicate_external_ref' | 'already_cancelled' | 'grn_on_bill';

/** One refused receipt line: its position in the request, its PO line, and (over_receipt) the quantities. */
export interface GoodsReceivedLineRefusal {
  index: number;
  poItemId: string;
  code: 'over_receipt' | 'line_not_on_po' | 'duplicate_line';
  /** over_receipt: ordered less already received on that PO line. */
  outstanding?: number;
  /** over_receipt: the quantity_received asked for. */
  asked?: number;
}

export interface GoodsReceivedRefusalDetails {
  lines?: GoodsReceivedLineRefusal[];
  /** po_not_receivable: the PO's status. */
  poStatus?: string;
  /** duplicate_external_ref: the note that holds the reference. */
  existing?: { id: string; grnNumber: string };
  /** grn_on_bill: the bills that carry the note (ten at most) and how many there are. */
  bills?: Array<{ id: string; invoiceNumber: string }>;
  billsTotal?: number;
}

/**
 * A refused goods receipt, raised before anything is written. `refusal` is the typed reason; the message is fixed wording that
 * names at most the caller's own documents and quantities. Its code is on the MCP REFUSAL_CODES.
 */
export class GoodsReceivedError extends Error {
  readonly code = 'GOODS_RECEIVED_REFUSED';
  constructor(message: string, readonly refusal: GoodsReceivedRefusalCode = 'invalid', readonly details: GoodsReceivedRefusalDetails = {}) {
    super(message);
    this.name = 'GoodsReceivedError';
  }
  /** The app route answers 404 for this one. */
  get notFound(): boolean { return this.refusal === 'not_found'; }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoodsReceivedError('Invalid receipt');
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new GoodsReceivedError('Valid purchase order and line IDs are required');
  return value.toLowerCase();
}
function quantity(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value !== 'number' && typeof value !== 'string') throw new GoodsReceivedError('Invalid quantity');
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || Math.round(number * 100) / 100 !== number
    || !Number.isSafeInteger(Math.round(number * 100))) throw new GoodsReceivedError('Quantities must be finite, non-negative and have at most two decimal places');
  return number;
}
function text(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new GoodsReceivedError('Receipt text fields must be strings');
  return value.trim() || undefined;
}
export function parseGoodsReceived(input: unknown, userId: string): GRNInput {
  const body = record(input);
  const date = body.receivedDate;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new GoodsReceivedError('A valid receipt date is required');
  }
  if (!Array.isArray(body.items) || body.items.length === 0) throw new GoodsReceivedError('At least one receipt line is required');
  const items = body.items.map(value => {
    const item = record(value);
    const result = { poItemId: id(item.poItemId), quantityReceived: quantity(item.quantityReceived), quantityRejected: quantity(item.quantityRejected), notes: text(item.notes) };
    if (result.quantityReceived === 0 && result.quantityRejected === 0) throw new GoodsReceivedError('Each line must record received or rejected goods');
    return result;
  });
  const seen = new Set<string>();
  const repeats: GoodsReceivedLineRefusal[] = [];
  items.forEach((item, index) => {
    if (seen.has(item.poItemId)) repeats.push({ index, poItemId: item.poItemId, code: 'duplicate_line' });
    seen.add(item.poItemId);
  });
  if (repeats.length > 0) throw new GoodsReceivedError('A purchase order line may appear only once per receipt', 'duplicate_line', { lines: repeats });
  return { purchaseOrderId: id(body.purchaseOrderId), receivedDate: date, receivedBy: text(body.receivedBy) ?? userId, notes: text(body.notes), items };
}
