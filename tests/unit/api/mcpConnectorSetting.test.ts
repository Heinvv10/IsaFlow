/**
 * /api/accounting/mcp-connector-setting (migration 1058): the owner/admin self-serve MCP connector switch.
 * The real withWriteAccess and withCsrf run; the SQL function and the audit writer are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { getMock, setMock, auditMock, csrfMock } = vi.hoisted(() => ({
  getMock: vi.fn(), setMock: vi.fn(), auditMock: vi.fn(), csrfMock: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (await import('@/lib/auth/withWriteAccess')).withWriteAccess,
}));
vi.mock('@/lib/auth/csrf', () => ({ verifyCsrf: csrfMock }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/mcp/connectorSetting', () => ({ getConnectorSetting: getMock, setConnectorSelfServe: setMock }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: auditMock }));

import handler, { COMPANY_CHANGED_MESSAGE, LOCKED_BY_PLATFORM_MESSAGE } from '../../../pages/api/accounting/mcp-connector-setting';

const C = 'abcdef12-1111-4111-8111-111111111111'; // letters, so an uppercase spelling differs

async function call(method: string, role: string | undefined, body: unknown = undefined) {
  const req = {
    method, query: {}, body, companyId: C, companyRole: role,
    user: { id: 'u-1', email: 'owner@example.co.za' }, headers: { 'user-agent': 'vitest' }, socket: {},
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown, setHeader() { return this; },
    status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, end() { return this; },
  };
  await handler(req, res as unknown as NextApiResponse);
  return res as typeof res & { sent: { data?: Record<string, unknown>; message?: string; error?: unknown } };
}

beforeEach(() => {
  vi.clearAllMocks();
  csrfMock.mockReturnValue(true);
  getMock.mockResolvedValue({ enabled: true, lockedByPlatform: false });
  setMock.mockResolvedValue({ result: 'ok', wasEnabled: false, wasSetVia: 'company_admin' });
  auditMock.mockResolvedValue(undefined);
});

describe('POST: who may switch it', () => {
  it.each(['owner', 'admin'])('%s: 200, the service gets req.companyId, one audit row with old/new and the actor', async (role) => {
    const res = await call('POST', role, { enabled: true, companyId: C });
    expect(res.statusCode).toBe(200);
    expect(setMock).toHaveBeenCalledWith(C, true);
    expect(auditMock).toHaveBeenCalledTimes(1);
    const a = auditMock.mock.calls[0]![0];
    expect(a).toMatchObject({
      companyId: C, userId: 'u-1', userEmail: 'owner@example.co.za', action: 'update',
      entityType: 'company_feature', entityId: C, entityRef: 'mcp_connector',
    });
    expect(a.changes.fields).toEqual([{ field: 'enabled', old: 'false', new: 'true', label: 'MCP connector' }]);
    expect(a.changes.metadata).toEqual({ event: 'company_feature.override_set', set_via: 'company_admin', previous_set_via: 'company_admin' });
    expect(res.sent.data).toEqual({ companyId: C, enabled: true, lockedByPlatform: false, canToggle: true });
  });

  it.each(['manager', 'viewer', 'member', undefined])('%s: 403 and the service is never called', async (role) => {
    const res = await call('POST', role, { enabled: true, companyId: C });
    expect(res.statusCode).toBe(403);
    expect(setMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('missing CSRF: 403, the service is never called', async () => {
    csrfMock.mockReturnValue(false);
    const res = await call('POST', 'owner', { enabled: true, companyId: C });
    expect(res.statusCode).toBe(403);
    expect(setMock).not.toHaveBeenCalled();
  });
});

describe('POST: the company is always the session company', () => {
  it('a page still showing another company (active company switched in another tab): 409, never reaches the service', async () => {
    const res = await call('POST', 'owner', { enabled: true, companyId: '22222222-2222-4222-8222-222222222222' });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toContain(COMPANY_CHANGED_MESSAGE);
    expect(setMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('the same company in another spelling (uppercase) is the session company: 200, the service gets req.companyId', async () => {
    const res = await call('POST', 'owner', { enabled: true, companyId: C.toUpperCase() });
    expect(res.statusCode).toBe(200);
    expect(setMock).toHaveBeenCalledWith(C, true);
  });

  it.each([[{}], [{ enabled: 'true', companyId: C }], [{ enabled: true }], [{ enabled: true, companyId: 'nope' }],
    [{ enabled: true, companyId: C, other: 1 }], [undefined]])('body %j is 400', async (body) => {
    expect((await call('POST', 'owner', body)).statusCode).toBe(400);
    expect(setMock).not.toHaveBeenCalled();
  });
});

describe('POST: what the SQL function answers', () => {
  it('locked (a platform admin switched it off): 409 with the exact sentence, no audit', async () => {
    setMock.mockResolvedValue({ result: 'locked', wasEnabled: false, wasSetVia: 'platform_admin' });
    const res = await call('POST', 'owner', { enabled: true, companyId: C });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toContain('Switched off by IsaFlow. Contact IsaFlow support.');
    expect(LOCKED_BY_PLATFORM_MESSAGE).toBe('Switched off by IsaFlow. Contact IsaFlow support.');
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('unchanged: 200, no audit', async () => {
    setMock.mockResolvedValue({ result: 'unchanged', wasEnabled: true, wasSetVia: 'default_new_company' });
    const res = await call('POST', 'admin', { enabled: true, companyId: C });
    expect(res.statusCode).toBe(200);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('forbidden from SQL (claims disagree with the wrapper): 403, no audit', async () => {
    setMock.mockResolvedValue({ result: 'forbidden', wasEnabled: null, wasSetVia: null });
    const res = await call('POST', 'owner', { enabled: false, companyId: C });
    expect(res.statusCode).toBe(403);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('switching OFF a company with no row: old is null, previous_set_via none', async () => {
    setMock.mockResolvedValue({ result: 'ok', wasEnabled: null, wasSetVia: null });
    getMock.mockResolvedValue({ enabled: false, lockedByPlatform: false });
    const res = await call('POST', 'owner', { enabled: false, companyId: C });
    expect(res.statusCode).toBe(200);
    const a = auditMock.mock.calls[0]![0];
    expect(a.changes.fields[0]).toMatchObject({ old: null, new: 'false' });
    expect(a.changes.metadata.previous_set_via).toBe('none');
  });

  it('an audit write that fails fails the request (the write rolls back with it)', async () => {
    auditMock.mockRejectedValue(new Error('audit down'));
    await expect(call('POST', 'owner', { enabled: true, companyId: C })).rejects.toThrow('audit down');
  });
});

describe('GET', () => {
  it('a viewer reads the state with canToggle false', async () => {
    const res = await call('GET', 'viewer');
    expect(res.statusCode).toBe(200);
    expect(res.sent.data).toEqual({ companyId: C, enabled: true, lockedByPlatform: false, canToggle: false });
    expect(getMock).toHaveBeenCalledWith(C);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('shows lockedByPlatform', async () => {
    getMock.mockResolvedValue({ enabled: false, lockedByPlatform: true });
    const res = await call('GET', 'owner');
    expect(res.sent.data).toEqual({ companyId: C, enabled: false, lockedByPlatform: true, canToggle: true });
  });

  it('other methods: 405', async () => {
    expect((await call('DELETE', 'owner')).statusCode).toBe(405);
  });
});
