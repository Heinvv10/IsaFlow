/**
 * Round-5 LOW-3: nothing locked the ROUTE-level classification.
 *
 * `k122e` asserts a service-level property (the thrown error is not an
 * `ArRequestError`). Reverting any AR dispute/dunning route's catch block to
 * `/not found/i` left every integration and unit test green, so the regression
 * that produced the round-4 HIGH could come straight back.
 *
 * The rule each case below locks, per route: an `ArRequestError` is the
 * service's own refusal and becomes a 4xx; ANYTHING else must escape the
 * handler so `withAuth` answers 5xx and ROLLBACKs the request transaction
 * (`src/lib/auth/withAuth.ts` — status >= 500 rolls back, everything below it
 * COMMITs). `'Not found'` is the literal `createCreditNote` throws, and is the
 * exact string a message-matching catch used to turn into a committed 400.
 *
 * Only the service layer and the response helpers are mocked; the real route
 * module runs, so a change to its catch block fails this test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ArRequestError } from '@/modules/accounting/services/ar/arErrors';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/rateLimit', () => ({ checkSendRateLimit: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(),
    badRequest: vi.fn(),
    badRequestFromError: vi.fn(),
    notFound: vi.fn(),
    validationError: vi.fn(),
    methodNotAllowed: vi.fn(),
    tooManyRequests: vi.fn(),
  },
}));

const resolveDispute = vi.fn();
const withdrawDispute = vi.fn();
const raiseDispute = vi.fn();
vi.mock('@/modules/accounting/services/ar/disputeService', async () => {
  const errors = await vi.importActual<typeof import('@/modules/accounting/services/ar/arErrors')>(
    '@/modules/accounting/services/ar/arErrors',
  );
  return {
    ArRequestError: errors.ArRequestError,
    resolveDispute: (...a: unknown[]) => resolveDispute(...a),
    withdrawDispute: (...a: unknown[]) => withdrawDispute(...a),
    raiseDispute: (...a: unknown[]) => raiseDispute(...a),
    listDisputes: vi.fn(),
  };
});

const sendDunning = vi.fn();
const renderTemplate = vi.fn();
vi.mock('@/modules/accounting/services/ar/dunningService', () => ({
  sendDunning: (...a: unknown[]) => sendDunning(...a),
  renderTemplate: (...a: unknown[]) => renderTemplate(...a),
}));

const setOverride = vi.fn();
vi.mock('@/modules/accounting/services/ar/dunningOverridesService', () => ({
  setOverride: (...a: unknown[]) => setOverride(...a),
  listOverrides: vi.fn(),
}));

import { apiResponse } from '@/lib/apiResponse';
import resolveRoute from '../../../../pages/api/accounting/ar/disputes/[id]/resolve';
import withdrawRoute from '../../../../pages/api/accounting/ar/disputes/[id]/withdraw';
import disputesRoute from '../../../../pages/api/accounting/ar/disputes/index';
import sendRoute from '../../../../pages/api/accounting/ar/dunning/send';
import previewRoute from '../../../../pages/api/accounting/ar/dunning/templates/[id]/preview';
import overridesRoute from '../../../../pages/api/accounting/ar/dunning/overrides/index';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const RECORD_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';

type Handler = (req: never, res: never) => Promise<void>;

interface RouteCase {
  name: string;
  handler: Handler;
  service: ReturnType<typeof vi.fn>;
  req: () => unknown;
}

function res() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as never;
}

const base = { companyId: COMPANY_ID, user: { id: USER_ID } };

const CASES: RouteCase[] = [
  {
    name: 'disputes/[id]/resolve',
    handler: resolveRoute as unknown as Handler,
    service: resolveDispute,
    req: () => ({ ...base, method: 'POST', query: { id: RECORD_ID }, body: { mode: 'resolve_no_credit' } }),
  },
  {
    name: 'disputes/[id]/withdraw',
    handler: withdrawRoute as unknown as Handler,
    service: withdrawDispute,
    req: () => ({ ...base, method: 'POST', query: { id: RECORD_ID }, body: {} }),
  },
  {
    name: 'disputes/index (POST)',
    handler: disputesRoute as unknown as Handler,
    service: raiseDispute,
    req: () => ({
      ...base,
      method: 'POST',
      query: {},
      body: { customerInvoiceId: RECORD_ID, reason: 'wrong amount', disputedAmount: 10 },
    }),
  },
  {
    name: 'dunning/send',
    handler: sendRoute as unknown as Handler,
    service: sendDunning,
    req: () => ({ ...base, method: 'POST', query: {}, body: { invoiceId: RECORD_ID, templateId: OTHER_ID } }),
  },
  {
    name: 'dunning/templates/[id]/preview',
    handler: previewRoute as unknown as Handler,
    service: renderTemplate,
    req: () => ({ ...base, method: 'POST', query: { id: RECORD_ID }, body: { invoiceId: OTHER_ID } }),
  },
  {
    name: 'dunning/overrides (POST)',
    handler: overridesRoute as unknown as Handler,
    service: setOverride,
    req: () => ({
      ...base,
      method: 'POST',
      query: {},
      body: { customerId: RECORD_ID, template_id_override: OTHER_ID },
    }),
  },
];

/** Every 4xx helper the six routes can reach. */
function fourxxCalls(): number {
  const r = apiResponse as unknown as Record<string, ReturnType<typeof vi.fn>>;
  return (
    r.badRequest!.mock.calls.length +
    r.badRequestFromError!.mock.calls.length +
    r.notFound!.mock.calls.length +
    r.validationError!.mock.calls.length
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('K-122 LOW-3 — AR routes classify a refusal by TYPE, not by message', () => {
  it.each(CASES)('$name rethrows a bare Error("Not found") instead of answering 4xx', async (c) => {
    c.service.mockRejectedValueOnce(new Error('Not found'));
    await expect(c.handler(c.req() as never, res())).rejects.toThrow('Not found');
    expect(fourxxCalls()).toBe(0);
    expect((apiResponse as unknown as Record<string, ReturnType<typeof vi.fn>>).success!).not.toHaveBeenCalled();
  });

  it.each(CASES)('$name rethrows a PG-shaped error rather than committing a 400', async (c) => {
    const pgError = Object.assign(new Error('null value in column "x" violates not-null constraint'), {
      code: '23502',
    });
    c.service.mockRejectedValueOnce(pgError);
    await expect(c.handler(c.req() as never, res())).rejects.toThrow('violates not-null constraint');
    expect(fourxxCalls()).toBe(0);
  });

  it.each(CASES)('$name still answers 4xx to the service\'s own ArRequestError', async (c) => {
    c.service.mockRejectedValueOnce(new ArRequestError('Dispute is not open', 400, 'DISPUTE_NOT_OPEN'));
    await expect(c.handler(c.req() as never, res())).resolves.toBeUndefined();
    expect(fourxxCalls()).toBe(1);
  });
});
