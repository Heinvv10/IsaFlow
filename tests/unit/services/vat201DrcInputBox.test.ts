/**
 * Domestic reverse charge input tax is an ordinary input claim — SARS field 15 —
 * and must read that way everywhere the report is read, not only on the VAT201
 * screen: `exportVat201` is what the MCP `vat201_export` tool returns. The real
 * report service runs; only the database reads are scripted.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  getVatPeriodLines: vi.fn(),
  getCompany: vi.fn(),
  getVatPeriodLock: vi.fn(),
  getVatExceptions: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/vatBoxBasisQuery', () => ({ getVatPeriodLines: m.getVatPeriodLines }));
vi.mock('@/modules/accounting/services/core/companyService', () => ({ getCompany: m.getCompany }));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockService', () => ({ getVatPeriodLock: m.getVatPeriodLock }));
vi.mock('@/modules/accounting/services/reports/vatExceptionsService', () => ({ getVatExceptions: m.getVatExceptions }));

import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { exportVat201 } from '@/modules/accounting/services/reports/vat201ExportService';

function line(over: Record<string, unknown>) {
  return {
    journalEntryId: 'j1', entryNumber: 'J-1', entryDate: '2026-07-10', lineId: 'l1', accountId: 'a1',
    accountCode: '1', accountName: 'x', accountType: 'asset', accountSubtype: null, vatType: null,
    debit: 0, credit: 0, cancelledSource: false, ...over,
  };
}

// DRC: a R1000 supply, R150 self-assessed: input tax 150 AND output tax 150, so the return's net is nil.
const DRC_LINES = [
  line({ lineId: 'l1', accountType: 'expense', accountSubtype: 'operating_expense', vatType: 'reverse_charge', debit: 1000 }),
  line({ lineId: 'l2', accountType: 'asset', accountSubtype: 'vat_input', vatType: 'reverse_charge', debit: 150 }),
  line({ lineId: 'l3', accountType: 'liability', accountSubtype: 'vat_output', vatType: 'reverse_charge', credit: 150 }),
  line({ lineId: 'l4', accountType: 'liability', accountSubtype: 'payable', credit: 1000 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  m.getVatPeriodLines.mockResolvedValue({ lines: DRC_LINES, postedThrough: '2026-07-31T00:00:00.000Z' });
  m.getCompany.mockResolvedValue({ vatNumber: '4123456789', name: 'Acme Ltd' });
  m.getVatPeriodLock.mockResolvedValue(null);
  m.getVatExceptions.mockResolvedValue({
    uncodedGlLineCount: 0, invoiceTaxCodeIssueCount: 0, invoiceGlMismatchCount: 0, vatOnBalanceSheetCount: 0,
    vatNonSupplyCount: 0, unpostedInvoiceVatCount: 0, unsupportedInputVatCount: 0, totalExceptions: 0,
    billTaxCodeWarningCount: 0, billTaxCodeWarningPotentialVat: 0,
  });
});

describe('domestic reverse charge input tax is box 15, not "change in use"', () => {
  it('the report numbers and labels it 15', async () => {
    const report = await getVat201Report('c1', '2026-07-01', '2026-07-31', { detail: 'summary' });
    const drc = report.boxes.find((b) => b.direction === 'input' && b.vatType === 'reverse_charge');
    expect(drc).toMatchObject({ box: '15', tax: 150 });
    expect(drc?.label).toMatch(/domestic reverse charge/i);
    expect(report.boxes.map((b) => b.label).join('|')).not.toMatch(/change in use/i);
  });

  it('the export (MCP vat201_export) carries input as other input tax and output in F12, and nets to the report', async () => {
    const report = await getVat201Report('c1', '2026-07-01', '2026-07-31', { detail: 'summary' });
    const out = await exportVat201('c1', '2026-07-01', '2026-07-31');
    const payload = out.payload as { totalOutputVAT: number; totalInputVAT: number; netVAT: number; fields: Array<{ code: string; value: number }> };
    const field = (code: string) => payload.fields.find((f) => f.code === code)?.value;
    expect(report.totals.netVat).toBe(0);
    expect(field('F11')).toBe(150); // Input VAT - Other
    expect(field('F12')).toBe(150); // Output VAT - Other and imported services (box 12)
    expect(field('F13')).toBe(0); // input adjustments
    expect(payload.totalOutputVAT).toBe(150);
    expect(payload.totalInputVAT).toBe(150);
    expect(payload.netVAT).toBe(report.totals.netVat);
  });

  it('the csv lists it under box 15', async () => {
    const out = await exportVat201('c1', '2026-07-01', '2026-07-31', 'csv');
    const rows = (out.csv ?? '').split('\n').filter((r) => /reverse charge/i.test(r));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/(^|,)"?15"?(,|$)/);
  });
});
