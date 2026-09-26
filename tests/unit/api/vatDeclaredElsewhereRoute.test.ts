/**
 * /api/accounting/vat-declared-elsewhere — owner/admin only (withRole
 * 'admin', which ROLE_HIERARCHY also passes for 'owner'/'super_admin').
 * Service refusals (blank reason, not found, not marked) are pinned in
 * tests/unit/services/vatDeclaredElsewhereService.test.ts; this file is the
 * route wiring — who gets through, and what body reaches the service.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
  withRole: (await vi.importActual<typeof import('@/lib/auth/withRole')>('@/lib/auth/withRole')).withRole,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ kind: 'badRequest', error })),
    forbidden: vi.fn((_res: unknown, error: string) => ({ kind: 'forbidden', error })),
    validationError: vi.fn((_res: unknown, errors: unknown) => ({ kind: 'validationError', errors })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
  },
}));

const m = vi.hoisted(() => ({
  markVatDeclaredElsewhereBulk: vi.fn(),
  unmarkVatDeclaredElsewhere: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/vatDeclaredElsewhereService', () => {
  class VatDeclaredElsewhereForbiddenError extends Error {}
  class VatDeclaredElsewhereRefusal extends Error {}
  return {
    markVatDeclaredElsewhereBulk: m.markVatDeclaredElsewhereBulk,
    unmarkVatDeclaredElsewhere: m.unmarkVatDeclaredElsewhere,
    VatDeclaredElsewhereForbiddenError,
    VatDeclaredElsewhereRefusal,
  };
});

import handler from '../../../pages/api/accounting/vat-declared-elsewhere';

const COMPANY = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const INV = 'cccccccc-0000-4000-8000-cccccccccccc';

type Out = { kind: string; [k: string]: unknown };

function call(role: string, body: unknown): Promise<Out> {
  let status = 0;
  const res = {
    status: (s: number) => { status = s; return { json: (b: unknown) => ({ kind: 'status', status, data: b }) }; },
  } as unknown as NextApiResponse;
  const req = { method: 'POST', body, companyId: COMPANY, companyRole: role, user: { id: USER } } as unknown as NextApiRequest;
  return (handler as unknown as (r: NextApiRequest, s: NextApiResponse) => Promise<Out>)(req, res);
}

const markBody = { action: 'mark', kind: 'customer', invoiceIds: [INV], reason: 'Historical import' };
const unmarkBody = { action: 'unmark', kind: 'customer', invoiceIds: [INV], reason: 'Reopen' };

beforeEach(() => {
  vi.clearAllMocks();
  m.markVatDeclaredElsewhereBulk.mockResolvedValue([{ invoiceId: INV, marked: true }]);
  m.unmarkVatDeclaredElsewhere.mockResolvedValue({ invoiceId: INV, marked: false });
});

describe('owner/admin only', () => {
  it.each(['viewer', 'manager', 'technician'])('refuses %s with 403 and never reaches the service', async (role) => {
    const out = await call(role, markBody);
    expect(out).toMatchObject({ kind: 'status', status: 403 });
    expect(m.markVatDeclaredElsewhereBulk).not.toHaveBeenCalled();
  });

  it.each(['admin', 'owner'])('lets %s mark, with the authenticated user and the reason', async (role) => {
    const out = await call(role, markBody);
    expect(out.kind).toBe('success');
    expect(m.markVatDeclaredElsewhereBulk).toHaveBeenCalledWith(
      COMPANY, 'customer', [INV], { userId: USER, role }, 'Historical import',
    );
  });
});

describe('mark / unmark dispatch', () => {
  it('unmark calls unmarkVatDeclaredElsewhere per id', async () => {
    const out = await call('owner', unmarkBody);
    expect(out.kind).toBe('success');
    expect(m.unmarkVatDeclaredElsewhere).toHaveBeenCalledWith(COMPANY, 'customer', INV, { userId: USER, role: 'owner' }, 'Reopen');
    expect(m.markVatDeclaredElsewhereBulk).not.toHaveBeenCalled();
  });

  it('rejects a blank reason before any role or service call', async () => {
    const out = await call('owner', { ...markBody, reason: '   ' });
    expect(out.kind).toBe('validationError');
    expect(m.markVatDeclaredElsewhereBulk).not.toHaveBeenCalled();
  });
});
