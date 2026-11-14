/**
 * Payroll component (one)
 * PATCH /api/payroll/components/:id  { countsAsRfi: boolean } - switch "Counts as retirement-funding income" (wave 5 RF)
 *
 * Only that flag is editable here: the other flags decide how a component was taxed on runs already costed. The change is
 * audited, and a run calculated before it that costs a percentage of RFI must be recalculated before approval
 * (payrollComponentRfi, payrollRunRecalcGate). Every refusal is judged before the write.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { isUuidParam } from '@/lib/validation';
import { setComponentCountsAsRfi } from '@/modules/accounting/services/payroll/payrollComponentRfi';
import { EmployeeComponentRefused } from '@/modules/accounting/services/payroll/payrollEmployeeComponentRefused';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;
  const { id } = req.query;
  if (req.method !== 'PATCH') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PATCH']);
  if (typeof id !== 'string' || !isUuidParam(id)) return apiResponse.notFound(res, 'Payroll component');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const unknownKeys = Object.keys(body).filter((k) => k !== 'countsAsRfi');
  if (unknownKeys.length > 0) return apiResponse.badRequest(res, `Only countsAsRfi can be changed here (got ${unknownKeys.join(', ')})`);
  if (typeof body.countsAsRfi !== 'boolean') return apiResponse.badRequest(res, 'countsAsRfi must be true or false');
  try {
    const found = await setComponentCountsAsRfi(companyId, id, body.countsAsRfi, { userId: req.user.id, userEmail: req.user.email, channel: 'rest' });
    if (!found) return apiResponse.notFound(res, 'Payroll component');
    return apiResponse.success(res, { id, countsAsRfi: body.countsAsRfi });
  } catch (err) {
    if (err instanceof EmployeeComponentRefused) return apiResponse.badRequest(res, err.message);
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
