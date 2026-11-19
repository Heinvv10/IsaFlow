/**
 * POST /api/payroll/emp501/returns/filing-file  { versionId, format: 'irp5' }  (wave 6 EFb)
 * The e@syFile IRP5 file of a finalised (or filed) EMP501 version, built from the version's stored figures, never the
 * live payroll; the first download stamps its sha256 on the version (999v), which marking it filed requires. The same
 * rules as EFa's /api/accounting/sars/returns/[form]/filing-file (downloadEmp501File), plus payroll-detail access: the
 * file carries ID and tax numbers. POST through withCsrf because it writes the stamp; GET is 405. No-store, in memory
 * only; nothing goes to SARS.
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
import { downloadEmp501File } from '@/modules/accounting/services/returns/emp501FilingFile';
import { respondReturnRefusal } from '@/modules/accounting/services/returns/respondRefusal';
import { ReturnRefusal } from '@/modules/accounting/services/returns/returnVersionTypes';

const Body = z.object({ versionId: UUID, format: z.literal('irp5').default('irp5') });

async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  if (!(await checkReportRateLimit(companyId, `emp501-filing-file:u:${userId}`, INTERACTIVE_REPORT_LIMIT))) {
    return apiResponse.tooManyRequests(res, 'Too many requests. Please try again shortly.');
  }
  try {
    const file = await downloadEmp501File(companyId, parsed.data.versionId, { userId, role: companyRole });
    log.info('EMP501 filing file downloaded', { companyId, versionId: parsed.data.versionId, stamped: file.stamped }, 'emp501-returns');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('X-Filing-File-Sha256', file.sha256);
    return res.status(200).send(file.body);
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (err instanceof ReturnRefusal) return respondReturnRefusal(res, err);
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));
