/**
 * Payroll READ for a route that is not under pages/api/payroll but returns one person's pay (the EMP201 drill and its versions, the
 * EMP201 breakdown, the natural-language query over payslips / employees): canWrite alone is not enough, because a manager whose Payroll
 * read is unticked, or whose Approve is withheld (a former accountant / bookkeeper), must not see per-employee pay (#1656, round 6).
 * The same question withPayrollDetailAccess asks, from the database through checkPermission. tests/unit/auth/payrollModuleCensus.test.ts
 * fails on a route outside pages/api/payroll that reads those tables without it.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { NO_PAYROLL_DETAIL_ACCESS } from '@/lib/payrollDetailAccess';
import { checkPermission } from './permissionService';

export function mayReadPayroll(companyId: string, userId: string): Promise<boolean> {
  return checkPermission(companyId, userId, 'payroll', 'read');
}

/** Answers 403 and returns true when the person may not read Payroll. */
export async function refuseWithoutPayrollRead(res: NextApiResponse, companyId: string, userId: string): Promise<boolean> {
  if (await mayReadPayroll(companyId, userId)) return false;
  apiResponse.forbidden(res, NO_PAYROLL_DETAIL_ACCESS);
  return true;
}

/** Answers 403 and returns true when the person may not WRITE Payroll (the same answer withPayrollModule gives a non-read request). */
export async function refuseWithoutPayrollWrite(res: NextApiResponse, companyId: string, userId: string): Promise<boolean> {
  if (await checkPermission(companyId, userId, 'payroll', 'write')) return false;
  apiResponse.forbidden(res, 'Your permissions do not include Payroll write. An owner or admin can grant it in User Access.');
  return true;
}
