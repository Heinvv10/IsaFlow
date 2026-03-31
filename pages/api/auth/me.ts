/**
 * GET /api/auth/me
 * Returns the currently authenticated user from the JWT cookie.
 * Uses a single JOIN query for performance (session + user in one round-trip).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { log } from '@/lib/logger';
import { apiResponse } from '@/lib/apiResponse';
import { verifyToken } from '@/lib/auth/jwt';
import { getUserAndValidateSession, AUTH_COOKIE_NAME } from '@/lib/auth/middleware';
import { createHash } from 'crypto';
import { withErrorHandler } from '@/lib/api-error-handler';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['GET']);
  }

  // Extract token from cookie or Authorization header
  const cookieToken = req.cookies[AUTH_COOKIE_NAME];
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  const token = cookieToken ?? bearerToken;

  if (!token) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
  }

  try {
    const payload = await verifyToken(token);
    if (!payload) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' },
      });
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const user = await getUserAndValidateSession(payload.sub, payload.sessionId, tokenHash);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: { code: 'SESSION_INVALID', message: 'Session expired or invalid' },
      });
    }

    return apiResponse.success(res, { user });
  } catch (err) {
    log.error('Failed to get current user', err instanceof Error ? { message: err.message } : { err }, 'auth/me');
    return apiResponse.internalError(res, err);
  }
}

export default withErrorHandler(handler as any);
