/**
 * POST /api/auth/change-password
 * Allows the authenticated user to change their password.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { verifyPassword, hashPassword, checkPasswordStrength } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
  }

  const authReq = req as AuthenticatedNextApiRequest;
  const userId = authReq.user.id;

  const { oldPassword, newPassword, confirmPassword } = req.body as {
    oldPassword?: string;
    newPassword?: string;
    confirmPassword?: string;
  };

  if (!oldPassword || !newPassword || !confirmPassword) {
    return apiResponse.badRequest(res, 'All password fields are required');
  }

  if (newPassword !== confirmPassword) {
    return apiResponse.badRequest(res, 'New passwords do not match');
  }

  const strength = checkPasswordStrength(newPassword);
  if (strength.score < 2) {
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

  const currentHash: string = rows[0].password_hash;
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

export default withAuth(withErrorHandler(handler) as any);
