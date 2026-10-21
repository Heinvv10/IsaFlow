/**
 * GET /api/accounting/sage-connect/status
 * Whether "Connect to Sage" is switched on (IsaFlow's Sage API key is configured).
 * The page uses it to offer the connection or go straight to the file upload.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { statusPayload } from '@/modules/accounting/services/sage/sageConnectRequest';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  return apiResponse.success(res, statusPayload());
}

export default withAuth(withErrorHandler(handler));
