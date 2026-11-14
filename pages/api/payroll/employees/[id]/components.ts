/**
 * Employee Component Assignment API
 * GET    /api/payroll/employees/:id/components          - List assignments
 * POST   /api/payroll/employees/:id/components          - Assign a component
 * PATCH  /api/payroll/employees/:id/components?aid=...  - Edit an assignment's dates (open or ended)
 * DELETE /api/payroll/employees/:id/components?aid=...  - End an assignment
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  assignComponentToEmployee,
  EmployeeComponentRefused,
  endEmployeeComponent,
  listEmployeeComponentAssignments,
} from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
import { updateEmployeeComponentDates } from '@/modules/accounting/services/payroll/payrollComponentDateEdit';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';

async function handler(
  req: AuthenticatedNextApiRequest,
  res: NextApiResponse,
): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;
  const { id } = req.query;

  if (typeof id !== 'string') {
    return apiResponse.badRequest(res, 'Invalid employee ID');
  }

  // GET — list all assignments for the employee
  if (req.method === 'GET') {
    const assignments = await listEmployeeComponentAssignments(companyId, id);
    return apiResponse.success(res, assignments);
  }

  // POST — assign a component to the employee
  if (req.method === 'POST') {
    const { componentId, amount, effectiveFrom, effectiveTo, isRecurring, percentOfRfi } = req.body as {
      componentId?: string;
      amount?: number;
      effectiveFrom?: string;
      effectiveTo?: string;
      isRecurring?: boolean;
      /** RF: a fraction of retirement-funding income (0.075 = 7.5%), with amount 0; judged by the service before the write. */
      percentOfRfi?: unknown;
    };

    if (!componentId) return apiResponse.badRequest(res, 'componentId is required');
    if (amount === undefined || amount === null) return apiResponse.badRequest(res, 'amount is required');
    if (!effectiveFrom) return apiResponse.badRequest(res, 'effectiveFrom is required');

    try {
      const assignment = await assignComponentToEmployee(
        companyId,
        id,
        componentId,
        Number(amount),
        effectiveFrom,
        effectiveTo || undefined,
        isRecurring !== false, // default true
        { userId: req.user.id, userEmail: req.user.email, channel: 'rest' },
        percentOfRfi === undefined || percentOfRfi === null ? null : (percentOfRfi as number),
      );
      res.status(201).json({ success: true, data: assignment });
      return;
    } catch (err) {
      if (err instanceof EmployeeComponentRefused) return apiResponse.badRequest(res, err.message);
      throw err;
    }
  }

  // PATCH — edit an assignment's dates: { effectiveFrom, effectiveTo | null } (null or '' = open-ended)
  if (req.method === 'PATCH') {
    const { aid } = req.query;
    const { effectiveFrom, effectiveTo } = (req.body ?? {}) as { effectiveFrom?: unknown; effectiveTo?: unknown };
    if (typeof aid !== 'string') return apiResponse.badRequest(res, 'aid (assignment ID) query param is required');
    if (typeof effectiveFrom !== 'string' || !effectiveFrom) return apiResponse.badRequest(res, 'effectiveFrom is required');
    if (effectiveTo !== undefined && effectiveTo !== null && typeof effectiveTo !== 'string') {
      return apiResponse.badRequest(res, 'effectiveTo must be a date or empty');
    }
    try {
      const changed = await updateEmployeeComponentDates(
        companyId, aid, effectiveFrom, effectiveTo ? effectiveTo : null, { userId: req.user.id, userEmail: req.user.email, channel: 'rest' },
      );
      if (!changed) return apiResponse.notFound(res, 'Component assignment');
      return apiResponse.success(res, { updated: aid });
    } catch (err) {
      if (err instanceof EmployeeComponentRefused) return apiResponse.badRequest(res, err.message);
      if (respondIfLockTimeout(res, err)) return;
      throw err;
    }
  }

  // DELETE — end an assignment (set effective_to)
  if (req.method === 'DELETE') {
    const { aid } = req.query;
    // cancel: void an assignment no paid run read (payrollComponentDateEdit); refused once one has.
    const { effectiveTo, cancel } = req.body as { effectiveTo?: string; cancel?: unknown };

    if (typeof aid !== 'string') return apiResponse.badRequest(res, 'aid (assignment ID) query param is required');
    if (!effectiveTo) return apiResponse.badRequest(res, 'effectiveTo is required');

    try {
      const ended = await endEmployeeComponent(companyId, aid, effectiveTo, {
        userId: req.user.id, userEmail: req.user.email, channel: 'rest',
      }, { cancel: cancel === true });
      if (!ended) return apiResponse.notFound(res, 'Component assignment');
    } catch (err) {
      if (err instanceof EmployeeComponentRefused) return apiResponse.badRequest(res, err.message);
      if (respondIfLockTimeout(res, err)) return;
      throw err;
    }
    return apiResponse.success(res, { ended: aid });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'PATCH', 'DELETE']);
}

// The URL names the employee, so a logged amount is what that person earns.
export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)), { maskBodyKeys: ['amount'] }));
