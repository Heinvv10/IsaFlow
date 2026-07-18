/**
 * Either-or auth wrapper (PRD-10 Layer 3, extensible to Layer 2 OAuth).
 *
 *   - If the request carries a `Bearer pat_…`/`oat_…` token, run the shared
 *     Bearer pipeline (src/lib/auth/bearerPipeline.ts): validate, app_user
 *     transaction with set_config jwt claims, membership re-check — mirroring
 *     withAuth's RLS setup so handlers downstream behave identically.
 *   - Otherwise, delegate to the existing cookie-based withAuth.
 *
 * Bearer-authed requests intentionally bypass withCsrf (the Bearer header IS
 * the credential — the existing capture-route pattern at
 * pages/api/accounting/capture/upload.ts:182-207). Routes wrapping this should
 * NOT also wrap withCsrf, or the Bearer caller will get 403s.
 */
import type { NextApiHandler } from 'next';
import { extractBearerToken } from './captureApiKeyAuth';
import { withAuth } from './withAuth';
import { runBearerRequest, type BearerHandler, type BearerAuthedRequest } from './bearerPipeline';

export function withBearerOrCookieAuth(handler: BearerHandler): NextApiHandler {
  return async (req, res) => {
    const authHeader = req.headers.authorization;
    const rawToken = extractBearerToken(typeof authHeader === 'string' ? authHeader : undefined);

    // No Bearer header → standard cookie auth path.
    if (!rawToken) return withAuth(handler)(req, res);

    return runBearerRequest(req, res, rawToken, handler);
  };
}

export type { BearerAuthedRequest };
