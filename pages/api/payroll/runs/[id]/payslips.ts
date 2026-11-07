/**
 * GET /api/payroll/runs/[id]/payslips?employeeId=&disposition=inline|attachment
 * The run's payslips as one PDF (wave 4 PS): one employee's with `employeeId`, every
 * employee's without it. From the stored lines (payslipModel); DRAFT unless the R-035
 * guard clears the run.
 *
 * Who: payroll-detail roles only (owner / admin / manager). A person's own session only:
 * a token channel (claims with no session id) is 403 AGENT_FORBIDDEN. A platform-admin
 * Login-as may read ONE employee's payslip; the all-employees export is refused under it
 * (403 IMPERSONATION_FORBIDDEN, assertNotImpersonating), before any read or record.
 * Another company's run, or an employee not on it, is 404.
 *
 * Every response is `Cache-Control: no-store`. The PDF is rendered in memory and sent;
 * nothing is written to disk. Every download writes one audit_log `export` row in the
 * request transaction, so it commits with the response (withAuth commits before flush).
 * The row carries the session id and, under Login-as, the platform admin behind it.
 * A cancelled run is 404, as the history hides it.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { withNoStore } from '@/lib/auth/withNoStore';
import { assertNotImpersonating, respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { currentSessionActor, impersonationPartiesOf } from '@/lib/auth/impersonationSessions';
import { log } from '@/lib/logger';
import { checkReportRateLimit, getClientIp, INTERACTIVE_REPORT_LIMIT } from '@/lib/rateLimit';
import { getPayslips, PayslipNotFound } from '@/modules/accounting/services/payroll/payslipModel';
import { buildPayslipPdf, payslipFilename } from '@/modules/accounting/services/payroll/payslipPdf';
import { auditPayslipDownload } from '@/modules/accounting/services/payroll/payslipHistory';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const runId = req.query.id;
  if (typeof runId !== 'string' || !UUID.test(runId)) return apiResponse.badRequest(res, 'id must be a UUID');
  const { employeeId, disposition = 'attachment' } = req.query;
  if (disposition !== 'inline' && disposition !== 'attachment') {
    return apiResponse.badRequest(res, 'disposition must be inline or attachment');
  }
  if (employeeId !== undefined && (typeof employeeId !== 'string' || !UUID.test(employeeId))) {
    return apiResponse.badRequest(res, 'employeeId must be a UUID');
  }

  const actor = await currentSessionActor();
  if (actor === 'unknown') {
    return apiResponse.error(res, ErrorCode.FORBIDDEN, 'Only a person signed in as themselves can download payslips; an agent or a job cannot.',
      { reason: 'AGENT_FORBIDDEN' });
  }
  if (employeeId === undefined) {
    try {
      await assertNotImpersonating();
    } catch (err) {
      if (respondIfImpersonationForbidden(res, err)) return;
      throw err;
    }
  }

  if (!(await checkReportRateLimit(companyId, `payslips:u:${user.id}`, INTERACTIVE_REPORT_LIMIT))) {
    log.warn('Payslip rate limit exceeded', { companyId, userId: user.id }, 'payslips');
    return apiResponse.tooManyRequests(res, 'Too many payslip requests. Please try again shortly.');
  }

  const sessionId = typeof user.claims.session_id === 'string' ? user.claims.session_id : null;
  let impersonatorUserId: string | null = null;
  if (actor === 'impersonation') {
    const parties = sessionId ? await impersonationPartiesOf(sessionId) : null;
    // currentSessionActor just found this session recorded; a vanished row is a failure, not an anonymous download.
    if (!parties) throw new Error('Login-as session has no recorded admin');
    impersonatorUserId = parties.actorUserId;
  }

  try {
    const run = await getPayslips(companyId, runId, employeeId ? [employeeId] : undefined);
    const pdf = await buildPayslipPdf(run);
    await auditPayslipDownload({
      companyId, runId, employeeIds: run.payslips.map((p) => p.employeeId), final: run.final,
      impersonated: actor === 'impersonation', disposition, impersonatorUserId,
      actor: { userId: user.id, userEmail: user.email, ip: getClientIp(req), userAgent: req.headers['user-agent'], sessionId },
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="${payslipFilename(run, employeeId ? run.payslips[0]?.employeeNumber : undefined)}"`);
    res.setHeader('Content-Length', pdf.length);
    return res.status(200).send(pdf);
  } catch (err) {
    if (err instanceof PayslipNotFound) return apiResponse.notFound(res, 'Payslip');
    throw err;
  }
}

export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)))));
