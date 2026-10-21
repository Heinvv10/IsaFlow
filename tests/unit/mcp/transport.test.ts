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
    companyRole: 'viewer',
  },
}));

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
    // The registry runs every tool inside a savepoint; here it just runs the callback.
    withSavepoint: vi.fn((_name: string, cb: () => unknown) => cb()),
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
import { SystemRoleLockTimeoutError } from '@/modules/accounting/services/gl/systemRoleWriteLock';
import { GlAccountLockTimeoutError } from '@/modules/accounting/services/gl/glAccountLock';

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

// Tools that fail in the ways a batch can meet (the role-lock one is the only one that stops it).
const counts = { roleBusy: 0 };
const failing = (name: string, handler: () => Promise<never> | Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }>) =>
  mcpRegistry.register({ name, description: 'test tool', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    scope: 'read:reports', write: false, handler });
failing('role_busy', async () => { counts.roleBusy += 1; throw new SystemRoleLockTimeoutError(); });
failing('row_busy', async () => { throw new GlAccountLockTimeoutError('acct-1'); });
failing('boom', async () => { throw new Error('Connection terminated unexpectedly'); });
failing('refuses', async () => ({ content: [{ type: 'text', text: 'not allowed' }], isError: true }));

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
  counts.roleBusy = 0;
  vi.mocked(hasFeature).mockResolvedValue(true);
  vi.mocked(checkRateLimit).mockResolvedValue(true);
});

describe('/api/mcp transport', () => {
  it('OPTIONS → 204 with CORS headers, no auth', async () => {
    const res = makeRes();
    await route(makeReq('OPTIONS') as never, res);
    expect(res.statusCode).toBe(204);
    // FB-3: the MCP request headers a browser client sends, and the ones it must read.
    expect(res.headers['access-control-allow-headers']).toBe(
      'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID',
    );
    expect(res.headers['access-control-expose-headers']).toBe('WWW-Authenticate, Mcp-Session-Id');
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
    expect(hasFeature).not.toHaveBeenCalled();
  });

  // FB-3: Streamable HTTP says a GET MUST return an SSE stream or 405. We
  // open no stream, so an MCP client's GET (Accept: text/event-stream) is 405.
  it('GET asking for text/event-stream → 405, no server-info body', async () => {
    for (const accept of ['text/event-stream', 'application/json, text/event-stream', 'TEXT/EVENT-STREAM']) {
      const res = makeRes();
      await route({ ...makeReq('GET'), headers: { accept } } as never, res);
      expect(res.statusCode, accept).toBe(405);
      expect(String(res.headers.allow)).toContain('POST');
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect((res.body as Record<string, unknown>).tools).toBeUndefined();
    }
    expect(hasFeature).not.toHaveBeenCalled();
  });

  it('server/discover → the legacy version only, so a 2026-07-28 client falls back to initialize', async () => {
    const res = makeRes();
    await route(makeReq('POST', rpc('server/discover', {})) as never, res);
    expect(res.statusCode).toBe(200);
    const result = (res.body as Record<string, unknown>).result as Record<string, unknown>;
    expect(result.supportedVersions).toEqual(['2025-06-18']);
    expect(result.resultType).toBe('complete');
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    const meta = result._meta as Record<string, Record<string, unknown>>;
    expect(meta['io.modelcontextprotocol/serverInfo']).toMatchObject({ name: 'isaflow', version: '1.0.0' });
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

  // serverInfo.icons is SEP-973 (2025-11-25) — the server states its own branding
  it('initialize → protocol version, server info + icons, tools capability', async () => {
    const res = makeRes();
    await route(makeReq('POST', rpc('initialize', {})) as never, res);
    expect(res.statusCode).toBe(200);
    const result = (res.body as Record<string, unknown>).result as Record<string, unknown>;
    expect(res.body).toMatchObject({ jsonrpc: '2.0', id: 1 });
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });

    const serverInfo = result.serverInfo as Record<string, unknown>;
    // Exact key set — toMatchObject alone would let a stray field through.
    expect(Object.keys(serverInfo).sort()).toEqual(['icons', 'name', 'title', 'version']);
    expect(serverInfo).toMatchObject({ name: 'isaflow', version: '1.0.0', title: 'IsaFlow Accounting' });
    // Absolute URIs — a remote client has no base for a relative path.
    expect(serverInfo.icons).toEqual([
      { src: expect.stringMatching(/^https?:\/\/[^/]+\/icons\/icon-192\.png$/), mimeType: 'image/png', sizes: ['192x192'] },
      { src: expect.stringMatching(/^https?:\/\/[^/]+\/icons\/icon-512\.png$/), mimeType: 'image/png', sizes: ['512x512'] },
    ]);
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
    // The membership role the bearer pipeline resolved is what payroll tools are fenced on (D3 round 3).
    expect(seenContexts[0]!.companyRole).toBe('viewer');
    const result = (res.body as { result: { content: Array<{ text: string }> } }).result;
    expect(result.content[0]!.text).toContain(COMPANY_ID);
  });

  it('a request with NO resolved role reaches the tool as null, and a fenced tool refuses it', async () => {
    const saved = { ...h.auth };
    try {
      (h.auth as Record<string, unknown>).companyRole = undefined;
      (h.auth as Record<string, unknown>).scopes = ['read:reports', 'read:payroll', 'write:payroll'];
      const res = makeRes();
      await route(makeReq('POST', rpc('tools/call', { name: 'echo_ctx', arguments: {} })) as never, res);
      expect(seenContexts.at(-1)!.companyRole).toBeNull(); // never defaulted to a role
      const refused = makeRes();
      await route(makeReq('POST', rpc('tools/call', { name: 'get_employee', arguments: { employee_id: '11111111-1111-4111-8111-111111111111' } })) as never, refused);
      const text = JSON.stringify(refused.body);
      expect(text).toMatch(/owner, admin and manager/);
    } finally {
      Object.assign(h.auth, saved);
    }
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
      // G3: names who can switch it on, never an upgrade.
      expect(err.message).toBe(
        'MCP connector not enabled for this company. Contact ISAFlow support to have it switched on.',
      );
      expect(err.message).not.toMatch(/upgrade|plan|subscri/i);
      // The request's id, not null: a null-id reply to a request that carried
      // an id is shown by MCP clients as a malformed result, hiding the message.
      expect((res.body as { id: unknown }).id).toBe(1);
    }
    expect(hasFeature).toHaveBeenCalledWith(COMPANY_ID, 'mcp_connector');
    expect(seenContexts).toHaveLength(0);
  });

  it('per-company rate limit 120/min → -32000 when exceeded', async () => {
    // mcp-ip throttle passes; only the per-company bucket is exhausted.
    vi.mocked(checkRateLimit).mockImplementation(async (key: string) => !key.startsWith('mcp:'));
    const res = makeRes();
    await route(makeReq('POST', rpc('ping')) as never, res);
    expect(checkRateLimit).toHaveBeenCalledWith(`mcp:${COMPANY_ID}`, { max: 120, windowSecs: 60, cost: 1 });
    expect((res.body as { error: { code: number } }).error.code).toBe(-32000);
    expect((res.body as { id: unknown }).id).toBe(1);
    expect((res.body as { error: { data: unknown } }).error.data).toEqual({ limitPerMinute: 120, windowSeconds: 60 });
  });

  const companyCharges = () => vi.mocked(checkRateLimit).mock.calls.filter(([k]) => (k as string).startsWith('mcp:'));
  it('a batch charges the per-company limiter its call count, once (R-175; more in transportBatchCharge)', async () => {
    await route(makeReq('POST', [rpc('ping', undefined, 1), rpc('ping', undefined, 2), rpc('ping', undefined, 3)]) as never, makeRes());
    expect(companyCharges()).toEqual([[`mcp:${COMPANY_ID}`, { max: 120, windowSecs: 60, cost: 3 }]]);
  });

  it('an over-large batch (>20) → 400 invalid request, nothing dispatched', async () => {
    const big = Array.from({ length: 21 }, (_, i) => rpc('ping', undefined, i));
    const res = makeRes();
    await route(makeReq('POST', big) as never, res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: number } }).error.code).toBe(-32600);
    expect(seenContexts).toHaveLength(0);
  });

  it('batch RPCs run sequentially (single shared pg connection safety)', async () => {
    // With sequential dispatch, both tools/call entries resolve and return in order.
    const res = makeRes();
    await route(makeReq('POST', [
      rpc('tools/call', { name: 'echo_ctx', arguments: {} }, 1),
      rpc('tools/call', { name: 'echo_ctx', arguments: {} }, 2),
    ]) as never, res);
    expect(seenContexts).toHaveLength(2);
    expect((res.body as Array<{ id: number }>).map((b) => b.id)).toEqual([1, 2]);
  });

  it('a batch stops running tool calls after the first role-lock refusal: the rest are answered at once as not run', async () => {
    // Each call behind a held role lock would wait 5s on the request's one pooled connection (20 calls: 100s).
    const res = makeRes();
    await route(makeReq('POST', [
      rpc('tools/call', { name: 'echo_ctx', arguments: {} }, 1),
      rpc('tools/call', { name: 'role_busy', arguments: {} }, 2),
      rpc('tools/call', { name: 'role_busy', arguments: {} }, 3),
      rpc('ping', undefined, 4),
      rpc('tools/call', { name: 'echo_ctx', arguments: {} }, 5),
    ]) as never, res);
    const body = res.body as Array<{ id: number; result: { isError?: boolean; content?: { text: string }[] } }>;
    const retry = 'The chart of accounts is being changed by another request — retry in a moment.';
    const text = (id: number) => { const r = body.find((b) => b.id === id)!.result; return `${r.isError}:${r.content?.[0]?.text}`; };
    // The call that waited gets the lock's refusal; the calls not run say so. The batch was charged its full five up front.
    expect({ roleBusyRuns: counts.roleBusy, echoRuns: seenContexts.length, ids: body.map((b) => b.id), ping: body[3]!.result, waited: text(2), skipped: [text(3), text(5)] })
      .toEqual({ roleBusyRuns: 1, echoRuns: 1, ids: [1, 2, 3, 4, 5], ping: {}, waited: `true:${retry}`,
        skipped: Array(2).fill(expect.stringMatching(/^true:Not run: an earlier call in this batch found the chart of accounts being changed.*Nothing was written and no Flows were debited for this call; it still counted towards the batch's rate limit/)) });
    expect(companyCharges()).toEqual([[`mcp:${COMPANY_ID}`, { max: 120, windowSecs: 60, cost: 5 }]]);
  });

  it('no other failure stops a batch: a thrown error, a returned tool error and a row-lock timeout each leave the later calls running', async () => {
    const res = makeRes();
    await route(makeReq('POST', [
      rpc('tools/call', { name: 'boom', arguments: {} }, 1),
      rpc('tools/call', { name: 'refuses', arguments: {} }, 2),
      rpc('tools/call', { name: 'row_busy', arguments: {} }, 3),
      rpc('tools/call', { name: 'echo_ctx', arguments: {} }, 4),
      rpc('tools/call', { name: 'echo_ctx', arguments: {} }, 5),
    ]) as never, res);
    const body = res.body as Array<{ id: number; result: { isError?: boolean; content?: { text: string }[] } }>;
    expect({ echoRuns: seenContexts.length, errors: body.map((b) => b.result.isError === true),
      rowBusy: body[2]!.result.content?.[0]?.text })
      .toEqual({ echoRuns: 2, errors: [true, true, true, false, false], rowBusy: 'GL account acct-1 is being changed by another request — retry in a moment.' });
  });

  it('non-GET/POST/OPTIONS → 405', async () => {
    const res = makeRes();
    await route(makeReq('PUT', {}) as never, res);
    expect(res.statusCode).toBe(405);
  });

  it('pre-auth per-IP throttle → 429 before any auth/dispatch', async () => {
    // The mcp-ip bucket is checked at the route level before withBearerAuth.
    vi.mocked(checkRateLimit).mockImplementation(async (key: string) => !key.startsWith('mcp-ip:'));
    const res = makeRes();
    await route(makeReq('POST', rpc('ping')) as never, res);
    expect(checkRateLimit).toHaveBeenCalledWith('mcp-ip:10.0.0.1', { max: 300, windowSecs: 60 });
    expect(res.statusCode).toBe(429);
    expect((res.body as { id: unknown }).id).toBe(1);
    expect(seenContexts).toHaveLength(0); // never reached a tool
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(String(res.headers['access-control-expose-headers'])).toContain('WWW-Authenticate');
  });

  it('per-company rate limit (429-equivalent refusal) carries CORS headers too', async () => {
    vi.mocked(checkRateLimit).mockImplementation(async (key: string) => !key.startsWith('mcp:'));
    const res = makeRes();
    await route(makeReq('POST', rpc('ping')) as never, res);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('pre-auth per-IP throttle does not echo an oversized id', async () => {
    vi.mocked(checkRateLimit).mockImplementation(async (key: string) => !key.startsWith('mcp-ip:'));
    const res = makeRes();
    await route(makeReq('POST', { ...rpc('ping'), id: 'x'.repeat(201) }) as never, res);
    expect(res.statusCode).toBe(429);
    expect((res.body as { id: unknown }).id).toBeNull();
  });
});
