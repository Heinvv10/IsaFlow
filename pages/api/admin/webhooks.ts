/**
 * Admin Webhooks API
 * GET /api/admin/webhooks — list all webhooks across companies
 * Supports: ?search=, ?status=active|disabled, ?companyId=, ?page=, ?limit=
 */

import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { adminOptionalUuid, adminPositiveInt } from '@/modules/admin/middleware/adminRequestErrors';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { listAdminWebhooks } from '@/modules/admin/services/adminWebhookService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const {
    search,
    status,
    companyId,
    page,
    limit,
  } = req.query;

  const validStatuses = ['active', 'disabled', 'all'] as const;
  type StatusParam = typeof validStatuses[number];
  const parsedStatus: StatusParam =
    validStatuses.includes(status as StatusParam) ? (status as StatusParam) : 'all';

  // No catch here: a malformed parameter is withAdmin's 400, a database failure withErrorHandler's 500 (breaker
  // #1405 B2: a catch-all around these validators answered the caller's mistake as a 500).
  const result = await listAdminWebhooks({
    search: search as string | undefined,
    status: parsedStatus,
    companyId: adminOptionalUuid(companyId, 'companyId'),
    page: adminPositiveInt(page, 'page') ?? 1,
    limit: adminPositiveInt(limit, 'limit') ?? 25,
  });

  return apiResponse.success(res, result);
}

export default withAdmin(handler);
