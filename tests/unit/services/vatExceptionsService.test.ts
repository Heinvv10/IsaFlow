// RED phase — written before implementation
/**
 * Unit tests for vatExceptionsService — exception list sections.
 * Reconciliation/variance tests live in vatExceptionsService.recon.test.ts.
 * Shared builders + the 7-query mock order: vatExceptionsTestUtils.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/reports/vat201Service', () => ({
  generateVAT201: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { generateVAT201 } from '@/modules/accounting/services/reports/vat201Service';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import {
  COMPANY_ID, PERIOD_START, PERIOD_END,
  makeVat201, makeUncodedRow, makeTaxIssueRow, makeMismatchRow,
  mockExceptionsSql,
} from './vatExceptionsTestUtils';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getVatExceptions — uncoded GL VAT lines', () => {
  it('lists uncoded VAT lines with journal metadata and signed amount', async () => {
    mockExceptionsSql({ uncoded: [makeUncodedRow()] });
    vi.mocked(generateVAT201).mockResolvedValueOnce(makeVat201(0, 0));

    const report = await getVatExceptions(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(report.uncodedGlLineCount).toBe(1);
    expect(report.uncodedGlLines).toHaveLength(1);
    const line = report.uncodedGlLines[0]!;
    expect(line.journalEntryId).toBe('je-1');
    expect(line.entryNumber).toBe('JE-0001');
    expect(line.entryDate).toBe('2026-03-15');
    expect(line.accountCode).toBe('2120');
    expect(line.accountName).toBe('VAT Output');
    expect(line.subtype).toBe('vat_output');
    expect(line.description).toBe('Sale without VAT coding');
    expect(line.amount).toBe(123.45);
    expect(report.totalExceptions).toBe(1);
  });

  it('maps vat_input account lines with the vat_input subtype', async () => {
    mockExceptionsSql({
      uncoded: [makeUncodedRow({
        account_code: '1140',
        account_name: 'VAT Input',
        account_subtype: 'vat_input',
        amount: '85.67',
      })],
    });
    vi.mocked(generateVAT201).mockResolvedValueOnce(makeVat201(0, 0));

    const report = await getVatExceptions(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(report.uncodedGlLines[0]!.subtype).toBe('vat_input');
    expect(report.uncodedGlLines[0]!.amount).toBe(85.67);
  });

  it('caps the list at 100 rows while the count reflects all rows', async () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      makeUncodedRow({ journal_entry_id: `je-${i}`, total_count: '120' }),
    );
    mockExceptionsSql({ uncoded: rows });
    vi.mocked(generateVAT201).mockResolvedValueOnce(makeVat201(0, 0));

    const report = await getVatExceptions(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(report.uncodedGlLines).toHaveLength(100);
    expect(report.uncodedGlLineCount).toBe(120);
  });
});

describe('getVatExceptions — invoice tax-code issues', () => {
  it('flags missing tax rate and rate-without-VAT across both invoice kinds', async () => {
    mockExceptionsSql({
      customerTaxIssues: [makeTaxIssueRow()],
      supplierTaxIssues: [
        makeTaxIssueRow({
          invoice_id: 'si-1',
          invoice_number: 'SINV-001',
          counterparty_name: 'Gamma Suppliers',
          tax_rate: '15.00',
          tax_amount: '0',
          subtotal: '2000.00',
        }),
      ],
    });
    vi.mocked(generateVAT201).mockResolvedValueOnce(makeVat201(0, 0));

    const report = await getVatExceptions(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(report.invoiceTaxCodeIssueCount).toBe(2);
    const [customer, supplier] = report.invoiceTaxCodeIssues;
    expect(customer!.invoiceKind).toBe('customer');
    expect(customer!.issue).toBe('missing_tax_rate');
    expect(customer!.taxRate).toBeNull();
    expect(customer!.subtotal).toBe(1000);
    expect(supplier!.invoiceKind).toBe('supplier');
    expect(supplier!.issue).toBe('rate_without_vat');
    expect(supplier!.taxRate).toBe(15);
    expect(report.totalExceptions).toBe(2);
  });
});

describe('getVatExceptions — invoice/GL VAT mismatches', () => {
  it('reports linked invoices whose GL VAT differs, with cent-level variance', async () => {
    mockExceptionsSql({
      customerMismatches: [makeMismatchRow()],
      supplierMismatches: [
        makeMismatchRow({
          invoice_id: 'si-9',
          invoice_number: 'SINV-009',
          counterparty_name: 'Delta Traders',
          invoice_vat: '300.00',
          gl_vat: '345.00',
        }),
      ],
    });
    vi.mocked(generateVAT201).mockResolvedValueOnce(makeVat201(0, 0));

    const report = await getVatExceptions(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(report.invoiceGlMismatchCount).toBe(2);
    const [customer, supplier] = report.invoiceGlMismatches;
    expect(customer!.invoiceKind).toBe('customer');
    expect(customer!.invoiceVat).toBe(150);
    expect(customer!.glVat).toBe(149.85);
    expect(customer!.variance).toBe(0.15);
    expect(supplier!.invoiceKind).toBe('supplier');
    expect(supplier!.variance).toBe(-45);
    expect(report.totalExceptions).toBe(2);
  });
});

describe('getVatExceptions — query scoping and failure', () => {
  it('passes the companyId and period bounds to the queries', async () => {
    mockExceptionsSql({});
    vi.mocked(generateVAT201).mockResolvedValueOnce(makeVat201(0, 0));

    await getVatExceptions(COMPANY_ID, PERIOD_START, PERIOD_END);

    // sql is a tagged template: call args are [strings, ...values]
    for (const call of vi.mocked(sql).mock.calls) {
      const values = call.slice(1);
      expect(values).toContain(COMPANY_ID);
      expect(values).toContain(PERIOD_START);
      expect(values).toContain(PERIOD_END);
    }
    expect(vi.mocked(sql).mock.calls).toHaveLength(7);
  });

  it('propagates a query failure instead of returning partial data', async () => {
    vi.mocked(sql).mockRejectedValue(new Error('connection terminated'));
    vi.mocked(generateVAT201).mockResolvedValue(makeVat201(0, 0));

    await expect(
      getVatExceptions(COMPANY_ID, PERIOD_START, PERIOD_END),
    ).rejects.toThrow('connection terminated');
  });
});
