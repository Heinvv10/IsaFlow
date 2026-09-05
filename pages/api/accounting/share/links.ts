/**
 * GET  /api/accounting/share/links        — this company's links (never the token)
 * POST /api/accounting/share/links        — create; returns the token ONCE
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withCsrf, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { parseSharePackParams } from '@/modules/accounting/services/share/shareParams';
import {
  createShareLink,
  listShareLinks,
  ShareLinkLimitError,
} from '@/modules/accounting/services/share/shareLinkService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    return apiResponse.success(res, { links: await listShareLinks(companyId) });
  }

  if (req.method === 'POST') {
    if (!(await checkReportRateLimit(companyId, 'share-link-create'))) {
      log.warn('Share link creation rate limit exceeded', { companyId, userId: user.id }, 'rateLimit');
      return apiResponse.tooManyRequests(res, 'Too many share links created. Please try again shortly.');
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const params = parseSharePackParams(body.params);
    if (!params) {
      return apiResponse.badRequest(res, 'params must be { type: board|management|monthly, from: YYYY-MM-DD, to: YYYY-MM-DD }');
    }
    const label = typeof body.label === 'string' ? body.label.slice(0, 120) : undefined;
    const ttlDays = typeof body.ttlDays === 'number' ? body.ttlDays : undefined;

    let created: Awaited<ReturnType<typeof createShareLink>>;
    try {
      created = await createShareLink({ companyId, userId: user.id, params, label, ttlDays });
    } catch (err) {
      if (err instanceof ShareLinkLimitError) return apiResponse.conflict(res, err.message);
      throw err;
    }

    // Same fallback as every other URL builder in this codebase; an unset
    // NEXT_PUBLIC_APP_URL must not hand a client a localhost link.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za';
    // The service already logged the creation; a second entry here would only
    // double-count it. `token` and `url` appear in this response and nowhere else.
    return apiResponse.success(res, {
      link: created.link,
      token: created.token,
      url: `${appUrl}/share/${created.token}`,
    });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

// Minting a link that shows a third party the company's figures, and
// withdrawing one, are owner/admin decisions — a manager is not one.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler, { allowedRoles: ['owner', 'admin'] }))));
