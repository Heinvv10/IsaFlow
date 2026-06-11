// RED phase — written before implementation
/**
 * Unit tests for vatExceptionsService.ts — getVatExceptions
 *
 * The service runs 7 SQL queries (in declaration order inside Promise.all)
 * plus one generateVAT201 call. Tests mock each in sequence:
 *  1. Uncoded GL VAT lines (vat_type IS NULL on vat_input/vat_output accounts)
 *  2. Customer invoices with tax-code issues
 *  3. Supplier invoices with tax-code issues
 *  4. Customer invoice ↔ GL VAT mismatches (linked via gl_journal_entry_id)
 *  5. Supplier invoice ↔ GL VAT mismatches
 *  6. GL VAT control movement for the period (one row)
 *  7. Unposted invoice VAT aggregates (one row)
 *
 * All numeric values arrive as strings (pg numeric) — the service must coerce.
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

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const PERIOD_START = '2026-03-01';
const PERIOD_END = '2026-04-30';

// ── Builders ──────────────────────────────────────────────────────────────────

function makeVat201(field5: number, field10: number) {
  return {
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    field1_standardRatedSupplies: 0,
    field2_zeroRatedSupplies: 0,
    field3_exemptSupplies: 0,
    field4_totalImports: 0,
    field5_outputVAT: field5,
    field6_capitalGoods: 0,
    field7_otherGoods: field10,
    field8_services: 0,
    field9_imports: 0,
    field10_totalInputVAT: field10,
    field11_vatPayableOrRefundable: field5 - field10,
    outputInvoices: [],
    inputInvoices: [],
  };
}

function makeUncodedRow(overrides: Record<string, unknown> = {}) {
  return {
    journal_entry_id: 'je-1',
    entry_number: 'JE-0001',
    entry_date: '2026-03-15',
    account_code: '2120',
    account_name: 'VAT Output',
    account_subtype: 'vat_output',
    description: 'Sale without VAT coding',
    amount: '123.45',
    total_count: '1',
    ...overrides,
  };
}

function makeTaxIssueRow(overrides: Record<string, unknown> = {}) {
  return {
    invoice_id: 'ci-1',
    invoice_number: 'INV-001',
    counterparty_name: 'Acme Ltd',
    invoice_date: '2026-03-10',
    subtotal: '1000.00',
    tax_rate: null,
    tax_amount: '0',
    total_count: '1',
    ...overrides,
  };
}

function makeMismatchRow(overrides: Record<string, unknown> = {}) {
  return {
    invoice_id: 'ci-9',
    invoice_number: 'INV-009',
    counterparty_name: 'Beta CC',
    invoice_date: '2026-03-20',
    invoice_vat: '150.00',
    gl_vat: '149.85',
    total_count: '1',
    ...overrides,
  };
}

const EMPTY_GL_CONTROL = [{ gl_output: '0', gl_input: '0' }];
const EMPTY_UNPOSTED = [
  {
    unposted_customer_vat: '0',
    unposted_customer_count: '0',
    unposted_supplier_vat: '0',
    unposted_supplier_count: '0',
  },
];

/** Mock the 7 SQL calls in service order. */
function mockExceptionsSql(opts: {
  uncoded?: unknown[];
  customerTaxIssues?: unknown[];
  supplierTaxIssues?: unknown[];
  customerMismatches?: unknown[];
  supplierMismatches?: unknown[];
  glControl?: unknown[];
  unposted?: unknown[];
}) {
  vi.mocked(sql)
    .mockResolvedValueOnce((opts.uncoded ?? []) as never)
    .mockResolvedValueOnce((opts.customerTaxIssues ?? []) as never)
    .mockResolvedValueOnce((opts.supplierTaxIssues ?? []) as never)
    .mockResolvedValueOnce((opts.customerMismatches ?? []) as never)
    .mockResolvedValueOnce((opts.supplierMismatches ?? []) as never)
    .mockResolvedValueOnce((opts.glControl ?? EMPTY_GL_CONTROL) as never)
    .mockResolvedValueOnce((opts.unposted ?? EMPTY_UNPOSTED) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

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
