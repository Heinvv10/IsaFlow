/**
 * #1656: the role model itself, through the real functions (no mocks of companyRoles.ts):
 * the legacy map, the per-module role defaults (Hein 2026-11-19: manager approves by default; a
 * former accountant / bookkeeper is a manager WITHOUT approve), and getEffectivePermissions, what
 * both permission grids show.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import {
  COMPANY_ROLES, LEGACY_ROLE_MAP, MANAGER_APPROVES_BY_DEFAULT, PERMISSION_ACTIONS, normalizeCompanyRole, roleDefaultPermission,
} from '@/lib/auth/companyRoles';
import { getEffectivePermissions } from '@/lib/auth/permissionService';

const C = '11111111-1111-4111-8111-111111111111';
const U = '99999999-9999-4999-8999-999999999999';
const allowed = (role: string) => PERMISSION_ACTIONS.filter((a) => roleDefaultPermission(role, a));

describe('normalizeCompanyRole', () => {
  it('maps every legacy value, and leaves the four roles and anything unknown alone', () => {
    expect(Object.fromEntries(Object.keys(LEGACY_ROLE_MAP).map((r) => [r, normalizeCompanyRole(r)]))).toEqual({
      accountant: 'manager', bookkeeper: 'manager', storeman: 'viewer', technician: 'viewer', user: 'viewer',
    });
    for (const r of COMPANY_ROLES) expect(normalizeCompanyRole(r)).toBe(r);
    expect(normalizeCompanyRole('toString')).toBe('toString');
    expect(normalizeCompanyRole('super_admin')).toBe('super_admin');
  });
});

describe('roleDefaultPermission', () => {
  it('owner/admin everything; manager all but delete (approve per the ruling); viewer read + export', () => {
    expect(MANAGER_APPROVES_BY_DEFAULT).toBe(true);
    expect(allowed('owner')).toEqual([...PERMISSION_ACTIONS]);
    expect(allowed('admin')).toEqual([...PERMISSION_ACTIONS]);
    expect(allowed('manager')).toEqual(['read', 'write', 'export', 'approve']);
    expect(allowed('viewer')).toEqual(['read', 'export']);
  });

  it('a former accountant / bookkeeper writes like a manager but does not approve; storeman/technician/user read', () => {
    expect(allowed('accountant')).toEqual(['read', 'write', 'export']);
    expect(allowed('bookkeeper')).toEqual(['read', 'write', 'export']);
    for (const r of ['storeman', 'technician', 'user']) expect(allowed(r)).toEqual(['read', 'export']);
    expect(allowed('nonsense')).toEqual([]);
  });
});

describe('getEffectivePermissions', () => {
  const modules = [{ module_key: 'suppliers', module_name: 'Suppliers & AP', description: null, display_order: 30 },
    { module_key: 'banking', module_name: 'Banking', description: null, display_order: 50 }];
  let rows: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    rows = [];
    vi.mocked(sql).mockImplementation(((s: TemplateStringsArray) =>
      Promise.resolve(s.join('?').includes('FROM permission_modules') ? modules : rows)) as never);
  });
  const view = async (role: string) => (await getEffectivePermissions(C, U, role))
    .map((p) => `${p.moduleKey}:${p.canWrite ? 'w' : '-'}${p.canApprove ? 'a' : '-'}`);

  it("a stored bookkeeper sees write without approve on every module, a manager with approve", async () => {
    expect(await view('bookkeeper')).toEqual(['suppliers:w-', 'banking:w-']);
    expect(await view('manager')).toEqual(['suppliers:wa', 'banking:wa']);
  });

  it("a user's row wins over the default; an owner's row cannot restrict them", async () => {
    rows = [{ module_key: 'suppliers', module_name: 'Suppliers & AP', can_read: true, can_write: true, can_delete: false, can_export: true, can_approve: false }];
    expect(await view('manager')).toEqual(['suppliers:w-', 'banking:wa']);
    expect(await view('owner')).toEqual(['suppliers:wa', 'banking:wa']);
  });
});
