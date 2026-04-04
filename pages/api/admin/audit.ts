/**
 * Admin Audit Log API
 * GET /api/admin/audit — Unified paginated audit trail (admin + accounting + auth)
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getUnifiedAuditLog } from '@/modules/admin/services/auditService';
import type { UnifiedAuditFilters } from '@/modules/admin/services/auditService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const {
        source,
        company_id,
        user_id,
        action,
        entity_type,
        search,
        from_date,
        to_date,
        page,
        limit,
      } = req.query;

      const filters: UnifiedAuditFilters = {
        source:      source      as UnifiedAuditFilters['source'],
        company_id:  company_id  as string | undefined,
        user_id:     user_id     as string | undefined,
        action:      action      as string | undefined,
        entity_type: entity_type as string | undefined,
        search:      search      as string | undefined,
        from_date:   from_date   as string | undefined,
        to_date:     to_date     as string | undefined,
        page:        page  ? Number(page)  : undefined,
        limit:       limit ? Number(limit) : undefined,
      };

      const result = await getUnifiedAuditLog(filters);
      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to get unified audit log', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to get audit log');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
