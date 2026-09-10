// tests/unit/services/afs/afs-api-ai-narrative.test.ts
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
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
  checkAiRateLimit: vi.fn().mockResolvedValue(true),
  getClientIp: vi.fn().mockReturnValue('1.2.3.4'),
}));
vi.mock('@/modules/accounting/services/afs/noteAiService', () => ({
  generateNoteNarrative: vi.fn(),
}));
// The section write guard (document binding, lock check, review invalidation) is proven
// against real PostgreSQL in tests/integration/controls/afsSectionReviewIntegrityHttp.int.test.ts.
vi.mock('@/modules/accounting/services/afs/afsSectionAttestation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/afs/afsSectionAttestation')>()),
  lockSectionForWrite: vi.fn().mockResolvedValue({
    id: 'section', documentId: 'document', sectionType: 'note', status: 'pending', reviewedBy: null, signedOffBy: null,
  }),
  voidSectionAttestation: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success:          vi.fn(),
    badRequest:       vi.fn(),
    notFound:         vi.fn(),
    methodNotAllowed: vi.fn(),
    tooManyRequests:  vi.fn(),
  },
}));

import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { generateNoteNarrative } from '@/modules/accounting/services/afs/noteAiService';
import { lockSectionForWrite } from '@/modules/accounting/services/afs/afsSectionAttestation';
import { ReviewError } from '@/modules/accounting/services/afs/afsReviewService';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so relative path required
import handler from '../../../../pages/api/accounting/afs/[documentId]/sections/[sectionId]/ai-narrative';

const COMPANY_ID  = 'ccc11111-0000-0000-0000-000000000001';
const DOCUMENT_ID = 'ddd22222-0000-0000-0000-000000000002';
const SECTION_ID  = 'sss33333-0000-0000-0000-000000000003';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

function makeRes(): NextApiResponse {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

function makeReq(method: 'POST' | 'PUT' = 'POST'): NextApiRequest {
  return {
    method,
    query:     { documentId: DOCUMENT_ID, sectionId: SECTION_ID },
    body:      {},
    companyId: COMPANY_ID,
    user:      { id: 'uuu44444-0000-0000-0000-000000000004' },
  } as unknown as NextApiRequest;
}

const MOCK_CONTENT = { title: 'Note 1', blocks: [{ type: 'paragraph', text: 'Existing text.' }] };

// ── POST — generate AI narrative ──────────────────────────────────────────────

describe('POST /afs/[documentId]/sections/[sectionId]/ai-narrative', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unsupported methods', async () => {
    const req = { ...makeReq(), method: 'DELETE' } as unknown as NextApiRequest;
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.methodNotAllowed).toHaveBeenCalled();
  });

  it('returns 404 when section not found', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    const req = makeReq('POST');
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.notFound).toHaveBeenCalled();
  });

  it('returns 400 when section has no AI prompt template', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{
      section_type: 'note_1',
      content: MOCK_CONTENT,
      company_name: 'Test Co',
      framework: 'full_ifrs',
      fiscal_year: 2025,
      ai_prompt_template: null,
    }] as never);
    const req = makeReq('POST');
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.badRequest).toHaveBeenCalledWith(
      res,
      'No AI prompt template configured for this section type',
    );
  });

  it('generates narrative and returns { narrative } on success', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([{
        section_type: 'note_1',
        content: MOCK_CONTENT,
        company_name: 'Test Co',
        framework: 'full_ifrs',
        fiscal_year: 2025,
        ai_prompt_template: 'Write a note about {tables}',
      }] as never)
      .mockResolvedValueOnce([] as never); // UPDATE

    vi.mocked(generateNoteNarrative).mockResolvedValueOnce('AI generated text.');

    const req = makeReq('POST');
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);

    expect(generateNoteNarrative).toHaveBeenCalledWith(
      'note_1',
      MOCK_CONTENT,
      'Write a note about {tables}',
      { name: 'Test Co', framework: 'full_ifrs', fiscalYear: 2025 },
    );
    expect(apiResponse.success).toHaveBeenCalledWith(res, { narrative: 'AI generated text.' });
  });

  it('uses fiscal_year from document — not server clock', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([{
        section_type: 'note_17',
        content: MOCK_CONTENT,
        company_name: 'Acme',
        framework: 'ifrs_for_smes',
        fiscal_year: 2023,
        ai_prompt_template: 'template',
      }] as never)
      .mockResolvedValueOnce([] as never);

    vi.mocked(generateNoteNarrative).mockResolvedValueOnce('narrative');

    const req = makeReq('POST');
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);

    expect(generateNoteNarrative).toHaveBeenCalledWith(
      'note_17', MOCK_CONTENT, 'template',
      expect.objectContaining({ fiscalYear: 2023 }),
    );
  });
});

// ── PUT — accept AI narrative ─────────────────────────────────────────────────

describe('PUT /afs/[documentId]/sections/[sectionId]/ai-narrative', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when section not found', async () => {
    vi.mocked(lockSectionForWrite).mockRejectedValueOnce(new ReviewError('Section not found', 'NOT_FOUND'));
    const req = makeReq('PUT');
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.notFound).toHaveBeenCalled();
  });

  it('returns 400 when section has no ai_narrative to accept', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{
      ai_narrative: null,
      content: MOCK_CONTENT,
    }] as never);
    const req = makeReq('PUT');
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);
    expect(apiResponse.badRequest).toHaveBeenCalledWith(res, 'No AI narrative to accept');
  });

  it('appends narrative as paragraph to content and saves to overrides', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([{
        ai_narrative: 'AI text here.',
        content: MOCK_CONTENT,
      }] as never)
      .mockResolvedValueOnce([] as never); // UPDATE

    const req = makeReq('PUT');
    const res = makeRes();
    await (handler as unknown as Handler)(req, res);

    // The second sql call (UPDATE) should include ai_narrative_accepted=true and overrides
    const updateCall = vi.mocked(sql).mock.calls[1];
    const flatStrings = (updateCall.flat() as unknown[]).filter((a): a is string => typeof a === 'string');
    expect(flatStrings.some((s: string) => s.includes('ai_narrative_accepted'))).toBe(true);
    expect(flatStrings.some((s: string) => s.includes('overrides'))).toBe(true);

    expect(apiResponse.success).toHaveBeenCalledWith(res, { accepted: true });
  });
});
