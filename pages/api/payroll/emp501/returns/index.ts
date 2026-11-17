/**
 * The EMP501 return lifecycle (wave 6 EFb). Payroll-detail roles only, no-store: a version's certificates carry ID
 * and tax numbers, so they are never sent, only totals and warnings.
 *
 * The shapes follow /api/accounting/sars/returns/[form]/* so the shared lifecycle bar drives both
 * (returnLifecycleClient); the period is the interim (1 March to 31 August) or the annual one (1 March to February end).
 *
 * GET  ?periodStart=&periodEnd=  every version with its drift, and what blocks a finalise (pre-validation errors,
 *      unfiled EMP201 months).
 * POST { action: 'finalise', periodStart, periodEnd }          finaliseReturn (refused 409 EMP501_NOT_READY first).
 * POST { action: 'file', versionId, reference, correctsLegacySubmissionIds?, reason? }
 *      markReturnFiled: the sars_submissions EMP501 row and the version's move to filed (owner/admin, Login-as refused).
 * POST { action: 'amend', versionId, reason }                  amendReturn (owner/admin, a reason, Login-as refused).
 * Every refusal lands before the first write.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { log } from '@/lib/logger';
import { checkReportRateLimit, INTERACTIVE_REPORT_LIMIT } from '@/lib/rateLimit';
import { UUID } from '@/lib/schemas/common';
import { emp501PeriodOf } from '@/modules/accounting/services/payroll/emp501Period';
import { finaliseReturn } from '@/modules/accounting/services/returns/finaliseReturn';
import { markReturnFiled } from '@/modules/accounting/services/returns/fileReturn';
import { amendReturn } from '@/modules/accounting/services/returns/amendReturn';
import { listVersions, type ReturnVersionView } from '@/modules/accounting/services/returns/returnDrift';
import { emp501Readiness } from '@/modules/accounting/services/returns/emp501Readiness';
import { respondReturnRefusal } from '@/modules/accounting/services/returns/respondRefusal';
import { ReturnRefusal, type ReturnVersion } from '@/modules/accounting/services/returns/returnVersionTypes';

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');
const Query = z.object({ periodStart: ISO_DATE, periodEnd: ISO_DATE });
const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('finalise'), periodStart: ISO_DATE, periodEnd: ISO_DATE }),
  z.object({
    action: z.literal('file'), versionId: UUID, reference: z.string().max(200).default(''),
    correctsLegacySubmissionIds: z.array(UUID).max(50).optional(), reason: z.string().max(2000).optional(),
  }),
  z.object({ action: z.literal('amend'), versionId: UUID, reason: z.string().max(2000).default('') }),
]);

/** A version with its totals, warnings and run count only: never the certificates or the employer record. */
function summary<T extends ReturnVersion>(v: T): T {
  const f = v.figures as { taxYear?: number; kind?: string; totals?: Record<string, unknown>; warnings?: unknown; runs?: unknown };
  return {
    ...v,
    figures: {
      taxYear: f.taxYear, kind: f.kind, ...(f.totals ?? {}), warnings: Array.isArray(f.warnings) ? f.warnings : [],
      runs: Array.isArray(f.runs) ? f.runs.length : 0,
    },
  };
}

async function get(req: NextApiRequest, res: NextApiResponse, companyId: string) {
  const q = Query.safeParse(req.query);
  if (!q.success) return apiResponse.validationError(res, q.error.flatten().fieldErrors as Record<string, string[]>);
  const p = emp501PeriodOf(q.data.periodStart, q.data.periodEnd);
  if (!p) return apiResponse.badRequest(res, 'The period is not an EMP501 period (1 March to 31 August, or to the end of February).');
  const readiness = await emp501Readiness(companyId, p);
  const { versions } = await listVersions(companyId, 'EMP501', p.start, p.end);
  return apiResponse.success(res, { versions: versions.map((v: ReturnVersionView) => summary(v)), vatReturn: null, readiness });
}

async function post(req: NextApiRequest, res: NextApiResponse, companyId: string, role: string) {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const actor = { userId, role };
  const b = parsed.data;
  if (!(await checkReportRateLimit(companyId, `emp501-${b.action}:u:${userId}`, INTERACTIVE_REPORT_LIMIT))) {
    return apiResponse.tooManyRequests(res, 'Too many requests. Please try again shortly.');
  }
  if (b.action === 'finalise') {
    const { version } = await finaliseReturn(companyId, 'EMP501', b.periodStart, b.periodEnd, actor);
    log.info('EMP501 finalised', { companyId, versionId: version.id }, 'emp501-returns');
    return apiResponse.success(res, { version: summary(version) });
  }
  if (b.action === 'file') {
    const out = await markReturnFiled(companyId, 'EMP501', b.versionId, b.reference, actor,
      { correctsLegacySubmissionIds: b.correctsLegacySubmissionIds, reason: b.reason });
    log.info('EMP501 filed', { companyId, versionId: out.version.id }, 'emp501-returns');
    return apiResponse.success(res, { version: summary(out.version), submissionId: out.submission.id });
  }
  const version = await amendReturn(companyId, 'EMP501', b.versionId, b.reason, actor);
  log.info('EMP501 amended', { companyId, versionId: version.id }, 'emp501-returns');
  return apiResponse.success(res, { version: summary(version) });
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  try {
    if (req.method === 'GET') return await get(req, res, companyId);
    if (req.method === 'POST') return await post(req, res, companyId, companyRole);
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (err instanceof ReturnRefusal) return respondReturnRefusal(res, err);
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));
