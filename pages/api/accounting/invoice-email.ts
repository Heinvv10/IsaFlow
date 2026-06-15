/**
 * Invoice Email API
 * POST { invoiceId, recipientEmail } — generate PDF + send email + track
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { checkSendRateLimit } from '@/lib/rateLimit';
import { sendInvoiceEmail } from '@/modules/accounting/services/core/emailService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  // Each call sends a real SMTP email to an arbitrary address — bound it per IP/company/day
  // so a logged-in user can't loop it into a spam cannon (pentest H9).
  if (!(await checkSendRateLimit(req, companyId, 'invoice-email'))) {
    return apiResponse.tooManyRequests(res, 'Email send limit reached. Please try again later.');
  }

  const { invoiceId, recipientEmail } = req.body;

  if (!invoiceId || typeof invoiceId !== 'string') {
    return apiResponse.badRequest(res, 'invoiceId is required');
  }

  if (!recipientEmail || typeof recipientEmail !== 'string') {
    return apiResponse.badRequest(res, 'recipientEmail is required');
  }

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(recipientEmail)) {
    return apiResponse.badRequest(res, 'Invalid email address');
  }

  try {
    const result = await sendInvoiceEmail(companyId, invoiceId, recipientEmail);

    if (!result.success) {
      log.warn('Invoice email not sent', {
        invoiceId,
        recipientEmail,
        error: result.error,
      }, 'invoice-email-api');

      return apiResponse.success(res, {
        sent: false,
        reason: result.error || 'Email delivery failed',
      }, 'Email could not be sent. Check SMTP configuration.');
    }

    return apiResponse.success(res, {
      sent: true,
      messageId: result.messageId,
      recipientEmail,
    }, 'Invoice email sent successfully');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send invoice email';
    log.error('Invoice email failed', { invoiceId, recipientEmail, error: message }, 'invoice-email-api');

    if (message.includes('not found')) {
      return apiResponse.notFound(res, 'Invoice', invoiceId);
    }
    return apiResponse.internalError(res, err, 'Failed to send invoice email');
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
