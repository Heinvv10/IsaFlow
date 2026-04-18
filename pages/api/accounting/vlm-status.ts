/**
 * VLM Status API
 * GET /api/accounting/vlm-status — Returns whether VLM is configured
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess} from '@/lib/auth';
import { isVlmAvailable } from '@/modules/accounting/services/bank/vlmService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  return apiResponse.success(res, { available: isVlmAvailable() });
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
