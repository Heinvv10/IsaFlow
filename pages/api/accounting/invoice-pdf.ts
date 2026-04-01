/**
 * Invoice PDF API
 * GET ?invoiceId=UUID — returns PDF as downloadable file
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { generateInvoicePdf } from '@/modules/accounting/services/invoicePdfService';

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
    const pdfBuffer = await generateInvoicePdf(companyId, invoiceId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Invoice-${invoiceId}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.status(200).end(pdfBuffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to generate PDF';
    const stack = err instanceof Error ? err.stack : '';
    log.error('Invoice PDF generation failed', { invoiceId, error: message, stack }, 'invoice-pdf-api');

    if (message.includes('not found')) {
      return apiResponse.notFound(res, 'Invoice', invoiceId);
    }
    return apiResponse.internalError(res, err, `Failed to generate invoice PDF: ${message}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
