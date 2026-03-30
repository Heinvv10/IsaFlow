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

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
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

export default withAuth(handler);
