/**
 * GET /api/accounting/sars/return-drill — what is behind one field of a SARS return.
 *   ?return=vat201&field=<1|1A|2|...|20>&from=YYYY-MM-DD&to=YYYY-MM-DD[&page=&pageSize=]
 *   ?return=emp201&field=<paye|eti|uif|sdl|remuneration>&from=&to=[&runId=&page=&pageSize=]
 *
 * VAT201 fields follow the SARS layout (vat201FieldDrill). EMP201 is per employee per
 * run, so it is payroll-detail roles only (a viewer gets VAT, not EMP201), a person's
 * own session only (a token channel is 403 AGENT_FORBIDDEN), and no-store. Read-only;
 * every query is scoped to the caller's company, so another company's run id is a 404.
 * Rate-limited per user; page size at most 200.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { canWrite } from '@/lib/auth/writeRoles';
import { withNoStore } from '@/lib/auth/withNoStore';
import { assertNotImpersonating, respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { currentSessionActor } from '@/lib/auth/impersonationSessions';
import { log } from '@/lib/logger';
import { checkReportRateLimit, INTERACTIVE_REPORT_LIMIT } from '@/lib/rateLimit';
import { reportWindowProblem } from '@/lib/validation';
import { NO_PAYROLL_DETAIL_ACCESS } from '@/lib/payrollDetailAccess';
import { emp201FieldDrill, isEmp201DrillField } from '@/modules/accounting/services/reports/emp201FieldDrill';
import { MAX_DRILL_PAGE_SIZE } from '@/modules/accounting/services/reports/drillPaging';
import { vat201FieldDrill } from '@/modules/accounting/services/reports/vat201FieldDrill';

const MAX_WINDOW_DAYS = 400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function intParam(v: unknown, fallback: number, max: number): number | null {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !/^\d{1,6}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= max ? n : null;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId, user, companyRole } = req as CompanyAuthedRequest;
  const { return: ret, field, from, to, runId } = req.query;
  if (ret !== 'vat201' && ret !== 'emp201') return apiResponse.badRequest(res, 'return must be vat201 or emp201');
  if (typeof field !== 'string') return apiResponse.badRequest(res, 'field is required');
  if (typeof from !== 'string' || typeof to !== 'string') return apiResponse.badRequest(res, 'from and to are required (YYYY-MM-DD)');
  const windowProblem = reportWindowProblem(from, to);
  if (windowProblem) return apiResponse.badRequest(res, windowProblem);
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_WINDOW_DAYS) {
    return apiResponse.badRequest(res, `The window must not exceed ${MAX_WINDOW_DAYS} days`);
  }
  const page = intParam(req.query.page, 1, 100000);
  const pageSize = intParam(req.query.pageSize, 100, MAX_DRILL_PAGE_SIZE);
  if (page === null || pageSize === null) {
    return apiResponse.badRequest(res, `page and pageSize must be positive integers (pageSize at most ${MAX_DRILL_PAGE_SIZE})`);
  }
  if (runId !== undefined && (typeof runId !== 'string' || !UUID.test(runId))) {
    return apiResponse.badRequest(res, 'runId must be a UUID');
  }

  if (ret === 'emp201') {
    if (!canWrite(companyRole)) return apiResponse.forbidden(res, NO_PAYROLL_DETAIL_ACCESS);
    if ((await currentSessionActor()) === 'unknown') {
      return apiResponse.error(res, ErrorCode.FORBIDDEN, 'Only a person signed in as themselves can read payroll detail; an agent or a job cannot.',
        { reason: 'AGENT_FORBIDDEN' });
    }
    // Per-employee pay for everyone: refused under a platform admin's Login-as, as the payslip export is.
    try {
      await assertNotImpersonating();
    } catch (err) {
      if (respondIfImpersonationForbidden(res, err)) return;
      throw err;
    }
  }
  if (!(await checkReportRateLimit(companyId, `return-drill:${ret}:u:${user.id}`, INTERACTIVE_REPORT_LIMIT))) {
    log.warn('Return drill rate limit exceeded', { companyId, userId: user.id, ret }, 'return-drill');
    return apiResponse.tooManyRequests(res, 'Too many requests. Please try again shortly.');
  }

  if (ret === 'vat201') {
    const drill = await vat201FieldDrill(companyId, from, to, field, page, pageSize);
    return drill ? apiResponse.success(res, drill) : apiResponse.notFound(res, 'VAT201 field');
  }
  if (!isEmp201DrillField(field)) return apiResponse.notFound(res, 'EMP201 field');
  const drill = await emp201FieldDrill(companyId, from, to, field, { runId, page, pageSize });
  return drill ? apiResponse.success(res, drill) : apiResponse.notFound(res, 'Payroll run');
}

export default withAuth(withNoStore(withErrorHandler(handler)));
