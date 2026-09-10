// tests/unit/services/afs/afs-api-suppress-reorder.test.ts
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
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/apiResponse', () => {
  const validationError = vi.fn();
  const zodValidationError = vi.fn((res, error) => {
    validationError(res, error.flatten().fieldErrors);
  });
  return {
    apiResponse: {
      success:          vi.fn(),
      badRequest:       vi.fn(),
      notFound:         vi.fn(),
      methodNotAllowed: vi.fn(),
      validationError,
      zodValidationError,
    },
  };
});

import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so relative path required
import suppressHandler from '../../../../pages/api/accounting/afs/[documentId]/sections/[sectionId]/suppress';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so relative path required
import reorderHandler  from '../../../../pages/api/accounting/afs/[documentId]/sections/reorder';

// v4-format UUIDs — required because the handler's UUID-validated path
// now rejects non-conforming IDs.
const COMPANY_ID  = '11111111-1111-4111-9111-111111111111';
const DOCUMENT_ID = '22222222-2222-4222-9222-222222222222';
const SECTION_ID  = '33333333-3333-4333-9333-333333333333';

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
      user:      { id: '44444444-4444-4444-9444-444444444444' },
    } as unknown as NextApiRequest;
  }

  it('rejects non-POST methods', async () => {
    const req = { ...makeReq(), method: 'GET' } as unknown as NextApiRequest;
    const res = makeRes();
    await (suppressHandler as unknown as Handler)(req, res);
    expect(apiResponse.methodNotAllowed).toHaveBeenCalled();
  });

  it('rejects non-boolean suppress value with field-keyed error', async () => {
    const req = makeReq({ suppress: 'true' });
    const res = makeRes();
    await (suppressHandler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ suppress: expect.any(Array) }),
    );
  });

  it('rejects suppress=true with missing reason — error keyed on reason', async () => {
    const req = makeReq({ suppress: true });
    const res = makeRes();
    await (suppressHandler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ reason: expect.any(Array) }),
    );
  });

  it('rejects suppress=true with whitespace-only reason', async () => {
    const req = makeReq({ suppress: true, reason: '   ' });
    const res = makeRes();
    await (suppressHandler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ reason: expect.any(Array) }),
    );
  });

  it('rejects unknown body fields (.strict)', async () => {
    const req = makeReq({ suppress: false, hackerField: 1 });
    const res = makeRes();
    await (suppressHandler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalled();
  });

  it('rejects non-UUID documentId path param', async () => {
    const req = {
      method:    'POST',
      query:     { documentId: 'not-a-uuid', sectionId: SECTION_ID },
      body:      { suppress: false },
      companyId: COMPANY_ID,
    } as unknown as NextApiRequest;
    const res = makeRes();
    await (suppressHandler as unknown as Handler)(req, res);
    expect(apiResponse.badRequest).toHaveBeenCalledWith(
      res,
      'documentId must be a valid UUID',
    );
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
      user:      { id: '44444444-4444-4444-9444-444444444444' },
    } as unknown as NextApiRequest;
  }

  it('rejects non-PUT methods', async () => {
    const req = { ...makeReq(), method: 'POST' } as unknown as NextApiRequest;
    const res = makeRes();
    await (reorderHandler as unknown as Handler)(req, res);
    expect(apiResponse.methodNotAllowed).toHaveBeenCalled();
  });

  // Two real v4 UUIDs for use in valid reorder bodies.
  const SECT_A = '44444444-4444-4444-9444-444444444444';
  const SECT_B = '55555555-5555-4555-9555-555555555555';

  it('rejects empty sections array — error keyed on sections', async () => {
    const req = makeReq({ sections: [] });
    const res = makeRes();
    await (reorderHandler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ sections: expect.any(Array) }),
    );
  });

  it('rejects more than 50 sections — error keyed on sections', async () => {
    // All ids must be valid UUIDs to bypass element-level validation and
    // trip the 50-cap rule.
    const sections = Array.from({ length: 51 }, (_, i) => ({
      id: `${i.toString(16).padStart(8, '0')}-1111-4111-9111-111111111111`,
      newSortOrder: i + 1,
    }));
    const req = makeReq({ sections });
    const res = makeRes();
    await (reorderHandler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ sections: expect.any(Array) }),
    );
  });

  it('rejects duplicate newSortOrder values — error keyed on sections', async () => {
    const sections = [
      { id: SECT_A, newSortOrder: 1 },
      { id: SECT_B, newSortOrder: 1 },
    ];
    const req = makeReq({ sections });
    const res = makeRes();
    await (reorderHandler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ sections: expect.any(Array) }),
    );
  });

  it('rejects zero newSortOrder — error keyed on sections', async () => {
    const sections = [{ id: SECT_A, newSortOrder: 0 }];
    const req = makeReq({ sections });
    const res = makeRes();
    await (reorderHandler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ sections: expect.any(Array) }),
    );
  });

  it('rejects non-UUID id at element level — error keyed on sections', async () => {
    const sections = [{ id: 'not-a-uuid', newSortOrder: 1 }];
    const req = makeReq({ sections });
    const res = makeRes();
    await (reorderHandler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ sections: expect.any(Array) }),
    );
  });

  it('rejects unknown fields in element (.strict on ReorderItemSchema)', async () => {
    const sections = [{ id: SECT_A, newSortOrder: 1, hackerField: true }];
    const req = makeReq({ sections });
    const res = makeRes();
    await (reorderHandler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ sections: expect.any(Array) }),
    );
  });

  it('rejects non-UUID documentId path param', async () => {
    const req = {
      method:    'PUT',
      query:     { documentId: 'not-a-uuid' },
      body:      { sections: [{ id: SECT_A, newSortOrder: 1 }] },
      companyId: COMPANY_ID,
    } as unknown as NextApiRequest;
    const res = makeRes();
    await (reorderHandler as unknown as Handler)(req, res);
    expect(apiResponse.badRequest).toHaveBeenCalledWith(res, 'documentId must be a valid UUID');
  });

  it('runs concurrent updates and returns { reordered: count }', async () => {
    const sections = [
      { id: SECTION_ID, newSortOrder: 2 },
      { id: SECT_A, newSortOrder: 1 },
    ];
    // Each section is locked through the write guard first, then renumbered.
    const locked = { id: SECTION_ID, document_id: DOCUMENT_ID, section_type: 'note_1', status: 'auto_generated',
      reviewed_by: null, signed_off_by: null, document_status: 'draft', signing_requested_at: null };
    vi.mocked(sql)
      // one lock per section, then the document's own sections read under those locks, then
      // one UPDATE per section
      .mockResolvedValueOnce([locked] as never)
      .mockResolvedValueOnce([{ ...locked, id: SECT_A }] as never)
      .mockResolvedValueOnce([{ id: SECTION_ID, sort_order: 1 }, { id: SECT_A, sort_order: 2 }] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);
    const req = makeReq({ sections });
    const res = makeRes();
    await (reorderHandler as unknown as Handler)(req, res);
    expect(sql).toHaveBeenCalledTimes(5);
    expect(apiResponse.success).toHaveBeenCalledWith(res, { reordered: 2 });
  });
});
