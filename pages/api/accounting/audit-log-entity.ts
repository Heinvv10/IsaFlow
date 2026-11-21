/**
 * Audit Log Entity History API
 * GET /api/accounting/audit-log-entity?type=invoice&id=<uuid>
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { mayReadPayroll } from '@/lib/auth/payrollReadGate';
import { refuseAuditPayrollType, singleQueryParam } from '@/modules/accounting/services/core/auditPayrollGate';
import { getEntityHistory } from '@/modules/accounting/services/core/auditTrailService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    try {
      const { type, id } = req.query;

      if (!type || !id) {
        return apiResponse.badRequest(res, 'type and id query params are required');
      }

      const typeOnce = singleQueryParam(res, 'type', type);
      if (typeOnce === null) return;
      const payrollRead = await mayReadPayroll(companyId, user.id);
      if (refuseAuditPayrollType(res, typeOnce, payrollRead)) return;
      const items = await getEntityHistory(
        companyId,
        typeOnce as string,
        id as string,
        payrollRead,
      );

      return apiResponse.success(res, { items });
    } catch (err) {
      log.error('Failed to get entity history', { error: err }, 'audit-log-entity-api');
      return apiResponse.badRequest(res, 'Failed to get entity history');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
