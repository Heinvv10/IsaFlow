/**
 * POST /api/accounting/sars/returns/[form]/file  (form = vat201 | emp201)
 *   { versionId, reference, overrideReason? }
 * Marks a finalised return version filed (wave 5 L1b). VAT201 runs the blocking-exceptions gate (owner/admin may
 * override with a reason) and the manual markSubmitted in one savepoint with the version's move to filed; EMP201 has
 * no VAT gate. Every refusal lands before the first write, so a 4xx leaves no submission, override or version change.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { log } from '@/lib/logger';
import { checkReportRateLimit, INTERACTIVE_REPORT_LIMIT } from '@/lib/rateLimit';
import { UUID } from '@/lib/schemas/common';
import { markReturnFiled } from '@/modules/accounting/services/returns/fileReturn';
import { respondReturnRefusal } from '@/modules/accounting/services/returns/respondRefusal';
import { returnFormOf } from '@/modules/accounting/services/returns/returnForm';
import { ReturnRefusal } from '@/modules/accounting/services/returns/returnVersionTypes';
import { VatGateBlockedError, VatGateOverrideForbiddenError } from '@/modules/accounting/services/reports/vatGateOverrideService';

const Body = z.object({
  versionId: UUID,
  // A blank reference is the service's 400 (a schema failure would be a 422).
  reference: z.string().max(200).default(''),
  overrideReason: z.string().trim().min(1).max(2000).optional(),
  /** Needed when the period was already filed the legacy way (409 LEGACY_SUBMISSION_EXISTS names it). */
  correctsLegacySubmissionId: UUID.optional(),
  reason: z.string().max(2000).optional(),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  const form = returnFormOf(req.query.form);
  if (!form) return apiResponse.notFound(res, 'Return form');
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  if (!(await checkReportRateLimit(companyId, `return-file:u:${userId}`, INTERACTIVE_REPORT_LIMIT))) {
    return apiResponse.tooManyRequests(res, 'Too many requests. Please try again shortly.');
  }
  try {
    const out = await markReturnFiled(companyId, form, parsed.data.versionId, parsed.data.reference,
      { userId, role: companyRole },
      { overrideReason: parsed.data.overrideReason, correctsLegacySubmissionId: parsed.data.correctsLegacySubmissionId, reason: parsed.data.reason });
    log.info('Return filed', { companyId, form, versionId: out.version.id }, 'sars-returns');
    return apiResponse.success(res, out);
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (err instanceof ReturnRefusal) return respondReturnRefusal(res, err);
    if (err instanceof VatGateOverrideForbiddenError) return apiResponse.forbidden(res, err.message);
    if (err instanceof VatGateBlockedError) return apiResponse.badRequest(res, err.message, { counts: err.counts });
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
