/**
 * Admin Audit Log API
 * GET /api/admin/audit — Unified paginated audit trail (admin + accounting + auth)
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { adminOptionalDate, adminOptionalUuid, adminPaging } from '@/modules/admin/middleware/adminRequestErrors';
import { apiResponse } from '@/lib/apiResponse';
import { getUnifiedAuditLog } from '@/modules/admin/services/auditService';
import type { UnifiedAuditFilters } from '@/modules/admin/services/auditService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const {
      source,
      company_id,
      user_id,
      action,
      entity_type,
      entity_id,
      search,
      from_date,
      to_date,
      page,
      limit,
    } = req.query;

    // One entity's entries: a present entity_id must be one non-empty value (WP13 review L1).
    if (entity_id !== undefined && (typeof entity_id !== 'string' || entity_id.trim() === '')) {
      return apiResponse.badRequest(res, 'entity_id must be a single non-empty value');
    }

    const filters: UnifiedAuditFilters = {
      source:      source      as UnifiedAuditFilters['source'],
      company_id:  adminOptionalUuid(company_id, 'company_id'),
      user_id:     user_id     as string | undefined,
      action:      action      as string | undefined,
      entity_type: entity_type as string | undefined,
      entity_id:   entity_id   as string | undefined,
      search:      search      as string | undefined,
      from_date:   adminOptionalDate(from_date, 'from_date'),
      to_date:     adminOptionalDate(to_date, 'to_date'),
      ...adminPaging({ page, limit }),
    };

    const result = await getUnifiedAuditLog(filters);
    return apiResponse.success(res, result);
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

export default withAdmin(handler);
