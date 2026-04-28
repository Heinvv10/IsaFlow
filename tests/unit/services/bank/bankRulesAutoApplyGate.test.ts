/**
 * Unit tests for the auto-apply behaviour in POST /api/accounting/bank-rules.
 *
 * Contract:
 *   1. `autoCreateEntry` still defaults to `false` when omitted (the user has
 *      to opt in to journal-entry posting).
 *   2. `applyRules` runs on every create when `bankAccountId` is provided —
 *      regardless of `autoCreateEntry`. Suggest-only rules still attach
 *      suggestions immediately; auto-post rules also create journal entries.
 *      `applyRules` itself enforces the suggestion-vs-post split internally.
 *   3. When `bankAccountId` is omitted, `applyRules` is not called (it needs
 *      a bank scope to operate).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({
  withAuth: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
  withWriteAccess: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));
vi.mock('@/lib/auth/withCsrf', () => ({
  withCsrf: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));
vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success:          vi.fn(),
    badRequest:       vi.fn(),
    methodNotAllowed: vi.fn(),
    validationError:  vi.fn(),
  },
}));

const { createRuleMock, applyRulesMock, getRulesMock } = vi.hoisted(() => ({
  createRuleMock: vi.fn(),
  applyRulesMock: vi.fn(),
  getRulesMock:   vi.fn(),
}));

vi.mock('@/modules/accounting/services/bank/bankRulesService', () => ({
  createRule: createRuleMock,
  applyRules: applyRulesMock,
  getRules:   getRulesMock,
}));

import { apiResponse } from '@/lib/apiResponse';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ alias resolution differs in test runner
import handler from '../../../../pages/api/accounting/bank-rules';

// Real v4-format UUIDs — Zod UUID validator (z.string().uuid()) enforces
// RFC 4122: 3rd group must start with '4', 4th group must start with 8-b.
const COMPANY_ID = '11111111-1111-4111-9111-111111111111';
const USER_ID    = '22222222-2222-4222-9222-222222222222';
const BANK_ID    = '33333333-3333-4333-9333-333333333333';
const GL_ID      = '44444444-4444-4444-9444-444444444444';
const SUP_ID     = '55555555-5555-4555-9555-555555555555';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

function makeReq(overrides: Partial<NextApiRequest> & { body?: Record<string, unknown> } = {}): NextApiRequest {
  return {
    method: 'POST',
    body: {},
    companyId: COMPANY_ID,
    user: { id: USER_ID, claims: {} },
    ...overrides,
  } as unknown as NextApiRequest;
}

function makeRes(): NextApiResponse {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

const VALID_RULE = {
  ruleName: 'Test rule',
  matchField: 'description',
  matchType: 'contains',
  matchPattern: 'WOOLWORTHS',
  glAccountId: GL_ID,
};

describe('POST /api/accounting/bank-rules — auto-apply behaviour', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createRuleMock.mockResolvedValue({ id: 'rule-1', autoCreateEntry: false });
    applyRulesMock.mockResolvedValue({ applied: 0, skipped: 0 });
  });

  it('CALLS applyRules when autoCreateEntry is omitted (suggest-only rules still apply)', async () => {
    const req = makeReq({ body: { ...VALID_RULE, bankAccountId: BANK_ID } });
    await (handler as unknown as Handler)(req, makeRes());

    expect(createRuleMock).toHaveBeenCalledTimes(1);
    expect(createRuleMock.mock.calls[0]![1].autoCreateEntry).toBe(false);
    expect(applyRulesMock).toHaveBeenCalledTimes(1);
    expect(applyRulesMock).toHaveBeenCalledWith(COMPANY_ID, BANK_ID, USER_ID);
  });

  it('CALLS applyRules when autoCreateEntry is explicitly false', async () => {
    const req = makeReq({ body: { ...VALID_RULE, bankAccountId: BANK_ID, autoCreateEntry: false } });
    await (handler as unknown as Handler)(req, makeRes());

    expect(createRuleMock).toHaveBeenCalledTimes(1);
    expect(applyRulesMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT call applyRules when bankAccountId is omitted', async () => {
    const req = makeReq({ body: { ...VALID_RULE, autoCreateEntry: true } });
    await (handler as unknown as Handler)(req, makeRes());

    expect(createRuleMock).toHaveBeenCalledTimes(1);
    expect(createRuleMock.mock.calls[0]![1].autoCreateEntry).toBe(true);
    expect(applyRulesMock).not.toHaveBeenCalled();
  });

  it('CALLS applyRules when both bankAccountId and autoCreateEntry=true are explicit', async () => {
    const req = makeReq({ body: { ...VALID_RULE, bankAccountId: BANK_ID, autoCreateEntry: true } });
    await (handler as unknown as Handler)(req, makeRes());

    expect(createRuleMock).toHaveBeenCalledTimes(1);
    expect(applyRulesMock).toHaveBeenCalledTimes(1);
    expect(applyRulesMock).toHaveBeenCalledWith(COMPANY_ID, BANK_ID, USER_ID);
  });
});

describe('POST /api/accounting/bank-rules — Zod schema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createRuleMock.mockResolvedValue({ id: 'rule-1', autoCreateEntry: false });
  });

  it('rejects payload with no glAccountId, no supplierId, and no clientId', async () => {
    const { glAccountId: _, ...noTarget } = VALID_RULE;
    const req = makeReq({ body: noTarget });
    await (handler as unknown as Handler)(req, makeRes());

    expect(createRuleMock).not.toHaveBeenCalled();
    expect(apiResponse.validationError).toHaveBeenCalledTimes(1);
  });

  it('rejects payload with missing ruleName', async () => {
    const { ruleName: _, ...noName } = VALID_RULE;
    const req = makeReq({ body: noName });
    await (handler as unknown as Handler)(req, makeRes());

    expect(createRuleMock).not.toHaveBeenCalled();
    expect(apiResponse.validationError).toHaveBeenCalledTimes(1);
  });

  it('rejects payload with invalid matchType enum value', async () => {
    const req = makeReq({ body: { ...VALID_RULE, matchType: 'fuzzy' } });
    await (handler as unknown as Handler)(req, makeRes());

    expect(createRuleMock).not.toHaveBeenCalled();
    expect(apiResponse.validationError).toHaveBeenCalledTimes(1);
  });

  it('accepts a minimal valid payload with supplierId only', async () => {
    const { glAccountId: _, ...rest } = VALID_RULE;
    const req = makeReq({ body: { ...rest, supplierId: SUP_ID } });
    await (handler as unknown as Handler)(req, makeRes());

    expect(createRuleMock).toHaveBeenCalledTimes(1);
    expect(apiResponse.validationError).not.toHaveBeenCalled();
  });
});
