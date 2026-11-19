/**
 * exportVat201 — the bill tax-code warning fields (Hein, 2026-09-27): the
 * export threads `billTaxCodeWarningCount`/`billTaxCodeWarningPotentialVat`
 * straight off the exceptions report, WARNING ONLY, never inside
 * `blockingExceptions`. PR #546 review: this had no test at all.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  getVat201Report: vi.fn(),
  getCompany: vi.fn(),
  getVatPeriodLock: vi.fn(),
  getVatExceptions: vi.fn(),
  getNilRatedSupplies: vi.fn(),
}));
// The filing verdict's nil-rated read (vat201RateCheck); scripted so no query reaches a database.
vi.mock('@/modules/accounting/services/reports/vat201NilRatedSupplies', () => ({ getNilRatedSupplies: m.getNilRatedSupplies }));
vi.mock('@/modules/accounting/services/reports/vat201ReportService', () => ({
  getVat201Report: m.getVat201Report,
}));
vi.mock('@/modules/accounting/services/core/companyService', () => ({
  getCompany: m.getCompany,
}));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockService', () => ({
  getVatPeriodLock: m.getVatPeriodLock,
}));
vi.mock('@/modules/accounting/services/reports/vatExceptionsService', () => ({
  getVatExceptions: m.getVatExceptions,
}));

import { exportVat201 } from '@/modules/accounting/services/reports/vat201ExportService';
import { csvVal } from '@/lib/csv';
import { MIXED_REPORT, NIL_NONE, NIL_ON_TAXED } from './reports/helpers/vat201MixedJournal';

const REPORT = {
  periodStart: '2026-07-01', periodEnd: '2026-08-31', detail: 'summary',
  boxes: [], excludedRows: [],
  totals: { outputTax: 0, inputTax: 0, netVat: 0, standardRatedSupplies: 0, standardRatedPurchases: 0, lateClaimInputTax: 0 },
  rateCheck: {
    rate: 15, outputImpliedTax: 0, outputVariance: 0, inputImpliedTax: 0, inputVariance: 0,
    ties: true, entriesWithoutBase: [], entriesWithoutBaseTotal: 0,
  },
  postedThrough: '2026-08-31T00:00:00.000Z',
};

const EXCEPTIONS = {
  uncodedGlLineCount: 0, invoiceTaxCodeIssueCount: 0, invoiceGlMismatchCount: 0,
  vatOnBalanceSheetCount: 0, vatNonSupplyCount: 0, unpostedInvoiceVatCount: 0,
  unsupportedInputVatCount: 0, totalExceptions: 0,
  billTaxCodeWarningCount: 3, billTaxCodeWarningPotentialVat: 45.06,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.getVat201Report.mockResolvedValue(REPORT);
  m.getCompany.mockResolvedValue({ vatNumber: '4123456789', name: 'Acme Ltd' });
  m.getVatPeriodLock.mockResolvedValue(null);
  m.getVatExceptions.mockResolvedValue(EXCEPTIONS);
  m.getNilRatedSupplies.mockResolvedValue(NIL_NONE);
});

describe('exportVat201 — bill tax-code warning fields', () => {
  it('passes billTaxCodeWarningCount and billTaxCodeWarningPotentialVat through, outside blockingExceptions', async () => {
    const out = await exportVat201('company-1', '2026-07-01', '2026-08-31');

    expect(out.billTaxCodeWarningCount).toBe(3);
    expect(out.billTaxCodeWarningPotentialVat).toBe(45.06);
    // WARNING ONLY: never folded into the blocking count.
    expect(out.blockingExceptions.totalExceptions).toBe(0);
    expect(out.blockingExceptions).not.toHaveProperty('billTaxCodeWarningCount');
  });

  it('carries the same fields for the csv format', async () => {
    const out = await exportVat201('company-1', '2026-07-01', '2026-08-31', 'csv');

    expect(out.billTaxCodeWarningCount).toBe(3);
    expect(out.billTaxCodeWarningPotentialVat).toBe(45.06);
  });
});

describe('exportVat201 — filingRateCheck, the verdict the lock and finalise gates judge', () => {
  it('a correct mixed-VAT journal: rateCheck (per box) reads 75 out, filingRateCheck ties on the taxed output base', async () => {
    m.getVat201Report.mockResolvedValue({ ...REPORT, ...MIXED_REPORT });
    m.getNilRatedSupplies.mockResolvedValue(NIL_ON_TAXED);
    for (const format of ['sars_payload', 'csv'] as const) {
      const out = await exportVat201('company-1', '2026-07-01', '2026-08-31', format);
      expect(out.rateCheck).toEqual(MIXED_REPORT.rateCheck);
      expect(out.filingRateCheck).toEqual({
        ties: true, outputVariance: 0, inputVariance: 0, taxedOutputBase: 1000, nilRatedGivenBack: 500, uncodedGivenBack: 0,
      });
    }
    expect(m.getNilRatedSupplies).toHaveBeenCalledWith('company-1', '2026-07-01', '2026-08-31');
  });

  it('a variance no nil-rated supply explains fails filingRateCheck too', async () => {
    m.getVat201Report.mockResolvedValue({ ...REPORT, ...MIXED_REPORT });
    const out = await exportVat201('company-1', '2026-07-01', '2026-08-31');
    expect(out.filingRateCheck).toMatchObject({ ties: false, outputVariance: -75, taxedOutputBase: 1500, nilRatedGivenBack: 0 });
  });
});

describe('exportVat201 — the csv: per-box diagnostic rows, then the verdict the gates judge as its own row', () => {
  const row = (cells: Array<string | number>) => cells.map(csvVal).join(',');

  it('header, box rows and TOTALS as before; a FILING_CHECK row after TOTALS; EXCLUDED rows last', async () => {
    const excluded = { id: 'a9', reason: 'unmapped_vat_treatment', detail: 'SYS-9 VAT Payable', amount: 12, documentNumber: 'SYS-9', lineCount: 1 };
    m.getVat201Report.mockResolvedValue({ ...REPORT, ...MIXED_REPORT, excludedRows: [excluded] });
    m.getNilRatedSupplies.mockResolvedValue(NIL_ON_TAXED);
    const lines = (await exportVat201('company-1', '2026-07-01', '2026-08-31', 'csv')).csv!.split('\n');
    expect(lines).toEqual([
      row(['box', 'label', 'direction', 'vat_type', 'base', 'tax', 'implied_tax_at_15pct', 'variance']),
      row(['1', 'Standard rated supplies', 'output', 'standard', 1500, 150, 225, -75]),
      row(['TOTALS', 'Output tax (box 4) / Input tax (box 19) / Net (box 20)', '', '', 1500, 150, 0, 150]),
      row(['FILING_CHECK', '15% check the lock and finalise gates judge, on the ledger as read now: ties; 500.00 of '
        + 'zero-rated or exempt supplies on taxed journals given back; input tax over-claimed by 0.00',
      'output', '', 1000, 150, 150, 0]),
      row(['EXCLUDED', 'SYS-9 VAT Payable', '', 'unmapped_vat_treatment', '', 12, '', '']),
    ]);
  });

  it('says FAILS on that row when the verdict fails', async () => {
    m.getVat201Report.mockResolvedValue({ ...REPORT, ...MIXED_REPORT });
    const csv = (await exportVat201('company-1', '2026-07-01', '2026-08-31', 'csv')).csv!;
    expect(csv).toContain('on the ledger as read now: FAILS; 0.00 of zero-rated');
  });

  it('a failed nil-rated read fails the export whole', async () => {
    m.getNilRatedSupplies.mockRejectedValue(new Error('nil read failed'));
    await expect(exportVat201('company-1', '2026-07-01', '2026-08-31', 'csv')).rejects.toThrow('nil read failed');
  });
});
