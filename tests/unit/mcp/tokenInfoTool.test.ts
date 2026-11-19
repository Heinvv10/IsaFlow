/**
 * token_info — which company, which scopes, and when the connector's token dies.
 *
 * Everything it reports comes from the McpToolContext the transport built from
 * the authenticated token; nothing comes from args (it takes none). The company
 * name is the one read it makes, scoped to ctx.companyId.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ warn: vi.fn(), savepoint: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: h.warn, debug: vi.fn() },
}));
vi.mock('@/lib/neon', () => ({ withSavepoint: h.savepoint }));
vi.mock('@/modules/accounting/services/core/companyService', () => ({ getCompany: vi.fn() }));
vi.mock('@/modules/accounting/services/practice/practiceUsersService', () => ({ getCompanyUser: vi.fn() }));

import { getCompany } from '@/modules/accounting/services/core/companyService';
import { getCompanyUser } from '@/modules/accounting/services/practice/practiceUsersService';
import { tokenInfoTool } from '@/lib/mcp/tools/tokenInfo';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-13T10:00:00.000Z');

function ctx(over: Partial<McpToolContext> = {}): McpToolContext {
  return {
    userId: 'user-1',
    companyId: COMPANY,
    scopes: ['read:reports', 'write:invoices', 'write:post'],
    tokenJti: 'tok-1',
    oauthAppId: null,
    companyRole: 'admin',
    authMethod: 'pat',
    tokenExpiresAt: '2026-12-13T10:00:00.000Z',
    refreshExpiresAt: null,
    ...over,
  };
}

function parse(r: { content: Array<{ text: string }>; isError?: boolean }): Record<string, unknown> {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

describe('token_info', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.mocked(getCompany).mockReset();
    vi.mocked(getCompany).mockResolvedValue({ name: 'Acme (Pty) Ltd' } as never);
    h.warn.mockReset();
    h.savepoint.mockReset().mockImplementation((_name: string, fn: () => Promise<unknown>) => fn());
    vi.mocked(getCompanyUser).mockReset();
    vi.mocked(getCompanyUser).mockResolvedValue({
      id: 'user-1', email: 'lew@acme.co.za', firstName: 'Lew', lastName: 'Smith', displayName: 'Lew Smith', companyRole: 'admin',
    });
  });
  afterEach(() => vi.useRealTimers());

  it('is a free read open to any token, with no arguments', () => {
    expect(tokenInfoTool.name).toBe('token_info');
    expect(tokenInfoTool.write).toBe(false);
    expect(tokenInfoTool.scope).toBeNull();
    expect(tokenInfoTool.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('reports a PAT: company, sorted scopes, role and expiry from the context', async () => {
    const data = parse(await tokenInfoTool.handler({}, ctx({ scopes: ['write:post', 'read:reports'] })));
    expect(getCompany).toHaveBeenCalledWith(COMPANY);
    expect(getCompanyUser).toHaveBeenCalledWith(COMPANY, 'user-1');
    expect(data).toEqual({
      company: { id: COMPANY, name: 'Acme (Pty) Ltd' },
      user: { id: 'user-1', email: 'lew@acme.co.za', name: 'Lew Smith' },
      auth_method: 'pat',
      token_id: 'tok-1',
      oauth_app_id: null,
      role: 'admin',
      scopes: ['read:reports', 'write:post'],
      expires_at: '2026-12-13T10:00:00.000Z',
      expires_in_seconds: 30 * 24 * 3600,
      refresh_expires_at: null,
      reconnect_by: '2026-12-13T10:00:00.000Z',
    });
  });

  it('reports an OAuth grant: reconnect_by is the REFRESH expiry, not the short access token', async () => {
    const data = parse(await tokenInfoTool.handler({}, ctx({
      authMethod: 'oauth',
      oauthAppId: 'app-9',
      tokenExpiresAt: '2026-11-13T11:00:00.000Z',
      refreshExpiresAt: '2027-02-11T10:00:00.000Z',
    })));
    expect(data.auth_method).toBe('oauth');
    expect(data.oauth_app_id).toBe('app-9');
    expect(data.expires_in_seconds).toBe(3600);
    expect(data.refresh_expires_at).toBe('2027-02-11T10:00:00.000Z');
    expect(data.reconnect_by).toBe('2027-02-11T10:00:00.000Z');
  });

  it('reports unknown expiry as null rather than inventing one', async () => {
    const data = parse(await tokenInfoTool.handler({}, ctx({ tokenExpiresAt: null, authMethod: null })));
    expect(data.expires_at).toBeNull();
    expect(data.expires_in_seconds).toBeNull();
    expect(data.reconnect_by).toBeNull();
    expect(data.auth_method).toBeNull();
  });

  it('never echoes credential material', async () => {
    const text = (await tokenInfoTool.handler({}, ctx())).content[0]!.text;
    expect(text).not.toMatch(/pat_|oat_|ort_|token_hash|secret/i);
  });

  it('user: the token user as this company\'s member; null fields when not a member or no name is set', async () => {
    vi.mocked(getCompanyUser).mockResolvedValueOnce({
      id: 'user-1', email: 'x@acme.co.za', firstName: null, lastName: null, displayName: 'x@acme.co.za', companyRole: 'viewer',
    });
    expect(parse(await tokenInfoTool.handler({}, ctx())).user).toEqual({ id: 'user-1', email: 'x@acme.co.za', name: null });
    vi.mocked(getCompanyUser).mockResolvedValueOnce(null);
    expect(parse(await tokenInfoTool.handler({}, ctx())).user).toEqual({ id: 'user-1', email: null, name: null });
    expect(getCompanyUser).toHaveBeenLastCalledWith(COMPANY, 'user-1');
  });

  it('describes the user as the token holder\'s OWN id, email and name, never another member', () => {
    expect(tokenInfoTool.description).toContain("the token holder's own id, email and name");
    expect(tokenInfoTool.description).toContain('never another member');
  });

  it('a refusal of the member read (42501: not a member) answers null fields, in a savepoint, with a warning', async () => {
    vi.mocked(getCompanyUser).mockRejectedValueOnce(Object.assign(new Error('caller is not a member'), { code: '42501' }));
    expect(parse(await tokenInfoTool.handler({}, ctx())).user).toEqual({ id: 'user-1', email: null, name: null });
    expect(h.savepoint).toHaveBeenCalledWith('token_info_user', expect.any(Function));
    expect(h.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ userId: 'user-1', companyId: COMPANY }), expect.any(String));
  });

  it('any other failure of the member read fails the call', async () => {
    vi.mocked(getCompanyUser).mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: '40P01' }));
    await expect(tokenInfoTool.handler({}, ctx())).rejects.toThrow('deadlock');
  });

  it('returns the generic not-found when the bound company cannot be read', async () => {
    vi.mocked(getCompany).mockResolvedValue(null as never);
    const r = await tokenInfoTool.handler({}, ctx());
    expect(r.isError).toBe(true);
  });
});
