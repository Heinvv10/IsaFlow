/**
 * Supplier Invoice PDF API
 * GET ?invoiceId=UUID — returns supplier invoice PDF as downloadable file
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { generateSupplierInvoicePdf } from '@/modules/accounting/services/ap/supplierInvoicePdfBuilder';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { invoiceId } = req.query;
  if (!invoiceId || typeof invoiceId !== 'string') {
    return apiResponse.badRequest(res, 'invoiceId query parameter is required');
  }

  try {
    const pdfBuffer = await generateSupplierInvoicePdf(companyId, invoiceId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="SupplierInvoice-${invoiceId}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.status(200).end(pdfBuffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to generate PDF';
    log.error('Supplier invoice PDF failed', { invoiceId, error: message }, 'supplier-invoice-pdf');
    if (message.includes('not found')) return apiResponse.notFound(res, 'SupplierInvoice', invoiceId);
    return apiResponse.internalError(res, err, `Failed to generate supplier invoice PDF`);
  }
}

export default withCompany(withErrorHandler(handler));
