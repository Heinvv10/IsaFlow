/**
 * Invoice Email API
 * POST { invoiceId, recipientEmail } — generate PDF + send email + track
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sendInvoiceEmail } from '@/modules/accounting/services/emailService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
