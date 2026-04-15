/**
 * Auth utilities for Next.js App Router routes (NextRequest).
 * Provides the same JWT-based identity resolution as withAuth() in middleware.ts,
 * but compatible with the App Router request/response API.
 *
 * Usage:
 *   import { getUserFromRequest } from '@/lib/auth/app-router';
 *   const user = await getUserFromRequest(req);
 *   if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 *   const userId = user.id;
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from './jwt';
import { AUTH_COOKIE_NAME, getUserAndValidateSession } from './middleware';
import type { AuthUser } from './types';
import { createHash } from 'crypto';

/**
 * Extract the JWT token from a NextRequest (cookie or Authorization header).
 */
function extractToken(req: NextRequest): string | null {
  // 1. Cookie (preferred)
  const cookieToken = req.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (cookieToken) return cookieToken;

  // 2. Authorization: Bearer <token>
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  return null;
}

/**
 * Resolve the full AuthUser from a NextRequest.
 * Returns null if the request is unauthenticated or the token is invalid.
 *
 * IMPORTANT: User identity comes ONLY from the verified JWT — never from
 * client-supplied headers like x-user-id.
 */
export async function getUserFromRequest(req: NextRequest): Promise<AuthUser | null> {
  const token = extractToken(req);
  if (!token) return null;

  const payload = await verifyToken(token);
  if (!payload || !payload.sub) return null;

  try {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    return await getUserAndValidateSession(payload.sub, payload.sessionId, tokenHash);
  } catch {
    return null;
  }
}

/**
 * Convenience: require authentication or return a 401 response.
 * Returns [user, null] on success, [null, 401Response] on failure.
 *
 * Usage:
 *   const [user, unauth] = await requireAuth(req);
 *   if (unauth) return unauth;
 */
export async function requireAuth(
  req: NextRequest
): Promise<[AuthUser, null] | [null, NextResponse]> {
  const user = await getUserFromRequest(req);
  if (!user) {
    return [null, NextResponse.json({ error: 'Unauthorized' }, { status: 401 })];
  }
  return [user, null];
}
