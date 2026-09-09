import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateThreeWayMatch } from '../../utils/threeWayMatch';
import { getSupplierInvoiceById } from './supplierInvoiceService';
type Row = DbRow;
const DEFAULT_TOLERANCE_PERCENT = 2;

export interface ThreeWayMatchItemResult {
  itemId: string;
  itemDescription: string;
  lineMatchStatus: 'unmatched' | 'po_matched' | 'grn_matched' | 'fully_matched';
  qtyVariancePct: number;
  priceVariancePct: number;
  match: ReturnType<typeof validateThreeWayMatch>;
}

export async function performThreeWayMatch(
  companyId: string,
  invoiceId: string,
): Promise<{
  invoiceId: string;
  matchStatus: 'unmatched' | 'po_matched' | 'grn_matched' | 'fully_matched';
  itemResults: ThreeWayMatchItemResult[];
}> {
  const invoice = await getSupplierInvoiceById(companyId, invoiceId);
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

  if (!invoice.purchaseOrderId) {
    log.info('performThreeWayMatch: invoice has no linked PO — returning unmatched', { invoiceId }, 'accounting');
    return { invoiceId, matchStatus: 'unmatched', itemResults: [] };
  }

  // Load tolerance from supplier_coding_rules; fall back to 2%
  const ruleRows = (await sql`
    SELECT qty_tolerance_pct, price_tolerance_pct
    FROM supplier_coding_rules
    WHERE company_id = ${companyId}::UUID AND supplier_id = ${invoice.supplierId}::UUID
    LIMIT 1
  `) as Row[];
  const qtyTolerance = ruleRows.length > 0 && ruleRows[0]!.qty_tolerance_pct != null
    ? Number(ruleRows[0]!.qty_tolerance_pct) : DEFAULT_TOLERANCE_PERCENT;
  const priceTolerance = ruleRows.length > 0 && ruleRows[0]!.price_tolerance_pct != null
    ? Number(ruleRows[0]!.price_tolerance_pct) : DEFAULT_TOLERANCE_PERCENT;

  const poItems = (await sql`
    SELECT * FROM po_items
    WHERE purchase_order_id = ${invoice.purchaseOrderId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];

  const grnItems = invoice.grnId
    ? ((await sql`
        SELECT * FROM grn_items
        WHERE grn_id = ${invoice.grnId}::UUID AND company_id = ${companyId}::UUID
      `) as Row[])
    : [];

  const itemResults: ThreeWayMatchItemResult[] = [];

  for (const item of (invoice.items ?? [])) {
    const poItem = item.poItemId ? poItems.find((p: Row) => String(p.id) === item.poItemId) : null;
    const grnItem = poItem
      ? grnItems.find((g: Row) => String(g.po_item_id) === String(poItem.id))
      : null;

    const poQty = poItem ? Number(poItem.quantity) : 0;
    const poPrice = poItem ? Number(poItem.unit_price) : 0;
    const grnQtyReceived = grnItem ? Number(grnItem.quantity_received) : 0;

    const qtyVariancePct = (item.quantity - poQty) / Math.max(poQty, 1) * 100;
    const priceVariancePct = (item.unitPrice - poPrice) / Math.max(poPrice, 1) * 100;

    const match = validateThreeWayMatch({
      poQuantity: poQty,
      poUnitPrice: poPrice,
      grnQuantityReceived: grnQtyReceived,
      invoiceQuantity: item.quantity,
      invoiceUnitPrice: item.unitPrice,
      qtyTolerancePercent: qtyTolerance,
      priceTolerancePercent: priceTolerance,
    });

    const lineMatchStatus = match.status;

    // Persist per-line match state — log failures but keep processing other lines
    try {
      // supplier_invoice_items has no company_id; scope via parent invoice
      await sql`
        UPDATE supplier_invoice_items sii
        SET line_match_status = ${lineMatchStatus},
            qty_variance_pct   = ${qtyVariancePct},
            price_variance_pct = ${priceVariancePct},
            match_computed_at  = NOW()
        FROM supplier_invoices si
        WHERE sii.id = ${item.id}::UUID
          AND si.id = sii.supplier_invoice_id
          AND si.company_id = ${companyId}::UUID
      `;
    } catch (updateErr) {
      log.error('Failed to persist line match status', { itemId: item.id, error: updateErr }, 'accounting');
    }

    itemResults.push({
      itemId: item.id,
      itemDescription: item.description,
      lineMatchStatus,
      qtyVariancePct,
      priceVariancePct,
      match,
    });
  }

  const overallStatus = itemResults.length === 0
    ? 'unmatched'
    : itemResults.every(r => r.lineMatchStatus === 'fully_matched')
      ? 'fully_matched'
      : itemResults.some(r => r.lineMatchStatus === 'po_matched')
        ? 'po_matched'
        : itemResults.some(r => r.lineMatchStatus === 'grn_matched')
          ? 'grn_matched'
          : 'unmatched';

  await sql`
    UPDATE supplier_invoices SET match_status = ${overallStatus}
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('3-way match completed', { invoiceId, matchStatus: overallStatus, lineCount: itemResults.length }, 'accounting');
  return { invoiceId, matchStatus: overallStatus, itemResults };
}

