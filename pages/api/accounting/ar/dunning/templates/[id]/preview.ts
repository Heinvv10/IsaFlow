/**
 * POST /api/accounting/ar/dunning/templates/[id]/preview
 * Body: { invoiceId }
 *
 * Returns rendered {subject, body, to_email, ...} for a template/invoice
 * combo — does NOT send. Used by the UI to preview before hitting /send.
 *
 * PRD-06 Phase 5. Company-scoped, auth-required.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { renderTemplate } from '@/modules/accounting/services/ar/dunningService';

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
    return;
  }
  const { companyId } = req as CompanyAuthedRequest;
  const templateId = typeof req.query.id === 'string' ? req.query.id : '';
  const invoiceId = typeof req.body?.invoiceId === 'string' ? req.body.invoiceId : '';

  if (!templateId) {
    apiResponse.badRequest(res, 'template id is required in path');
    return;
  }
  if (!invoiceId) {
    apiResponse.badRequest(res, 'invoiceId is required in body');
    return;
  }

  try {
    const portalBaseUrl = process.env.PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
    const rendered = await renderTemplate(companyId, templateId, invoiceId, portalBaseUrl);
    if (!rendered) {
      apiResponse.notFound(res, 'Invoice', invoiceId);
      return;
    }
    apiResponse.success(res, { preview: rendered });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg)) {
      apiResponse.notFound(res, 'Template', templateId);
      return;
    }
    apiResponse.badRequest(res, msg);
  }
}

export default withAuth(withErrorHandler(withCsrf(handler)));
