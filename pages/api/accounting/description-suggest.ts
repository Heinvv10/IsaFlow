/**
 * GET /api/accounting/description-suggest
 * Auto-suggest descriptions from templates + GL history.
 * WS-6.5
 *
 * Query params:
 *   q           — search term (required)
 *   entity_type — optional filter (e.g. 'journal_entry')
 *   limit       — max results (default 10)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth } from '@/lib/auth/withAuth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { suggestDescriptions } from '@/modules/accounting/services/core/descriptionTemplateService';
import type { CompanyAuthedRequest } from '@/lib/auth/withAuth';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['GET']);
  }

  const companyReq = req as CompanyAuthedRequest;
  const companyId = companyReq.companyId;

  const q = (req.query.q as string | undefined) ?? '';
  const entityType = req.query.entity_type as string | undefined;
  const limit = Math.min(Number(req.query.limit ?? 10), 20);

  if (!q.trim()) {
    return apiResponse.success(res, { suggestions: [] });
  }

  const suggestions = await suggestDescriptions(companyId, q, entityType, limit);
  return apiResponse.success(res, { suggestions });
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
