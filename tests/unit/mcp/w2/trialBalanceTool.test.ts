/**
 * `trial_balance` v2 (W2) — a WRAP, not a rewrite.
 *
 * `getTrialBalanceReport` already computes rows, accountCount, totalDebit,
 * totalCredit, difference and balanced, against the single exported
 * BALANCE_TOLERANCE. This tool CONSUMES those. It must not recompute the
 * balanced assertion: the original defect was three callers each rolling their
 * own, which is how a 7-of-118-account listing came to be stamped
 * "Difference R0.00 · Balanced".
 *
 * And it must surface `accountCount`, because that defect was a SCOPE failure,
 * not an arithmetic one. An assertion that does not state what it covers
 * reproduces the bug in a response that looks verified.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/trialBalanceService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getTrialBalanceReport: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  getFiscalPeriodIdForDate: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/postedThroughService', () => ({
  getLedgerPostedThrough: vi.fn().mockResolvedValue('2026-08-31T22:15:00.000Z'),
}));

import { getTrialBalanceReport, BALANCE_TOLERANCE } from '@/modules/accounting/services/gl/trialBalanceService';
import { getFiscalPeriodIdForDate } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { trialBalanceTool } from '@/lib/mcp/tools/reportsTrialBalance';
import { assertEnvelopeSound } from '@/lib/mcp/contracts';
import type { McpToolContext } from '@/lib/mcp/types';

const CTX = {
  userId: 'u1', companyId: '11111111-1111-4111-8111-111111111111',
  scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a',
} as McpToolContext;
const PERIOD = '22222222-2222-4222-8222-222222222222';

const payload = (r: { content: Array<{ text: string }> }) =>
  JSON.parse(r.content[0]!.text) as Record<string, unknown>;

const row = (over: Record<string, unknown> = {}) => ({
  accountCode: '1101', accountName: 'Trade Debtors', accountType: 'asset',
  normalBalance: 'debit', debitBalance: 100, creditBalance: 0,
  openingDebit: 60, openingCredit: 0, periodDebit: 40, periodCredit: 0, ...over,
});

const REPORT = {
  fiscalPeriodId: PERIOD, asAtDate: '2026-02-28', periodStart: '2026-02-01',
  periodEnd: '2026-02-28', fiscalYearStart: '2025-03-01', costCentreId: undefined,
  rows: [row(), row({ accountCode: '4000', accountType: 'revenue', normalBalance: 'credit',
                      debitBalance: 0, creditBalance: 100, openingDebit: 0, openingCredit: 60,
                      periodDebit: 0, periodCredit: 40 })],
  accountCount: 118, totalDebit: 100, totalCredit: 100, difference: 0, balanced: true,
};

beforeEach(() => {
  vi.mocked(getTrialBalanceReport).mockReset().mockResolvedValue(REPORT as never);
  vi.mocked(getFiscalPeriodIdForDate).mockReset().mockResolvedValue(PERIOD);
});

describe('trial_balance v2', () => {
  it('CONSUMES balanced and difference rather than recomputing them', async () => {
    // Proof it does not recompute: the service is made to disagree with its own
    // rows, and the tool must report what the service said.
    vi.mocked(getTrialBalanceReport).mockResolvedValue({
      ...REPORT, totalDebit: 100, totalCredit: 100, difference: 7.5, balanced: false,
    } as never);
    const data = payload(await trialBalanceTool.handler({}, CTX));
    expect(data.difference).toBe(7.5);
    expect(data.balanced).toBe(false);
  });

  it('states the SCOPE its balanced assertion covers', async () => {
    const data = payload(await trialBalanceTool.handler({}, CTX));
    expect(data.accountCount).toBe(118);
    expect(data.rowsTotal).toBe(118);
    // 118 accounts exist, 2 were served: the caller can see it is a page.
    expect(data.rowsReturned).toBe(2);
    expect(data.truncated).toBe(true);
  });

  it('returns opening, movement and closing on every row', async () => {
    const data = payload(await trialBalanceTool.handler({}, CTX));
    expect((data.rows as Array<Record<string, unknown>>)[0]).toMatchObject({
      openingDebit: 60, periodDebit: 40, debitBalance: 100,
    });
  });

  it('passes include_zero_balances through to the service, defaulting to false', async () => {
    await trialBalanceTool.handler({}, CTX);
    expect(vi.mocked(getTrialBalanceReport).mock.calls[0]![2]).toMatchObject({ includeZeroBalances: false });
    await trialBalanceTool.handler({ include_zero_balances: true }, CTX);
    expect(vi.mocked(getTrialBalanceReport).mock.calls[1]![2]).toMatchObject({ includeZeroBalances: true });
  });

  it('takes companyId from ctx and accepts no company argument', async () => {
    await trialBalanceTool.handler({}, CTX);
    expect(vi.mocked(getTrialBalanceReport).mock.calls[0]![0]).toBe(CTX.companyId);
    expect(Object.keys(trialBalanceTool.inputSchema.properties as object)).not.toContain('company_id');
  });

  it('names the single tolerance rather than carrying its own', async () => {
    const data = payload(await trialBalanceTool.handler({}, CTX));
    expect(data.balanceTolerance).toBe(BALANCE_TOLERANCE);
  });

  it('refuses when no fiscal period covers the date, instead of returning nothing', async () => {
    vi.mocked(getFiscalPeriodIdForDate).mockResolvedValue(null);
    const res = await trialBalanceTool.handler({}, CTX);
    expect(res.isError).toBe(true);
    expect(getTrialBalanceReport).not.toHaveBeenCalled();
  });

  it('builds a sound envelope with the period end as as_at', async () => {
    const data = payload(await trialBalanceTool.handler({}, CTX));
    assertEnvelopeSound(data as never);
    expect(data.as_at).toBe('2026-02-28');
    expect(data.posted_through).toBe('2026-08-31T22:15:00.000Z');
    expect(data.figureBasis).toBe('gl.trialbalance.v2');
  });

  it('pages with a cursor and covers every account across the pages', async () => {
    const many = Array.from({ length: 5 }, (_, i) => row({ accountCode: `10${i}` }));
    vi.mocked(getTrialBalanceReport).mockResolvedValue({ ...REPORT, rows: many, accountCount: 5 } as never);
    const p1 = payload(await trialBalanceTool.handler({ limit: 2 }, CTX));
    expect(p1.rowsReturned).toBe(2);
    const p2 = payload(await trialBalanceTool.handler({ limit: 2, cursor: p1.next_cursor }, CTX));
    const p3 = payload(await trialBalanceTool.handler({ limit: 2, cursor: p2.next_cursor }, CTX));
    expect(p3.next_cursor).toBeNull();
    const codes = [p1, p2, p3].flatMap((p) => (p.rows as Array<Record<string, unknown>>).map((r) => r.accountCode));
    expect(new Set(codes).size).toBe(5);
  });
});
