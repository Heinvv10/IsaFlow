/**
 * Bank Reconciliation GL Lines API — the reconciliation screen's manual-match list.
 * GET /api/accounting/bank-reconciliation-gl-lines?reconciliationId=<uuid>[&search=<text>][&limit=<1..500>]
 *
 * Every GL line of the session's bank account a statement line may still be matched to: the definition auto-match
 * uses (`reconcilableGlLineWhere`: posted, standing, not matched to any statement line, dated on or before the
 * statement date of an in-progress session), newest first. At most `limit` lines (default and maximum
 * RECON_GL_LINES_MAX); `total` is how many match and `truncated` says the list was cut, so the screen can ask for a
 * search instead of showing part of the list as the whole. `search` narrows on the server (description, entry
 * number, amount). A session that is not this company's is a 404.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { UUID } from '@/lib/schemas/common';
import { parseBoundedInt } from '@/modules/accounting/services/gl/ledgerDateRange';
import {
  listReconcilableGlLines, RECON_GL_LINES_MAX, RECON_GL_SEARCH_MAX,
} from '@/modules/accounting/services/bank/bankReconcilableGlLines';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const { reconciliationId, search, limit } = req.query;
  if (!UUID.safeParse(reconciliationId).success) return apiResponse.badRequest(res, 'reconciliationId must be a valid UUID');
  if (search !== undefined && (typeof search !== 'string' || search.length > RECON_GL_SEARCH_MAX)) {
    return apiResponse.badRequest(res, `search must be one text of at most ${RECON_GL_SEARCH_MAX} characters`);
  }
  const max = limit === undefined ? RECON_GL_LINES_MAX : parseBoundedInt(limit, 1, RECON_GL_LINES_MAX);
  if (max === null) return apiResponse.badRequest(res, `limit must be a whole number from 1 to ${RECON_GL_LINES_MAX}`);
  const page = await listReconcilableGlLines(companyId, String(reconciliationId), { search, limit: max });
  if (!page) return apiResponse.notFound(res, 'Reconciliation', String(reconciliationId));
  return apiResponse.success(res, { ...page, limit: max });
}

export default withAuth(withErrorHandler(handler));
