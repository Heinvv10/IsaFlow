/**
 * GET /api/payroll/settings/payslip-email  { platformEnabled, enabled }   payroll-detail roles
 * PUT /api/payroll/settings/payslip-email  { enabled: boolean }           owner / admin, own session, never Login-as
 *
 * The company switch for emailing payslips (wave 6 PE; payslipEmailSettings). The platform switch is read here and
 * never written: only a platform admin sets it (spec rule 20). Each change is audited; every response is no-store.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withNoStore } from '@/lib/auth/withNoStore';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { payslipEmailActor } from '@/lib/payslipEmailApi';
import { readPayslipEmailState, setPayslipEmailEnabled } from '@/modules/accounting/services/payroll/payslipEmailSettings';

const Body = z.object({ enabled: z.boolean() }).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  if (req.method === 'GET') return apiResponse.success(res, await readPayslipEmailState(companyId));
  if (req.method !== 'PUT') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
  if (!['owner', 'admin'].includes(companyRole)) {
    return apiResponse.forbidden(res, 'Only an owner or admin can turn payslip email on or off.');
  }
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, 'enabled must be true or false');
  const actor = await payslipEmailActor(req, res);
  if (!actor) return;
  return apiResponse.success(res, await setPayslipEmailEnabled(companyId, parsed.data.enabled, actor));
}

export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)))));
