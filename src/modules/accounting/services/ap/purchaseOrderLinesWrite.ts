/**
 * The ONE writer of `po_items` rows from priced lines (cents): the MCP import (`purchaseOrderImport`) and the MCP update
 * (`purchaseOrderUpdate`) both insert through it. The caller has locked / created the parent PO of its own company (po_items
 * has no company_id: tenancy goes through the parent). `itemId` is the catalogue link (migration 1005), null for none.
 */
import { sql } from '@/lib/neon';

export interface PoLineRow {
  description: string;
  quantity: number;
  /** The stored unit price: the line's effective ex-VAT price (net / quantity, 6 decimals). */
  unitPrice: number;
  taxRate: number;
  netCents: number;
  taxCents: number;
  glAccountId: string | null;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  itemId?: string | null;
}

const r2 = (c: number) => c / 100;

export async function insertPoLines(poId: string, l: readonly PoLineRow[]): Promise<void> {
  await sql`
    INSERT INTO po_items (purchase_order_id, product_id, description, quantity, unit_price, tax_rate, line_total, tax_amount,
                          gl_account_id, cc1_id, cc2_id, bu_id, item_id, sort_order)
    SELECT ${poId}::UUID, NULL::UUID, x.description, x.quantity, x.unit_price, x.tax_rate, x.line_total, x.tax_amount,
           x.gl_account_id, x.cc1_id, x.cc2_id, x.bu_id, x.item_id, x.sort_order
      FROM unnest(${l.map((x) => x.description)}::TEXT[], ${l.map((x) => x.quantity)}::NUMERIC[],
                  ${l.map((x) => x.unitPrice)}::NUMERIC[], ${l.map((x) => x.taxRate)}::NUMERIC[], ${l.map((x) => r2(x.netCents))}::NUMERIC[],
                  ${l.map((x) => r2(x.taxCents))}::NUMERIC[], ${l.map((x) => x.glAccountId)}::UUID[], ${l.map((x) => x.cc1Id)}::UUID[],
                  ${l.map((x) => x.cc2Id)}::UUID[], ${l.map((x) => x.buId)}::UUID[], ${l.map((x) => x.itemId ?? null)}::UUID[],
                  ${l.map((_, i) => i)}::INT[])
        AS x(description, quantity, unit_price, tax_rate, line_total, tax_amount, gl_account_id, cc1_id, cc2_id, bu_id, item_id, sort_order)
  `;
}
