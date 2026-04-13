/**
 * Audit Log Entity History API
 * GET /api/accounting/audit-log-entity?type=invoice&id=<uuid>
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { getEntityHistory } from '@/modules/accounting/services/core/auditTrailService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    try {
      const { type, id } = req.query;

      if (!type || !id) {
        return apiResponse.badRequest(res, 'type and id query params are required');
      }

      const items = await getEntityHistory(
        companyId,
        type as string,
        id as string,
      );

      return apiResponse.success(res, { items });
    } catch (err) {
      log.error('Failed to get entity history', { error: err }, 'audit-log-entity-api');
      return apiResponse.badRequest(res, 'Failed to get entity history');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

 
export default withCompany(withErrorHandler(withWriteAccess(handler)));
