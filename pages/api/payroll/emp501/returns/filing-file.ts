/**
 * GET /api/payroll/emp501/returns/filing-file?versionId=  (wave 6 EFb)
 * The e@syFile IRP5 file of a finalised (or filed) EMP501 version, built from the version's stored figures, never the
 * live payroll; the first download stamps its sha256 on the version (999v), which marking it filed requires.
 * Payroll-detail roles only (the file carries ID and tax numbers), no-store, Login-as refused (it stamps who
 * generated the file). In memory only; nothing goes to SARS.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { assertNotImpersonating, respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import { emp501FileOf, stampEmp501File } from '@/modules/accounting/services/returns/emp501FilingFile';
import { getVersionForUpdate } from '@/modules/accounting/services/returns/returnVersionWrites';
import { respondReturnRefusal } from '@/modules/accounting/services/returns/respondRefusal';
import { ReturnRefusal } from '@/modules/accounting/services/returns/returnVersionTypes';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const id = UUID.safeParse(req.query.versionId);
  if (!id.success) return apiResponse.badRequest(res, 'versionId must be a UUID');
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  try {
    await assertNotImpersonating();
    // Row-locked: two first downloads stamp once.
    const v = await getVersionForUpdate(companyId, id.data);
    if (!v || v.formType !== 'EMP501') return apiResponse.notFound(res, 'Return version');
    const file = emp501FileOf(v);
    await stampEmp501File(companyId, v, file, userId);
    log.info('EMP501 filing file generated', { companyId, versionId: v.id, bytes: file.body.length }, 'emp501-returns');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('X-IsaFlow-File-Sha256', file.sha256);
    return res.status(200).send(file.body);
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (err instanceof ReturnRefusal) return respondReturnRefusal(res, err);
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));
