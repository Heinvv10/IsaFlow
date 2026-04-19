/**
 * Employee Component Assignment API
 * GET    /api/payroll/employees/:id/components          - List assignments
 * POST   /api/payroll/employees/:id/components          - Assign a component
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
  endEmployeeComponent,
  listEmployeeComponentAssignments,
} from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';

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
    const { componentId, amount, effectiveFrom, effectiveTo } = req.body as {
      componentId?: string;
      amount?: number;
      effectiveFrom?: string;
      effectiveTo?: string;
    };

    if (!componentId) return apiResponse.badRequest(res, 'componentId is required');
    if (amount === undefined || amount === null) return apiResponse.badRequest(res, 'amount is required');
    if (!effectiveFrom) return apiResponse.badRequest(res, 'effectiveFrom is required');

    const assignment = await assignComponentToEmployee(
      companyId,
      id,
      componentId,
      Number(amount),
      new Date(effectiveFrom),
      effectiveTo ? new Date(effectiveTo) : undefined,
    );

    res.status(201).json({ success: true, data: assignment });
    return;
  }

  // DELETE — end an assignment (set effective_to)
  if (req.method === 'DELETE') {
    const { aid } = req.query;
    const { effectiveTo } = req.body as { effectiveTo?: string };

    if (typeof aid !== 'string') return apiResponse.badRequest(res, 'aid (assignment ID) query param is required');
    if (!effectiveTo) return apiResponse.badRequest(res, 'effectiveTo is required');

    await endEmployeeComponent(companyId, aid, new Date(effectiveTo));
    return apiResponse.success(res, { ended: aid });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
