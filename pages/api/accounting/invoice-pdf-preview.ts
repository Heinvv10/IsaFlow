/**
 * Invoice PDF preview before the first save (master plan wave 4, PR PV)
 * POST — the body create takes (customer-invoices-create); returns the PDF it would print, inline, marked
 * "PREVIEW: NOT SAVED" and with no invoice number.
 *
 * Stateless: it never calls create, writes no row, takes no number and is not metered (create is: withFlowMeter).
 * Every id in the body is resolved within the company (invoicePreviewModel): another company's customer is a 404.
 * Its own rate-limit bucket, per company, so typing under an open preview cannot use up `invoice-pdf` downloads.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { checkReportRateLimit, INTERACTIVE_REPORT_LIMIT } from '@/lib/rateLimit';
import { generateInvoicePdf } from '@/modules/accounting/services/ar/invoicePdfService';
import { parsePreviewBody, PreviewBodyError, previewRateLimitName } from '@/modules/accounting/services/ar/invoicePreviewBody';
import { buildInvoicePreviewModel } from '@/modules/accounting/services/ar/invoicePreviewModel';
import { InvoiceLineValidationError } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { DocumentCurrencyError } from '@/modules/accounting/services/shared/documentCurrency';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);

  try {
    // The shape and the caps first: a refused body costs no rate-limit unit and no query.
    const body = parsePreviewBody(req.body);
    if (!(await checkReportRateLimit(companyId, previewRateLimitName(companyId), INTERACTIVE_REPORT_LIMIT))) {
      log.warn('Invoice PDF preview rate limit exceeded', { companyId }, 'rateLimit');
      return apiResponse.tooManyRequests(res, 'Too many previews. Please try again shortly.');
    }
    const preview = await buildInvoicePreviewModel(companyId, body);
    if (!preview) return apiResponse.notFound(res, 'Customer');
    const pdf = await generateInvoicePdf(companyId, 'preview', preview.model, { notes: preview.notes });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Invoice-preview.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', pdf.length);
    return res.status(200).send(pdf);
  } catch (err) {
    if (err instanceof PreviewBodyError || err instanceof InvoiceLineValidationError || err instanceof DocumentCurrencyError) {
      return apiResponse.badRequest(res, err.message);
    }
    throw err;
  }
}

// The caps are judged on the parsed body (64 KB); this only stops a far larger one before it is parsed.
export const config = { api: { bodyParser: { sizeLimit: '256kb' } } };

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
