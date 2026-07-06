/**
 * SARS eFiling channel status.
 * GET — redacted { configured, baseUrlHost, channel }. Drives whether the
 * "Submit to SARS" surface appears. Never returns credentials/activation keys.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { efilingConfigStatus } from '@/modules/accounting/services/reports/sarsEfilingConfig';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }
  return apiResponse.success(res, efilingConfigStatus());
}

export default withAuth(withErrorHandler(handler));
