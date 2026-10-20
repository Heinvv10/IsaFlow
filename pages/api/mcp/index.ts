/**
 * /api/mcp — MCP over HTTP, JSON-RPC 2.0 transport (pages-router adaptation
 * of ApexGEO's src/app/api/v1/mcp/route.ts).
 *
 * Methods: initialize, notifications/initialized, ping, tools/list,
 * tools/call — the complete set Claude Code / Desktop / claude.ai / Codex
 * use today — plus server/discover for 2026-07-28 clients (lists only the
 * legacy version, so they fall back to initialize). Single requests and
 * batch arrays supported.
 *
 * Auth: POST is Bearer-only via withBearerAuth (401 + WWW-Authenticate
 * challenge; cookies never accepted — CSRF posture). GET serves an
 * UNAUTHENTICATED server-info document, except that a GET asking for
 * text/event-stream is 405 (no SSE stream); OPTIONS handles CORS preflight.
 * (Plan wrapped the whole route in withBearerAuth; GET/OPTIONS must stay
 * open for client discovery, so only POST is wrapped.)
 *
 * Tenant: McpToolContext is built from the authenticated request ONLY —
 * companyId/userId/scopes/jti never come from JSON-RPC params.
 * Gating: per-company mcp_connector feature flag (dark by default) and a
 * 120 req/min per-company rate limit.
 *
 * Responses are raw JSON-RPC 2.0 envelopes ({jsonrpc,id,result|error}), NOT
 * the app's apiResponse {success,data} shape — MCP clients parse the RPC
 * envelope verbatim, so apiResponse would break them. This is a deliberate,
 * documented exception to the CLAUDE.md "responses via apiResponse.*" rule
 * (same precedent as /api/oauth/token and the discovery endpoints).
 */
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withBearerAuth } from '@/lib/auth/withBearerAuth';
import type { BearerAuthedRequest } from '@/lib/auth/bearerPipeline';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { log } from '@/lib/logger';
import { mcpRegistry } from '@/lib/mcp/toolIndex';
import type { McpToolContext } from '@/lib/mcp/types';
import {
  companyRateLimited,
  connectorNotEnabled,
  ipThrottled,
} from '@/lib/mcp/transportRefusals';
import { skippedForRoleLock } from '@/lib/mcp/batchSkip';
import { isRoleLockRefusal } from '@/modules/accounting/services/gl/systemRoleWriteLock';
import { discoverResult, initializeResult, serverInfoDocument } from '@/lib/mcp/serverInfo';
import { setMcpCors } from '@/lib/mcp/httpCors';
import {
  RPC_CODES,
  isNotification,
  rpcError,
  rpcResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '@/lib/mcp/jsonrpc';

const MAX_BATCH_SIZE = 20;

// Bound the request body to Next's 1MB default. It was 32kb (a batch of ≤20
// small JSON-RPC calls) until import_bank_statement, which carries a whole
// statement file: 32kb fits only ~150-250 OFX transactions, well under a
// months-long catch-up on a busy account.
//
// This is a real 32× increase in per-request cost. Since R-175 checkRateLimit
// counts every admitted call on the shared counter (a refused call consumes
// nothing), so the per-IP 300/min holds at its nominal value across processes.
// Next still parses the body before the handler runs, so the buffer +
// JSON.parse cost is paid ahead of both the per-IP check below and any
// authentication.
//
// Accepted deliberately for the import use case. If MCP traffic grows, the
// right fix is a size check keyed on the tool being called rather than one
// endpoint-wide ceiling — every other tool needs only a few kb.
// Raised to 3mb for attach_entity_document (2 MB file → ~2.7 MB base64):
// 183 of 4,870 historical supplier-bill scans exceed 750 KB, the largest
// 1.9 MB. Same trade-off as above; every tool still enforces its own cap.
export const config = {
  api: { bodyParser: { sizeLimit: '3mb' } },
};

async function handleRpc(
  rpc: JsonRpcRequest,
  ctx: McpToolContext,
): Promise<JsonRpcResponse | null> {
  if (!rpc || typeof rpc !== 'object' || typeof rpc.method !== 'string') {
    return rpcError(null, RPC_CODES.INVALID_REQUEST, 'Invalid Request');
  }

  switch (rpc.method) {
    case 'initialize':
      return rpcResult(rpc.id, initializeResult());

    case 'server/discover':
      // 2026-07-28 probe: lists only the legacy version, so a dual-era client
      // falls back to `initialize` (src/lib/mcp/serverInfo.ts). Behind
      // withBearerAuth like every POST; a 401 + challenge is a valid answer.
      return rpcResult(rpc.id, discoverResult());

    case 'notifications/initialized':
      // Pure notification — acknowledged with no response entry.
      return null;

    case 'ping':
      return rpcResult(rpc.id, {});

    case 'tools/list':
      return rpcResult(rpc.id, { tools: mcpRegistry.getManifest() });

    case 'tools/call': {
      const toolName = rpc.params?.name;
      const toolArgs = (rpc.params?.arguments as Record<string, unknown> | undefined) ?? {};
      if (typeof toolName !== 'string' || !toolName) {
        return rpcError(rpc.id, RPC_CODES.INVALID_PARAMS, 'tool name required');
      }
      try {
        // Unknown tools / scope rejections come back as normal isError tool
        // results so MCP clients can relay them to the model.
        const result = await mcpRegistry.call(toolName, toolArgs, ctx);
        return rpcResult(rpc.id, result);
      } catch (err) {
        log.error(
          'MCP transport: tool dispatch failed',
          { tool: toolName, err: err instanceof Error ? err.message : String(err) },
          'mcp',
        );
        return rpcError(rpc.id, RPC_CODES.INTERNAL_ERROR, 'Internal error executing tool');
      }
    }

    default:
      return rpcError(rpc.id, RPC_CODES.METHOD_NOT_FOUND, `method not found: ${rpc.method}`);
  }
}

const postHandler = async (req: BearerAuthedRequest, res: NextApiResponse): Promise<void> => {
  setMcpCors(res);

  const enabled = await hasFeature(req.companyId, 'mcp_connector');
  if (!enabled) {
    res.status(200).json(connectorNotEnabled(req.body));
    return;
  }

  const body = req.body as unknown;
  if (body === null || body === undefined || typeof body !== 'object') {
    res.status(400).json(rpcError(null, RPC_CODES.PARSE_ERROR, 'Parse error — invalid JSON'));
    return;
  }

  // A batch packs N JSON-RPC calls into one HTTP request. Cap the batch and
  // charge the per-company limiter one unit PER CALL so a batch can't bypass
  // the 120/min budget (one request could otherwise pack hundreds of writes).
  // One atomic charge of N (R-175): the whole batch fits and is charged, or
  // nothing is charged and the batch is refused. Charging a unit at a time
  // spent what was left of the window on a batch that then ran nothing.
  // Calls a role-lock skip later leaves unrun stay charged, as before.
  const rpcCount = Array.isArray(body) ? body.length : 1;
  if (rpcCount > MAX_BATCH_SIZE) {
    res.status(400).json(
      rpcError(null, RPC_CODES.INVALID_REQUEST, `Batch too large (max ${MAX_BATCH_SIZE})`),
    );
    return;
  }
  if (rpcCount > 0 && !(await checkRateLimit(`mcp:${req.companyId}`, { max: 120, windowSecs: 60, cost: rpcCount }))) {
    res.status(200).json(companyRateLimited(body));
    return;
  }

  const ctx: McpToolContext = {
    userId: req.user.id,
    companyId: req.companyId,
    scopes: req.scopes ?? [],
    tokenJti: req.patId ?? req.oauthAuthorisationId ?? null,
    oauthAppId: req.oauthAppId ?? null,
    companyRole: req.companyRole ?? null,
  };

  if (Array.isArray(body)) {
    // Sequential, NOT Promise.all — every RPC shares one pg connection (the
    // request's ALS-bound client); concurrent queries/savepoints on a single
    // connection corrupt each other (postgresql-gotchas §36).
    const responses: JsonRpcResponse[] = [];
    // Once one call has waited out the company's role-write lock (5s), the tool
    // calls after it are not run — each would wait 5s more on this one pooled
    // connection: audited as rejected and told why (`batchSkip`). No other error stops a batch.
    let roleLockBusy = false;
    for (const r of body as JsonRpcRequest[]) {
      const skipped = roleLockBusy ? await skippedForRoleLock(r, ctx) : null;   // null: not a tool call — answered as usual
      const resp = skipped ? rpcResult(r.id, skipped) : await handleRpc(r, ctx);
      if (resp !== null) responses.push(resp);
      roleLockBusy ||= isRoleLockRefusal(resp?.result);
    }
    if (responses.length === 0) {
      res.status(202).end();
      return;
    }
    res.status(200).json(responses);
    return;
  }

  const single = body as JsonRpcRequest;
  const response = await handleRpc(single, ctx);
  if (response === null || (isNotification(single) && !response.error)) {
    res.status(202).end();
    return;
  }
  res.status(200).json(response);
};

const authedPost = withBearerAuth(
  withErrorHandler(postHandler as Parameters<typeof withErrorHandler>[0]),
);

const route: NextApiHandler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === 'OPTIONS') {
    setMcpCors(res);
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
    return;
  }

  if (req.method === 'GET') {
    setMcpCors(res);
    // An MCP client's GET asks for a server-to-client SSE stream (Streamable
    // HTTP 2025-06-18/11-25: answer text/event-stream or 405). We open none,
    // so 405. A GET without that Accept (a person, a docs link) still gets
    // the server-info document.
    const accept = String(req.headers.accept ?? '');
    if (accept.toLowerCase().includes('text/event-stream')) {
      res.setHeader('Allow', 'GET, POST, OPTIONS');
      res.status(405).json({
        success: false,
        error: { code: 'METHOD_NOT_ALLOWED', message: 'No SSE stream on GET; use POST for JSON-RPC' },
      });
      return;
    }
    res.status(200).json(serverInfoDocument());
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for JSON-RPC' } });
    return;
  }

  // Pre-auth per-IP throttle — the per-company 120/min limiter only runs AFTER
  // a valid token; without this an anonymous caller could spam garbage bearer
  // tokens, each costing a token-hash DB lookup. Bounds that before auth.
  const ip = getClientIp(req);
  if (!(await checkRateLimit(`mcp-ip:${ip}`, { max: 300, windowSecs: 60 }))) {
    setMcpCors(res);
    res.status(429).json(ipThrottled(req.body));
    return;
  }

  return authedPost(req, res);
};

export default route;
