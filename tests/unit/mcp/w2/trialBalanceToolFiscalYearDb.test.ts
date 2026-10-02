/**
 * D4: MCP `trial_balance` returns what its description says, against Postgres
 * (the LED-01 fixture in rolled-back temp tables): the fiscal year of the
 * period END, the opening at the period start, and a derived year-end close
 * per row with opening + movement + close = closing — 0 inside one fiscal year,
 * search_gl's closedToRetainedEarnings across one.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/reports/postedThroughService', () => ({
  getLedgerPostedThrough: vi.fn().mockResolvedValue('2026-09-30T00:00:00.000Z'),
}));

import { trialBalanceTool } from '@/lib/mcp/tools/reportsTrialBalance';
import { searchGlTool } from '@/lib/mcp/tools/reports';
import { fiscalYearStart } from '@/modules/accounting/services/gl/fiscalYearBasis';
import type { McpToolContext } from '@/lib/mcp/types';
import { isDbReachable } from '../../helpers/dbReachable';
import { company, SEPT, withLedger } from '../../services/reports/ledgerAgreementFixture';

const CTX = { userId: 'u1', companyId: company, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a' } as McpToolContext;
const YEAR = '20000000-0000-4000-8000-0000000000b3';
const payload = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

interface ToolRow {
  accountCode: string; normalBalance: 'debit' | 'credit';
  openingDebit: number; openingCredit: number; periodDebit: number; periodCredit: number;
  debitBalance: number; creditBalance: number; closedToRetainedEarnings: number;
}
const side = (r: ToolRow, dr: number, cr: number) => (r.normalBalance === 'debit' ? dr - cr : cr - dr);

describe('trial_balance — description matches the payload (Postgres)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('names every field it returns, and each field means what the description says', async () => {
    await withLedger(3, async () => {
      for (const [period, ends] of [[YEAR, ['2026-02-28']], [SEPT, []]] as const) {
        const data = payload(await trialBalanceTool.handler({ fiscal_period_id: period }, CTX));
        const rows = data.rows as ToolRow[];
        expect(rows.length).toBeGreaterThan(0);
        for (const key of [...Object.keys(rows[0]!), 'fiscalYearStart', 'fiscalYearEndsClosed']) {
          if (key === 'accountName' || key === 'accountType' || key === 'accountCode' || key === 'normalBalance') continue;
          expect(trialBalanceTool.description, key).toContain(key);
        }
        expect(data.fiscalYearStart).toBe(fiscalYearStart(String(data.periodEnd), 3));
        expect(data.fiscalYearEndsClosed).toEqual(ends);
        for (const r of rows) {
          const opening = side(r, r.openingDebit, r.openingCredit);
          const closing = side(r, r.debitBalance, r.creditBalance);
          expect(opening + side(r, r.periodDebit, r.periodCredit) + r.closedToRetainedEarnings, r.accountCode).toBeCloseTo(closing, 2);
          if (ends.length === 0) expect(r.closedToRetainedEarnings, r.accountCode).toBe(0);
          if (r.accountCode === 'RE-BF') continue;
          const gl = payload(await searchGlTool.handler(
            { account_code: r.accountCode, from_date: String(data.periodStart), to_date: String(data.periodEnd) }, CTX));
          expect([opening, r.closedToRetainedEarnings, closing], `${period} ${r.accountCode}`)
            .toEqual([gl.openingBalance, gl.closedToRetainedEarnings, gl.periodClosingBalance]);
        }
      }
    }, 3, [[YEAR, '2026-01-01', '2026-12-31']]);
  }, 30000);

  // 4300 earned 100 in Dec 2025 (FY ending Feb 2026) and nothing in Jan–Mar 2026: it opens at 100,
  // does not move, is closed to zero. The description says such a row comes back without the flag.
  it.skipIf(!reachable)('returns an opening-only row without include_zero_balances, as described', async () => {
    const Q1 = '20000000-0000-4000-8000-0000000000b4';
    await withLedger(3, async () => {
      const data = payload(await trialBalanceTool.handler({ fiscal_period_id: Q1 }, CTX));
      const income = (data.rows as ToolRow[]).find(r => r.accountCode === '4300');
      expect(income).toMatchObject({ openingCredit: 100, periodDebit: 0, periodCredit: 0, debitBalance: 0, creditBalance: 0, closedToRetainedEarnings: -100 });
      expect(trialBalanceTool.description).toContain('opens with a balance and is closed to zero at a fiscal-year start inside the period');
    }, 3, [[Q1, '2026-01-01', '2026-03-31']]);
  }, 30000);
});
