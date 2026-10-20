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
import { DEFAULT_MCP_SCOPES } from './oauthScopes';
import { setMcpCors } from '@/lib/mcp/httpCors';

function appOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za';
}

/**
 * `scope` is the read-only default (MCP 2025-11-25: the challenge SHOULD carry
 * one), so a client that would otherwise ask for nothing has a starting set.
 */
export function bearerChallenge(): string {
  return (
    `Bearer realm="IsaFlow MCP", ` +
    `resource_metadata="${appOrigin()}/.well-known/oauth-protected-resource", ` +
    `scope="${DEFAULT_MCP_SCOPES.join(' ')}"`
  );
}

function setChallenge(res: NextApiResponse): void {
  res.setHeader('WWW-Authenticate', bearerChallenge());
}

export function withBearerAuth(handler: BearerHandler): NextApiHandler {
  return async (req, res) => {
    // CORS first, so every answer this wrapper gives — the 401 challenge
    // included — is readable by a browser client (FB-3). Safe with `*`: this
    // wrapper never reads a cookie.
    setMcpCors(res);
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
