/**
 * POST /api/auth/2fa-setup
 * Generate TOTP secret and QR code for the authenticated user.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withAuth } from '@/lib/auth/middleware';
import type { AuthenticatedNextApiRequest } from '@/lib/auth/middleware';
import { apiResponse } from '@/lib/apiResponse';
import { generateTOTPSecret } from '@/modules/auth/services/twoFactorService';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { checkRateLimit } from '@/lib/rateLimit';

/** 2fa-setup takes no body — reject any unexpected keys. */
const PostBody = z.object({}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
  }

  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!(await checkRateLimit(`2fa-setup:${ip}`, { max: 5, windowSecs: 15 * 60 }))) {
    return res.status(429).json({ success: false, error: 'Too many attempts. Try again later.' });
  }

  // Validate (and reject unknown keys) — body should be empty or absent
  const bodyToParse = req.body && typeof req.body === 'object' ? req.body : {};
  const parsed = PostBody.safeParse(bodyToParse);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Unexpected fields in request body');
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
