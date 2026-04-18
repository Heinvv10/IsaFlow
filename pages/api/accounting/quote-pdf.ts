/**
 * Quote PDF API
 * GET ?quoteId=UUID — returns quotation PDF as downloadable file
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { generateQuotePdf } from '@/modules/accounting/services/ar/quotePdfBuilder';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { quoteId } = req.query;
  if (!quoteId || typeof quoteId !== 'string') {
    return apiResponse.badRequest(res, 'quoteId query parameter is required');
  }

  try {
    const pdfBuffer = await generateQuotePdf(companyId, quoteId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Quote-${quoteId}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.status(200).end(pdfBuffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to generate PDF';
    log.error('Quote PDF generation failed', { quoteId, error: message }, 'quote-pdf-api');
    if (message.includes('not found')) {
      return apiResponse.notFound(res, 'Quote', quoteId);
    }
    return apiResponse.internalError(res, err, `Failed to generate quote PDF: ${message}`);
  }
}

export default withAuth(withErrorHandler(handler));
