/**
 * GET  /api/accounting/commentary?type=&from=&to=   — drafts and approvals for a pack
 *                                                     owner/admin/manager only
 * POST /api/accounting/commentary                   — generate drafts (never approves)
 *
 * The POST writes drafts only. Nothing on this route can put text on a share
 * link; that takes the separate approve route and a named user.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withCsrf, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { parseSharePackParams } from '@/modules/accounting/services/share/shareParams';
import { listCommentary, generateDrafts } from '@/modules/accounting/services/commentary/commentaryService';
import { buildManagementPackData } from '@/modules/accounting/services/commentary/packData';
import { canReadSharingSurface } from '@/modules/accounting/services/reports/sharingAccess';

/** Regeneration withdraws an approval a named person gave. That is the same
 *  class of decision as approving in the first place, so a manager who may
 *  generate drafts may not overwrite what an owner signed off. */
const REPLACE_ROLES = new Set(['owner', 'admin']);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    // This arm returns DRAFT text — sentences about the company's numbers that
    // no named person has approved. withWriteAccess lets every read method
    // through, so without this check a viewer could read them.
    if (!canReadSharingSurface(companyRole)) {
      return apiResponse.forbidden(res, `Your role (${companyRole ?? 'none'}) cannot view commentary.`);
    }
    const params = parseSharePackParams({ type: req.query.type, from: req.query.from, to: req.query.to });
    if (!params) return apiResponse.badRequest(res, 'type, from and to are required');
    return apiResponse.success(res, { commentary: await listCommentary(companyId, params) });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const params = parseSharePackParams(body.params);
    if (!params) return apiResponse.badRequest(res, 'params must be { type, from, to }');

    const replace = body.replace === true;
    if (replace && !REPLACE_ROLES.has(String(companyRole))) {
      return apiResponse.forbidden(res, 'Only an owner or admin can withdraw an approval by regenerating.');
    }

    // Building the pack reads the whole ledger twice (period and comparative);
    // the limit is per company, so one tenant cannot spend another's capacity.
    if (!(await checkReportRateLimit(companyId, 'commentary-generate'))) {
      log.warn('Commentary generation rate limit exceeded', { companyId, userId: user.id }, 'rateLimit');
      return apiResponse.tooManyRequests(res, 'Too many commentary generations. Please try again shortly.');
    }

    const data = await buildManagementPackData(companyId, params);
    const result = await generateDrafts({ companyId, userId: user.id, params, data, replace });
    return apiResponse.success(res, result);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
