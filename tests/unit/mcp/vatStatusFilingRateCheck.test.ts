/**
 * MCP `vat_status` and `vat201_export` tell an agent the 15% verdict the lock and finalise gates judge, as
 * `filingRateCheck` (vat201RateCheck.rateCheckForFiling), beside the per-box `rateCheck`, which is unchanged. A
 * period holding a correct mixed-VAT journal must not read as failing.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ getVat201Report: vi.fn(), getNilRatedSupplies: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/vat201ReportService', () => ({ getVat201Report: m.getVat201Report }));
vi.mock('@/modules/accounting/services/reports/vat201NilRatedSupplies', () => ({ getNilRatedSupplies: m.getNilRatedSupplies }));

import { vatStatusTool } from '@/lib/mcp/tools/vat';
import { vat201ExportTool } from '@/lib/mcp/tools/vatReports';
import type { McpToolContext } from '@/lib/mcp/types';
import { MIXED_REPORT, NIL_NONE, NIL_ON_TAXED } from '../services/reports/helpers/vat201MixedJournal';

const COMPANY = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const ctx: McpToolContext = { userId: 'u1', companyId: COMPANY, scopes: ['read:vat'], tokenJti: 't', oauthAppId: null };
const args = { period_start: '2026-07-01', period_end: '2026-08-31' };
const REPORT = {
  ...MIXED_REPORT, periodStart: '2026-07-01', periodEnd: '2026-08-31', detail: 'standard', rows: [], rowsTotal: 0,
  excludedRows: [], excludedLineCount: 0, excludedAmount: 0, nextCursor: null, postedThrough: '2026-08-31T00:00:00.000Z',
};
const text = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  m.getVat201Report.mockResolvedValue(REPORT);
});

describe('vat_status', () => {
  it('a correct mixed-VAT journal: rateCheck (per box) reads 75 out, filingRateCheck ties', async () => {
    m.getNilRatedSupplies.mockResolvedValue(NIL_ON_TAXED);
    const out = text(await vatStatusTool.handler(args, ctx));
    expect(out.rateCheck).toEqual(MIXED_REPORT.rateCheck);
    expect(out.filingRateCheck).toEqual({
      ties: true, outputVariance: 0, inputVariance: 0, taxedOutputBase: 1000, nilRatedGivenBack: 500, uncodedGivenBack: 0,
    });
    expect(m.getNilRatedSupplies).toHaveBeenCalledWith(COMPANY, '2026-07-01', '2026-08-31');
  });

  it('a variance no nil-rated supply explains fails filingRateCheck too', async () => {
    m.getNilRatedSupplies.mockResolvedValue(NIL_NONE);
    expect(text(await vatStatusTool.handler(args, ctx)).filingRateCheck)
      .toMatchObject({ ties: false, outputVariance: -75, taxedOutputBase: 1500, nilRatedGivenBack: 0 });
  });

  it('a refused period reads neither the report nor the nil-rated supplies', async () => {
    expect((await vatStatusTool.handler({ period_start: '2026-08-31', period_end: '2026-07-01' }, ctx)).isError).toBe(true);
    expect(m.getVat201Report).not.toHaveBeenCalled();
    expect(m.getNilRatedSupplies).not.toHaveBeenCalled();
  });
});

describe('the descriptions send an agent to filingRateCheck to decide', () => {
  it.each([['vat_status', vatStatusTool.description], ['vat201_export', vat201ExportTool.description]])(
    '%s: decide on filingRateCheck.ties; rateCheck is the per-box diagnostic', (_name, description) => {
      expect(description).toContain('filingRateCheck.ties');
      expect(description).toMatch(/rateCheck is the per-box diagnostic/);
      expect(description).not.toMatch(/ties=false means the ledger disagrees with itself|DO NOT FILE a return whose ties is false/);
    },
  );
});
