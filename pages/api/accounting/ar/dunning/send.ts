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

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { sendDunning } from '@/modules/accounting/services/ar/dunningService';
import { log } from '@/lib/logger';

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
    return;
  }
  const { companyId, user } = req as CompanyAuthedRequest;
  const body = req.body ?? {};
  const invoiceId = typeof body.invoiceId === 'string' ? body.invoiceId : '';
  const templateId = typeof body.templateId === 'string' ? body.templateId : '';

  if (!invoiceId) {
    apiResponse.badRequest(res, 'invoiceId is required');
    return;
  }
  if (!templateId) {
    apiResponse.badRequest(res, 'templateId is required');
    return;
  }

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
    const msg = err instanceof Error ? err.message : String(err);
    if (/Invoice .* not found/i.test(msg)) {
      apiResponse.notFound(res, 'Invoice', invoiceId);
      return;
    }
    if (/Template .* not found/i.test(msg)) {
      apiResponse.notFound(res, 'Template', templateId);
      return;
    }
    if (
      /no outstanding balance/i.test(msg) ||
      /cancelled invoice/i.test(msg) ||
      /no email address/i.test(msg)
    ) {
      apiResponse.badRequest(res, msg);
      return;
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
