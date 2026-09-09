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
import { z } from 'zod';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { renderTemplate } from '@/modules/accounting/services/ar/dunningService';

const BodySchema = z.object({ invoiceId: UUID }).strict();

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
    return;
  }
  const { companyId } = req as CompanyAuthedRequest;
  const idParse = UUID.safeParse(req.query.id);
  if (!idParse.success) {
    apiResponse.badRequest(res, 'template id must be a valid UUID');
    return;
  }
  const templateId = idParse.data;

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    return;
  }
  const { invoiceId } = parsed.data;

  try {
    const portalBaseUrl = process.env.PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
    // Read-shaped: never mint a portal token here. Previewing must not persist
    // a permanent unauthenticated-access credential for an invoice that may
    // never be sent (and withAuth COMMITs on 4xx, so it would survive a 404).
    // An invoice with no token yet previews the '(portal link unavailable)'
    // placeholder; the real link is minted when the reminder is sent.
    const rendered = await renderTemplate(companyId, templateId, invoiceId, portalBaseUrl, {
      mintPortalToken: false,
    });
    if (!rendered) {
      apiResponse.notFound(res, 'Invoice', invoiceId);
      return;
    }
    apiResponse.success(res, { preview: rendered });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : '';
    if (/not found/i.test(errMsg)) {
      apiResponse.notFound(res, 'Template', templateId);
      return;
    }
    apiResponse.badRequestFromError(res, err, 'Failed to render preview');
  }
}

export default withAuth(withErrorHandler(withCsrf(handler)));
