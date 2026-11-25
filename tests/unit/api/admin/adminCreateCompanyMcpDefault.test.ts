/**
 * Admin-created companies get the MCP connector on by default (migration 1056), with the creating platform admin
 * as the actor (the company has no owner yet): POST /api/admin/companies passes req.user.id, and
 * adminCompanyMutations.createCompany calls enable_mcp_connector_default for the new company.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, createCompanyMock } = vi.hoisted(() => ({ sqlMock: vi.fn(), createCompanyMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createCompany } from '@/modules/admin/services/adminCompanyMutations';

const joined = (call: unknown[]) => (call[0] as string[]).join('?');

describe('adminCompanyMutations.createCompany: MCP connector default-on', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    sqlMock.mockImplementation(async (strings: string[]) => {
      const text = strings.join('?');
      if (/INSERT INTO companies/.test(text)) return [{ id: 'co-new', name: 'Acme' }];
      if (/enable_mcp_connector_default/.test(text)) return [{ enabled: true }];
      return [];
    });
  });

  it('calls enable_mcp_connector_default for the new company with the admin as actor, after the INSERT', async () => {
    await createCompany({ name: 'Acme', actorUserId: 'admin-1' });
    const calls = sqlMock.mock.calls;
    const insert = calls.findIndex((c) => /INSERT INTO companies/.test(joined(c)));
    const defaultOn = calls.findIndex((c) => /enable_mcp_connector_default/.test(joined(c)));
    expect(insert).toBeGreaterThan(-1);
    expect(defaultOn).toBeGreaterThan(insert);
    expect(calls[defaultOn]!.slice(1)).toEqual(['co-new', 'admin-1']);
    expect(calls.filter((c) => /enable_mcp_connector_default/.test(joined(c)))).toHaveLength(1);
  });
});

describe('POST /api/admin/companies passes the admin as actor', () => {
  it('forwards req.user.id as actorUserId', async () => {
    vi.resetModules();
    vi.doMock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
    vi.doMock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
    vi.doMock('@/modules/admin/services/auditService', () => ({ logAdminAction: vi.fn(async () => undefined) }));
    vi.doMock('@/modules/admin/services/adminCompanyService', () => ({
      listCompanies: vi.fn(),
      createCompany: createCompanyMock,
    }));
    createCompanyMock.mockResolvedValue({ id: 'co-new', name: 'Acme' });
    const { default: route } = await import('../../../../pages/api/admin/companies');
    const { callRoute } = await import('../../helpers/adminRouteCall');
    const r = await callRoute(route, 'POST', {}, { name: 'Acme' });
    expect(r.statusCode).toBe(200);
    expect(createCompanyMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'Acme', actorUserId: 'platform-admin' }));
  });
});
