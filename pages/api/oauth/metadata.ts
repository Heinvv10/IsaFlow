/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414).
 *
 * Served at /.well-known/oauth-authorization-server via next.config.js rewrite.
 * Unauthenticated by design — this is public discovery data that lets MCP
 * clients (Claude Code / Desktop / claude.ai / Codex) find the authorize,
 * token, and dynamic-registration endpoints with zero manual setup.
 *
 * Response is the raw RFC document (NOT the apiResponse envelope) — OAuth
 * clients parse this shape verbatim, same precedent as /api/oauth/token.
 */
import type { NextApiHandler } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { OAUTH_SCOPES } from '@/lib/auth/oauth';

function appOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za';
}

const handler: NextApiHandler = (req, res) => {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  }
  const base = appOrigin();
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    // 'none' = dynamically-registered public clients (PKCE-only);
    // secret-post = pre-registered confidential clients.
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: [...OAUTH_SCOPES],
  });
};

export default withErrorHandler(handler);
