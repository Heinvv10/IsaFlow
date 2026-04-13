/**
 * Purchase Order PDF API
 * GET ?poId=UUID — returns purchase order PDF as downloadable file
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { generatePurchaseOrderPdf } from '@/modules/accounting/services/purchaseOrderPdfBuilder';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { poId } = req.query;
  if (!poId || typeof poId !== 'string') {
    return apiResponse.badRequest(res, 'poId query parameter is required');
  }

  try {
    const pdfBuffer = await generatePurchaseOrderPdf(companyId, poId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PO-${poId}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.status(200).end(pdfBuffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to generate PDF';
    log.error('PO PDF failed', { poId, error: message }, 'purchase-order-pdf');
    if (message.includes('not found')) return apiResponse.notFound(res, 'PurchaseOrder', poId);
    return apiResponse.internalError(res, err, `Failed to generate purchase order PDF`);
  }
}

export default withCompany(withErrorHandler(handler));
