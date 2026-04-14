/**
 * POST /api/auth/forgot-password
 * Generates a password reset token and sends a reset email.
 * Always returns 200 (email enumeration prevention).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { generateResetToken } from '@/lib/auth/password';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import { passwordResetEmailHtml } from '@/lib/email-templates-auth';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.isaflow.co.za';

interface UserRow {
  id: string;
  email: string;
  first_name: string;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
  }

  // Rate limit: 5 requests per IP per 15 minutes
  // Use last-hop x-forwarded-for (proxy-appended) to prevent client IP spoofing.
  const ip = getClientIp(req);
  if (checkRateLimit(ip, { windowMs: 15 * 60 * 1000, maxRequests: 5 })) {
    return res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
    });
  }

  const { email } = req.body as { email?: string };
  if (!email || typeof email !== 'string') {
    return apiResponse.badRequest(res, 'Email is required');
  }

  const normalised = email.trim().toLowerCase();

  // Look up user — silently succeed if not found (enumeration prevention)
  const rows = (await sql`
    SELECT id, email, first_name
    FROM users
    WHERE email = ${normalised}
    LIMIT 1
  `) as UserRow[];

  if (rows.length === 0) {
    log.info('Password reset requested for unknown email', { email: normalised }, 'forgotPassword');
    return apiResponse.success(res, { message: 'If that email exists, a reset link has been sent.' });
  }

  const user = rows[0]!;

  // Invalidate any existing unused tokens for this user
  await sql`
    UPDATE password_reset_tokens
    SET used_at = NOW()
    WHERE user_id = ${user.id}
      AND used_at IS NULL
  `;

  // Generate new token
  const { token, hashedToken, expiresAt } = generateResetToken();

  await sql`
    INSERT INTO password_reset_tokens (user_id, hashed_token, expires_at)
    VALUES (${user.id}, ${hashedToken}, ${expiresAt.toISOString()}::TIMESTAMPTZ)
  `;

  const resetUrl = `${APP_URL}/reset-password?token=${token}`;

  const result = await sendEmail({
    to: user.email,
    subject: 'Reset your ISAFlow password',
    html: passwordResetEmailHtml({ name: user.first_name, resetUrl }),
  });

  if (!result.success) {
    log.error('Failed to send password reset email', { userId: user.id, error: result.error }, 'forgotPassword');
  } else {
    log.info('Password reset email sent', { userId: user.id }, 'forgotPassword');
  }

  // Always return success to prevent email enumeration
  return apiResponse.success(res, { message: 'If that email exists, a reset link has been sent.' });
}

export default withErrorHandler(handler);
