/**
 * POST /api/auth/2fa-verify
 * Verify TOTP code during login using a short-lived temp token.
 * Returns full auth token on success (mirrors login response).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { serialize } from 'cookie';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { verifyToken, signToken } from '@/lib/auth/jwt';
import { createSession } from '@/lib/auth/session';
import { AUTH_COOKIE_NAME } from '@/lib/auth/middleware';
import { verifyTOTPCode, addTrustedDevice } from '@/modules/auth/services/twoFactorService';
import { log } from '@/lib/logger';
import type { AuthRole } from '@/lib/auth/types';
import { createHash } from 'crypto';
import { checkRateLimit } from '@/lib/rateLimit';
import { withErrorHandler } from '@/lib/api-error-handler';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
  }

  // Rate limit: 5 attempts per IP per 15 minutes
  const rawIp = Array.isArray(req.headers['x-forwarded-for'])
    ? req.headers['x-forwarded-for'][0]
    : req.headers['x-forwarded-for'] ?? req.socket.remoteAddress;
  const ip: string = rawIp ?? 'unknown';
  if (checkRateLimit(ip, { windowMs: 15 * 60 * 1000, maxRequests: 5 })) {
    return res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
    });
  }

  const {
    tempToken,
    code,
    trustDevice,
    deviceFingerprint,
    deviceName,
  } = req.body as {
    tempToken?: string;
    code?: string;
    trustDevice?: boolean;
    deviceFingerprint?: string;
    deviceName?: string;
  };

  if (!tempToken || !code) {
    return apiResponse.badRequest(res, 'tempToken and code are required');
  }

  try {
    // Verify the temp token
    const payload = await verifyToken(tempToken);
    if (!payload) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired temp token' },
      });
    }

    // Temp tokens use sessionId = '2fa-pending'
    if (payload.sessionId !== '2fa-pending') {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_TOKEN', message: 'Token is not a 2FA temp token' },
      });
    }

    const userId = payload.sub;

    // Look up the user
    const rows = (await sql`
      SELECT id, email, first_name, last_name, role,
             is_active, permissions, profile_picture, department, onboarding_completed
      FROM users
      WHERE id = ${userId} AND is_active = true
      LIMIT 1
    `) as Row[];

    const user = rows[0];
    if (!user) {
      return res.status(401).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
      });
    }

    // Verify TOTP code
    const codeValid = await verifyTOTPCode(userId, code.trim());
    if (!codeValid) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_2FA_CODE', message: 'Invalid authentication code' },
      });
    }

    const firstName = (user.first_name as string) || '';
    const lastName = (user.last_name as string) || '';

    const authUser = {
      id: String(user.id),
      userId: String(user.id),
      email: user.email as string,
      firstName,
      lastName,
      name: `${firstName} ${lastName}`.trim() || (user.email as string),
      role: user.role as AuthRole,
      permissions: (user.permissions as string[]) || [],
      isActive: true,
      profilePicture: user.profile_picture as string | undefined,
      department: user.department as string | undefined,
    };

    // Create full session
    const ipAddress = Array.isArray(req.headers['x-forwarded-for'])
      ? req.headers['x-forwarded-for'][0]
      : req.headers['x-forwarded-for'] ?? req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const pendingToken = await signToken(authUser, 'pending');
    const session = await createSession(authUser.id, pendingToken, ipAddress, userAgent);

    const finalToken = await signToken(authUser, session.id);
    const finalHash = createHash('sha256').update(finalToken).digest('hex');

    await sql`
      UPDATE user_sessions SET token_hash = ${finalHash} WHERE id = ${Number(session.id)}
    `;

    // Optionally trust device
    if (trustDevice && deviceFingerprint) {
      await addTrustedDevice(userId, deviceFingerprint, deviceName ?? 'Unknown Device');
    }

    const onboardingCompleted = !!user.onboarding_completed;

    const authCookieString = serialize(AUTH_COOKIE_NAME, finalToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 60 * 60, // 8 hours
    });

    const cookies = [authCookieString];
    if (onboardingCompleted) {
      cookies.push(`ff_onboarding_done=1; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    }
    res.setHeader('Set-Cookie', cookies);

    log.info('2FA verified — full session created', { userId }, 'api/auth/2fa-verify');

    return apiResponse.success(res, {
      user: { ...authUser, onboardingCompleted },
    }, 'Two-factor authentication verified');
  } catch (err) {
    log.error('2fa-verify error', err instanceof Error ? { message: err.message } : { err }, 'api/auth/2fa-verify');
    return apiResponse.internalError(res, err);
  }
}

export default withErrorHandler(handler as any);
