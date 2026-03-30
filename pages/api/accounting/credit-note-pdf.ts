/**
 * Credit Note PDF API
 * GET ?creditNoteId=UUID — returns credit note PDF as downloadable file
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { generateCreditNotePdf } from '@/modules/accounting/services/invoicePdfService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { creditNoteId } = req.query;
  if (!creditNoteId || typeof creditNoteId !== 'string') {
    return apiResponse.badRequest(res, 'creditNoteId query parameter is required');
  }

  try {
    const pdfBuffer = await generateCreditNotePdf(companyId, creditNoteId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="CreditNote-${creditNoteId}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.status(200).end(pdfBuffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to generate PDF';
    log.error('Credit note PDF generation failed', { creditNoteId, error: message }, 'credit-note-pdf-api');

    if (message.includes('not found')) {
      return apiResponse.notFound(res, 'Credit Note', creditNoteId);
    }
    return apiResponse.internalError(res, err, 'Failed to generate credit note PDF');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
