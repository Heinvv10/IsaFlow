/**
 * K-053 round 5 (LOW-2): /api/accounting/soft-delete decides 400-vs-500 on the
 * ERROR CLASS and reads no message text at all.
 *
 * Round 4 still carried one `err.message.includes('fiscal period')` arm, for
 * the two plain Errors resolveReversalDate raised. Any unrelated fault whose
 * message merely mentioned a fiscal period — the NULL-fiscal-period assertions
 * elsewhere in the ledger code being the realistic source — was then answered
 * 400 with the raw internal message and never reached the log.error branch.
 * Those two throws are ReversalPeriodError now, so the arm is gone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { errorLog } = vi.hoisted(() => ({ errorLog: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: errorLog, warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(() => ({ kind: 'success' })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ kind: 'badRequest', error })),
    notFound: vi.fn(() => ({ kind: 'notFound' })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
    internalError: vi.fn(() => ({ kind: 'internalError' })),
  },
}));

const { softDeleteMock, undoDeleteMock } = vi.hoisted(() => ({
  softDeleteMock: vi.fn(),
  undoDeleteMock: vi.fn(),
}));

vi.mock('@/modules/accounting/services/core/softDeleteService', () => ({
  softDelete: softDeleteMock,
  undoDelete: undoDeleteMock,
  isValidEntityType: (t: string) => t === 'customer_invoice',
}));

// Real classes, so the route's instanceof checks are the ones under test.
import { SoftDeleteRefusalError } from '@/modules/accounting/services/core/softDeleteErrors';
import {
  ClosedFiscalPeriodError,
  ReversalPeriodError,
} from '@/modules/accounting/services/gl/journalEntryPostingService';
import handler from '../../../../pages/api/accounting/soft-delete';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
const ENTITY_ID = '11111111-1111-4111-8111-111111111111';

function req(method: 'POST' | 'PUT'): NextApiRequest {
  return {
    method,
    body: { entityType: 'customer_invoice', entityId: ENTITY_ID },
    companyId: COMPANY_ID,
    user: { id: USER_ID },
  } as unknown as NextApiRequest;
}
const res = {} as NextApiResponse;

async function post(): Promise<{ kind: string; error?: string }> {
  return (await handler(req('POST'), res)) as unknown as { kind: string; error?: string };
}
async function put(): Promise<{ kind: string; error?: string }> {
  return (await handler(req('PUT'), res)) as unknown as { kind: string; error?: string };
}

describe('K-053 soft-delete route error classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    softDeleteMock.mockReset();
    undoDeleteMock.mockReset();
  });

  it('a refusal is a 400 on both verbs', async () => {
    softDeleteMock.mockRejectedValue(new SoftDeleteRefusalError('nope'));
    expect((await post()).kind).toBe('badRequest');
    undoDeleteMock.mockRejectedValue(new SoftDeleteRefusalError('nope'));
    expect((await put()).kind).toBe('badRequest');
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('a closed period and an unusable reversal period are both 400', async () => {
    softDeleteMock.mockRejectedValue(new ClosedFiscalPeriodError('closed'));
    expect((await post()).kind).toBe('badRequest');

    softDeleteMock.mockRejectedValue(
      new ReversalPeriodError('The fiscal period covering reversal_date 2026-01-31 is closed.'),
    );
    expect((await post()).kind).toBe('badRequest');

    undoDeleteMock.mockRejectedValue(
      new ReversalPeriodError('No fiscal period covers reversal_date 2026-01-31. Create the fiscal year first'),
    );
    expect((await put()).kind).toBe('badRequest');
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('a plain fault that MENTIONS a fiscal period is a 500 and is logged', async () => {
    // The exact case the substring arm got wrong. The message is a fault's, not
    // a refusal's, and it must not travel to the caller as a 400.
    softDeleteMock.mockRejectedValue(
      new Error('assert: NULL fiscal period on journal entry 9f2c — refusing to post'),
    );
    expect((await post()).kind).toBe('internalError');
    expect(errorLog).toHaveBeenCalledTimes(1);

    undoDeleteMock.mockRejectedValue(
      new Error('Reversal entry 9f2c recorded for this delete does not exist (fiscal period 3)'),
    );
    expect((await put()).kind).toBe('internalError');
    expect(errorLog).toHaveBeenCalledTimes(2);
  });

  it('a fault carrying no such wording is still a 500', async () => {
    softDeleteMock.mockRejectedValue(new Error('Journal entry 9f2c not found'));
    expect((await post()).kind).toBe('internalError');
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('a non-Error rejection is a 500, not a crash', async () => {
    softDeleteMock.mockRejectedValue('boom');
    expect((await post()).kind).toBe('internalError');
  });
});
