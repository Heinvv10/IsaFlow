/**
 * Auth Library — Phase 2 GoTrue barrel
 * Central export for all authentication utilities.
 *
 * Old custom-auth modules (jwt, password, session, middleware, sessionHelpers,
 * withCompany) are being removed as part of the GoTrue cutover.  Any remaining
 * callers should import from the new wrappers below.
 */

// ── Types ────────────────────────────────────────────────────────────────────
export * from './types';

// ── New GoTrue wrappers ───────────────────────────────────────────────────────
// withAuth: user + company + tx + GUCs (replaces old withCompany)
// withRole: role gate, compose inside withAuth
export { withAuth, withRole, type CompanyAuthedRequest } from './withAuth';

// withUserAuth: JWT-verify only, no company (replaces old withAuth from middleware)
export { withUserAuth, type UserAuthedRequest, type AuthenticatedNextApiRequest } from './withUserAuth';

// withPlatformAdmin: user-only + super_admin gate + BYPASSRLS pool
export { withPlatformAdmin, type PlatformAdminRequest } from './withPlatformAdmin';

// Back-compat alias — callers that still reference CompanyApiRequest by the old name
export type { CompanyAuthedRequest as CompanyApiRequest } from './withAuth';

// ── Guards ───────────────────────────────────────────────────────────────────
// Write-access gate (blocks viewers from mutating)
export { withWriteAccess, DEFAULT_WRITE_ROLES, type WriteRole } from './withWriteAccess';

// CSRF gate
export { withCsrf } from './withCsrf';

// Module-permission gate
export { withModulePermission } from './withModulePermission';

// Bank-feed extension token gate
export { withExtensionToken, type ExtensionAuthedRequest } from './withExtensionToken';
export { signExtensionToken, verifyExtensionToken, type ExtensionTokenPayload } from './extensionJwt';

// ── App Router ────────────────────────────────────────────────────────────────
export { getUserFromRequest, requireAuth } from './app-router';

// ── Cookie constants ─────────────────────────────────────────────────────────
export { ACCESS_COOKIE, REFRESH_COOKIE, ACTIVE_COMPANY_COOKIE } from './cookies';

// ── Landing resolver ──────────────────────────────────────────────────────────
export { resolveDefaultLanding, type LandingInput } from './resolveLanding';

// ── Helpers ───────────────────────────────────────────────────────────────────
import type { NextApiRequest } from 'next';
import type { CompanyAuthedRequest } from './withAuth';

/**
 * Get the authenticated user from a company-authed request.
 * Must be used after withAuth middleware.
 */
export function getAuthUser(req: NextApiRequest) {
  const authedReq = req as CompanyAuthedRequest;
  return authedReq.user ?? null;
}
