/**
 * #1656: withPayrollModule asks Payroll READ for GET / HEAD / OPTIONS and Payroll WRITE for every other method, from the
 * user's module permissions in the database, before the wrapped handler runs. A refusal is a 403 and the handler never
 * runs (so nothing is read or written).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';

const db = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@/lib/auth/permissionService', () => ({
  checkPermission: vi.fn(async (_c: string, _u: string, module: string, action: string) => db.allowed.has(`${module}:${action}`)),
}));

import { checkPermission } from '@/lib/auth/permissionService';
import { withPayrollModule } from '@/lib/auth/withPayrollModule';

function res() {
  const r = { statusCode: 200, body: undefined as unknown, status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  r.status.mockImplementation((c: number) => { r.statusCode = c; return r; });
  r.json.mockImplementation((b: unknown) => { r.body = b; return r; });
  return r;
}
const req = (method: string, user: { id: string } | null = { id: 'u-1' }) =>
  ({ method, companyId: 'c-1', user }) as never;

beforeEach(() => {
  db.allowed.clear();
  vi.mocked(checkPermission).mockClear();
});

describe('withPayrollModule (#1656)', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('%s needs Payroll read', async (method) => {
    const inner = vi.fn();
    const r = res();
    await withPayrollModule(inner)(req(method), r as unknown as NextApiResponse);
    expect(r.statusCode).toBe(403);
    expect(inner).not.toHaveBeenCalled();
    expect(checkPermission).toHaveBeenCalledWith('c-1', 'u-1', 'payroll', 'read');
    db.allowed.add('payroll:read');
    await withPayrollModule(inner)(req(method), res() as unknown as NextApiResponse);
    expect(inner).toHaveBeenCalledOnce();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s needs Payroll write; read alone is refused', async (method) => {
    db.allowed.add('payroll:read');
    const inner = vi.fn();
    const r = res();
    await withPayrollModule(inner)(req(method), r as unknown as NextApiResponse);
    expect(r.statusCode).toBe(403);
    expect(String((r.body as { error?: { message?: string } }).error?.message ?? JSON.stringify(r.body))).toMatch(/Payroll write/);
    expect(inner).not.toHaveBeenCalled();
    db.allowed.add('payroll:write');
    await withPayrollModule(inner)(req(method), res() as unknown as NextApiResponse);
    expect(inner).toHaveBeenCalledOnce();
  });

  it('no user is refused without asking the database', async () => {
    const inner = vi.fn();
    const r = res();
    await withPayrollModule(inner)(req('GET', null), r as unknown as NextApiResponse);
    expect(r.statusCode).toBe(403);
    expect(inner).not.toHaveBeenCalled();
    expect(checkPermission).not.toHaveBeenCalled();
  });
});

describe('withPayrollModule + withPayrollDetailAccess on one GET (round 3, L1)', () => {
  it('Payroll read is asked of the database once, not by each wrapper', async () => {
    const { withPayrollDetailAccess } = await import('@/lib/auth/withPayrollDetailAccess');
    db.allowed.add('payroll:read');
    const inner = vi.fn();
    const r = req('GET') as unknown as { companyRole: string };
    r.companyRole = 'manager';
    await withPayrollModule(withPayrollDetailAccess(inner))(r as never, res() as unknown as NextApiResponse);
    expect(inner).toHaveBeenCalledOnce();
    expect(vi.mocked(checkPermission).mock.calls.filter((c) => c[2] === 'payroll' && c[3] === 'read')).toHaveLength(1);
  });

  it('a write is still asked Payroll write by the module and Payroll read by the detail gate (different questions)', async () => {
    const { withPayrollDetailAccess } = await import('@/lib/auth/withPayrollDetailAccess');
    db.allowed.add('payroll:write');
    const inner = vi.fn();
    const r = req('POST') as unknown as { companyRole: string };
    r.companyRole = 'manager';
    const out = res();
    await withPayrollModule(withPayrollDetailAccess(inner))(r as never, out as unknown as NextApiResponse);
    expect(inner).not.toHaveBeenCalled(); // write granted, read not: the detail gate refuses
    expect(out.statusCode).toBe(403);
    expect(vi.mocked(checkPermission).mock.calls.map((c) => c[3])).toEqual(['write', 'read']);
  });
});
