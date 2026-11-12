import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (handler: unknown) => handler }));
vi.mock('@/lib/auth/withWriteAccess', () => ({ withWriteAccess: (handler: unknown) => handler }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (handler: unknown) => handler }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (handler: unknown) => handler }));
vi.mock('@/lib/apiJournalDate', () => ({
  JOURNAL_DATE_REFUSED: Symbol('refused'),
  withJournalDateRefusal: (_res: unknown, run: () => unknown) => run(),
}));
// The route calls the ETI wrapper (wave 5 ET), which locks and books ETI around the service: route-level tests pass straight through it.
vi.mock('@/modules/accounting/services/payroll/directivePaymentEti', async () => ({
  applyTaxDirective: (await import('@/modules/accounting/services/payroll/taxDirectivePaymentService')).applyTaxDirective,
}));
vi.mock('@/modules/accounting/services/payroll/taxDirectivePaymentService', () => ({
  applyTaxDirective: vi.fn(),
  TaxDirectiveAlreadyAppliedError: class extends Error {},
  TaxDirectiveNotApprovedError: class extends Error {},
  TaxDirectiveSplitChangedError: class extends Error {},
  TaxDirectiveWithoutEmployeeError: class extends Error {},
}));

import { DocumentClaimLockTimeoutError } from '@/modules/accounting/services/core/documentClaimLock';
import { applyTaxDirective } from '@/modules/accounting/services/payroll/taxDirectivePaymentService';
import applyRoute from '../../../pages/api/accounting/tax-directives/[id]/apply';

const ID = '33333333-3333-4333-8333-333333333333';

function call() {
  const req = {
    method: 'POST', query: { id: ID }, body: { paymentDate: '2026-11-03' },
    companyId: '11111111-1111-4111-8111-111111111111', user: { id: '22222222-2222-4222-8222-222222222222' },
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
    setHeader(key: string, value: string) { this.headers[key] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
  };
  return Promise.resolve((applyRoute as unknown as (q: NextApiRequest, s: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse))
    .then(() => res);
}

describe('tax directive apply lock timeout', () => {
  beforeEach(() => vi.resetAllMocks());

  it('answers a held cost centre with the standard retryable 503 response', async () => {
    vi.mocked(applyTaxDirective).mockRejectedValue(new DocumentClaimLockTimeoutError('tax directive'));

    const res = await call();

    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
    expect(JSON.stringify(res.sent)).toContain('DOCUMENT_CLAIM_LOCK_TIMEOUT');
  });
});
