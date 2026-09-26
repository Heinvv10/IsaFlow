/**
 * /api/accounting/sars/sars-submissions — mark_submitted's blocking VAT
 * exceptions gate. VAT201 only; other form types (EMP201 etc.) are untouched.
 * The gate itself (vatGateOverrideService) is pinned in
 * tests/unit/services/vatGateOverrideService.test.ts; this file is about the
 * route wiring it into markSubmitted, before that write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown, message?: string) => ({ kind: 'success', data, message })),
    badRequest: vi.fn((_res: unknown, error: string, details?: unknown) => ({ kind: 'badRequest', error, details })),
    badRequestFromError: vi.fn((_res: unknown, err: unknown) => ({ kind: 'badRequestFromError', err })),
    forbidden: vi.fn((_res: unknown, error: string) => ({ kind: 'forbidden', error })),
    notFound: vi.fn((_res: unknown, resource: string, id: string) => ({ kind: 'notFound', resource, id })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
  },
}));

const m = vi.hoisted(() => ({
  listSubmissions: vi.fn(),
  markSubmitted: vi.fn(),
  getSubmission: vi.fn(),
  assertVatGateClear: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/sarsService', () => ({
  listSubmissions: m.listSubmissions,
  markSubmitted: m.markSubmitted,
  getSubmission: m.getSubmission,
}));
vi.mock('@/modules/accounting/services/reports/vatGateOverrideService', () => {
  class VatGateBlockedError extends Error { counts: unknown; constructor(counts: unknown) { super('blocked'); this.counts = counts; } }
  class VatGateOverrideForbiddenError extends Error {}
  return { assertVatGateClear: m.assertVatGateClear, VatGateBlockedError, VatGateOverrideForbiddenError };
});

import handler from '../../../pages/api/accounting/sars/sars-submissions';
import {
  VatGateBlockedError, VatGateOverrideForbiddenError,
} from '@/modules/accounting/services/reports/vatGateOverrideService';

const COMPANY = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const SUB_ID = 'cccccccc-0000-4000-8000-cccccccccccc';

type Out = { kind: string; [k: string]: unknown };

function call(role: string, body: unknown): Promise<Out> {
  const req = {
    method: 'POST', body, companyId: COMPANY, companyRole: role, user: { id: USER },
  } as unknown as NextApiRequest;
  const res = {} as NextApiResponse;
  return (handler as unknown as (r: NextApiRequest, s: NextApiResponse) => Promise<Out>)(req, res);
}

const vat201Submission = { id: SUB_ID, formType: 'VAT201', periodStart: '2026-03-01', periodEnd: '2026-04-30' };

beforeEach(() => {
  vi.clearAllMocks();
  m.getSubmission.mockResolvedValue(vat201Submission);
  m.assertVatGateClear.mockResolvedValue({ overridden: false, counts: { totalExceptions: 0 } });
  m.markSubmitted.mockResolvedValue({ id: SUB_ID, status: 'submitted' });
});

const body = { id: SUB_ID, action: 'mark_submitted', reference: 'REF-1' };

describe('mark_submitted — VAT201 blocking exceptions gate', () => {
  it('checks the gate with the period, the actor and any overrideReason, before marking submitted', async () => {
    await call('owner', { ...body, overrideReason: 'Historical' });
    expect(m.assertVatGateClear).toHaveBeenCalledWith(
      COMPANY, '2026-03-01', '2026-04-30', 'sars_submission', SUB_ID,
      { userId: USER, role: 'owner' }, 'Historical',
    );
    expect(m.markSubmitted).toHaveBeenCalledWith(COMPANY, SUB_ID, 'REF-1');
  });

  it('answers a block with 400 carrying the exception counts, and never marks submitted', async () => {
    m.assertVatGateClear.mockRejectedValue(new VatGateBlockedError({ totalExceptions: 3 }));
    const out = await call('manager', body);
    expect(out.kind).toBe('badRequest');
    expect(m.markSubmitted).not.toHaveBeenCalled();
  });

  it('answers a non-owner/admin override attempt with 403, and never marks submitted', async () => {
    m.assertVatGateClear.mockRejectedValue(new VatGateOverrideForbiddenError());
    const out = await call('manager', { ...body, overrideReason: 'trust me' });
    expect(out.kind).toBe('forbidden');
    expect(m.markSubmitted).not.toHaveBeenCalled();
  });

  it('is not consulted for a non-VAT201 submission', async () => {
    m.getSubmission.mockResolvedValue({ id: SUB_ID, formType: 'EMP201', periodStart: '2026-03-01', periodEnd: '2026-04-30' });
    const out = await call('manager', body);
    expect(m.assertVatGateClear).not.toHaveBeenCalled();
    expect(out.kind).toBe('success');
  });

  it('answers a missing submission with 404 before any gate check or write', async () => {
    m.getSubmission.mockResolvedValue(null);
    const out = await call('owner', body);
    expect(out.kind).toBe('notFound');
    expect(m.assertVatGateClear).not.toHaveBeenCalled();
    expect(m.markSubmitted).not.toHaveBeenCalled();
  });
});
