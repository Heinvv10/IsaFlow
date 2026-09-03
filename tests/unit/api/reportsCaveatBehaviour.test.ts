/**
 * Behavioural guards for two things a source-grep test cannot hold.
 *
 * 1. ai-commentary must put the unclassified caveat INSIDE its risk areas.
 *    A grep for `riskAreas.unshift(` still matches when the call is wrapped in
 *    `if (false)`, so the guard has to run the handler and read the output.
 * 2. reports-ratios must default "today" from the LOCAL calendar. On this UTC+2
 *    host, `new Date().toISOString()` between 00:00 and 02:00 SAST returns
 *    yesterday, silently shortening the reporting period by a day.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({
  sql: (...a: unknown[]) => sqlMock(...a),
  withSavepoint: (_n: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: vi.fn(async () => true),
  checkReportRateLimit: vi.fn(async () => true),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('@/modules/accounting/services/gl/trialBalanceBasis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/trialBalanceBasis')>()),
  getRetainedEarningsBroughtForward: vi.fn(async () => 0),
}));

import aiCommentary from '../../../pages/api/accounting/ai-commentary';
import reportsRatios from '../../../pages/api/accounting/reports-ratios';

const COMPANY = '11111111-1111-4111-8111-111111111111';

/** 39 expense accounts with no subtype — production's real cohort. */
const UNCLASSIFIED_EXPENSE_ROWS = [
  {
    account_type: 'expense', account_subtype: null, account_count: '39',
    period_debit: '114177043.06', period_credit: '0',
    cumulative_debit: '114177043.06', cumulative_credit: '0',
  },
];

function mockRes() {
  const res = {
    statusCode: 0,
    sent: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; },
    send(p: unknown) { this.sent = p; return this; },
    setHeader() { return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockImplementation(async (strings: readonly string[]) => {
    const q = strings.join('?');
    if (q.includes('GROUP BY ga.account_type')) return UNCLASSIFIED_EXPENSE_ROWS;
    if (q.includes('has_inventory')) return [{ has_inventory: false }];
    if (q.includes('FROM companies')) return [{ name: 'Test Co' }];
    return [];
  });
});

describe('ai-commentary caveat reaches the narrative', () => {
  it('adds an Unclassified Accounts risk area naming the defaulted total', async () => {
    const req = {
      method: 'POST',
      body: { from: '2026-01-01', to: '2026-09-30' },
      companyId: COMPANY,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as NextApiRequest;
    const res = mockRes();

    await (aiCommentary as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);

    const body = res.sent as { data?: { riskAreas?: Array<{ area: string; description: string }> } };
    const risks = body.data?.riskAreas ?? [];
    const caveat = risks.find((r) => r.area === 'Unclassified Accounts');
    expect(caveat, 'no Unclassified Accounts risk area in the commentary').toBeDefined();
    expect(caveat!.description).toContain('39 expense account');
    expect(caveat!.description).toMatch(/operating expenses/i);
    // It must lead: a caveat buried under three other risks is not a caveat.
    expect(risks[0]!.area).toBe('Unclassified Accounts');
  });
});

describe('reports-ratios defaults "today" from the local calendar', () => {
  afterEach(() => vi.useRealTimers());

  it('does not roll back a day just after midnight SAST', async () => {
    // 00:30 on 15 March SAST is still 14 March in UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T22:30:00.000Z'));

    const req = { method: 'GET', query: {}, companyId: COMPANY } as unknown as NextApiRequest;
    const res = mockRes();

    await (reportsRatios as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);

    const body = res.sent as { data?: { period?: { from: string; to: string } } };
    expect(body.data?.period?.to).toBe('2026-03-15');
    expect(body.data?.period?.to).not.toBe('2026-03-14');
    // And the year-to-date start follows the same local year.
    expect(body.data?.period?.from).toBe('2026-01-01');
  });
});
