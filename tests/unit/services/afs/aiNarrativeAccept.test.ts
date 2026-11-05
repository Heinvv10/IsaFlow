/**
 * PUT .../sections/<id>/ai-narrative (accept): the AI call's failure sentence is not a narrative, so accepting it is a 400
 * and nothing is written (it would be frozen into the section's blocks). A real narrative is accepted as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const m = vi.hoisted(() => ({ sql: vi.fn(), apiResponse: { badRequest: vi.fn(), success: vi.fn(), notFound: vi.fn(), methodNotAllowed: vi.fn(), tooManyRequests: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/withWriteAccess', () => ({ withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/apiResponse', () => ({ apiResponse: m.apiResponse }));
vi.mock('@/modules/accounting/services/afs/noteAiService', () => ({ generateNoteNarrative: vi.fn() }));
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/
import handler from '../../../../pages/api/accounting/afs/[documentId]/sections/[sectionId]/ai-narrative';

const accept = async (narrative: string | null) => {
  m.sql.mockResolvedValueOnce([{ ai_narrative: narrative, content: { title: 'Cash Flow', blocks: [] } }]).mockResolvedValue([]);
  const req = { method: 'PUT', query: { documentId: '33333333-3333-4333-8333-333333333333', sectionId: '44444444-4444-4444-8444-444444444444' }, companyId: 'c' } as unknown as NextApiRequest;
  await (handler as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<void>)(req, {} as NextApiResponse);
};

beforeEach(() => vi.clearAllMocks());

describe('accepting an AI narrative', () => {
  it.each(['AI commentary unavailable for this section.', 'AI summary unavailable for this period.'])('refuses the failure sentence %j with a 400 and writes nothing', async (text) => {
    await accept(text);
    expect(m.apiResponse.badRequest).toHaveBeenCalledTimes(1);
    expect(m.sql).toHaveBeenCalledTimes(1);
    expect(m.apiResponse.success).not.toHaveBeenCalled();
  });

  it('accepts a real narrative: copied into the overrides blocks, flag set', async () => {
    await accept('Cash held.');
    expect(m.apiResponse.badRequest).not.toHaveBeenCalled();
    expect(m.apiResponse.success).toHaveBeenCalledWith(expect.anything(), { accepted: true });
    expect(m.sql).toHaveBeenCalledTimes(2);
  });
});
