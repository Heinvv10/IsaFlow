/**
 * Transport-level refusals for /api/mcp — the JSON-RPC error envelopes the
 * route answers with before any method is dispatched (connector off, per-company
 * rate limit, per-IP throttle). Each echoes the request id via `refusalId`.
 */
import { RPC_CODES, rpcError, type JsonRpcRequest, type JsonRpcResponse } from '@/lib/mcp/jsonrpc';

/**
 * The id to answer a transport-level refusal with. JSON-RPC lets a server reply
 * `id: null` only when it cannot determine the request id — but a single
 * request's id is right there in the body, and a null-id reply to a request
 * that carried one is what MCP clients report as a "malformed result" with the
 * real message (rate limit, connector off) never shown. A batch has no single
 * id, so it keeps null.
 */
export function refusalId(body: unknown): JsonRpcRequest['id'] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const id = (body as JsonRpcRequest).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

export function connectorNotEnabled(body: unknown): JsonRpcResponse {
  return rpcError(refusalId(body), RPC_CODES.NOT_ENABLED, 'MCP connector not enabled for this company');
}

export function companyRateLimited(body: unknown): JsonRpcResponse {
  return rpcError(refusalId(body), RPC_CODES.SERVER_ERROR, 'Rate limit exceeded. Slow down and retry.', {
    // Mirrors the { max: 120, windowSecs: 60 } checkRateLimit call in pages/api/mcp/index.ts
    // (kept literal there: the rate-limit key census reads literal options only).
    limitPerMinute: 120,
    retryAfterSeconds: 60,
  });
}

export function ipThrottled(body: unknown): JsonRpcResponse {
  return rpcError(refusalId(body), RPC_CODES.SERVER_ERROR, 'Too many requests. Slow down and retry.');
}
