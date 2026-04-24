/**
 * GET  /api/payroll/loans          - list loans (?status=, ?employeeId=)
 * POST /api/payroll/loans          - create a new loan + amortisation schedule
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  withCsrf,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import {
  createLoan,
  listLoans,
  type LoanMethod,
  type LoanStatus,
} from '@/modules/accounting/services/payroll/payrollLoanService';

const CreateBody = z
  .object({
    employeeId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, { message: "Invalid UUID" }),
    loanNumber: z.string().min(1).max(50),
    description: z.string().min(1).max(200),
    principal: z.number().positive(),
    annualInterestRate: z.number().nonnegative().max(2),
    termMonths: z.number().int().min(1).max(600),
    method: z.enum(['declining_balance', 'straight_line', 'interest_free']),
    startDate: z.string(),
    firstPeriodYear: z.number().int().min(2000).max(2100),
    firstPeriodMonth: z.number().int().min(1).max(12),
    notes: z.string().max(1000).optional(),
  })
  .strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const status = typeof req.query.status === 'string' ? (req.query.status as LoanStatus) : undefined;
    const employeeId = typeof req.query.employeeId === 'string' ? req.query.employeeId : undefined;
    const loans = await listLoans(companyId, { status, employeeId });
    return apiResponse.success(res, loans);
  }

  if (req.method === 'POST') {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
    }
    try {
      const loan = await createLoan({
        companyId,
        userId: user.id,
        employeeId: parsed.data.employeeId,
        loanNumber: parsed.data.loanNumber,
        description: parsed.data.description,
        principal: parsed.data.principal,
        annualInterestRate: parsed.data.annualInterestRate,
        termMonths: parsed.data.termMonths,
        method: parsed.data.method as LoanMethod,
        startDate: new Date(parsed.data.startDate),
        firstPeriodYear: parsed.data.firstPeriodYear,
        firstPeriodMonth: parsed.data.firstPeriodMonth,
        notes: parsed.data.notes,
      });
      return apiResponse.created(res, loan);
    } catch (err) {
      return apiResponse.badRequestFromError(res, err, 'Create failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
