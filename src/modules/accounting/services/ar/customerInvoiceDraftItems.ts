/**
 * The stored lines of a customer-invoice draft edit, and the item links of its replacement lines (migration 1005): a line
 * naming a NEW item is checked (this company's, active) and, with no account of its own, defaults to the item's sales
 * account; a line sent without an item keeps an identical stored line's; null clears it. See items/itemEditLines. Reads only,
 * before any write. An invoice has ONE rate on its header, so no line rate is derived from the item here.
 */
import { ItemLineRefusal } from '../items/itemLineDefaults';
import { resolveEditLineItems } from '../items/itemEditLines';
import type { InvoiceLineCoding } from './invoiceLineCoding';

type Row = Record<string, unknown>;
interface Tx { (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown> }

const idOrNull = (v: unknown): string | null => (v == null ? null : String(v));

export async function resolveDraftEditItems<T extends { description: string; quantity: number; unitPrice: number; itemId?: string | null; glAccountId?: string | null }>(
  tx: Tx, companyId: string, invoiceId: string, items: readonly T[],
): Promise<{ items: T[]; stored: InvoiceLineCoding[] } | { message: string }> {
  // The invoice row is locked (FOR UPDATE) by the caller, so its lines are this company's.
  const rows = (await tx`
    SELECT gl_account_id, project_id, item_id, description, quantity, unit_price FROM customer_invoice_items WHERE invoice_id = ${invoiceId}::UUID
  `) as Row[];
  const stored = rows.map((r) => ({ glAccountId: idOrNull(r.gl_account_id), projectId: idOrNull(r.project_id) }));
  try {
    const resolved = await resolveEditLineItems(companyId, 'sales', items, rows.map((r) => ({
      itemId: idOrNull(r.item_id), description: String(r.description), quantity: Number(r.quantity), unitPrice: Number(r.unit_price),
    })), (i) => `items[${i}]`);
    return { items: resolved, stored };
  } catch (err) {
    if (err instanceof ItemLineRefusal) return { message: err.message };
    throw err;
  }
}
