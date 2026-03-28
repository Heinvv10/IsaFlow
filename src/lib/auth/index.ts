/**
 * Auth Library
 * Central export for all authentication utilities
 */

// Types
export * from './types';

// JWT utilities
export { signToken, verifyToken, decodeToken, isTokenExpired, getTokenExpiryTime } from './jwt';

// Password utilities
export {
  hashPassword,
  verifyPassword,
  checkPasswordStrength,
  generateRandomPassword,
  generateResetToken,
  hashResetToken,
  isResetTokenExpired,
} from './password';

// Session management
export {
  createSession,
  validateSession,
  getSession,
  deleteSession,
  deleteAllUserSessions,
  getUserSessions,
  cleanupExpiredSessions,
  extendSession,
} from './session';

// Middleware (Pages Router)
export {
  withAuth,
  withRole,
  withPermission,
  withRoleAndPermission,
  withOptionalAuth,
  hasRole,
  hasPermission,
  AUTH_COOKIE_NAME,
  type AuthenticatedNextApiRequest,
} from './middleware';

// Company-scoped middleware
export { withCompany, type CompanyApiRequest } from './withCompany';

// App Router utilities (NextRequest)
export { getUserFromRequest, requireAuth } from './app-router';

import type { NextApiRequest } from 'next';
import type { AuthenticatedNextApiRequest } from './middleware';
import type { AuthUser } from './types';

/**
 * Get the authenticated user from request
 * Must be used after withAuth middleware
 */
export function getAuthUser(req: NextApiRequest): AuthUser | null {
  const authReq = req as AuthenticatedNextApiRequest;
  return authReq.user || null;
}
