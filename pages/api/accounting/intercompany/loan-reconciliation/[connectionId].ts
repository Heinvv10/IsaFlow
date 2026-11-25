/**
 * GET /api/accounting/intercompany/loan-reconciliation/[connectionId]?section=undone|attention|mismatch&limit&offset (intercompany P5, read
 * only; plan docs/plans/2026-11-24-intercompany-p5-reconciliation.md): one connection's loan reconciliation as at today, `{ connectionId,
 * partnerName, asOf, readAt, summary, section: { key, items, total, limit, offset } }`. The whole summary and the section's total come from
 * the same ONE statement on every page; `readAt` is that statement's time.
 * Order: 403 for a Login-as session or one without a session id, the dark flag `intercompany_loan_clearing` off, or no intercompany write
 * role (before anything else is read); 400 for a connection that is no UUID, a bad section / page, or ANY `asOf` parameter (the report is as
 * of today: there is no chosen date); 404, one body, for a connection that is not this company's loan connection (another pair's, a random
 * id, a cash connection without messages); 422 over 5 000 messages; 503 when the read runs out of time. GET only; nothing is written.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { loanReconReport } from '@/modules/accounting/services/intercompany/loanReconService';
import { parseReconQuery } from '@/modules/accounting/services/intercompany/loanReconRefusals';
import { respondIfReconRefusal } from '@/modules/accounting/services/intercompany/loanReconRoute';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  try {
    // the service checks the person first, then refuses a bad request (400), so the order of (c) holds with ONE check per request
    return apiResponse.success(res, await loanReconReport(req.companyId, parseReconQuery(req.query as Record<string, unknown>)));
  } catch (err) {
    if (respondIfReconRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(handler as any));
