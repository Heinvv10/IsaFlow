/**
 * The checks a purchase-order edit runs BEFORE its first write, in order: the supplier is this company's; a linked PO's supplier
 * does not change; the replacement lines' items (migration 1005); the lines' accounts; the lines' CC1 / CC2 / BU. Extracted from
 * the REST PUT (`pages/api/accounting/purchase-orders/[id]`) so the PUT and the MCP `update_purchase_order` run the same code;
 * reads only. The PUT maps each refusal to a 400 and the tool to a tool error.
 *
 * Throws `SupplierNotInCompanyError`, `PurchaseOrderEditRefusal` (a linked PO's supplier), `ItemLineRefusal`,
 * `DocumentLineAccountRefusal`, or a dimension refusal (`isDimensionRefusal`).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { assertSupplierInCompany } from '../core/contactDirectoryService';
import { assertDocumentLineAccounts } from '../gl/documentLineAccountGuard';
import type { DimensionIds } from '../gl/dimensions/dimensionTypes';
import { poSupplierChangeBlocked } from './billPurchaseOrderLinks';
import { noteKeepsPoSupplierRefusal } from './purchaseOrderMaintenanceGuards';
import { readStoredPoLineDimensions, resolvePoLineDimensions, sentFromSnake } from './purchaseOrderLineDimensions';
import { resolveEditedPoLines } from './purchaseOrderItemLines';

/** 400: a PO edit the PO's state does not allow (a supplier change on a PO that has bills linked). */
export class PurchaseOrderEditRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PurchaseOrderEditRefusal';
  }
}

/** A replacement line in the PUT's snake_case body shape. */
export interface PoEditLine {
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate?: number | null;
  gl_account_id?: string | null;
  item_id?: string | null;
  cc1_id?: string | null;
  cc2_id?: string | null;
  bu_id?: string | null;
}

export interface ValidatedPoEdit<T extends PoEditLine> {
  /** The lines with items resolved (account and rate defaults from the item); undefined when none were sent. */
  items: T[] | undefined;
  /** Per line, in order; empty when no lines were sent. */
  dims: DimensionIds[];
}

export async function validatePoEdit<T extends PoEditLine>(
  companyId: string, poId: string, supplierId: string | null | undefined, sentItems: readonly T[] | undefined,
): Promise<ValidatedPoEdit<T>> {
  await assertSupplierInCompany(companyId, supplierId);
  const blocked = supplierId ? await poSupplierChangeBlocked(companyId, poId, supplierId) : null;
  if (blocked) throw new PurchaseOrderEditRefusal(blocked);
  // Any goods received note, cancelled included, keeps the PO's supplier (Codex gate at 42de08b3, 3).
  const noted = await noteKeepsPoSupplierRefusal(companyId, poId, supplierId);
  if (noted) throw new PurchaseOrderEditRefusal(noted);
  // migration 1005: item links (new item checked, default account and rate; none keeps the stored one)
  const items: T[] | undefined = sentItems?.length ? await resolveEditedPoLines(companyId, poId, sentItems) : sentItems ? [...sentItems] : undefined;
  if (!items || items.length === 0) return { items, dims: [] };

  // Before the first write: an inactive or foreign account on a replacement line would otherwise land in po_items with nothing to
  // catch it (gl/documentLineAccountGuard). The edit replaces every line, so an untouched line on a since-deactivated account must
  // not block an unrelated edit: each account is exempt only up to the number of lines the PO already had on it.
  const kept = new Map(((await sql`
    SELECT lower(gl_account_id::TEXT) AS a, COUNT(*)::INT AS n FROM po_items
     WHERE purchase_order_id = ${poId}::UUID AND gl_account_id IS NOT NULL
     GROUP BY 1
  `) as DbRow[]).map((r) => [String(r.a), Number(r.n)] as const));
  const toCheck = items.map((i) => i.gl_account_id).filter((a) => {
    const key = a ? String(a).toLowerCase() : '';
    const left = kept.get(key) ?? 0;
    if (left > 0) { kept.set(key, left - 1); return false; }
    return true;
  });
  await assertDocumentLineAccounts(companyId, toCheck);

  // P5-3: each replacement line's CC1 / CC2 / BU, under the bill lines' rules.
  const dims = await resolvePoLineDimensions(companyId, items.map(sentFromSnake), await readStoredPoLineDimensions(poId));
  return { items, dims };
}
