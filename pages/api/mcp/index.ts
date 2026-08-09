/**
 * /api/mcp — MCP over HTTP, JSON-RPC 2.0 transport (pages-router adaptation
 * of ApexGEO's src/app/api/v1/mcp/route.ts).
 *
 * Methods: initialize, notifications/initialized, ping, tools/list,
 * tools/call — the complete set Claude Code / Desktop / claude.ai / Codex
 * use today. Single requests and batch arrays supported.
 *
 * Auth: POST is Bearer-only via withBearerAuth (401 + WWW-Authenticate
 * challenge; cookies never accepted — CSRF posture). GET serves an
 * UNAUTHENTICATED server-info document; OPTIONS handles CORS preflight.
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
  CLIENT_MCP_TOOL_NAMES,
  MCP_AUTH_SERVER_METADATA_PATH,
  MCP_PATH,
  MCP_PROD_ENDPOINT,
  MCP_PROTECTED_RESOURCE_METADATA_PATH,
} from '@/lib/mcp/clientMetadata';
import {
  MCP_PROTOCOL_VERSION,
  RPC_CODES,
  isNotification,
  rpcError,
  rpcResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '@/lib/mcp/jsonrpc';

const MAX_BATCH_SIZE = 20;

// Bound the request body to 32kb (a batch of ≤20 small JSON-RPC calls) instead
// of Next's 1MB default — same spirit as the /api/oauth/* 8kb caps, sized up
// for batches.
export const config = {
  api: { bodyParser: { sizeLimit: '32kb' } },
};

function appOrigin(): string {
  // Trailing slash would double up in every `${base}/path` below.
  return (process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za').replace(/\/+$/, '');
}

/**
 * Server branding for the client's connector list (SEP-973, spec revision
 * 2025-11-25 — declared ahead of MCP_PROTOCOL_VERSION; the 2025-06-18
 * Implementation schema sets no additionalProperties:false, so clients that
 * predate the field pass it through). Absolute URIs: a remote client has no
 * base to resolve a relative path against. Both PNGs are the white-on-teal
 * mark from public/icons/, which reads on light and dark, so no `theme` split.
 *
 * Motivation: with no server-supplied icon, a client falls back to scraping a
 * favicon off the domain. On 2026-08-09 claude.ai's connector list rendered the
 * .co.za registry's logo (ZA Central Registry) next to IsaFlow — the icon was
 * byte-matched to registry.net.za's favicon. Our own /favicon.ico is correct
 * and served, so the fallback, not our assets, produced it.
 */
function serverIcons(): Array<{ src: string; mimeType: string; sizes: string[] }> {
  const base = appOrigin();
  return [
    { src: `${base}/icons/icon-192.png`, mimeType: 'image/png', sizes: ['192x192'] },
    { src: `${base}/icons/icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] },
  ];
}

function setCors(res: NextApiResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

async function handleRpc(
  rpc: JsonRpcRequest,
  ctx: McpToolContext,
): Promise<JsonRpcResponse | null> {
  if (!rpc || typeof rpc !== 'object' || typeof rpc.method !== 'string') {
    return rpcError(null, RPC_CODES.INVALID_REQUEST, 'Invalid Request');
  }

  switch (rpc.method) {
    case 'initialize':
      return rpcResult(rpc.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: {
          name: 'isaflow',
          version: '1.0.0',
          title: 'IsaFlow Accounting',
          icons: serverIcons(),
        },
        capabilities: { tools: { listChanged: false } },
      });

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
  setCors(res);

  const enabled = await hasFeature(req.companyId, 'mcp_connector');
  if (!enabled) {
    res.status(200).json(
      rpcError(null, RPC_CODES.NOT_ENABLED, 'MCP connector not enabled for this company'),
    );
    return;
  }

  const body = req.body as unknown;
  if (body === null || body === undefined || typeof body !== 'object') {
    res.status(400).json(rpcError(null, RPC_CODES.PARSE_ERROR, 'Parse error — invalid JSON'));
    return;
  }

  // A batch packs N JSON-RPC calls into one HTTP request. Cap the batch and
  // charge the per-company limiter PER CALL so a batch can't bypass the
  // 120/min budget (one request could otherwise pack hundreds of writes).
  const rpcCount = Array.isArray(body) ? body.length : 1;
  if (rpcCount > MAX_BATCH_SIZE) {
    res.status(400).json(
      rpcError(null, RPC_CODES.INVALID_REQUEST, `Batch too large (max ${MAX_BATCH_SIZE})`),
    );
    return;
  }
  for (let i = 0; i < rpcCount; i++) {
    const allowed = await checkRateLimit(`mcp:${req.companyId}`, { max: 120, windowSecs: 60 });
    if (!allowed) {
      res.status(200).json(
        rpcError(null, RPC_CODES.SERVER_ERROR, 'Rate limit exceeded. Slow down and retry.'),
      );
      return;
    }
  }

  const ctx: McpToolContext = {
    userId: req.user.id,
    companyId: req.companyId,
    scopes: req.scopes ?? [],
    tokenJti: req.patId ?? req.oauthAuthorisationId ?? null,
    oauthAppId: req.oauthAppId ?? null,
  };

  if (Array.isArray(body)) {
    // Sequential, NOT Promise.all — every RPC shares one pg connection (the
    // request's ALS-bound client); concurrent queries/savepoints on a single
    // connection corrupt each other (postgresql-gotchas §36).
    const responses: JsonRpcResponse[] = [];
    for (const r of body as JsonRpcRequest[]) {
      const resp = await handleRpc(r, ctx);
      if (resp !== null) responses.push(resp);
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
    setCors(res);
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
    return;
  }

  if (req.method === 'GET') {
    // Unauthenticated server-info advertisement (MCP spec allows GET).
    setCors(res);
    const origin = appOrigin();
    res.status(200).json({
      name: 'isaflow',
      version: '1.0.0',
      protocolVersion: MCP_PROTOCOL_VERSION,
      transport: 'http-jsonrpc',
      endpoint: `${origin}${MCP_PATH}`,
      productionEndpoint: MCP_PROD_ENDPOINT,
      auth: {
        type: 'bearer',
        description:
          'Connect with the browser OAuth flow (recommended) or a personal access token (pat_...).',
        authorizationServer: `${origin}${MCP_AUTH_SERVER_METADATA_PATH}`,
        protectedResource: `${origin}${MCP_PROTECTED_RESOURCE_METADATA_PATH}`,
      },
      tools: CLIENT_MCP_TOOL_NAMES,
    });
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
    setCors(res);
    res.status(429).json(rpcError(null, RPC_CODES.SERVER_ERROR, 'Too many requests. Slow down and retry.'));
    return;
  }

  return authedPost(req, res);
};

export default route;
