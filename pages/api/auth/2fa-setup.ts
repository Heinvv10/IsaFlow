/**
 * POST /api/auth/2fa-setup
 * Generate TOTP secret and QR code for the authenticated user.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth } from '@/lib/auth/middleware';
import type { AuthenticatedNextApiRequest } from '@/lib/auth/middleware';
import { apiResponse } from '@/lib/apiResponse';
import { generateTOTPSecret } from '@/modules/auth/services/twoFactorService';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { checkRateLimit } from '@/lib/rateLimit';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
  }

  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (checkRateLimit(`2fa-setup:${ip}`, { maxRequests: 5, windowMs: 15 * 60 * 1000 })) {
    return res.status(429).json({ success: false, error: 'Too many attempts. Try again later.' });
  }

  const { user } = req as AuthenticatedNextApiRequest;

  try {
    const result = await generateTOTPSecret(user.id, user.email);

    // Mask the raw secret — only expose QR code and URI
    return apiResponse.success(res, {
      uri: result.uri,
      qrCodeDataUrl: result.qrCodeDataUrl,
      secretMasked: result.secret.slice(0, 4) + '****',
    }, '2FA setup initiated');
  } catch (err) {
    log.error('2fa-setup error', err instanceof Error ? { message: err.message } : { err }, 'api/auth/2fa-setup');
    return apiResponse.internalError(res, err);
  }
}

export default withAuth(withErrorHandler(handler));
