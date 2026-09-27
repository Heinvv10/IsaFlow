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
}));
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
