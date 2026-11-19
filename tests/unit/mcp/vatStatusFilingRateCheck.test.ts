/**
 * MCP `vat_status` and `vat201_export` carry `rateCheck` (the report's per-box diagnostic, unmodified) and
 * `filingRateCheck` (vat201RateCheck.rateCheckForFiling on the ledger as read at call time), with the key set every
 * surface shares. A period holding a correct mixed-VAT journal must not read as failing; a failed read fails the call.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  getVat201Report: vi.fn(), getNilRatedSupplies: vi.fn(), getCompany: vi.fn(), getVatPeriodLock: vi.fn(), getVatExceptions: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/vat201ReportService', () => ({ getVat201Report: m.getVat201Report }));
vi.mock('@/modules/accounting/services/reports/vat201NilRatedSupplies', () => ({ getNilRatedSupplies: m.getNilRatedSupplies }));
vi.mock('@/modules/accounting/services/core/companyService', () => ({ getCompany: m.getCompany }));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockService', () => ({
  getVatPeriodLock: m.getVatPeriodLock, lockVatPeriod: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/vatExceptionsService', () => ({ getVatExceptions: m.getVatExceptions }));

import { vatStatusTool } from '@/lib/mcp/tools/vat';
import { lockVatPeriodTool, vat201ExportTool } from '@/lib/mcp/tools/vatReports';
import type { McpToolContext } from '@/lib/mcp/types';
import {
  FILING_MIXED_TIES, FILING_RATE_CHECK_KEYS, MIXED_REPORT, NIL_NONE, NIL_ON_TAXED, keysOf,
} from '../services/reports/helpers/vat201MixedJournal';

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
  m.getNilRatedSupplies.mockResolvedValue(NIL_ON_TAXED);
  m.getCompany.mockResolvedValue({ vatNumber: '4123456789', name: 'Acme Ltd' });
  m.getVatPeriodLock.mockResolvedValue(null);
  m.getVatExceptions.mockResolvedValue({
    uncodedGlLineCount: 0, invoiceTaxCodeIssueCount: 0, invoiceGlMismatchCount: 0, vatOnBalanceSheetCount: 0,
    vatNonSupplyCount: 0, unpostedInvoiceVatCount: 0, unsupportedInputVatCount: 0, totalExceptions: 0,
    billTaxCodeWarningCount: 0, billTaxCodeWarningPotentialVat: 0,
  });
});

describe('vat_status', () => {
  it('a correct mixed-VAT journal: rateCheck (per box) reads 75 out, filingRateCheck ties', async () => {
    const out = text(await vatStatusTool.handler(args, ctx));
    expect(out.rateCheck).toEqual(MIXED_REPORT.rateCheck);
    expect(out.filingRateCheck).toEqual(FILING_MIXED_TIES);
    expect(keysOf(out.filingRateCheck)).toEqual(FILING_RATE_CHECK_KEYS);
    expect(m.getNilRatedSupplies).toHaveBeenCalledWith(COMPANY, '2026-07-01', '2026-08-31');
  });

  it.each([
    ['summary', {}], ['standard', {}], ['boxes', {}], ['full', {}], ['standard', { cursor: 'next-page' }],
  ])('carries filingRateCheck beside rateCheck at detail %s %j (every page)', async (detail, extra) => {
    const out = text(await vatStatusTool.handler({ ...args, detail, ...extra }, ctx));
    expect(out.rateCheck).toEqual(MIXED_REPORT.rateCheck);
    expect(out.filingRateCheck).toEqual(FILING_MIXED_TIES);
  });

  it('a variance no nil-rated supply explains fails filingRateCheck too', async () => {
    m.getNilRatedSupplies.mockResolvedValue(NIL_NONE);
    expect(text(await vatStatusTool.handler(args, ctx)).filingRateCheck)
      .toMatchObject({ ties: false, outputVariance: -75, taxedOutputBase: 1500, nilRatedGivenBack: 0 });
  });

  it('a failed nil-rated read fails the call whole, as a failed report read does (never a missing verdict)', async () => {
    m.getNilRatedSupplies.mockRejectedValue(new Error('nil read failed'));
    await expect(vatStatusTool.handler(args, ctx)).rejects.toThrow('nil read failed');
    m.getNilRatedSupplies.mockResolvedValue(NIL_ON_TAXED);
    m.getVat201Report.mockRejectedValue(new Error('report read failed'));
    await expect(vatStatusTool.handler(args, ctx)).rejects.toThrow('report read failed');
  });

  it('a refused period reads neither the report nor the nil-rated supplies', async () => {
    expect((await vatStatusTool.handler({ period_start: '2026-08-31', period_end: '2026-07-01' }, ctx)).isError).toBe(true);
    expect(m.getVat201Report).not.toHaveBeenCalled();
    expect(m.getNilRatedSupplies).not.toHaveBeenCalled();
  });
});

describe('vat201_export (the tool handler)', () => {
  it.each(['sars_payload', 'csv'])('format %s: rateCheck unmodified, filingRateCheck the verdict, the shared key set', async (format) => {
    const out = text(await vat201ExportTool.handler({ ...args, format }, ctx));
    expect(out.rateCheck).toEqual(MIXED_REPORT.rateCheck);
    expect(out.filingRateCheck).toEqual(FILING_MIXED_TIES);
    expect(keysOf(out.filingRateCheck)).toEqual(FILING_RATE_CHECK_KEYS);
  });

  it('a locked period is still judged on the ledger as it is now (the export reads it whatever the lock)', async () => {
    m.getVatPeriodLock.mockResolvedValue({ id: 'lock-1', outputTax: 150, inputTax: 0, netVat: 150 });
    expect(text(await vat201ExportTool.handler(args, ctx)).filingRateCheck).toEqual(FILING_MIXED_TIES);
  });

  it('a failed nil-rated read fails the export whole', async () => {
    m.getNilRatedSupplies.mockRejectedValue(new Error('nil read failed'));
    await expect(vat201ExportTool.handler(args, ctx)).rejects.toThrow('nil read failed');
  });
});

describe('descriptions (a lint; the behaviour is pinned above and in lockVatPeriodGate.test.ts)', () => {
  it.each([
    ['vat_status', vatStatusTool.description], ['vat201_export', vat201ExportTool.description],
    ['lock_vat_period', lockVatPeriodTool.description],
  ])('%s: decide on filingRateCheck.ties; rateCheck is the per-box diagnostic; no unconditional "same verdict"', (_n, d) => {
    expect(d).toContain('filingRateCheck.ties');
    expect(d).toMatch(/rateCheck is the (report's )?per-box diagnostic/);
    expect(d).not.toMatch(/same verdict|ties=false means the ledger disagrees with itself|DO NOT FILE a return whose ties is false/);
  });

  it('lock_vat_period says a null filingRateCheck means the period was already locked and nothing was judged', () => {
    expect(lockVatPeriodTool.description).toMatch(/filingRateCheck is null when the period was already locked/);
  });
});
