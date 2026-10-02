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
});
