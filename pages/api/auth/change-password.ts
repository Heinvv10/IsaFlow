/**
 * POST /api/auth/change-password
 * Allows the authenticated user to change their password.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { verifyPassword, hashPassword, checkPasswordStrength } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rateLimit';
type Row = Record<string, unknown>;

const PostBody = z.object({
  oldPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
  confirmPassword: z.string().min(1, 'Password confirmation is required'),
}).strict().refine((d) => d.newPassword === d.confirmPassword, {
  message: 'New passwords do not match',
  path: ['confirmPassword'],
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
  }

  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!(await checkRateLimit(`change-password:${ip}`, { max: 5, windowSecs: 15 * 60 }))) {
    return res.status(429).json({ success: false, error: 'Too many attempts. Try again later.' });
  }

  const authReq = req as AuthenticatedNextApiRequest;
  const userId = authReq.user.id;

  const parsed = PostBody.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }

  const { oldPassword, newPassword } = parsed.data;

  const strength = checkPasswordStrength(newPassword);
  if (!strength.isValid) {
    return apiResponse.badRequest(
      res,
      `Password too weak: ${strength.issues[0] ?? 'Please choose a stronger password'}`
    );
  }

  // Fetch current password hash
  const rows = (await sql`
    SELECT password_hash FROM users WHERE id = ${userId} LIMIT 1
  `) as Row[];

  if (!rows.length) {
    return apiResponse.notFound(res, 'User');
  }

  const currentHash: string = String(rows[0]!.password_hash);
  const valid = await verifyPassword(oldPassword, currentHash);

  if (!valid) {
    return apiResponse.badRequest(res, 'Current password is incorrect');
  }

  const newHash = await hashPassword(newPassword);

  await sql`
    UPDATE users SET password_hash = ${newHash} WHERE id = ${userId}
  `;

  log.info('Password changed', { userId }, 'auth/change-password');

  return apiResponse.success(res, null, 'Password changed successfully');
}

export default withAuth(withErrorHandler(handler));
