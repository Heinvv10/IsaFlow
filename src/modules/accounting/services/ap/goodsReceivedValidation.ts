import type { GRNInput } from './procurementService';
export class GoodsReceivedError extends Error {
  constructor(message: string, readonly notFound = false) { super(message); }
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
  if (new Set(items.map(item => item.poItemId)).size !== items.length) throw new GoodsReceivedError('A purchase order line may appear only once per receipt');
  return { purchaseOrderId: id(body.purchaseOrderId), receivedDate: date, receivedBy: text(body.receivedBy) ?? userId, notes: text(body.notes), items };
}
