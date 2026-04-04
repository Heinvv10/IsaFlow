// RED phase — written before implementation
/**
 * Unit tests for sarsService.ts — generateVAT201
 *
 * Verifies the SARS VAT201 field classification logic using mocked SQL responses.
 * Each test controls what the three SQL queries return (customer invoices,
 * supplier invoices, supplier VAT by classification) and asserts the correct
 * VAT201 fields are computed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { generateVAT201 } from '@/modules/accounting/services/sarsService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const PERIOD_START = '2026-03-01';
const PERIOD_END = '2026-03-31';

// ── Builders ──────────────────────────────────────────────────────────────────

function makeCustomerInvoice(
  id: string,
  subtotal: number,
  taxAmount: number,
  vatType: string
) {
  return {
    id,
    invoice_number: `INV-${id}`,
    invoice_date: '2026-03-15',
    subtotal,
    tax_amount: taxAmount,
    total_amount: subtotal + taxAmount,
    tax_rate: vatType === 'zero_rated' ? 0 : 0.15,
    customer_name: `Customer ${id}`,
    vat_type: vatType,
  };
}

function makeSupplierInvoice(
  id: string,
  subtotal: number,
  taxAmount: number,
  taxRate = 0.15
) {
  return {
    id,
    invoice_number: `SINV-${id}`,
    invoice_date: '2026-03-10',
    subtotal,
    tax_amount: taxAmount,
    total_amount: subtotal + taxAmount,
    tax_rate: taxRate,
    supplier_name: `Supplier ${id}`,
  };
}

function makeVatByClass(classification: string, vatTotal: number) {
  return { classification, vat_total: vatTotal };
}

/**
 * Mock the three sequential sql calls that generateVAT201 makes:
 *  1. Customer invoices (output VAT)
 *  2. Supplier invoices (input VAT — for inputInvoices list)
 *  3. Supplier VAT by classification (for field6/7/8/9)
 */
function mockVat201Sql(
  customerRows: unknown[],
  supplierRows: unknown[],
  vatByClassRows: unknown[]
) {
  vi.mocked(sql)
    .mockResolvedValueOnce(customerRows as never)   // customer_invoices query
    .mockResolvedValueOnce(supplierRows as never)   // supplier_invoices query
    .mockResolvedValueOnce(vatByClassRows as never); // supplier_invoice_items group query
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe('generateVAT201', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Field 1: Standard-rated output ──────────────────────────────────────────

  it('puts standard-rated customer invoices into field1', async () => {
    mockVat201Sql(
      [makeCustomerInvoice('1', 10000, 1500, 'standard')],
      [],
      []
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field1_standardRatedSupplies).toBe(10000);
    expect(result.field2_zeroRatedSupplies).toBe(0);
    expect(result.field3_exemptSupplies).toBe(0);
  });

  // ── Field 2: Zero-rated output ───────────────────────────────────────────────

  it('puts zero-rated customer invoices into field2', async () => {
    mockVat201Sql(
      [makeCustomerInvoice('2', 5000, 0, 'zero_rated')],
      [],
      []
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field2_zeroRatedSupplies).toBe(5000);
    expect(result.field1_standardRatedSupplies).toBe(0);
    expect(result.field3_exemptSupplies).toBe(0);
  });

  it('puts export-type invoices into field2 (exports are zero-rated)', async () => {
    mockVat201Sql(
      [makeCustomerInvoice('3', 20000, 0, 'export')],
      [],
      []
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field2_zeroRatedSupplies).toBe(20000);
  });

  // ── Field 3: Exempt output (the fix) ─────────────────────────────────────────

  it('puts exempt customer invoices into field3', async () => {
    mockVat201Sql(
      [makeCustomerInvoice('4', 8000, 0, 'exempt')],
      [],
      []
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field3_exemptSupplies).toBe(8000);
    expect(result.field1_standardRatedSupplies).toBe(0);
    expect(result.field2_zeroRatedSupplies).toBe(0);
  });

  it('puts no_vat customer invoices into field3', async () => {
    mockVat201Sql(
      [makeCustomerInvoice('5', 3000, 0, 'no_vat')],
      [],
      []
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field3_exemptSupplies).toBe(3000);
  });

  // ── Field 5: Output VAT calculation ──────────────────────────────────────────

  it('calculates field5 as standard-rated supplies x 15%', async () => {
    mockVat201Sql(
      [makeCustomerInvoice('6', 10000, 1500, 'standard')],
      [],
      []
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field5_outputVAT).toBeCloseTo(1500, 2);
  });

  it('field5 is zero when all supplies are zero-rated or exempt', async () => {
    mockVat201Sql(
      [
        makeCustomerInvoice('7', 5000, 0, 'zero_rated'),
        makeCustomerInvoice('8', 3000, 0, 'exempt'),
      ],
      [],
      []
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field5_outputVAT).toBe(0);
  });

  // ── Field 6: Capital goods input VAT ─────────────────────────────────────────

  it('classifies capital_goods supplier items into field6', async () => {
    mockVat201Sql(
      [],
      [makeSupplierInvoice('A', 50000, 7500)],
      [makeVatByClass('capital_goods', 7500)]
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field6_capitalGoods).toBe(7500);
    expect(result.field7_otherGoods).toBe(0);
  });

  // ── Field 7: Other goods input VAT ───────────────────────────────────────────

  it('classifies standard supplier items into field7', async () => {
    mockVat201Sql(
      [],
      [makeSupplierInvoice('B', 20000, 3000)],
      [makeVatByClass('standard', 3000)]
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field7_otherGoods).toBe(3000);
    expect(result.field6_capitalGoods).toBe(0);
  });

  it('falls back to invoice-level tax_amount for field7 when no item-level data', async () => {
    // Empty vatByClass — triggers the fallback path
    mockVat201Sql(
      [],
      [makeSupplierInvoice('C', 10000, 1500, 0.15)],
      []
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field7_otherGoods).toBe(1500);
  });

  it('does not include zero-tax-rate supplier invoices in field7 fallback', async () => {
    mockVat201Sql(
      [],
      [makeSupplierInvoice('D', 10000, 0, 0)],
      []
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field7_otherGoods).toBe(0);
  });

  // ── Field 8: Services input VAT ──────────────────────────────────────────────

  it('classifies services supplier items into field8', async () => {
    mockVat201Sql(
      [],
      [makeSupplierInvoice('E', 15000, 2250)],
      [makeVatByClass('services', 2250)]
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field8_services).toBe(2250);
    expect(result.field7_otherGoods).toBe(0);
  });

  // ── Field 9: Imports input VAT ───────────────────────────────────────────────

  it('classifies imported supplier items into field9', async () => {
    mockVat201Sql(
      [],
      [makeSupplierInvoice('F', 30000, 4500)],
      [makeVatByClass('imported', 4500)]
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field9_imports).toBe(4500);
    expect(result.field7_otherGoods).toBe(0);
  });

  it('classifies reverse_charge items into field9', async () => {
    mockVat201Sql(
      [],
      [makeSupplierInvoice('G', 8000, 1200)],
      [makeVatByClass('reverse_charge', 1200)]
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field9_imports).toBe(1200);
  });

  // ── Field 10: Total input VAT ─────────────────────────────────────────────────

  it('field10 equals sum of fields 6+7+8+9', async () => {
    mockVat201Sql(
      [],
      [
        makeSupplierInvoice('H', 50000, 7500),
        makeSupplierInvoice('I', 20000, 3000),
        makeSupplierInvoice('J', 15000, 2250),
        makeSupplierInvoice('K', 30000, 4500),
      ],
      [
        makeVatByClass('capital_goods', 7500),
        makeVatByClass('standard', 3000),
        makeVatByClass('services', 2250),
        makeVatByClass('imported', 4500),
      ]
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field10_totalInputVAT).toBeCloseTo(
      result.field6_capitalGoods +
      result.field7_otherGoods +
      result.field8_services +
      result.field9_imports,
      2
    );
    expect(result.field10_totalInputVAT).toBeCloseTo(17250, 2);
  });

  // ── Field 11: VAT payable / refundable ───────────────────────────────────────

  it('field11 equals output VAT minus input VAT when output exceeds input', async () => {
    mockVat201Sql(
      [makeCustomerInvoice('1', 100000, 15000, 'standard')],
      [],
      [makeVatByClass('standard', 5000)]
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    // field5 = 100000 * 0.15 = 15000; field10 = 5000
    expect(result.field11_vatPayableOrRefundable).toBeCloseTo(10000, 2);
  });

  it('field11 is negative (refundable) when input VAT exceeds output VAT', async () => {
    mockVat201Sql(
      [makeCustomerInvoice('2', 10000, 1500, 'standard')],
      [],
      [makeVatByClass('capital_goods', 50000)]
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    // output: 10000 * 0.15 = 1500; input: 50000
    expect(result.field11_vatPayableOrRefundable).toBeLessThan(0);
    expect(result.field11_vatPayableOrRefundable).toBeCloseTo(-48500, 2);
  });

  // ── Mixed classification scenario ────────────────────────────────────────────

  it('correctly splits mixed customer invoices across fields 1, 2, and 3', async () => {
    mockVat201Sql(
      [
        makeCustomerInvoice('std', 10000, 1500, 'standard'),
        makeCustomerInvoice('zero', 5000, 0, 'zero_rated'),
        makeCustomerInvoice('exempt', 2000, 0, 'exempt'),
        makeCustomerInvoice('exp', 8000, 0, 'export'),
      ],
      [],
      []
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field1_standardRatedSupplies).toBe(10000);
    expect(result.field2_zeroRatedSupplies).toBe(13000); // zero_rated + export
    expect(result.field3_exemptSupplies).toBe(2000);
  });

  // ── Output invoices list ──────────────────────────────────────────────────────

  it('populates outputInvoices with mapped fields', async () => {
    mockVat201Sql(
      [makeCustomerInvoice('list-1', 5000, 750, 'standard')],
      [],
      []
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.outputInvoices).toHaveLength(1);
    expect(result.outputInvoices[0]!.invoiceNumber).toBe('INV-list-1');
    expect(result.outputInvoices[0]!.totalExclVat).toBe(5000);
    expect(result.outputInvoices[0]!.vatAmount).toBe(750);
    expect(result.outputInvoices[0]!.vatType).toBe('standard');
  });

  // ── Input invoices list ──────────────────────────────────────────────────────

  it('populates inputInvoices with mapped fields', async () => {
    mockVat201Sql(
      [],
      [makeSupplierInvoice('s-list-1', 20000, 3000)],
      [makeVatByClass('standard', 3000)]
    );

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.inputInvoices).toHaveLength(1);
    expect(result.inputInvoices[0]!.invoiceNumber).toBe('SINV-s-list-1');
    expect(result.inputInvoices[0]!.vatAmount).toBe(3000);
    expect(result.inputInvoices[0]!.vatType).toBe('standard');
  });

  // ── Empty period ──────────────────────────────────────────────────────────────

  it('returns zero-filled result when no invoices exist in period', async () => {
    mockVat201Sql([], [], []);

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.field1_standardRatedSupplies).toBe(0);
    expect(result.field2_zeroRatedSupplies).toBe(0);
    expect(result.field3_exemptSupplies).toBe(0);
    expect(result.field5_outputVAT).toBe(0);
    expect(result.field10_totalInputVAT).toBe(0);
    expect(result.field11_vatPayableOrRefundable).toBe(0);
    expect(result.outputInvoices).toHaveLength(0);
    expect(result.inputInvoices).toHaveLength(0);
  });

  // ── Period metadata ──────────────────────────────────────────────────────────

  it('echoes periodStart and periodEnd through to result', async () => {
    mockVat201Sql([], [], []);

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(result.periodStart).toBe(PERIOD_START);
    expect(result.periodEnd).toBe(PERIOD_END);
  });

  // ── SQL error handling ────────────────────────────────────────────────────────

  it('still returns a result when customer_invoices query fails (graceful)', async () => {
    // First call (customer invoices) rejects — service catches and continues
    vi.mocked(sql).mockRejectedValueOnce(new Error('table missing') as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    const result = await generateVAT201(COMPANY_ID, PERIOD_START, PERIOD_END);
    // Should not throw — output fields default to 0
    expect(result.field1_standardRatedSupplies).toBe(0);
    expect(result.field5_outputVAT).toBe(0);
  });
});
