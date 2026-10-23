// GET /api/accounting/afs/report-templates: period_months reaches the wording and is validated.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({
  withAuth: (handler: unknown) => handler,
  withWriteAccess: (handler: unknown) => handler,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (handler: unknown) => handler }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: { success: vi.fn(), badRequest: vi.fn(), notFound: vi.fn(), methodNotAllowed: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so relative path required
import handler from '../../../../pages/api/accounting/afs/report-templates';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
const call = (query: Record<string, string>) => (handler as unknown as Handler)(
  { method: 'GET', companyId: 'c1', query: { type: 'review', period_end: '2027-02-28', ...query } } as unknown as NextApiRequest,
  {} as NextApiResponse,
);

describe('report-templates period_months', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ company_name: 'Synthetic', registration_number: null }]);
  });

  it('defaults to twelve months', async () => {
    await call({});
    const body = (apiResponse.success as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { templates: { practitionerReport: string } };
    expect(body.templates.practitionerReport).toContain('for the year then ended');
  });

  it('14 months says "for the period then ended"', async () => {
    await call({ period_months: '14' });
    const body = (apiResponse.success as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { templates: { practitionerReport: string; directorsReport: string } };
    expect(body.templates.practitionerReport).toContain('for the period then ended');
    expect(body.templates.directorsReport).toContain('for the 14 months ended 2027-02-28');
  });

  it.each(['0', '16', '1.5', 'abc', ''])('period_months=%j is a 400', async (bad) => {
    await call({ period_months: bad });
    expect(apiResponse.badRequest).toHaveBeenCalledTimes(1);
    expect(apiResponse.success).not.toHaveBeenCalled();
  });
});
