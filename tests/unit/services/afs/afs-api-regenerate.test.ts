// tests/unit/services/afs/afs-api-regenerate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({
  withAuth: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
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
  },
}));

import { generateSection } from '@/modules/accounting/services/afs/noteEngineService';
import { apiResponse } from '@/lib/apiResponse';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so @/ alias won't resolve; relative path needed
import handler from '../../../../pages/api/accounting/afs/[documentId]/sections/[sectionId]/regenerate';

const COMPANY_ID  = 'ccc11111-0000-0000-0000-000000000001';
const DOCUMENT_ID = 'ddd22222-0000-0000-0000-000000000002';
const SECTION_ID  = 'sss33333-0000-0000-0000-000000000003';

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
    expect(apiResponse.badRequest).toHaveBeenCalledWith(res, expect.stringContaining('fiscalYear'));
  });

  it('rejects fiscalYear below 2000', async () => {
    const req = makeReq({ body: { fiscalYear: 1999, framework: 'full_ifrs' } });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.badRequest).toHaveBeenCalledWith(res, expect.stringContaining('fiscalYear'));
  });

  it('rejects invalid framework value', async () => {
    const req = makeReq({ body: { fiscalYear: 2025, framework: 'gaap' } });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.badRequest).toHaveBeenCalledWith(res, expect.stringContaining('framework'));
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
