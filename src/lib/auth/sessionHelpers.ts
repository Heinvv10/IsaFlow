/**
 * Auth Session Helpers
 * Low-level token extraction and session/user lookup.
 *
 * Split from middleware.ts to stay within the 300-line limit.
 * withAuth, withRole, withPermission, etc. remain in middleware.ts.
 */

import type { NextApiRequest } from 'next';
import { sql } from '@/lib/neon';
import type { AuthUser, AuthRole } from './types';

/** Cookie name for JWT token — defined here to avoid circular imports with middleware.ts */
export const AUTH_COOKIE_NAME = 'isaflow_auth';

/**
 * Extract token from request (cookie or Authorization header)
 */
export function extractToken(req: NextApiRequest): string | null {
  const cookieToken = req.cookies[AUTH_COOKIE_NAME];
  if (cookieToken) return cookieToken;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  return null;
}

/**
 * Get user and validate session in a SINGLE query (optimized)
 * // WORKING: Combines session validation + user lookup
 * Performance: ~100ms vs previous ~600ms (2 sequential queries)
 */
export async function getUserAndValidateSession(
  userId: string,
  sessionId: string,
  tokenHash: string
): Promise<AuthUser | null> {
  // Single JOIN query instead of 2 sequential queries
  // REQUIRES INDEX: CREATE INDEX idx_user_sessions_composite ON user_sessions(id, token_hash, expires_at);
  const result = await sql`
    SELECT
      u.id,
      u.email,
      u.first_name,
      u.last_name,
      u.role,
      u.permissions,
      u.is_active,
      u.profile_picture,
      u.department,
      u.must_change_password,
      s.id as session_id
    FROM users u
    INNER JOIN user_sessions s ON s.user_id = u.id
    WHERE u.id = ${userId}
      AND s.id = ${sessionId}
      AND s.token_hash = ${tokenHash}
      AND s.expires_at > NOW()
      AND u.is_active = true
    LIMIT 1
  `;

  const row = result[0];
  if (!row) return null;

  const firstName = (row.first_name as string) || '';
  const lastName = (row.last_name as string) || '';

  return {
    id: row.id as string,
    userId: row.id as string,
    email: row.email as string,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim() || (row.email as string),
    role: row.role as AuthRole,
    permissions: (row.permissions as string[]) || [],
    isActive: row.is_active as boolean,
    profilePicture: row.profile_picture as string | undefined,
    department: row.department as string | undefined,
    mustChangePassword: (row.must_change_password as boolean) || false,
  };
}
