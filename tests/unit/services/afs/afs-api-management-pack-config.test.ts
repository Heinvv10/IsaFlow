// tests/unit/services/afs/afs-api-management-pack-config.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({
  withAuth: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
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
vi.mock('@/modules/accounting/services/afs/managementPackConfigService', () => ({
  getManagementPackConfig: vi.fn(),
  upsertManagementPackConfig: vi.fn(),
}));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success:          vi.fn(),
    badRequest:       vi.fn(),
    methodNotAllowed: vi.fn(),
    validationError:  vi.fn(),
    zodValidationError: vi.fn(),
  },
}));

import { upsertManagementPackConfig } from '@/modules/accounting/services/afs/managementPackConfigService';
import { apiResponse } from '@/lib/apiResponse';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so @/ alias won't resolve; relative path needed
import handler from '../../../../pages/api/accounting/afs/management-pack-config';

const COMPANY_ID  = '11111111-1111-4111-9111-111111111111';
const CONFIG_ID   = '22222222-2222-4222-9222-222222222222';
const OTHER_COMP  = '33333333-3333-4333-9333-333333333333';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

function makeReq(body: Record<string, unknown> = {}): NextApiRequest {
  return {
    method:    'PUT',
    query:     {},
    body,
    companyId: COMPANY_ID,
  } as unknown as NextApiRequest;
}

function makeRes(): NextApiResponse {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe('PUT /afs/management-pack-config', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unsupported method', async () => {
    const req = { ...makeReq(), method: 'DELETE' } as unknown as NextApiRequest;
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.methodNotAllowed).toHaveBeenCalled();
  });

  // ── Backward-compat: the UI round-trips the full ManagementPackConfig ──────
  // (id, companyId, enabled, reviewRequired, sectionsEnabled). The handler
  // must accept these and strip server-controlled fields before calling the
  // service.

  it('accepts the full config object the UI sends and strips id/companyId', async () => {
    vi.mocked(upsertManagementPackConfig).mockResolvedValueOnce({} as never);
    const req = makeReq({
      id: CONFIG_ID,
      companyId: OTHER_COMP, // must NOT replace the auth-derived companyId
      enabled: true,
      generationDay: 5,
      deliveryDay: 10,
      reviewRequired: false,
      sectionsEnabled: { revenue: true, payroll: false },
      packStyle: 'detailed',
      comparisonMode: 'prior_year',
      currencyDisplay: 'thousands',
      recipients: [{ email: 'cfo@example.com', role: 'CFO', receives: 'final' }],
    });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);

    // Service is always called with the request's auth companyId.
    expect(upsertManagementPackConfig).toHaveBeenCalledTimes(1);
    const [calledCompanyId, calledUpdates] = vi.mocked(upsertManagementPackConfig).mock.calls[0]!;
    expect(calledCompanyId).toBe(COMPANY_ID);

    // id and companyId are stripped from updates so the service can't be
    // tricked into rebinding the row to another tenant.
    expect(calledUpdates).not.toHaveProperty('id');
    expect(calledUpdates).not.toHaveProperty('companyId');
    expect(calledUpdates).toMatchObject({
      enabled: true,
      generationDay: 5,
      deliveryDay: 10,
      reviewRequired: false,
      packStyle: 'detailed',
    });
    expect(apiResponse.success).toHaveBeenCalled();
  });

  it('accepts a partial config (UI sends only edited fields)', async () => {
    vi.mocked(upsertManagementPackConfig).mockResolvedValueOnce({} as never);
    const req = makeReq({ packStyle: 'board' });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(upsertManagementPackConfig).toHaveBeenCalledWith(COMPANY_ID, expect.objectContaining({ packStyle: 'board' }));
  });

  // ── Validation rejections ──────────────────────────────────────────────────

  it('rejects deliveryDay below 1', async () => {
    const req = makeReq({ deliveryDay: 0 });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ deliveryDay: expect.any(Array) }),
    );
  });

  it('rejects deliveryDay above 28', async () => {
    const req = makeReq({ deliveryDay: 29 });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ deliveryDay: expect.any(Array) }),
    );
  });

  it('rejects invalid packStyle', async () => {
    const req = makeReq({ packStyle: 'gibberish' });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ packStyle: expect.any(Array) }),
    );
  });

  it('rejects invalid comparisonMode', async () => {
    const req = makeReq({ comparisonMode: 'next_year' });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ comparisonMode: expect.any(Array) }),
    );
  });

  it('rejects invalid currencyDisplay', async () => {
    const req = makeReq({ currencyDisplay: 'gazillions' });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ currencyDisplay: expect.any(Array) }),
    );
  });

  it('rejects malformed recipient email', async () => {
    const req = makeReq({
      recipients: [{ email: 'not-an-email', role: 'CFO', receives: 'final' }],
    });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalled();
  });

  it('rejects more than 50 recipients', async () => {
    const recipients = Array.from({ length: 51 }, (_, i) => ({
      email: `r${i}@example.com`,
      role: 'reviewer',
      receives: 'final' as const,
    }));
    const req = makeReq({ recipients });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ recipients: expect.any(Array) }),
    );
  });

  it('rejects unknown body fields (.strict)', async () => {
    const req = makeReq({ packStyle: 'detailed', hackerField: 1 });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalled();
  });

  it('rejects unknown fields inside a recipient (.strict on RecipientSchema)', async () => {
    const req = makeReq({
      recipients: [{ email: 'a@b.co', role: 'CFO', receives: 'final', hacker: 1 }],
    });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalled();
  });
});
