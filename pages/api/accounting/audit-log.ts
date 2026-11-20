/**
 * Audit Log API
 * GET /api/accounting/audit-log — List audit entries with filters and pagination
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { mayReadPayroll } from '@/lib/auth/payrollReadGate';
import { refuseAuditPayrollType } from '@/modules/accounting/services/core/auditPayrollGate';
import { getAuditLog } from '@/modules/accounting/services/core/auditTrailService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

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

      // Payroll entity types (an employee's email, a directive, a garnishee order ...) are Payroll's: left out of the rows and the count
      // without Payroll read, and asking for one by name is a 403 (#1656 round 8).
      const payrollRead = await mayReadPayroll(companyId, user.id);
      if (refuseAuditPayrollType(res, entity_type, payrollRead)) return;
      const result = await getAuditLog(companyId, {
        payrollRead,
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

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
