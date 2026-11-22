/**
 * Supplier invoice three-way match (invoice vs PO vs goods received), persisted per line and overall.
 * Split out of supplierInvoiceWorkflowService.ts for file-size compliance; that module re-exports it.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateThreeWayMatch } from '../../utils/threeWayMatch';
import { getSupplierInvoiceById } from './supplierInvoiceService';
import { judgeMatchLine, overallMatchStatus, readBillMatchInputs } from './threeWayMatchState';

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

  const inputs = await readBillMatchInputs(companyId, invoice);
  if (!inputs) {
    log.info('performThreeWayMatch: invoice has no linked PO — returning unmatched', { invoiceId }, 'accounting');
    return { invoiceId, matchStatus: 'unmatched', itemResults: [] };
  }

  const itemResults: ThreeWayMatchItemResult[] = [];

  for (const item of (invoice.items ?? [])) {
    const { match, qtyVariancePct, priceVariancePct } = judgeMatchLine(item, inputs);

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

  const overallStatus = overallMatchStatus(itemResults);

  await sql`
    UPDATE supplier_invoices SET match_status = ${overallStatus}
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('3-way match completed', { invoiceId, matchStatus: overallStatus, lineCount: itemResults.length }, 'accounting');
  return { invoiceId, matchStatus: overallStatus, itemResults };
}
