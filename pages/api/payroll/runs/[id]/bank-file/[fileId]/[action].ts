/**
 * POST /api/payroll/runs/[id]/bank-file/[fileId]/confirm  record that the bank accepted the file (wave 6 BF).
 * POST /api/payroll/runs/[id]/bank-file/[fileId]/void     void a generated file that was never sent.
 *
 * Owner / admin, a person's own session, never Login-as (payrollBankFileApi). Confirm writes only the file row: the
 * run stays `approved` and reopenable (spec 0a.17). Refusals are judged before the write (payrollBankFileConfirm).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withNoStore } from '@/lib/auth/withNoStore';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { bankFileWriter, respondIfBankFileRefused, UUID } from '@/lib/payrollBankFileApi';
import { settleBankFile } from '@/modules/accounting/services/payroll/payrollBankFileConfirm';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const { id: runId, fileId, action } = req.query;
  if (typeof runId !== 'string' || !UUID.test(runId)) return apiResponse.badRequest(res, 'id must be a UUID');
  if (typeof fileId !== 'string' || !UUID.test(fileId)) return apiResponse.badRequest(res, 'fileId must be a UUID');
  if (action !== 'confirm' && action !== 'void') return apiResponse.notFound(res, 'Bank file action');

  const actor = await bankFileWriter(req, res);
  if (!actor) return;
  try {
    return apiResponse.success(res, await settleBankFile({ companyId, runId, fileId, action, actor }));
  } catch (err) {
    if (respondIfLockTimeout(res, err) || respondIfBankFileRefused(res, err)) return;
    throw err;
  }
}

export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)))));
