/**
 * CORS for /api/mcp, in one place (FB-3).
 *
 * `Access-Control-Allow-Origin: *` is safe here, unlike the app's allow-listed
 * `apiResponse.setCorsHeaders`: the endpoint is Bearer-only and never reads a
 * cookie (withBearerAuth), so a cross-origin page gains nothing it could not
 * do with the token itself.
 *
 * The allowed headers are the ones MCP clients send (Streamable HTTP: the
 * protocol-version header on every POST, session id on 2025 revisions,
 * Mcp-Method / Mcp-Name on 2026-07-28, Last-Event-ID on resumption). The
 * exposed headers are what a browser client must be able to READ: the 401's
 * WWW-Authenticate is how it discovers the OAuth flow, and without exposing it
 * a browser client sees a bare 401.
 *
 * withBearerAuth sets these before it can answer 401, so the challenge reaches
 * browser clients too; the transport sets them on every other answer.
 */
import type { NextApiResponse } from 'next';

export const MCP_CORS_ALLOW_HEADERS =
  'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID';
export const MCP_CORS_EXPOSE_HEADERS = 'WWW-Authenticate, Mcp-Session-Id';
export const MCP_CORS_ALLOW_METHODS = 'GET, POST, OPTIONS';

export function setMcpCors(res: NextApiResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', MCP_CORS_ALLOW_HEADERS);
  res.setHeader('Access-Control-Allow-Methods', MCP_CORS_ALLOW_METHODS);
  res.setHeader('Access-Control-Expose-Headers', MCP_CORS_EXPOSE_HEADERS);
}
