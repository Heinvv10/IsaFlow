/**
 * POST /api/accounting/ar/dunning/send
 * Body: { invoiceId, templateId }
 *
 * Renders the template for the invoice, sends the email, inserts an
 * immutable dunning_sends row with the rendered snapshot, and returns the
 * send id + message token.
 *
 * PRD-06 Phase 5. Company-scoped, write-only (manager+).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { checkSendRateLimit } from '@/lib/rateLimit';
import { sendDunning } from '@/modules/accounting/services/ar/dunningService';
import { log } from '@/lib/logger';

const BodySchema = z.object({
  invoiceId: UUID,
  templateId: UUID,
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
    return;
  }
  const { companyId, user } = req as CompanyAuthedRequest;

  const sendAllowed = await checkSendRateLimit(req, companyId, 'dunning');
  if (!sendAllowed) {
    apiResponse.tooManyRequests(res, 'Too many send requests. Please try again later.');
    return;
  }

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    return;
  }
  const { invoiceId, templateId } = parsed.data;

  try {
    const portalBaseUrl = process.env.PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
    const result = await sendDunning({
      companyId,
      invoiceId,
      templateId,
      sentBy: user.id,
      triggerSource: 'manual',
      portalBaseUrl,
    });
    if (result.emailStatus === 'failed') {
      log.warn('Dunning email failed', { sendId: result.sendId, error: result.emailError }, 'ar-dunning');
    }
    apiResponse.success(res, result);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : '';
    if (/Invoice .* not found/i.test(errMsg)) {
      apiResponse.notFound(res, 'Invoice', invoiceId);
      return;
    }
    if (/Template .* not found/i.test(errMsg)) {
      apiResponse.notFound(res, 'Template', templateId);
      return;
    }
    if (
      /no outstanding balance/i.test(errMsg) ||
      /cancelled invoice/i.test(errMsg) ||
      /no email address/i.test(errMsg)
    ) {
      apiResponse.badRequestFromError(res, err, 'Failed to send dunning notices');
      return;
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
