/**
 * Scope gate for handlers behind withBearerOrCookieAuth (PRD-10 Layer 3).
 *
 * **Contract:** withScope only enforces against requests that passed through
 * withBearerOrCookieAuth (which attaches `req.scopes`). On a cookie-only
 * `withAuth` route, `req.scopes` is undefined and the gate is intentionally
 * a no-op — UI users have full access. On a route exposed via Bearer auth,
 * the gate enforces strictly: a token without one of the required scopes
 * gets 403 INSUFFICIENT_SCOPE.
 *
 * Usage:
 *   export default withBearerOrCookieAuth(
 *     withScope('write:bank-tx', withErrorHandler(handler)),
 *   );
 */
import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';

interface ScopedRequest extends NextApiRequest {
  scopes?: string[];
}

export function withScope(required: string | string[]) {
  const requiredScopes = Array.isArray(required) ? required : [required];

  return (handler: NextApiHandler): NextApiHandler => {
    return async (req: NextApiRequest, res: NextApiResponse) => {
      const scopes = (req as ScopedRequest).scopes;

      // Cookie session (no scopes attached) — full UI access, gate is a no-op.
      if (!scopes) return handler(req, res);

      const ok = requiredScopes.some((s) => scopes.includes(s));
      if (!ok) {
        return apiResponse.error(
          res,
          ErrorCode.INSUFFICIENT_SCOPE,
          `Token missing required scope: ${requiredScopes.join(' or ')}`,
        );
      }
      return handler(req, res);
    };
  };
}
