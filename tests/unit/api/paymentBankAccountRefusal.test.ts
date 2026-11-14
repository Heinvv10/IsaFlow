/**
 * The three payment routes answer a bank-account refusal (BankAccountRefusedError,
 * raised by the service before it writes) as a 400 with the reason, and still
 * rethrow anything else (a 500 rolls the request back).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withWriteAccess', () => ({ withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/withPayrollDetailAccess', () => ({ withPayrollDetailAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
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
  TaxDirectiveNotLumpSumError: class extends Error {},
}));
// The route's first check reads the directive's type (DR round 4); a stub here keeps the test off any database.
vi.mock('@/modules/accounting/services/payroll/taxDirectiveLabour', () => ({ refuseRegularPayDirective: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/payroll/uifPaymentService', () => ({
  markUifDeclarationPaid: vi.fn(),
  UifDeclarationNotSubmittedError: class extends Error {},
}));
vi.mock('@/modules/accounting/services/payroll/uifDeclarationService', () => ({ getUifDeclaration: vi.fn(), markUifSubmitted: vi.fn() }));
vi.mock('@/modules/accounting/services/loans/loanPaymentService', () => ({ listLoanPayments: vi.fn(), recordLoanPayment: vi.fn() }));

import { BankAccountRefusedError } from '@/modules/accounting/services/gl/paymentBankAccount';
import { applyTaxDirective } from '@/modules/accounting/services/payroll/taxDirectivePaymentService';
import { markUifDeclarationPaid, UifDeclarationNotSubmittedError } from '@/modules/accounting/services/payroll/uifPaymentService';
import { recordLoanPayment } from '@/modules/accounting/services/loans/loanPaymentService';
import applyRoute from '../../../pages/api/accounting/tax-directives/[id]/apply';
import uifRoute from '../../../pages/api/payroll/uif/[id]';
import loanRoute from '../../../pages/api/accounting/loans/[id]/payments';

const ID = '33333333-3333-4333-8333-333333333333';
const REFUSAL = 'ABSA 1544331 is not a bank account';

type Route = (q: NextApiRequest, s: NextApiResponse) => unknown;
async function call(route: unknown, method: string, body: unknown) {
  const req = {
    method, query: { id: ID }, body,
    companyId: '11111111-1111-4111-8111-111111111111', user: { id: '22222222-2222-4222-8222-222222222222' },
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown,
    setHeader() { return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
  };
  await (route as Route)(req, res as unknown as NextApiResponse);
  return res;
}

const routes: Array<[string, unknown, string, unknown, () => ReturnType<typeof vi.fn>]> = [
  ['tax directive apply', applyRoute, 'POST', { paymentDate: '2026-11-03' }, () => vi.mocked(applyTaxDirective) as never],
  ['UIF mark paid', uifRoute, 'PATCH', { markPaid: true }, () => vi.mocked(markUifDeclarationPaid) as never],
  ['loan payment', loanRoute, 'POST', { paymentDate: '2026-11-03' }, () => vi.mocked(recordLoanPayment) as never],
];

describe.each(routes)('%s route', (_name, route, method, body, service) => {
  beforeEach(() => vi.resetAllMocks());

  it('answers a bank-account refusal as 400 with the reason', async () => {
    service().mockRejectedValue(new BankAccountRefusedError(REFUSAL));
    const res = await call(route, method, body);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toContain(REFUSAL);
  });

  it('rethrows any other failure', async () => {
    service().mockRejectedValue(new Error('boom'));
    await expect(call(route, method, body)).rejects.toThrow('boom');
  });
});

describe('UIF mark paid route - a declaration that is not submitted', () => {
  beforeEach(() => vi.resetAllMocks());

  it('answers 409 with the reason, not a 500', async () => {
    vi.mocked(markUifDeclarationPaid).mockRejectedValue(new UifDeclarationNotSubmittedError('draft'));
    const res = await call(uifRoute, 'PATCH', { markPaid: true });
    expect(res.statusCode).toBe(409);
  });
});
