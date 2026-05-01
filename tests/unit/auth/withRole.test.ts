import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withRole } from '@/lib/auth/withAuth';
import { ROLE_HIERARCHY, type AuthRole } from '@/lib/auth/types';

function fakeRes() {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  return { status, json } as unknown as NextApiResponse;
}

function fakeReq(companyRole: string | undefined) {
  return { companyRole } as unknown as NextApiRequest;
}

describe('withRole + ROLE_HIERARCHY', () => {
  it('owner is in the hierarchy and outranks admin', () => {
    expect(ROLE_HIERARCHY.owner).toBeGreaterThan(ROLE_HIERARCHY.admin);
    expect(ROLE_HIERARCHY.owner).toBeGreaterThan(ROLE_HIERARCHY.manager);
  });

  it('super_admin remains the top level', () => {
    expect(ROLE_HIERARCHY.super_admin).toBeGreaterThan(ROLE_HIERARCHY.owner);
  });

  it('owner passes withRole("admin") — regression for 2026-05-01 owner-blocked-from-fiscal-period-reopen bug', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const guarded = withRole('admin')(handler);
    const res = fakeRes();
    await guarded(fakeReq('owner'), res);
    expect(handler).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('owner passes withRole("manager")', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const guarded = withRole('manager')(handler);
    const res = fakeRes();
    await guarded(fakeReq('owner'), res);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('manager fails withRole("admin")', async () => {
    const handler = vi.fn();
    const guarded = withRole('admin')(handler);
    const res = fakeRes();
    await guarded(fakeReq('manager'), res);
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('viewer fails withRole("admin")', async () => {
    const handler = vi.fn();
    const guarded = withRole('admin')(handler);
    const res = fakeRes();
    await guarded(fakeReq('viewer'), res);
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('unknown role string falls through to level 0 and is blocked', async () => {
    const handler = vi.fn();
    const guarded = withRole('admin')(handler);
    const res = fakeRes();
    await guarded(fakeReq('definitely-not-a-role'), res);
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('every key in ROLE_HIERARCHY is a valid AuthRole literal', () => {
    const keys = Object.keys(ROLE_HIERARCHY) as AuthRole[];
    const expected: AuthRole[] = [
      'super_admin', 'owner', 'system', 'admin', 'manager', 'storeman', 'technician', 'viewer',
    ];
    expect(keys.sort()).toEqual(expected.sort());
  });
});
