import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withRole } from '@/lib/auth/withAuth';
import { ROLE_HIERARCHY, type AuthRole } from '@/lib/auth/types';

function fakeRes() {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  return { status, json } as unknown as NextApiResponse;
}

function fakeReq(companyRole: string | null | undefined, method = 'POST') {
  return { companyRole, method } as unknown as NextApiRequest;
}

const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];
// system and super_admin rank above admin in ROLE_HIERARCHY, but neither is a company role:
// withRole('admin') is an explicit allow-list of owner and admin, not a rank.
const REFUSED: Array<string | null | undefined> = [
  'system', 'super_admin', 'manager', 'viewer', 'storeman', 'technician', 'definitely-not-a-role', '', null, undefined,
];
const CASES = METHODS.flatMap((m) => REFUSED.map((r) => [m, r] as const));

describe('ROLE_HIERARCHY', () => {
  it('owner is in the hierarchy and outranks admin', () => {
    expect(ROLE_HIERARCHY.owner).toBeGreaterThan(ROLE_HIERARCHY.admin);
    expect(ROLE_HIERARCHY.owner).toBeGreaterThan(ROLE_HIERARCHY.manager);
  });

  it('super_admin remains the top level', () => {
    expect(ROLE_HIERARCHY.super_admin).toBeGreaterThan(ROLE_HIERARCHY.owner);
  });

  it('every key in ROLE_HIERARCHY is a valid AuthRole literal', () => {
    const keys = Object.keys(ROLE_HIERARCHY) as AuthRole[];
    const expected: AuthRole[] = [
      'super_admin', 'owner', 'system', 'admin', 'manager', 'storeman', 'technician', 'viewer',
    ];
    expect(keys.sort()).toEqual(expected.sort());
  });
});

describe('withRole("admin") admits owner and admin only, on every method', () => {
  it.each(METHODS.flatMap((m) => ['owner', 'admin'].map((r) => [m, r] as const)))(
    '%s as %s reaches the handler — owner is the 2026-05-01 fiscal-period-reopen regression',
    async (method, role) => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const res = fakeRes();
      await withRole('admin')(handler)(fakeReq(role, method), res);
      expect(handler).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    },
  );

  it.each(CASES)('%s as %s gets 403 and the handler never runs', async (method, role) => {
    const handler = vi.fn();
    const res = fakeRes();
    await withRole('admin')(handler)(fakeReq(role, method), res);
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'FORBIDDEN', message: 'This action requires admin role or higher' },
    });
  });

  it('a role named like an Object.prototype key is refused', async () => {
    for (const role of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const handler = vi.fn();
      const res = fakeRes();
      await withRole('admin')(handler)(fakeReq(role), res);
      expect(handler, role).not.toHaveBeenCalled();
      expect(res.status, role).toHaveBeenCalledWith(403);
    }
  });

  it('a level with no allow-list is refused when the route is built, not admitted at request time', () => {
    for (const level of ['manager', 'owner', 'viewer', 'constructor', '__proto__']) {
      expect(() => withRole(level as never), level).toThrow(/no allow-list/);
    }
  });
});
