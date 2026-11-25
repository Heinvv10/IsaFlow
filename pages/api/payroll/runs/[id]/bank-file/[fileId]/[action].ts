/**
 * POST /api/payroll/runs/[id]/bank-file/[fileId]/confirm  record that the bank accepted the file (wave 6 BF); a file
 *      that paid garnishee creditors also posts the journal clearing their payable (wave 7 GC2). { paidAsGenerated: true }
 *      attests the bank paid it as made when a creditor's details changed since (else 409 CREDITOR_DETAILS_CHANGED).
 * POST /api/payroll/runs/[id]/bank-file/[fileId]/void     { notSentToBank: true } void a generated file never sent.
 *
 * Owner / admin with Payroll Approve (GC2: confirm posts a journal), a person's own session, never Login-as (payrollBankFileApi). Confirm never writes the run header: the
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
import { withPayrollModule } from '@/lib/auth/withPayrollModule';
import { refuseWithoutApprove } from '@/modules/accounting/services/core/approvePermissionResponse';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const { id: runId, fileId, action } = req.query;
  if (typeof runId !== 'string' || !UUID.test(runId)) return apiResponse.badRequest(res, 'id must be a UUID');
  if (typeof fileId !== 'string' || !UUID.test(fileId)) return apiResponse.badRequest(res, 'fileId must be a UUID');
  if (action !== 'confirm' && action !== 'void') return apiResponse.notFound(res, 'Bank file action');

  const actor = await bankFileWriter(req, res);
  if (!actor) return;
  // Wave 7 GC2: confirming posts the garnishee creditors' journal (#1656: every posting entry point asks the module's
  // Approve). Asked for void too: one gate before the one service call, and a void settles the same file.
  if (await refuseWithoutApprove(res, companyId, actor.userId, 'payroll', 'salary bank files')) return;
  try {
    const body = req.body as { notSentToBank?: unknown; paidAsGenerated?: unknown } | undefined;
    const notSentToBank = body?.notSentToBank === true;
    const paidAsGenerated = body?.paidAsGenerated === true;
    return apiResponse.success(res, await settleBankFile({ companyId, runId, fileId, action, actor, notSentToBank, paidAsGenerated }));
  } catch (err) {
    if (respondIfLockTimeout(res, err) || respondIfBankFileRefused(res, err)) return;
    throw err;
  }
}

export default withAuth(withNoStore(withErrorHandler(withPayrollModule(withCsrf(withPayrollDetailAccess(handler))))));
