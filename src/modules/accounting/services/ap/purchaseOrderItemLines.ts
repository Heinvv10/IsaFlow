/**
 * The item links of a purchase order's lines (migration 1005), for both PO routes.
 *
 *  - POST: a line naming an item takes the item's purchases account and, with no `taxRate`, the rate its VAT type gives.
 *  - PUT (which REPLACES every line): a line naming a NEW item is checked and defaulted the same way; a line sent without
 *    one keeps an identical stored line's item (items/itemEditLines); `item_id: null` clears it.
 * A PO line has no account of its own to be checked on POST, so a DEFAULTED account is held to the bill-line rules here (not
 * AP / AR control, VAT, bank, a header or an inactive account): the budget check reads it, and the bill raised from the PO
 * would be refused on it. Every refusal is an `ItemLineRefusal` (400 with its code) raised before the first write.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { ItemLineRefusal, applyItemLineDefaults } from '../items/itemLineDefaults';
import { resolveEditLineItemsSnake } from '../items/itemEditLines';
import { billLineAccountRefusalsById } from './billLineAccountGuard';

async function holdDefaultedAccounts(companyId: string, defaulted: Array<{ index: number; account: string }>): Promise<void> {
  // ONE query over the distinct accounts, FOR SHARE in id order (a per-account loop would lock in line order and could
  // deadlock a concurrent account merge, which locks in id order).
  const refusals = await billLineAccountRefusalsById(companyId, defaulted.map((d) => d.account));
  for (const { index, account } of defaulted) {
    const refusal = refusals.get(account.toLowerCase());
    if (refusal) throw new ItemLineRefusal(`items[${index}].item_id: the item's purchases account is not acceptable on a purchase order line. ${refusal}`);
  }
}

/** POST: the lines' item, account and rate. Returns per line the item id, the account and the rate to store. */
export async function defaultNewPoLines(
  companyId: string, items: ReadonlyArray<{ itemId?: string | null; taxRate?: number | null }>,
): Promise<Array<{ itemId?: string | null; glAccountId?: string | null; taxRate?: number | null }>> {
  const out = await applyItemLineDefaults(companyId, items.map((i) => ({ itemId: i.itemId, taxRate: i.taxRate, glAccountId: undefined as string | undefined })), 'purchase', (n) => `items[${n}]`, { deriveTax: true });
  await holdDefaultedAccounts(companyId, out.flatMap((l, index) => (l.glAccountId ? [{ index, account: l.glAccountId }] : [])));
  return out;
}

/** PUT: the replacement lines with their items resolved against the PO's stored lines. */
export async function resolveEditedPoLines<T extends {
  description: string; quantity: number; unit_price: number; item_id?: string | null; gl_account_id?: string | null; tax_rate?: number | null;
}>(companyId: string, poId: string, items: readonly T[]): Promise<T[]> {
  const stored = (await sql`
    SELECT pi.item_id, pi.description, pi.quantity, pi.unit_price FROM po_items pi
    JOIN purchase_orders po ON po.id = pi.purchase_order_id
    WHERE pi.purchase_order_id = ${poId}::UUID AND po.company_id = ${companyId}::UUID
  `) as DbRow[];
  const out = await resolveEditLineItemsSnake(companyId, 'purchase', items, stored.map((r) => ({
    itemId: r.item_id == null ? null : String(r.item_id), description: String(r.description), quantity: Number(r.quantity), unitPrice: Number(r.unit_price),
  })), (n) => `items[${n}]`, { deriveTax: true });
  await holdDefaultedAccounts(companyId, out.flatMap((l, index) => (l.gl_account_id && l.gl_account_id !== items[index]!.gl_account_id
    ? [{ index, account: l.gl_account_id }] : [])));
  return out;
}
