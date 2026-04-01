/**
 * Audit Log API
 * GET /api/accounting/audit-log — List audit entries with filters and pagination
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getAuditLog } from '@/modules/accounting/services/auditTrailService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    try {
      const {
        entity_type,
        entity_id,
        user_id,
        action,
        date_from,
        date_to,
        search,
        limit,
        offset,
      } = req.query;

      const result = await getAuditLog(companyId, {
        entityType: entity_type as string | undefined,
        entityId: entity_id as string | undefined,
        userId: user_id as string | undefined,
        action: action as string | undefined,
        dateFrom: date_from as string | undefined,
        dateTo: date_to as string | undefined,
        search: search as string | undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });

      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to get audit log', { error: err }, 'audit-log-api');
      return apiResponse.internalError(res, err, 'Failed to get audit log');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
