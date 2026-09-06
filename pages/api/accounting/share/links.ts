/**
 * GET  /api/accounting/share/links        — this company's links (never the token)
 *                                          owner/admin/manager only
 * POST /api/accounting/share/links        — create; returns the token ONCE
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withCsrf, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { parseSharePackParams } from '@/modules/accounting/services/share/shareParams';
import { canReadSharingSurface } from '@/modules/accounting/services/reports/sharingAccess';
import {
  createShareLink,
  listShareLinks,
  ShareLinkLimitError,
} from '@/modules/accounting/services/share/shareLinkService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    // withWriteAccess gates POST only — GET passes straight through it — so the
    // owner/admin option on the export line below says nothing about this arm.
    // Without this check any member, a viewer included, could read who a pack
    // was shared with, when the link expires and how often it has been opened.
    if (!canReadSharingSurface(companyRole)) {
      return apiResponse.forbidden(res, `Your role (${companyRole ?? 'none'}) cannot view share links.`);
    }
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

    // No fallback, and checked BEFORE anything is minted. Every other URL
    // builder in this codebase defaults to the production host, which is
    // harmless for a link a logged-in user follows and is not harmless here:
    // the raw token is returned ONCE, so a URL built against the wrong origin
    // is a live link against this company's cap that nobody can ever open, and
    // the person is not told. On a staging deploy with the variable unset,
    // every link minted would point at production. Better a 500 the operator
    // can see — raised before the row exists, so there is nothing to orphan.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!appUrl) {
      log.error('NEXT_PUBLIC_APP_URL is not set — refusing to mint a share link', { companyId }, 'share');
      throw new Error('NEXT_PUBLIC_APP_URL is not configured; a share link URL cannot be built.');
    }

    let created: Awaited<ReturnType<typeof createShareLink>>;
    try {
      created = await createShareLink({ companyId, userId: user.id, params, label, ttlDays });
    } catch (err) {
      if (err instanceof ShareLinkLimitError) return apiResponse.conflict(res, err.message);
      throw err;
    }

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
