/**
 * The three-way match as the bill page shows it (`ThreeWayMatchPanel`): each line against its PO line and GRN.
 *
 * `readMatchInputs` is what `performThreeWayMatch` and the panel both judge from. `po_items` and `grn_items` have no
 * company_id, so their tenancy goes through the purchase order and the goods received note.
 */
import { sql, type DbRow } from '@/lib/neon';
import { validateThreeWayMatch } from '../../utils/threeWayMatch';
import type { InvoiceMatchStatus } from '../../types/ap.types';

const DEFAULT_TOLERANCE_PERCENT = 2;

export interface MatchInputs {
  qtyTolerance: number;
  priceTolerance: number;
  poItems: DbRow[];
  grnItems: DbRow[];
}

export async function readMatchInputs(
  companyId: string, invoice: { supplierId: string; purchaseOrderId: string; grnId?: string | null },
): Promise<MatchInputs> {
  // Tolerance from supplier_coding_rules; 2% without one.
  const rules = (await sql`
    SELECT qty_tolerance_pct, price_tolerance_pct
    FROM supplier_coding_rules
    WHERE company_id = ${companyId}::UUID AND supplier_id = ${invoice.supplierId}::UUID
    LIMIT 1
  `) as DbRow[];
  const poItems = (await sql`
    SELECT pi.* FROM po_items pi
    JOIN purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${companyId}::UUID
    WHERE pi.purchase_order_id = ${invoice.purchaseOrderId}::UUID
  `) as DbRow[];
  const grnItems = invoice.grnId
    ? ((await sql`
        SELECT gi.* FROM grn_items gi
        JOIN goods_received_notes g ON g.id = gi.grn_id AND g.company_id = ${companyId}::UUID
        WHERE gi.grn_id = ${invoice.grnId}::UUID
      `) as DbRow[])
    : [];
  return {
    qtyTolerance: rules[0]?.qty_tolerance_pct != null ? Number(rules[0].qty_tolerance_pct) : DEFAULT_TOLERANCE_PERCENT,
    priceTolerance: rules[0]?.price_tolerance_pct != null ? Number(rules[0].price_tolerance_pct) : DEFAULT_TOLERANCE_PERCENT,
    poItems,
    grnItems,
  };
}

/** The bill's status from its lines' (no lines: unmatched). */
export function overallMatchStatus(lines: ReadonlyArray<{ lineMatchStatus: InvoiceMatchStatus }>): InvoiceMatchStatus {
  if (lines.length === 0) return 'unmatched';
  if (lines.every((l) => l.lineMatchStatus === 'fully_matched')) return 'fully_matched';
  if (lines.some((l) => l.lineMatchStatus === 'po_matched')) return 'po_matched';
  if (lines.some((l) => l.lineMatchStatus === 'grn_matched')) return 'grn_matched';
  return 'unmatched';
}

export interface MatchLine {
  invoiceItemId: string;
  description: string;
  poQuantity: number;
  invoiceQuantity: number;
  grnQuantityReceived: number;
  poUnitPrice: number;
  invoiceUnitPrice: number;
  qtyVariancePct: number;
  priceVariancePct: number;
  lineMatchStatus: InvoiceMatchStatus;
  mismatches: string[];
}

export interface ThreeWayMatchState {
  invoiceId: string;
  matchStatus: InvoiceMatchStatus;
  paymentMatched: boolean;
  paymentMatchedAt: string | null;
  hasPurchaseOrder: boolean;
  summary: { totalLines: number; fullyMatched: number; priceMismatches: number; quantityMismatches: number; grnMismatches: number };
  itemResults: MatchLine[];
  tolerancesApplied: { qtyTolerancePct: number; priceTolerancePct: number };
}

/** The state as of now, judged from the live PO, GRN and bill; reads only. Null when the bill is not this company's. */
export async function readThreeWayMatchState(companyId: string, invoiceId: string): Promise<ThreeWayMatchState | null> {
  const invoices = (await sql`
    SELECT supplier_id::TEXT AS supplier_id, purchase_order_id::TEXT AS purchase_order_id, grn_id::TEXT AS grn_id,
           payment_matched, payment_matched_at
    FROM supplier_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as DbRow[];
  const inv = invoices[0];
  if (!inv) return null;
  const items = (await sql`
    SELECT sii.id::TEXT AS id, sii.description, sii.quantity, sii.unit_price, sii.po_item_id::TEXT AS po_item_id
    FROM supplier_invoice_items sii
    JOIN supplier_invoices si ON si.id = sii.supplier_invoice_id
    WHERE sii.supplier_invoice_id = ${invoiceId}::UUID AND si.company_id = ${companyId}::UUID
    ORDER BY sii.id
  `) as DbRow[];

  const base = {
    invoiceId,
    paymentMatched: Boolean(inv.payment_matched),
    paymentMatchedAt: inv.payment_matched_at ? String(inv.payment_matched_at) : null,
  };
  const poId = inv.purchase_order_id ? String(inv.purchase_order_id) : null;
  if (poId === null) {
    return {
      ...base, matchStatus: 'unmatched', hasPurchaseOrder: false, itemResults: [],
      summary: { totalLines: items.length, fullyMatched: 0, priceMismatches: 0, quantityMismatches: 0, grnMismatches: 0 },
      tolerancesApplied: { qtyTolerancePct: DEFAULT_TOLERANCE_PERCENT, priceTolerancePct: DEFAULT_TOLERANCE_PERCENT },
    };
  }

  const inputs = await readMatchInputs(companyId, {
    supplierId: String(inv.supplier_id), purchaseOrderId: poId, grnId: inv.grn_id ? String(inv.grn_id) : null,
  });
  const summary = { totalLines: items.length, fullyMatched: 0, priceMismatches: 0, quantityMismatches: 0, grnMismatches: 0 };
  const itemResults = items.map((item): MatchLine => {
    const poItem = item.po_item_id ? inputs.poItems.find((p) => String(p.id) === String(item.po_item_id)) : undefined;
    const grnItem = poItem ? inputs.grnItems.find((g) => String(g.po_item_id) === String(poItem.id)) : undefined;
    const poQuantity = poItem ? Number(poItem.quantity) : 0;
    const poUnitPrice = poItem ? Number(poItem.unit_price) : 0;
    const grnQuantityReceived = grnItem ? Number(grnItem.quantity_received) : 0;
    const invoiceQuantity = Number(item.quantity);
    const invoiceUnitPrice = Number(item.unit_price);
    const match = validateThreeWayMatch({
      poQuantity, poUnitPrice, grnQuantityReceived, invoiceQuantity, invoiceUnitPrice,
      qtyTolerancePercent: inputs.qtyTolerance, priceTolerancePercent: inputs.priceTolerance,
    });
    if (match.status === 'fully_matched') summary.fullyMatched += 1;
    if (!match.priceMatch) summary.priceMismatches += 1;
    if (!match.quantityMatch) summary.quantityMismatches += 1;
    if (!match.grnMatch) summary.grnMismatches += 1;
    return {
      invoiceItemId: String(item.id), description: String(item.description ?? ''),
      poQuantity, invoiceQuantity, grnQuantityReceived, poUnitPrice, invoiceUnitPrice,
      qtyVariancePct: (invoiceQuantity - poQuantity) / Math.max(poQuantity, 1) * 100,
      priceVariancePct: (invoiceUnitPrice - poUnitPrice) / Math.max(poUnitPrice, 1) * 100,
      lineMatchStatus: match.status,
      mismatches: match.mismatches,
    };
  });
  return {
    ...base, hasPurchaseOrder: true, summary, itemResults,
    matchStatus: overallMatchStatus(itemResults),
    tolerancesApplied: { qtyTolerancePct: inputs.qtyTolerance, priceTolerancePct: inputs.priceTolerance },
  };
}
