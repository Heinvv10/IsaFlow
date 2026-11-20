/** 403 for a request that names a payroll audit entity type by name without Payroll read (#1656 round 8); the unnamed rows are filtered in SQL. */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { NO_PAYROLL_DETAIL_ACCESS } from '@/lib/payrollDetailAccess';
import { PAYROLL_AUDIT_ENTITY_TYPES } from './auditPayrollTypes';

/** Answers 403 and returns true when `entityType` is a payroll audit type and the person has no Payroll read. */
export function refuseAuditPayrollType(res: NextApiResponse, entityType: unknown, payrollRead: boolean): boolean {
  if (payrollRead || typeof entityType !== 'string' || !PAYROLL_AUDIT_ENTITY_TYPES.includes(entityType)) return false;
  apiResponse.forbidden(res, NO_PAYROLL_DETAIL_ACCESS);
  return true;
}
