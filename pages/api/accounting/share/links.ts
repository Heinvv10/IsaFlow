/**
 * GET  /api/accounting/share/links        — this company's links (never the token)
 * POST /api/accounting/share/links        — create; returns the token ONCE
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withCsrf, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { parseSharePackParams } from '@/modules/accounting/services/share/shareParams';
import { createShareLink, listShareLinks } from '@/modules/accounting/services/share/shareLinkService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    return apiResponse.success(res, { links: await listShareLinks(companyId) });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const params = parseSharePackParams(body.params);
    if (!params) {
      return apiResponse.badRequest(res, 'params must be { type: board|management|monthly, from: YYYY-MM-DD, to: YYYY-MM-DD }');
    }
    const label = typeof body.label === 'string' ? body.label.slice(0, 120) : undefined;
    const ttlDays = typeof body.ttlDays === 'number' ? body.ttlDays : undefined;

    const { link, token } = await createShareLink({ companyId, userId: user.id, params, label, ttlDays });
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3200';
    log.info('Share link issued to user', { companyId, userId: user.id, shareLinkId: link.id }, 'share');
    // `token` and `url` appear in this response and nowhere else, ever.
    return apiResponse.success(res, { link, token, url: `${appUrl}/share/${token}` });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
