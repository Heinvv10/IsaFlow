// tests/unit/services/afs/afs-api-create.test.ts
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
vi.mock('@/modules/accounting/services/afs/afsDocumentService', () => ({
  listAfsDocuments: vi.fn(),
  createAfsDocument: vi.fn(),
  AfsDocumentDuplicateError: class AfsDocumentDuplicateError extends Error {
    public readonly existing: { id: string };
    constructor(msg: string, existing: { id: string }) {
      super(msg);
      this.existing = existing;
    }
  },
}));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success:          vi.fn(),
    created:          vi.fn(),
    conflict:         vi.fn(),
    badRequest:       vi.fn(),
    methodNotAllowed: vi.fn(),
    validationError:  vi.fn(),
  },
}));

import { createAfsDocument, AfsDocumentDuplicateError } from '@/modules/accounting/services/afs/afsDocumentService';
import { apiResponse } from '@/lib/apiResponse';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so @/ alias won't resolve; relative path needed
import handler from '../../../../pages/api/accounting/afs/index';

const COMPANY_ID = '11111111-1111-4111-9111-111111111111';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

function makeReq(body: Record<string, unknown> = {}): NextApiRequest {
  return {
    method:    'POST',
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

describe('POST /afs (create document)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unknown method', async () => {
    const req = { ...makeReq(), method: 'DELETE' } as unknown as NextApiRequest;
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.methodNotAllowed).toHaveBeenCalled();
  });

  it('rejects missing documentType with field-keyed error', async () => {
    const req = makeReq({ reportingFramework: 'full_ifrs', fiscalYear: 2025 });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ documentType: expect.any(Array) }),
    );
  });

  it('rejects invalid documentType', async () => {
    const req = makeReq({ documentType: 'gibberish', reportingFramework: 'full_ifrs', fiscalYear: 2025 });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ documentType: expect.any(Array) }),
    );
  });

  it('rejects invalid reportingFramework', async () => {
    const req = makeReq({ documentType: 'afs', reportingFramework: 'gaap', fiscalYear: 2025 });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ reportingFramework: expect.any(Array) }),
    );
  });

  it('rejects fiscalYear below 2000', async () => {
    const req = makeReq({ documentType: 'afs', reportingFramework: 'full_ifrs', fiscalYear: 1999 });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ fiscalYear: expect.any(Array) }),
    );
  });

  it('rejects fiscalYear above 2100', async () => {
    const req = makeReq({ documentType: 'afs', reportingFramework: 'full_ifrs', fiscalYear: 2101 });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ fiscalYear: expect.any(Array) }),
    );
  });

  it('rejects period that is not YYYY-MM', async () => {
    const req = makeReq({ documentType: 'management_pack', reportingFramework: 'full_ifrs', period: '2026-13' });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ period: expect.any(Array) }),
    );
  });

  it('rejects unknown body fields (.strict)', async () => {
    const req = makeReq({
      documentType: 'afs',
      reportingFramework: 'full_ifrs',
      fiscalYear: 2025,
      hackerField: 1,
    });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalled();
  });

  // ── Cross-field refines (the heart of this PR's safety logic) ───────────────

  it('rejects documentType=afs without fiscalYear — error keyed on fiscalYear', async () => {
    const req = makeReq({ documentType: 'afs', reportingFramework: 'full_ifrs' });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ fiscalYear: expect.any(Array) }),
    );
  });

  it('rejects documentType=management_pack without period — error keyed on period', async () => {
    const req = makeReq({ documentType: 'management_pack', reportingFramework: 'full_ifrs' });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.validationError).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ period: expect.any(Array) }),
    );
  });

  // ── Happy paths for both branches of the refine ─────────────────────────────

  it('creates an AFS document with fiscalYear + reporting framework', async () => {
    vi.mocked(createAfsDocument).mockResolvedValueOnce({ id: 'doc-1' } as never);
    const req = makeReq({ documentType: 'afs', reportingFramework: 'ifrs_smes', fiscalYear: 2025 });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(createAfsDocument).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      documentType: 'afs',
      reportingFramework: 'ifrs_smes',
      fiscalYear: 2025,
    }));
    expect(apiResponse.created).toHaveBeenCalled();
  });

  it('creates a management_pack document with period', async () => {
    vi.mocked(createAfsDocument).mockResolvedValueOnce({ id: 'pack-1' } as never);
    const req = makeReq({ documentType: 'management_pack', reportingFramework: 'full_ifrs', period: '2026-04' });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(createAfsDocument).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      documentType: 'management_pack',
      reportingFramework: 'full_ifrs',
      period: '2026-04',
    }));
    expect(apiResponse.created).toHaveBeenCalled();
  });

  it('returns 409 conflict on duplicate', async () => {
    vi.mocked(createAfsDocument).mockRejectedValueOnce(
      new AfsDocumentDuplicateError('Already exists', { id: 'doc-existing' }),
    );
    const req = makeReq({ documentType: 'afs', reportingFramework: 'ifrs_smes', fiscalYear: 2025 });
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.conflict).toHaveBeenCalled();
  });
});
