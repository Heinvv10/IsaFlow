/** GET — the Bills "Intercompany" tab: { openCount: messages that need a person, enabled: this company has an intercompany connection } (P2). */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { inboxSummary } from '@/modules/accounting/services/intercompany/inboxRead';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  return apiResponse.success(res, await inboxSummary(req.companyId));
}

export default withAuth(withErrorHandler(handler));
