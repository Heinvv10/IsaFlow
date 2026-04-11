/**
 * VLM Status API
 * GET /api/accounting/vlm-status — Returns whether VLM is configured
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, withWriteAccess} from '@/lib/auth';
import { isVlmAvailable } from '@/modules/accounting/services/vlmService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  return apiResponse.success(res, { available: isVlmAvailable() });
}

 
export default withCompany(withErrorHandler(withWriteAccess(handler)));
