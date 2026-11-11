/**
 * POST /api/accounting/sars/returns/[form]/finalise  (form = vat201 | emp201)
 *   { periodStart, periodEnd, overrideReason?, force?, acknowledgeVatReturnMismatch?, mismatchReason? }
 * Finalises the return for the period (wave 5 L1a): VAT201 locks the period through the same
 * gates as /vat-period-locks; EMP201 is refused unless every pay run it sums is final under
 * R-035. Every refusal lands before the first write, and the whole finalise runs in a savepoint,
 * so a 4xx leaves no lock, no override row and no version.
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
import { finaliseReturn, ReturnRefusal } from '@/modules/accounting/services/returns/finaliseReturn';
import { VatPeriodLockRefusal } from '@/modules/accounting/services/reports/vatPeriodLockService';
import {
  VatGateBlockedError, VatGateOverrideForbiddenError,
} from '@/modules/accounting/services/reports/vatGateOverrideService';
import { respondReturnRefusal } from '@/modules/accounting/services/returns/respondRefusal';
import { returnFormOf } from '@/modules/accounting/services/returns/returnForm';

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');
const Body = z.object({
  periodStart: ISO_DATE,
  periodEnd: ISO_DATE,
  overrideReason: z.string().trim().min(1).max(2000).optional(),
  force: z.boolean().optional(),
  /** VAT201: proceed although a submitted vat_returns row disagrees; needs a reason, kept on the version. */
  acknowledgeVatReturnMismatch: z.boolean().optional(),
  mismatchReason: z.string().trim().min(1).max(2000).optional(),
}).refine((b) => b.acknowledgeVatReturnMismatch !== true || b.mismatchReason !== undefined,
  { message: 'mismatchReason is required with acknowledgeVatReturnMismatch', path: ['mismatchReason'] });

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
  const { periodStart, periodEnd, overrideReason, force, acknowledgeVatReturnMismatch, mismatchReason } = parsed.data;
  try {
    const { version, vatReturn } = await finaliseReturn(companyId, form, periodStart, periodEnd,
      { userId, role: companyRole },
      {
        overrideReason, force,
        acknowledgeVatReturnMismatch: acknowledgeVatReturnMismatch && mismatchReason ? { reason: mismatchReason } : undefined,
      });
    log.info('Return finalised', { companyId, form, versionId: version.id }, 'sars-returns');
    return apiResponse.success(res, { version, vatReturn });
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (err instanceof ReturnRefusal) return respondReturnRefusal(res, err);
    if (err instanceof VatGateOverrideForbiddenError) return apiResponse.forbidden(res, err.message);
    if (err instanceof VatGateBlockedError) return apiResponse.badRequest(res, err.message, { counts: err.counts });
    if (err instanceof VatPeriodLockRefusal) return apiResponse.badRequest(res, err.message);
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
