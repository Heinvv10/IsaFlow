/**
 * GET /api/payroll/runs/[id]/explanation?employeeId=
 * How one employee's PAYE, UIF, SDL and ETI on this run were calculated (wave 5 EX-core), as the line stored it
 * (payroll_run_lines.explanation, migration 973). Nothing is recomputed.
 *
 * Who: payroll-detail roles only (owner / admin / manager), a person's own session (a token channel is 403
 * AGENT_FORBIDDEN, as the payslips route refuses it); a Login-as may read it, one employee at a time, and each such read
 * writes an audit_log row (export, payroll_explanation) naming the platform admin behind it, in the request transaction.
 * Another company's run, a cancelled run, or an employee not on the run is 404. Every response is
 * `Cache-Control: no-store`.
 *
 * 200 { state: 'recorded', final, explanations } or { state: 'not_recorded', final, costedAt, recordedFrom }: a line
 * costed before explanations has none (the UI asks a draft to be recalculated; a final run says when recording began).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { withNoStore } from '@/lib/auth/withNoStore';
import { currentSessionActor, impersonationPartiesOf } from '@/lib/auth/impersonationSessions';
import { getClientIp } from '@/lib/rateLimit';
import {
  auditImpersonatedExplanationRead, getLineExplanation, LineExplanationNotFound,
} from '@/modules/accounting/services/payroll/payrollLineExplanation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const { id: runId, employeeId } = req.query;
  if (typeof runId !== 'string' || !UUID.test(runId)) return apiResponse.badRequest(res, 'id must be a UUID');
  if (typeof employeeId !== 'string' || !UUID.test(employeeId)) return apiResponse.badRequest(res, 'employeeId must be a UUID');

  const actor = await currentSessionActor();
  if (actor === 'unknown') {
    return apiResponse.error(res, ErrorCode.FORBIDDEN, 'Only a person signed in as themselves can read payroll calculations; an agent or a job cannot.',
      { reason: 'AGENT_FORBIDDEN' });
  }
  try {
    const read = await getLineExplanation(companyId, runId, employeeId);
    if (actor === 'impersonation') {
      const sessionId = typeof user.claims.session_id === 'string' ? user.claims.session_id : null;
      const parties = sessionId ? await impersonationPartiesOf(sessionId) : null;
      // currentSessionActor just found this session recorded; a vanished row is a failure, not an anonymous read.
      if (!parties) throw new Error('Login-as session has no recorded admin');
      await auditImpersonatedExplanationRead({
        companyId, runId, employeeId, impersonatorUserId: parties.actorUserId,
        actor: { userId: user.id, userEmail: user.email, ip: getClientIp(req), userAgent: req.headers['user-agent'], sessionId },
      });
    }
    return apiResponse.success(res, read);
  } catch (err) {
    if (err instanceof LineExplanationNotFound) return apiResponse.notFound(res, 'Pay run line');
    throw err;
  }
}

export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)))));
