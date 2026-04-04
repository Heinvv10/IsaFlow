/**
 * POST /api/auth/2fa-disable
 * Disable 2FA for the authenticated user (requires current code).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth } from '@/lib/auth/middleware';
import type { AuthenticatedNextApiRequest } from '@/lib/auth/middleware';
import { apiResponse } from '@/lib/apiResponse';
import { disable2FA } from '@/modules/auth/services/twoFactorService';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { checkRateLimit } from '@/lib/rateLimit';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
  }

  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (checkRateLimit(`2fa-disable:${ip}`, { maxRequests: 5, windowMs: 15 * 60 * 1000 })) {
    return res.status(429).json({ success: false, error: 'Too many attempts. Try again later.' });
  }

  const { user } = req as AuthenticatedNextApiRequest;
  const { code } = req.body as { code?: string };

  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    return apiResponse.badRequest(res, 'Current 2FA code is required to disable 2FA');
  }

  try {
    const success = await disable2FA(user.id, code.trim());

    if (!success) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_CODE', message: 'Invalid authentication code' },
      });
    }

    log.info('2FA disabled', { userId: user.id }, 'api/auth/2fa-disable');

    return apiResponse.success(res, null, '2FA has been disabled');
  } catch (err) {
    log.error('2fa-disable error', err instanceof Error ? { message: err.message } : { err }, 'api/auth/2fa-disable');
    return apiResponse.internalError(res, err);
  }
}

export default withAuth(withErrorHandler(handler));
