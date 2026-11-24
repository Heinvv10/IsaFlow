/**
 * GET /api/accounting/intercompany/loan-reconciliation (intercompany P5, read only): this company's connections the loan reconciliation can
 * open (a loan connection, or one carrying an allocation message) as `{ connections: [{ id, partnerName, settlementMode, status }] }`.
 * Refused 403 for a Login-as session or one without a session id, with the dark flag `intercompany_loan_clearing` off, or without an
 * intercompany write role, before anything else is read. GET only.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { loanReconConnections } from '@/modules/accounting/services/intercompany/loanReconService';
import { respondIfReconRefusal } from '@/modules/accounting/services/intercompany/loanReconRoute';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  try {
    return apiResponse.success(res, { connections: await loanReconConnections(req.companyId) });
  } catch (err) {
    if (respondIfReconRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(handler as any));
