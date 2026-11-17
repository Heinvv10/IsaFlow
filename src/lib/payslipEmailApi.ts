/**
 * The HTTP side of payslip email (wave 6 PE; spec rules 11, 12, 14, 20).
 *
 * `payslipEmailActor` takes a write only from a person signed in as themselves: a token channel (claims with no
 * recorded session) is 403 AGENT_FORBIDDEN, as the payslip download route, and a platform admin's Login-as is 403
 * IMPERSONATION_FORBIDDEN (an outbound send is never made under another person's name). Judged before any read.
 *
 * `payslipEmailHandler(mailer, admit)` is the send route's handler, POST /api/payroll/runs/[id]/payslips/email, built around
 * the Mailer it is given: the page wraps it with `sendEmail`; the integration suite wraps the same handler, in the
 * same middleware, with a capture mailer. Nothing selects the mailer from the environment.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import type { CompanyAuthedRequest } from '@/lib/auth';
import { assertNotImpersonating, respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { currentSessionActor } from '@/lib/auth/impersonationSessions';
import { getClientIp } from '@/lib/rateLimit';
import { PayslipEmailRefusal } from '@/modules/accounting/services/payroll/payslipDeliveryRefusal';
import { SEND_LIMITS, sendPayslipEmails, type Mailer, type SendLimits } from '@/modules/accounting/services/payroll/payslipDeliveryService';
import { listRunDeliveries } from '@/modules/accounting/services/payroll/payslipDeliveryRecord';
import type { EmployeeEmailActor } from '@/modules/accounting/services/payroll/payrollEmployeeEmail';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The actor of a payslip-email write, or null once a refusal has been sent. */
export async function payslipEmailActor(req: NextApiRequest, res: NextApiResponse): Promise<EmployeeEmailActor | null> {
  const { user } = req as CompanyAuthedRequest;
  if ((await currentSessionActor()) === 'unknown') {
    apiResponse.error(res, ErrorCode.FORBIDDEN, 'Only a person signed in as themselves can do this; an agent or a job cannot.',
      { reason: 'AGENT_FORBIDDEN' });
    return null;
  }
  try {
    await assertNotImpersonating();
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return null;
    throw err;
  }
  const sessionId = typeof user.claims.session_id === 'string' ? user.claims.session_id : null;
  const agent = req.headers['user-agent'];
  return { userId: user.id, userEmail: user.email, ip: getClientIp(req), userAgent: typeof agent === 'string' ? agent : undefined, sessionId };
}

const CODE: Record<number, ErrorCode> = {
  403: ErrorCode.FORBIDDEN, 404: ErrorCode.NOT_FOUND, 409: ErrorCode.CONFLICT, 429: ErrorCode.RATE_LIMIT,
};

export function respondIfPayslipEmailRefused(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof PayslipEmailRefusal)) return false;
  apiResponse.error(res, CODE[err.status]!, err.message, { reason: err.reason });
  return true;
}

const Body = z.object({
  employeeIds: z.array(z.string().regex(UUID, 'employeeIds must be UUIDs')).min(1).max(500).optional(),
  resend: z.boolean().optional(),
}).strict().refine((b) => b.resend !== true || (b.employeeIds !== undefined && b.employeeIds.length <= SEND_LIMITS.maxSends), {
  // A resend names whom (at most one request's worth), or a caller looping on `remaining` would resend the same slips.
  message: `resend needs employeeIds (at most ${SEND_LIMITS.maxSends})`,
});

/** The send limit, charged for the recipients left after judging (the route supplies it: pages/api/…/email.ts). */
export type AdmitPayslipEmails = (req: NextApiRequest, companyId: string, count: number) => Promise<boolean>;

/**
 * GET: the run's deliveries at its current approval (payroll-detail roles). POST: send. `limits` is SEND_LIMITS in
 * the page route; a test may lower it.
 */
export function payslipEmailHandler(mailer: Mailer, admit: AdmitPayslipEmails, limits: SendLimits = SEND_LIMITS) {
  async function handler(req: NextApiRequest, res: NextApiResponse) {
    const { companyId, companyRole } = req as CompanyAuthedRequest;
    const runId = req.query.id;
    if (typeof runId !== 'string' || !UUID.test(runId)) return apiResponse.badRequest(res, 'id must be a UUID');
    if (req.method === 'GET') return apiResponse.success(res, await listRunDeliveries(companyId, runId));
    if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid request');
    const resend = parsed.data.resend === true;
    if (resend && !['owner', 'admin'].includes(companyRole)) {
      return apiResponse.forbidden(res, 'Only an owner or admin can send a payslip again.');
    }
    const actor = await payslipEmailActor(req, res);
    if (!actor) return;
    try {
      return apiResponse.success(res, await sendPayslipEmails({
        companyId, runId, employeeIds: parsed.data.employeeIds, resend, actor, mailer, limits,
        admit: (count) => admit(req, companyId, count),
      }));
    } catch (err) {
      if (respondIfLockTimeout(res, err) || respondIfPayslipEmailRefused(res, err)) return;
      throw err;
    }
  }
  return handler;
}
