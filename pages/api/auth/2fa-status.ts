/**
 * GET /api/auth/2fa-status
 * Return current 2FA status for the authenticated user.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth } from '@/lib/auth/middleware';
import type { AuthenticatedNextApiRequest } from '@/lib/auth/middleware';
import { apiResponse } from '@/lib/apiResponse';
import { get2FAStatus } from '@/modules/auth/services/twoFactorService';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['GET']);
  }

  const { user } = req as AuthenticatedNextApiRequest;

  try {
    const status = await get2FAStatus(user.id);
    return apiResponse.success(res, status);
  } catch (err) {
    log.error('2fa-status error', err instanceof Error ? { message: err.message } : { err }, 'api/auth/2fa-status');
    return apiResponse.internalError(res, err);
  }
}

export default withAuth(withErrorHandler(handler as any));
