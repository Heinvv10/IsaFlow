/**
 * POST /api/payroll/runs/[id]/mark-paid  { reference?: string, paidOn?: 'YYYY-MM-DD' }
 *
 * Marks an approved pay run paid (wave 7 MP, W27; Hein rulings 4 and 16). Send NEITHER field to mark it paid by its
 * confirmed salary bank file (the file's action date is the payment date), or BOTH to record a bank payment made
 * another way: its reference (1-64 characters) and the payment date (not before the approval day, not after today).
 *
 * The roles that approve and reopen a run (owner, admin, manager) holding Payroll Approve, never under Login-as. Every
 * refusal is judged before the one write (payrollRunMarkPaid) and answered with `details.reason`; anything else is a
 * 500, which rolls the request back.
 */
import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, withCsrf, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { withPayrollModule } from '@/lib/auth/withPayrollModule';
import { getClientIp } from '@/lib/rateLimit';
import { refuseWithoutApprove } from '@/modules/accounting/services/core/approvePermissionResponse';
import { markPayrollRunPaid } from '@/modules/accounting/services/payroll/payrollRunMarkPaid';
import { PayrollRunMarkPaidRefusal } from '@/modules/accounting/services/payroll/payrollRunMarkPaidJudge';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Body = z.object({ reference: z.string().max(200).optional(), paidOn: z.string().max(20).optional() }).strict();
const CODE: Record<400 | 404 | 409, ErrorCode> = { 400: ErrorCode.BAD_REQUEST, 404: ErrorCode.NOT_FOUND, 409: ErrorCode.CONFLICT };

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const { companyId, companyRole, user } = req as CompanyAuthedRequest;
  const id = req.query.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return apiResponse.badRequest(res, 'Invalid payroll run ID');
  if (!['owner', 'admin', 'manager'].includes(companyRole)) {
    return apiResponse.forbidden(res, 'Only owners, admins and managers can mark a payroll run paid');
  }
  // Marking paid ends what a reopen could undo, so it takes Payroll Approve too (#1656), before the run is read.
  if (await refuseWithoutApprove(res, companyId, user.id, 'payroll', 'pay runs (mark paid)')) return;
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) return apiResponse.badRequest(res, 'Send a bank payment reference and payment date, or neither (to use the confirmed bank file).');

  const agent = req.headers['user-agent'];
  try {
    const result = await markPayrollRunPaid({
      companyId, runId: id, reference: parsed.data.reference, paidOn: parsed.data.paidOn,
      actor: {
        userId: user.id, userEmail: user.email, ip: getClientIp(req), userAgent: typeof agent === 'string' ? agent : undefined,
        sessionId: typeof user.claims.session_id === 'string' ? user.claims.session_id : null,
      },
    });
    return apiResponse.success(res, result);
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (respondIfLockTimeout(res, err)) return;
    if (err instanceof PayrollRunMarkPaidRefusal) return apiResponse.error(res, CODE[err.status], err.message, { reason: err.reason });
    throw err;
  }
}

export default withAuth(withErrorHandler(withPayrollModule(withCsrf(withWriteAccess(handler)))));
