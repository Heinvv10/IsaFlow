/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * Served at /.well-known/oauth-protected-resource (and the /api/mcp-suffixed
 * variant) via next.config.js rewrites. Unauthenticated public discovery:
 * tells MCP clients that /api/mcp is the protected resource, that Bearer
 * tokens go in the Authorization header only (never query/body — CSRF
 * posture), and which authorization server issues its tokens.
 *
 * Raw RFC document shape, not the apiResponse envelope (client-parsed).
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
    resource: `${base}/api/mcp`,
    resource_name: 'IsaFlow MCP',
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: [...OAUTH_SCOPES],
  });
};

export default withErrorHandler(handler);
