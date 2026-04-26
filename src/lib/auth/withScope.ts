/**
 * Scope gate for handlers behind withBearerOrCookieAuth (PRD-10 Layer 3).
 *
 * Cookie-authed requests have full UI access — req.scopes is undefined and the
 * gate is a no-op (the user is doing what they could already do via the UI).
 *
 * PAT/OAuth-authed requests must carry an explicit scope claim. If none of the
 * required scopes are present, return 403 INSUFFICIENT_SCOPE — the user (or
 * integration developer) needs a token with broader permissions.
 *
 * Usage:
 *   export default withBearerOrCookieAuth(
 *     withScope('write:bank-tx', withErrorHandler(handler)),
 *   );
 */
import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';

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
        return res.status(403).json({
          success: false,
          error: {
            code: 'INSUFFICIENT_SCOPE',
            message: `Token missing required scope: ${requiredScopes.join(' or ')}`,
          },
        });
      }
      return handler(req, res);
    };
  };
}
