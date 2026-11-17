/**
 * GET  /api/payroll/runs/[id]/bank-file  the run's salary bank files and whether generating is switched on.
 * POST /api/payroll/runs/[id]/bank-file  { actionDate: 'YYYY-MM-DD' } generate the ACB file (wave 6 BF).
 *
 * GET: payroll-detail roles. POST: owner / admin, a person's own session, never Login-as (payrollBankFileApi).
 * The file is built in memory and returned in the JSON body (never written to disk); every response is no-store.
 * Every refusal is judged before any write (payrollBankFileService) and answered with `details.reason`.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withNoStore } from '@/lib/auth/withNoStore';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { bankFileWriter, respondIfBankFileRefused, UUID } from '@/lib/payrollBankFileApi';
import { generateSalaryBankFile } from '@/modules/accounting/services/payroll/payrollBankFileService';
import { readRunBankFileState } from '@/modules/accounting/services/payroll/payrollBankFileStatus';

const Body = z.object({ actionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'actionDate must be YYYY-MM-DD') }).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const runId = req.query.id;
  if (typeof runId !== 'string' || !UUID.test(runId)) return apiResponse.badRequest(res, 'id must be a UUID');

  if (req.method === 'GET') return apiResponse.success(res, await readRunBankFileState(companyId, runId));
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);

  const actor = await bankFileWriter(req, res);
  if (!actor) return;
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'actionDate is required');
  try {
    return apiResponse.success(res, await generateSalaryBankFile({ companyId, runId, actionDate: parsed.data.actionDate, actor }));
  } catch (err) {
    if (respondIfLockTimeout(res, err) || respondIfBankFileRefused(res, err)) return;
    throw err;
  }
}

export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)))));
