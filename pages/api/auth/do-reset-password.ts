/**
 * POST /api/auth/do-reset-password
 * Validates a reset token and sets a new password.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rateLimit';
import { hashResetToken, isResetTokenExpired, hashPassword, checkPasswordStrength } from '@/lib/auth/password';

interface TokenRow {
  id: string;
  user_id: string;
  expires_at: Date | string;
  used_at: Date | string | null;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
  }

  // Rate limit: 10 attempts per IP per 15 minutes
  const rawIp = Array.isArray(req.headers['x-forwarded-for'])
    ? req.headers['x-forwarded-for'][0]
    : req.headers['x-forwarded-for'] ?? req.socket.remoteAddress;
  const ip: string = rawIp ?? 'unknown';
  if (!(await checkRateLimit(ip, { max: 10, windowSecs: 15 * 60 }))) {
    return res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
    });
  }

  const { token, password, confirmPassword } = req.body as {
    token?: string;
    password?: string;
    confirmPassword?: string;
  };

  if (!token || !password || !confirmPassword) {
    return apiResponse.badRequest(res, 'Token, password, and confirm password are required');
  }

  if (password !== confirmPassword) {
    return apiResponse.badRequest(res, 'Passwords do not match');
  }

  const strength = checkPasswordStrength(password);
  if (!strength.isValid) {
    return apiResponse.badRequest(res, strength.issues[0] ?? 'Password is too weak');
  }

  const hashedToken = hashResetToken(token);

  const rows = (await sql`
    SELECT id, user_id, expires_at, used_at
    FROM password_reset_tokens
    WHERE hashed_token = ${hashedToken}
    LIMIT 1
  `) as TokenRow[];

  if (rows.length === 0) {
    return apiResponse.badRequest(res, 'Invalid or expired reset link. Please request a new one.');
  }

  const record = rows[0]!;

  if (record.used_at !== null) {
    return apiResponse.badRequest(res, 'This reset link has already been used. Please request a new one.');
  }

  if (isResetTokenExpired(record.expires_at)) {
    return apiResponse.badRequest(res, 'This reset link has expired. Please request a new one.');
  }

  const passwordHash = await hashPassword(password);

  // Update password and mark token as used atomically
  await sql`
    UPDATE users
    SET password_hash = ${passwordHash}, must_change_password = false, updated_at = NOW()
    WHERE id = ${record.user_id}
  `;

  await sql`
    UPDATE password_reset_tokens
    SET used_at = NOW()
    WHERE id = ${record.id}::UUID
  `;

  log.info('Password reset completed', { userId: record.user_id }, 'doResetPassword');

  return apiResponse.success(res, { message: 'Password updated successfully. You can now sign in.' });
}

export default withErrorHandler(handler);
