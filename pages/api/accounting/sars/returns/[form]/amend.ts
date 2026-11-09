/**
 * POST /api/accounting/sars/returns/[form]/amend  (form = vat201 | emp201)
 *   { versionId, reason }
 * Amends a finalised or filed return version (wave 5 L1b): owner/admin only, a reason is mandatory, Login-as is
 * refused. The version becomes superseded and a VAT201's own lock is released; finalise then creates the next version.
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
import { UUID } from '@/lib/schemas/common';
import { amendReturn } from '@/modules/accounting/services/returns/amendReturn';
import { respondReturnRefusal } from '@/modules/accounting/services/returns/respondRefusal';
import { returnFormOf } from '@/modules/accounting/services/returns/returnForm';
import { ReturnRefusal } from '@/modules/accounting/services/returns/returnVersionTypes';
import { VatPeriodLockRefusal } from '@/modules/accounting/services/reports/vatPeriodLockService';

const Body = z.object({
  versionId: UUID,
  // A blank or missing reason is the service's 400 (a schema failure would be a 422).
  reason: z.string().max(2000).default(''),
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
  try {
    const version = await amendReturn(companyId, form, parsed.data.versionId, parsed.data.reason, { userId, role: companyRole });
    log.info('Return amended', { companyId, form, versionId: version.id }, 'sars-returns');
    return apiResponse.success(res, { version });
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (err instanceof ReturnRefusal) return respondReturnRefusal(res, err);
    if (err instanceof VatPeriodLockRefusal) return apiResponse.badRequest(res, err.message);
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
