/**
 * /api/mcp JSON-RPC transport — MCP Phase 2, Task 2.4.
 *
 * Invariants:
 *  - ctx (companyId/userId/scopes/jti) comes from the authenticated request,
 *    NEVER from JSON-RPC params
 *  - company without the mcp_connector flag → -32001 for every method
 *  - per-company rate limit 120/min → -32000
 *  - GET/OPTIONS are unauthenticated (discovery); POST is Bearer-only
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  auth: {
    user: { id: 'user-gotrue-1' },
    companyId: '22222222-2222-2222-2222-222222222222',
    scopes: ['read:reports'],
    patId: 'pat-jti-1',
    authMethod: 'pat' as const,
  },
}));

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/auth/withBearerAuth', () => ({
  // Simulates a successfully authenticated Bearer request: attaches the auth
  // context and calls through. Auth-failure paths are covered by the
  // withBearerAuth suite (Task 2.3), not re-tested here.
  withBearerAuth: (handler: (req: unknown, res: unknown) => unknown) =>
    async (req: Record<string, unknown>, res: unknown) => {
      Object.assign(req, h.auth);
      return handler(req, res);
    },
}));

vi.mock('@/modules/admin/services/featureFlagService', () => ({
  hasFeature: vi.fn(async () => true),
}));

vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: vi.fn(async () => true),
  getClientIp: vi.fn(() => '10.0.0.1'),
}));

import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { checkRateLimit } from '@/lib/rateLimit';
import { mcpRegistry } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import type { McpToolContext } from '@/lib/mcp/types';
import route from '../../../pages/api/mcp/index';

const COMPANY_ID = h.auth.companyId;

// One controlled tool on the real (otherwise empty at this task) registry.
const seenContexts: McpToolContext[] = [];
mcpRegistry.register({
  name: 'echo_ctx',
  description: 'test tool — echoes its auth context',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  scope: 'read:reports',
  write: false,
  handler: async (_args, ctx) => {
    seenContexts.push(ctx);
    return { content: [{ type: 'text', text: JSON.stringify({ company: ctx.companyId }) }] };
  },
});

interface FakeRes {
  statusCode: number;
  body?: unknown;
  headers: Record<string, unknown>;
  ended: boolean;
}

function makeRes(): NextApiResponse & FakeRes {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, unknown>,
    body: undefined as unknown,
    ended: false,
    setHeader(k: string, v: unknown) { res.headers[k.toLowerCase()] = v; return res; },
    status(c: number) { res.statusCode = c; return res; },
    json(b: unknown) { res.body = b; return res; },
    end() { res.ended = true; return res; },
  };
  return res as unknown as NextApiResponse & FakeRes;
}

function makeReq(method: string, body?: unknown): Record<string, unknown> {
  return {
    method,
    body,
    headers: { 'content-type': 'application/json', authorization: 'Bearer pat_x' },
    url: '/api/mcp',
  };
}

function rpc(method: string, params?: Record<string, unknown>, id: number | undefined = 1) {
  return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
}

beforeEach(() => {
  vi.clearAllMocks();
  seenContexts.length = 0;
  vi.mocked(hasFeature).mockResolvedValue(true);
  vi.mocked(checkRateLimit).mockResolvedValue(true);
});

describe('/api/mcp transport', () => {
  it('OPTIONS → 204 with CORS headers, no auth', async () => {
    const res = makeRes();
    await route(makeReq('OPTIONS') as never, res);
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-headers']).toBe('Authorization, Content-Type');
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
    expect(hasFeature).not.toHaveBeenCalled();
  });

  it('GET → unauthenticated server-info with discovery URLs and client tool names', async () => {
    const res = makeRes();
    await route({ ...makeReq('GET'), headers: {} } as never, res);
    expect(res.statusCode).toBe(200);
    const b = res.body as Record<string, unknown>;
    expect(b.name).toBe('isaflow');
    expect(String(b.endpoint)).toMatch(/\/api\/mcp$/);
    expect((b.auth as Record<string, unknown>).authorizationServer).toContain(
      '/.well-known/oauth-authorization-server',
    );
    expect(b.tools).toEqual(CLIENT_MCP_TOOL_NAMES);
    expect(hasFeature).not.toHaveBeenCalled();
  });

  it('initialize → protocol version, server info, tools capability', async () => {
    const res = makeRes();
    await route(makeReq('POST', rpc('initialize', {})) as never, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'isaflow', version: '1.0.0', title: 'IsaFlow Accounting' },
        capabilities: { tools: { listChanged: false } },
      },
    });
  });

  it('ping → empty result; notifications/initialized → 202 no body', async () => {
    const ping = makeRes();
    await route(makeReq('POST', rpc('ping')) as never, ping);
    expect(ping.body).toEqual({ jsonrpc: '2.0', id: 1, result: {} });

    const note = makeRes();
    await route(makeReq('POST', { jsonrpc: '2.0', method: 'notifications/initialized' }) as never, note);
    expect(note.statusCode).toBe(202);
    expect(note.ended).toBe(true);
    expect(note.body).toBeUndefined();
  });

  it('tools/list → registry manifest', async () => {
    const res = makeRes();
    await route(makeReq('POST', rpc('tools/list')) as never, res);
    const result = (res.body as { result: { tools: Array<{ name: string }> } }).result;
    expect(result.tools.map((t) => t.name)).toContain('echo_ctx');
  });

  it('tools/call builds ctx from the REQUEST — params cannot inject a company', async () => {
    const res = makeRes();
    await route(
      makeReq('POST', rpc('tools/call', {
        name: 'echo_ctx',
        arguments: { company_id: '99999999-9999-9999-9999-999999999999' },
      })) as never,
      res,
    );
    expect(seenContexts).toHaveLength(1);
    expect(seenContexts[0]!.companyId).toBe(COMPANY_ID); // from req, not params
    expect(seenContexts[0]!.userId).toBe('user-gotrue-1');
    expect(seenContexts[0]!.tokenJti).toBe('pat-jti-1');
    const result = (res.body as { result: { content: Array<{ text: string }> } }).result;
    expect(result.content[0]!.text).toContain(COMPANY_ID);
  });

  it('tools/call without a name → -32602', async () => {
    const res = makeRes();
    await route(makeReq('POST', rpc('tools/call', { arguments: {} })) as never, res);
    expect((res.body as { error: { code: number } }).error.code).toBe(-32602);
  });

  it('unknown method → -32601', async () => {
    const res = makeRes();
    await route(makeReq('POST', rpc('resources/list')) as never, res);
    expect((res.body as { error: { code: number } }).error.code).toBe(-32601);
  });

  it('malformed body → -32700 with HTTP 400', async () => {
    const res = makeRes();
    await route(makeReq('POST', 'not-json-at-all') as never, res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: number } }).error.code).toBe(-32700);
  });

  it('batch array → one response per non-notification request', async () => {
    const res = makeRes();
    await route(
      makeReq('POST', [
        rpc('initialize', {}, 1),
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        rpc('ping', undefined, 2),
      ]) as never,
      res,
    );
    const bodies = res.body as Array<{ id: number }>;
    expect(bodies).toHaveLength(2);
    expect(bodies.map((b) => b.id)).toEqual([1, 2]);
  });

  it('company without mcp_connector → -32001 for every method', async () => {
    vi.mocked(hasFeature).mockResolvedValue(false);
    for (const method of ['initialize', 'tools/list', 'tools/call']) {
      const res = makeRes();
      await route(makeReq('POST', rpc(method, { name: 'echo_ctx' })) as never, res);
      const err = (res.body as { error: { code: number; message: string } }).error;
      expect(err.code).toBe(-32001);
      expect(err.message).toBe('MCP connector not enabled for this company');
    }
    expect(hasFeature).toHaveBeenCalledWith(COMPANY_ID, 'mcp_connector');
    expect(seenContexts).toHaveLength(0);
  });

  it('per-company rate limit 120/min → -32000 when exceeded', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue(false);
    const res = makeRes();
    await route(makeReq('POST', rpc('ping')) as never, res);
    expect(checkRateLimit).toHaveBeenCalledWith(`mcp:${COMPANY_ID}`, { max: 120, windowSecs: 60 });
    expect((res.body as { error: { code: number } }).error.code).toBe(-32000);
  });

  it('non-GET/POST/OPTIONS → 405', async () => {
    const res = makeRes();
    await route(makeReq('PUT', {}) as never, res);
    expect(res.statusCode).toBe(405);
  });
});
