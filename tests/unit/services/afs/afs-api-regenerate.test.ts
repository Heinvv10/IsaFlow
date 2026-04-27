// tests/unit/services/afs/afs-api-regenerate.test.ts
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
vi.mock('@/modules/accounting/services/afs/noteEngineService', () => ({
  generateSection: vi.fn(),
}));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success:          vi.fn(),
    badRequest:       vi.fn(),
    methodNotAllowed: vi.fn(),
    validationError:  vi.fn(),
  },
}));

import { generateSection } from '@/modules/accounting/services/afs/noteEngineService';
import { apiResponse } from '@/lib/apiResponse';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so @/ alias won't resolve; relative path needed
import handler from '../../../../pages/api/accounting/afs/[documentId]/sections/[sectionId]/regenerate';

// v4-format UUIDs (3rd group must start with 4, 4th with 8-b) — required
// because the handler's UUID-validated path now rejects non-conforming IDs.
const COMPANY_ID  = '11111111-1111-4111-9111-111111111111';
const DOCUMENT_ID = '22222222-2222-4222-9222-222222222222';
const SECTION_ID  = '33333333-3333-4333-9333-333333333333';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method:    'POST',
    query:     { documentId: DOCUMENT_ID, sectionId: SECTION_ID },
    body:      { fiscalYear: 2025, framework: 'full_ifrs' },
    companyId: COMPANY_ID,
    ...overrides,
  } as unknown as NextApiRequest;
}

function makeRes(): NextApiResponse {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe('POST /afs/[documentId]/sections/[sectionId]/regenerate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects non-POST methods', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.methodNotAllowed).toHaveBeenCalled();
  });

  it('rejects missing fiscalYear', async () => {
    const req = makeReq({ body: { framework: 'full_ifrs' } });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalled();
  });

  it('rejects fiscalYear below 2000', async () => {
    const req = makeReq({ body: { fiscalYear: 1999, framework: 'full_ifrs' } });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalled();
  });

  it('rejects invalid framework value', async () => {
    const req = makeReq({ body: { fiscalYear: 2025, framework: 'gaap' } });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalled();
  });

  it('calls generateSection and returns { sectionId } on success', async () => {
    vi.mocked(generateSection).mockResolvedValueOnce(undefined);
    const req = makeReq();
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(generateSection).toHaveBeenCalledWith(
      COMPANY_ID, DOCUMENT_ID, SECTION_ID, 2025, 'full_ifrs',
    );
    expect(apiResponse.success).toHaveBeenCalledWith(res, { sectionId: SECTION_ID });
  });

  it('accepts ifrs_smes as a valid framework', async () => {
    vi.mocked(generateSection).mockResolvedValueOnce(undefined);
    const req = makeReq({ body: { fiscalYear: 2024, framework: 'ifrs_smes' } });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(generateSection).toHaveBeenCalledWith(
      COMPANY_ID, DOCUMENT_ID, SECTION_ID, 2024, 'ifrs_smes',
    );
  });
});
