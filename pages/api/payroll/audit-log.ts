/**
 * Payroll Audit Log API
 * GET /api/payroll/audit-log?entityType=employee&entityId=<uuid>&limit=100
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  listAuditEntries,
  type AuditEntityType,
} from '@/modules/payroll/payrollAuditService';

const VALID_TYPES: AuditEntityType[] = ['employee', 'pay_structure', 'payroll_run'];

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { entityType, entityId, limit } = req.query;
  const parsedType =
    typeof entityType === 'string' && VALID_TYPES.includes(entityType as AuditEntityType)
      ? (entityType as AuditEntityType)
      : undefined;
  const parsedId = typeof entityId === 'string' ? entityId : undefined;
  const parsedLimit = typeof limit === 'string' ? Number(limit) : undefined;

  try {
    const entries = await listAuditEntries(req.companyId, {
      entityType: parsedType,
      entityId: parsedId,
      limit: parsedLimit,
    });
    return apiResponse.success(res, { entries });
  } catch (err) {
    log.error('audit-log GET failed', { error: err }, 'payroll-api');
    return apiResponse.internalError(res, err, 'Failed to fetch audit log');
  }
}

export default withCompany(withErrorHandler(handler));
