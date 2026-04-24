/**
 * POST /api/payroll/runs/[id]/reopen
 *
 * Body: { reason: string }
 *
 * Transitions an approved payroll run back to 'calculated' so it can be
 * recalculated and re-approved. Logged with the actor + reason.
 *
 * NOTE: this only flips status — the GL journal posted at approval is NOT
 * reversed automatically. If the period also needs the journal reversed
 * the user must do that explicitly via the GL.
 *
 * Paid runs cannot be reopened (payments have moved). Cancelled runs
 * cannot be reopened either — create a fresh run for the period.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  withCsrf,
  withWriteAccess,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { reopenPayrollRun } from '@/modules/accounting/services/payroll/payrollRunLock';
import { log } from '@/lib/logger';

const Body = z.object({ reason: z.string().min(5).max(500) }).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId, companyRole, user } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing run id');

  // Only owners / admins / managers can reopen — same gate as approve.
  // withAuth sets the per-company role on req.companyRole (not on user);
  // the original user.role check left this permanently stuck at forbidden.
  if (!['owner', 'admin', 'manager'].includes(companyRole)) {
    return apiResponse.forbidden(res, 'Only owners, admins, and managers can reopen a payroll run');
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Reason is required (≥ 5 characters)');
  }

  try {
    const result = await reopenPayrollRun({
      runId: id,
      companyId,
      userId: user.id,
      reason: parsed.data.reason,
    });
    log.info('Payroll run reopened via API', {
      runId: id, companyId, userId: user.id, reason: parsed.data.reason, previousStatus: result.previousStatus,
    }, 'payroll-api');
    return apiResponse.success(res, result);
  } catch (err) {
    return apiResponse.badRequestFromError(res, err, 'Reopen failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
