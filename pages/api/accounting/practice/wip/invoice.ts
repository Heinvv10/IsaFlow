/**
 * Practice WIP Invoice Generation API
 * POST /api/accounting/practice/wip/invoice — generate invoice from WIP entries
 */

import type { NextApiResponse } from 'next';
import {
  withAuth,
  type CompanyAuthedRequest,
  type AuthenticatedNextApiRequest,
  withWriteAccess,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { generateWipInvoice } from '@/modules/accounting/services/practice/practiceWipService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  try {
    const result = await generateWipInvoice(companyId, req.user.id, req.body);
    return apiResponse.created(res, result);
  } catch (err) {
    log.error('WIP invoice generation failed', { error: err }, 'practice-api');
    return apiResponse.badRequestFromError(res, err, 'WIP invoice failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
