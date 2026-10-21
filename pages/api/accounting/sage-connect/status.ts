/**
 * GET /api/accounting/sage-connect/status
 * Whether "Connect to Sage" is switched on (IsaFlow's Sage API key is
 * configured), the company's Sage read in progress or review waiting for
 * import (the page resumes it after a refresh), and why the company cannot
 * take another Sage take-on, if it cannot. Expires the company's stale reviews
 * first (24 hours) and marks interrupted reads failed.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { findPriorTakeOn } from '@/modules/accounting/services/sage/sageTakeOnContext';
import { latestOpenPull, purgeExpiredPulls } from '@/modules/accounting/services/sage/sageTakeOnStore';
import { statusPayload } from '@/modules/accounting/services/sage/sageConnectRequest';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  await purgeExpiredPulls(companyId);
  return apiResponse.success(res, statusPayload(await latestOpenPull(companyId), await findPriorTakeOn(companyId)));
}

export default withAuth(withErrorHandler(handler));
