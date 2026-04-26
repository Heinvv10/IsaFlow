/**
 * Auth utilities for Next.js App Router routes (NextRequest).
 * Phase 2: Uses GoTrue JWT verification via parseCookies + verifyToken.
 *
 * Usage:
 *   import { getUserFromRequest } from '@/lib/auth/app-router';
 *   const user = await getUserFromRequest(req);
 *   if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 *   const userId = user.id;
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from './gotrue';
import { ACCESS_COOKIE } from './cookies';

export type AppRouterUser = {
  id: string;
  email?: string;
  claims: Record<string, unknown>;
};

/**
 * Extract the GoTrue JWT from a NextRequest (sb-access-token cookie or Bearer header).
 */
function extractToken(req: NextRequest): string | null {
  // 1. Cookie (preferred — set by login/register handlers)
  const cookieToken = req.cookies.get(ACCESS_COOKIE)?.value;
  if (cookieToken) return cookieToken;

  // 2. Authorization: Bearer <token>
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  return null;
}

/**
 * Resolve the authenticated user from a NextRequest.
 * Returns null if the request is unauthenticated or the JWT is invalid/expired.
 */
export async function getUserFromRequest(req: NextRequest): Promise<AppRouterUser | null> {
  const token = extractToken(req);
  if (!token) return null;

  try {
    const claims = await verifyToken(token);
    if (!claims.sub) return null;
    return {
      id: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      claims: claims as Record<string, unknown>,
    };
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
): Promise<[AppRouterUser, null] | [null, NextResponse]> {
  const user = await getUserFromRequest(req);
  if (!user) {
    return [null, NextResponse.json({ error: 'Unauthorized' }, { status: 401 })];
  }
  return [user, null];
}

// Back-compat export shape for callers that typed the return as AuthUser
export type { AppRouterUser as AuthUser };
