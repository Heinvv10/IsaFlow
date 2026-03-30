/**
 * POST /api/auth/logout
 * Deletes the current user session from the database and clears the auth cookie.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { serialize } from 'cookie';
import { log } from '@/lib/logger';
import { apiResponse } from '@/lib/apiResponse';
import { verifyToken } from '@/lib/auth/jwt';
import { deleteSession } from '@/lib/auth/session';
import { AUTH_COOKIE_NAME } from '@/lib/auth/middleware';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
  }

  const token = req.cookies[AUTH_COOKIE_NAME];

  // Best-effort session deletion — don't fail if token is missing/invalid
  if (token) {
    try {
      const payload = await verifyToken(token);
      if (payload?.sessionId) {
        await deleteSession(payload.sessionId);
      }
    } catch (err) {
      log.warn('Failed to delete session during logout', { err }, 'auth/logout');
    }
  }

  // Clear the auth cookie and onboarding cookie
  const secureSuffix = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    serialize(AUTH_COOKIE_NAME, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 0,
      expires: new Date(0),
    }),
    `ff_onboarding_done=; Path=/; Max-Age=0; SameSite=Lax${secureSuffix}`,
  ]);

  log.info('User logged out', {}, 'auth/logout');
  return apiResponse.success(res, null, 'Logged out successfully');
}
