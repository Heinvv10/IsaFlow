/**
 * Strict Bearer-only wrapper — the MCP endpoint's auth (CSRF posture:
 * cookies are NEVER accepted, so a browser can't be confused into calling
 * /api/mcp with ambient credentials).
 *
 * Same context/GUC/membership behaviour as the Bearer branch of
 * withBearerOrCookieAuth (shared pipeline — src/lib/auth/bearerPipeline.ts),
 * but an absent/invalid Bearer token → 401 with a WWW-Authenticate challenge
 * pointing at the RFC 9728 resource-metadata document. The challenge is how
 * Claude-family clients discover they must run the OAuth flow.
 */
import type { NextApiHandler, NextApiResponse } from 'next';
import { extractBearerToken } from './captureApiKeyAuth';
import { runBearerRequest, type BearerHandler } from './bearerPipeline';

function appOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za';
}

function setChallenge(res: NextApiResponse): void {
  res.setHeader(
    'WWW-Authenticate',
    `Bearer realm="IsaFlow MCP", resource_metadata="${appOrigin()}/.well-known/oauth-protected-resource"`,
  );
}

export function withBearerAuth(handler: BearerHandler): NextApiHandler {
  return async (req, res) => {
    const authHeader = req.headers.authorization;
    const rawToken = extractBearerToken(typeof authHeader === 'string' ? authHeader : undefined);

    // No Bearer credential at all (including cookie-only requests) → 401 +
    // challenge. Cookies are intentionally ignored on this wrapper.
    if (!rawToken) {
      setChallenge(res);
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Bearer token required' },
      });
      return;
    }

    return runBearerRequest(req, res, rawToken, handler, { onAuthFailure: setChallenge });
  };
}
