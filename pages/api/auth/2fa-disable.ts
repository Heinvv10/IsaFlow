/**
 * POST /api/auth/2fa-disable
 * Disable 2FA for the authenticated user (requires current code).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withAuth } from '@/lib/auth/middleware';
import type { AuthenticatedNextApiRequest } from '@/lib/auth/middleware';
import { apiResponse } from '@/lib/apiResponse';
import { disable2FA } from '@/modules/auth/services/twoFactorService';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { checkRateLimit } from '@/lib/rateLimit';

const PostBody = z.object({
  /** TOTP code or backup code used to confirm disabling 2FA. */
  code: z.string().min(1, 'Current 2FA code is required'),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
  }

  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!(await checkRateLimit(`2fa-disable:${ip}`, { max: 5, windowSecs: 15 * 60 }))) {
    return res.status(429).json({ success: false, error: 'Too many attempts. Try again later.' });
  }

  const parsed = PostBody.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }

  const { user } = req as AuthenticatedNextApiRequest;
  const { code } = parsed.data;

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
