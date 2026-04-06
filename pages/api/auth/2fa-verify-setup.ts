/**
 * POST /api/auth/2fa-verify-setup
 * Verify initial TOTP code and enable 2FA for the authenticated user.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth } from '@/lib/auth/middleware';
import type { AuthenticatedNextApiRequest } from '@/lib/auth/middleware';
import { apiResponse } from '@/lib/apiResponse';
import { verifyTOTPSetup } from '@/modules/auth/services/twoFactorService';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { checkRateLimit } from '@/lib/rateLimit';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
  }

  // Rate limit: 5 attempts per IP per 15 minutes (prevent TOTP brute-force)
  const rawIp = Array.isArray(req.headers['x-forwarded-for'])
    ? req.headers['x-forwarded-for'][0]
    : req.headers['x-forwarded-for'] ?? req.socket.remoteAddress;
  const ip: string = rawIp ?? 'unknown';
  if (checkRateLimit(`2fa-setup:${ip}`, { windowMs: 15 * 60 * 1000, maxRequests: 5 })) {
    return res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
    });
  }

  const { user } = req as AuthenticatedNextApiRequest;
  const { code } = req.body as { code?: string };

  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    return apiResponse.badRequest(res, 'Verification code is required');
  }

  try {
    const result = await verifyTOTPSetup(user.id, code.trim());

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_CODE', message: 'Invalid or expired verification code' },
      });
    }

    log.info('2FA enabled via setup verification', { userId: user.id }, 'api/auth/2fa-verify-setup');

    return apiResponse.success(res, {
      backupCodes: result.backupCodes,
    }, '2FA enabled successfully. Save your backup codes — they will not be shown again.');
  } catch (err) {
    log.error('2fa-verify-setup error', err instanceof Error ? { message: err.message } : { err }, 'api/auth/2fa-verify-setup');
    return apiResponse.internalError(res, err);
  }
}

export default withAuth(withErrorHandler(handler));
