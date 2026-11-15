/**
 * Admin Webhooks API
 * GET /api/admin/webhooks — list all webhooks across companies
 * Supports: ?search=, ?status=active|disabled, ?companyId=, ?page=, ?limit=
 */

import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { adminOptionalUuid, adminPositiveInt } from '@/modules/admin/middleware/adminRequestErrors';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
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

  try {
    const result = await listAdminWebhooks({
      search: search as string | undefined,
      status: parsedStatus,
      companyId: adminOptionalUuid(companyId, 'companyId'),
      page: adminPositiveInt(page, 'page') ?? 1,
      limit: adminPositiveInt(limit, 'limit') ?? 25,
    });

    return apiResponse.success(res, result);
  } catch (err) {
    log.error('Admin: failed to list webhooks', { error: err }, 'admin-webhooks-api');
    return apiResponse.error(res, ErrorCode.INTERNAL_ERROR, 'Failed to list webhooks');
  }
}

export default withAdmin(handler);
