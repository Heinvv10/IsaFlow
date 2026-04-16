// tests/unit/services/afs/afs-api-suppress-reorder.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({
  withCompany: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));
vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success:          vi.fn(),
    badRequest:       vi.fn(),
    notFound:         vi.fn(),
    methodNotAllowed: vi.fn(),
  },
}));

import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so relative path required
import suppressHandler from '../../../../pages/api/accounting/afs/[documentId]/sections/[sectionId]/suppress';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so relative path required
import reorderHandler  from '../../../../pages/api/accounting/afs/[documentId]/sections/reorder';

const COMPANY_ID  = 'ccc11111-0000-0000-0000-000000000001';
const DOCUMENT_ID = 'ddd22222-0000-0000-0000-000000000002';
const SECTION_ID  = 'sss33333-0000-0000-0000-000000000003';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

function makeRes(): NextApiResponse {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

// ── suppress ──────────────────────────────────────────────────────────────────

describe('POST /afs/[documentId]/sections/[sectionId]/suppress', () => {
  beforeEach(() => vi.clearAllMocks());

  function makeReq(body: Record<string, unknown> = {}): NextApiRequest {
    return {
      method:    'POST',
      query:     { documentId: DOCUMENT_ID, sectionId: SECTION_ID },
      body,
      companyId: COMPANY_ID,
    } as unknown as NextApiRequest;
  }

  it('rejects non-POST methods', async () => {
    const req = { ...makeReq(), method: 'GET' } as unknown as NextApiRequest;
    const res = makeRes();
    await (suppressHandler as unknown as Handler)(req, res);
    expect(apiResponse.methodNotAllowed).toHaveBeenCalled();
  });

  it('rejects non-boolean suppress value', async () => {
    const req = makeReq({ suppress: 'true' });
    const res = makeRes();
    await (suppressHandler as unknown as Handler)(req, res);
    expect(apiResponse.badRequest).toHaveBeenCalledWith(res, 'suppress must be a boolean');
  });

  it('rejects suppress=true without reason', async () => {
    const req = makeReq({ suppress: true });
    const res = makeRes();
    await (suppressHandler as unknown as Handler)(req, res);
    expect(apiResponse.badRequest).toHaveBeenCalledWith(res, 'reason is required when suppressing a section');
  });

  it('returns 404 when section not found', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    const req = makeReq({ suppress: true, reason: 'zero balance' });
    const res = makeRes();
    await (suppressHandler as unknown as Handler)(req, res);
    expect(apiResponse.notFound).toHaveBeenCalled();
  });

  it('rejects suppression of a signed-off section', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ status: 'signed_off' }] as never);
    const req = makeReq({ suppress: true, reason: 'zero balance' });
    const res = makeRes();
    await (suppressHandler as unknown as Handler)(req, res);
    expect(apiResponse.badRequest).toHaveBeenCalledWith(res, 'Cannot suppress a signed-off section');
  });

  it('suppresses a pending section and returns { suppressed: true }', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([{ status: 'auto_generated' }] as never)
      .mockResolvedValueOnce([] as never);
    const req = makeReq({ suppress: true, reason: 'zero balance' });
    const res = makeRes();
    await (suppressHandler as unknown as Handler)(req, res);
    expect(apiResponse.success).toHaveBeenCalledWith(res, { suppressed: true });
  });

  it('unsuppresses a section and returns { suppressed: false }', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([{ status: 'pending' }] as never)
      .mockResolvedValueOnce([] as never);
    const req = makeReq({ suppress: false });
    const res = makeRes();
    await (suppressHandler as unknown as Handler)(req, res);
    expect(apiResponse.success).toHaveBeenCalledWith(res, { suppressed: false });
  });
});

// ── reorder ───────────────────────────────────────────────────────────────────

describe('PUT /afs/[documentId]/sections/reorder', () => {
  beforeEach(() => vi.clearAllMocks());

  function makeReq(body: Record<string, unknown> = {}): NextApiRequest {
    return {
      method:    'PUT',
      query:     { documentId: DOCUMENT_ID },
      body,
      companyId: COMPANY_ID,
    } as unknown as NextApiRequest;
  }

  it('rejects non-PUT methods', async () => {
    const req = { ...makeReq(), method: 'POST' } as unknown as NextApiRequest;
    const res = makeRes();
    await (reorderHandler as unknown as Handler)(req, res);
    expect(apiResponse.methodNotAllowed).toHaveBeenCalled();
  });

  it('rejects empty sections array', async () => {
    const req = makeReq({ sections: [] });
    const res = makeRes();
    await (reorderHandler as unknown as Handler)(req, res);
    expect(apiResponse.badRequest).toHaveBeenCalledWith(res, 'sections must be a non-empty array');
  });

  it('rejects more than 50 sections', async () => {
    const sections = Array.from({ length: 51 }, (_, i) => ({ id: `id-${i}`, newSortOrder: i + 1 }));
    const req = makeReq({ sections });
    const res = makeRes();
    await (reorderHandler as unknown as Handler)(req, res);
    expect(apiResponse.badRequest).toHaveBeenCalledWith(res, expect.stringContaining('50'));
  });

  it('rejects duplicate newSortOrder values', async () => {
    const sections = [
      { id: 'id-1', newSortOrder: 1 },
      { id: 'id-2', newSortOrder: 1 },
    ];
    const req = makeReq({ sections });
    const res = makeRes();
    await (reorderHandler as unknown as Handler)(req, res);
    expect(apiResponse.badRequest).toHaveBeenCalledWith(res, expect.stringContaining('Duplicate'));
  });

  it('rejects zero newSortOrder', async () => {
    const sections = [{ id: 'id-1', newSortOrder: 0 }];
    const req = makeReq({ sections });
    const res = makeRes();
    await (reorderHandler as unknown as Handler)(req, res);
    expect(apiResponse.badRequest).toHaveBeenCalledWith(res, expect.stringContaining('id'));
  });

  it('runs concurrent updates and returns { reordered: count }', async () => {
    const sections = [
      { id: SECTION_ID, newSortOrder: 2 },
      { id: 'sss44444-0000-0000-0000-000000000004', newSortOrder: 1 },
    ];
    vi.mocked(sql)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);
    const req = makeReq({ sections });
    const res = makeRes();
    await (reorderHandler as unknown as Handler)(req, res);
    expect(sql).toHaveBeenCalledTimes(2);
    expect(apiResponse.success).toHaveBeenCalledWith(res, { reordered: 2 });
  });
});
