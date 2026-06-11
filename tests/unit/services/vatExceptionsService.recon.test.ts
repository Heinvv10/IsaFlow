// RED phase — written before implementation
/**
 * Unit tests for vatExceptionsService — VAT201 vs GL control reconciliation,
 * date handling, and clean-books behavior.
 * Exception list sections are covered in vatExceptionsService.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/reports/vat201Service', () => ({
  generateVAT201: vi.fn(),
}));

import { generateVAT201 } from '@/modules/accounting/services/reports/vat201Service';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import {
  COMPANY_ID, PERIOD_START, PERIOD_END,
  makeVat201, makeUncodedRow, mockExceptionsSql,
} from './vatExceptionsTestUtils';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getVatExceptions — clean books', () => {
  it('returns zero exceptions and zero variances when GL matches VAT201', async () => {
    mockExceptionsSql({
      glControl: [{ gl_output: '1500.00', gl_input: '600.00' }],
    });
    vi.mocked(generateVAT201).mockResolvedValueOnce(makeVat201(1500, 600));

    const report = await getVatExceptions(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(report.periodStart).toBe(PERIOD_START);
    expect(report.periodEnd).toBe(PERIOD_END);
    expect(report.uncodedGlLines).toEqual([]);
    expect(report.uncodedGlLineCount).toBe(0);
    expect(report.invoiceTaxCodeIssues).toEqual([]);
    expect(report.invoiceTaxCodeIssueCount).toBe(0);
    expect(report.invoiceGlMismatches).toEqual([]);
    expect(report.invoiceGlMismatchCount).toBe(0);
    expect(report.controlRecon.outputVat201).toBe(1500);
    expect(report.controlRecon.outputGl).toBe(1500);
    expect(report.controlRecon.outputVariance).toBe(0);
    expect(report.controlRecon.inputVariance).toBe(0);
    expect(report.controlRecon.netGl).toBe(900);
    expect(report.controlRecon.netVat201).toBe(900);
    expect(report.controlRecon.netVariance).toBe(0);
    expect(report.totalExceptions).toBe(0);
  });

  it('treats an empty GL control result (no VAT accounts yet) as zero movement', async () => {
    mockExceptionsSql({ glControl: [] });
    vi.mocked(generateVAT201).mockResolvedValueOnce(makeVat201(0, 0));

    const report = await getVatExceptions(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(report.controlRecon.outputGl).toBe(0);
    expect(report.controlRecon.inputGl).toBe(0);
    expect(report.controlRecon.outputVariance).toBe(0);
    expect(report.controlRecon.inputVariance).toBe(0);
    expect(report.totalExceptions).toBe(0);
  });
});

describe('getVatExceptions — VAT control reconciliation', () => {
  it('computes cent-level variances between VAT201 boxes and GL control movement', async () => {
    mockExceptionsSql({
      glControl: [{ gl_output: '1499.85', gl_input: '600.10' }],
    });
    vi.mocked(generateVAT201).mockResolvedValueOnce(makeVat201(1500, 600));

    const report = await getVatExceptions(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(report.controlRecon.outputVat201).toBe(1500);
    expect(report.controlRecon.outputGl).toBe(1499.85);
    expect(report.controlRecon.outputVariance).toBe(0.15);
    expect(report.controlRecon.inputVat201).toBe(600);
    expect(report.controlRecon.inputGl).toBe(600.1);
    expect(report.controlRecon.inputVariance).toBe(-0.1);
    expect(report.controlRecon.netVat201).toBe(900);
    expect(report.controlRecon.netGl).toBe(899.75);
    expect(report.controlRecon.netVariance).toBe(0.25);
    // both output and input variances are non-zero → 2 recon exceptions
    expect(report.totalExceptions).toBe(2);
  });

  it('counts a single recon exception when only one side is out', async () => {
    mockExceptionsSql({
      glControl: [{ gl_output: '1490.00', gl_input: '600.00' }],
    });
    vi.mocked(generateVAT201).mockResolvedValueOnce(makeVat201(1500, 600));

    const report = await getVatExceptions(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(report.controlRecon.outputVariance).toBe(10);
    expect(report.controlRecon.inputVariance).toBe(0);
    expect(report.totalExceptions).toBe(1);
  });

  it('aggregates unposted invoice VAT as reconciliation context', async () => {
    mockExceptionsSql({
      unposted: [
        {
          unposted_customer_vat: '420.69',
          unposted_customer_count: '3',
          unposted_supplier_vat: '99.99',
          unposted_supplier_count: '2',
        },
      ],
    });
    vi.mocked(generateVAT201).mockResolvedValueOnce(makeVat201(0, 0));

    const report = await getVatExceptions(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(report.controlRecon.unpostedCustomerVat).toBe(420.69);
    expect(report.controlRecon.unpostedCustomerCount).toBe(3);
    expect(report.controlRecon.unpostedSupplierVat).toBe(99.99);
    expect(report.controlRecon.unpostedSupplierCount).toBe(2);
  });
});

describe('getVatExceptions — date handling', () => {
  it('renders pg Date objects as local calendar dates (no UTC day-shift)', async () => {
    // pg returns DATE columns as Date objects at local midnight; in UTC+2
    // toISOString() would shift 2026-03-15 back to 2026-03-14.
    mockExceptionsSql({
      uncoded: [makeUncodedRow({ entry_date: new Date(2026, 2, 15) })],
    });
    vi.mocked(generateVAT201).mockResolvedValueOnce(makeVat201(0, 0));

    const report = await getVatExceptions(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(report.uncodedGlLines[0]!.entryDate).toBe('2026-03-15');
  });
});
