/**
 * Shared builders/mocks for vatExceptionsService tests.
 *
 * The service runs 7 SQL queries (in declaration order inside Promise.all)
 * plus one generateVAT201 call. mockExceptionsSql queues each in sequence:
 *  1. Uncoded GL VAT lines (vat_type IS NULL on vat_input/vat_output accounts)
 *  2. Customer invoices with tax-code issues
 *  3. Supplier invoices with tax-code issues
 *  4. Customer invoice ↔ GL VAT mismatches (linked via gl_journal_entry_id)
 *  5. Supplier invoice ↔ GL VAT mismatches
 *  6. GL VAT control movement for the period (one row)
 *  7. Unposted invoice VAT aggregates (one row)
 *
 * All numeric values arrive as strings (pg numeric) — the service must coerce.
 * NOTE: each test file must call vi.mock('@/lib/neon', ...) itself; this
 * helper only queues values on the already-mocked sql.
 */

import { vi } from 'vitest';
import { sql } from '@/lib/neon';

export const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
export const PERIOD_START = '2026-03-01';
export const PERIOD_END = '2026-04-30';

export function makeVat201(field5: number, field10: number) {
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

export function makeUncodedRow(overrides: Record<string, unknown> = {}) {
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

export function makeTaxIssueRow(overrides: Record<string, unknown> = {}) {
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

export function makeMismatchRow(overrides: Record<string, unknown> = {}) {
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

export const EMPTY_GL_CONTROL = [{ gl_output: '0', gl_input: '0' }];
export const EMPTY_UNPOSTED = [
  {
    unposted_customer_vat: '0',
    unposted_customer_count: '0',
    unposted_supplier_vat: '0',
    unposted_supplier_count: '0',
  },
];

export interface MockExceptionsOpts {
  uncoded?: unknown[];
  customerTaxIssues?: unknown[];
  supplierTaxIssues?: unknown[];
  customerMismatches?: unknown[];
  supplierMismatches?: unknown[];
  glControl?: unknown[];
  unposted?: unknown[];
}

/** Queue the 7 SQL results in service call order. */
export function mockExceptionsSql(opts: MockExceptionsOpts) {
  vi.mocked(sql)
    .mockResolvedValueOnce((opts.uncoded ?? []) as never)
    .mockResolvedValueOnce((opts.customerTaxIssues ?? []) as never)
    .mockResolvedValueOnce((opts.supplierTaxIssues ?? []) as never)
    .mockResolvedValueOnce((opts.customerMismatches ?? []) as never)
    .mockResolvedValueOnce((opts.supplierMismatches ?? []) as never)
    .mockResolvedValueOnce((opts.glControl ?? EMPTY_GL_CONTROL) as never)
    .mockResolvedValueOnce((opts.unposted ?? EMPTY_UNPOSTED) as never);
}
