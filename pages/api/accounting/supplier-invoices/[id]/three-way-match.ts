/**
 * GET  /api/accounting/supplier-invoices/[id]/three-way-match
 *   Returns the cached match state from supplier_invoice_items columns.
 *
 * POST /api/accounting/supplier-invoices/[id]/three-way-match
 *   Triggers a recompute via performThreeWayMatch and returns the fresh result.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { performThreeWayMatch } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';

type Row = DbRow;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const invoiceId = req.query.id as string;

  if (!invoiceId) return apiResponse.badRequest(res, 'invoiceId is required');

  if (req.method === 'GET') {
    // Return cached match state — no recompute
    const invRows = (await sql`
      SELECT id, match_status, payment_matched, payment_matched_at
      FROM supplier_invoices
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
      LIMIT 1
    `) as Row[];

    if (invRows.length === 0) return apiResponse.notFound(res, 'Supplier invoice', invoiceId);
    const inv = invRows[0]!;

    const itemRows = (await sql`
      SELECT sii.id, sii.description, sii.quantity, sii.unit_price,
             sii.line_match_status, sii.qty_variance_pct, sii.price_variance_pct, sii.match_computed_at
      FROM supplier_invoice_items sii
      JOIN supplier_invoices si ON si.id = sii.supplier_invoice_id
      WHERE sii.supplier_invoice_id = ${invoiceId}::UUID AND si.company_id = ${companyId}::UUID
      ORDER BY sii.id
    `) as Row[];

    const itemResults = itemRows.map((r: Row) => ({
      itemId: String(r.id),
      itemDescription: String(r.description),
      quantity: Number(r.quantity),
      unitPrice: Number(r.unit_price),
      lineMatchStatus: r.line_match_status ? String(r.line_match_status) : null,
      qtyVariancePct: r.qty_variance_pct != null ? Number(r.qty_variance_pct) : null,
      priceVariancePct: r.price_variance_pct != null ? Number(r.price_variance_pct) : null,
      matchComputedAt: r.match_computed_at ? String(r.match_computed_at) : null,
    }));

    const matchedCount = itemResults.filter(i => i.lineMatchStatus === 'fully_matched').length;
    const summary = {
      totalLines: itemResults.length,
      matchedLines: matchedCount,
      allLinesMatched: itemResults.length > 0 && matchedCount === itemResults.length,
    };

    log.info('3-way match GET', { invoiceId, matchStatus: inv.match_status }, 'three-way-match');

    return apiResponse.success(res, {
      invoiceId,
      matchStatus: String(inv.match_status),
      paymentMatched: Boolean(inv.payment_matched),
      paymentMatchedAt: inv.payment_matched_at ? String(inv.payment_matched_at) : null,
      itemResults,
      summary,
    });
  }

  if (req.method === 'POST') {
    // Recompute match
    const result = await performThreeWayMatch(companyId, invoiceId);

    // Reload payment_matched flag for the combined response
    const flagRows = (await sql`
      SELECT payment_matched, payment_matched_at
      FROM supplier_invoices
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
      LIMIT 1
    `) as Row[];
    const flagRow = flagRows[0];

    const matchedCount = result.itemResults.filter(i => i.lineMatchStatus === 'fully_matched').length;
    const summary = {
      totalLines: result.itemResults.length,
      matchedLines: matchedCount,
      allLinesMatched: result.itemResults.length > 0 && matchedCount === result.itemResults.length,
    };

    log.info('3-way match POST recomputed', { invoiceId, matchStatus: result.matchStatus }, 'three-way-match');

    return apiResponse.success(res, {
      ...result,
      paymentMatched: flagRow ? Boolean(flagRow.payment_matched) : false,
      paymentMatchedAt: flagRow?.payment_matched_at ? String(flagRow.payment_matched_at) : null,
      summary,
    });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

// GET uses read-only auth; POST requires write access — single handler, guard inside
export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
