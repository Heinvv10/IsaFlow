/**
 * Unit tests for supplierPaymentService.ts
 *
 * Focuses on cross-tenant IDOR fix: createSupplierPayment must scope the
 * supplier_invoices SELECT to company_id, and must reject invoice IDs that
 * belong to a different tenant.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// paymentAllocation util is pure — let it run for real so validation works
vi.mock('@/modules/accounting/services/ar/customerPaymentAllocationService', () => ({
  confirmCustomerPayment: vi.fn(),
  cancelCustomerPayment: vi.fn(),
  postCustomerInvoiceToGL: vi.fn(),
}));

// Re-export stubs for the workflow service split
vi.mock(
  '@/modules/accounting/services/ap/supplierPaymentWorkflowService',
  () => ({
    approveSupplierPayment: vi.fn(),
    processSupplierPayment: vi.fn(),
  })
);

import { sql, withTransaction } from '@/lib/neon';
import { createSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentService';
import type { CreatePaymentInput } from '@/modules/accounting/services/ap/supplierPaymentService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockWithTransaction = withTransaction as unknown as MockedFunction<
  (fn: (tx: typeof sql) => Promise<unknown>) => Promise<unknown>
>;

const COMPANY_ID  = 'comp-aaaa-0000-0000-000000000001';
const USER_ID     = 'user-bbbb-0000-0000-000000000001';
const SUPPLIER_ID = 'supp-cccc-0000-0000-000000000001';
const INVOICE_ID  = 'inv0-dddd-0000-0000-000000000001';
const PAYMENT_ID  = 'pay0-eeee-0000-0000-000000000001';

const samplePaymentRow = {
  id: PAYMENT_ID,
  payment_number: 'SPMT-00001',
  supplier_id: SUPPLIER_ID,
  payment_date: '2026-03-20',
  total_amount: '2500.00',
  payment_method: 'eft',
  bank_account_id: null,
  reference: 'PAY-REF-001',
  description: 'March invoices',
  status: 'draft',
  gl_journal_entry_id: null,
  batch_id: null,
  created_by: USER_ID,
  approved_by: null,
  approved_at: null,
  processed_at: null,
  created_at: '2026-03-20T08:00:00.000Z',
  updated_at: '2026-03-20T08:00:00.000Z',
  supplier_name: 'Widget Supplies',
};

const validInput: CreatePaymentInput = {
  supplierId: SUPPLIER_ID,
  paymentDate: '2026-03-20',
  totalAmount: 2500,
  paymentMethod: 'eft',
  reference: 'PAY-REF-001',
  description: 'March invoices',
  allocations: [{ invoiceId: INVOICE_ID, amount: 2500 }],
};

// ── createSupplierPayment — cross-tenant invoice guard ───────────────────────

describe('createSupplierPayment — cross-tenant invoice guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws when invoice count returned differs from requested (simulates cross-tenant invoice)', async () => {
    // DB returns 0 rows — the invoice UUID belongs to another tenant and was
    // filtered out by the company_id scope added to the SELECT.
    mockSql.mockResolvedValueOnce([]);

    await expect(createSupplierPayment(COMPANY_ID, validInput, USER_ID))
      .rejects.toThrow(/not found or belong to a different company/i);
  });

  it('throws when only some invoices are found (partial cross-tenant match)', async () => {
    const INVOICE_ID_2 = 'inv1-dddd-0000-0000-000000000002';
    const inputWithTwo: CreatePaymentInput = {
      ...validInput,
      totalAmount: 3000,
      allocations: [
        { invoiceId: INVOICE_ID,   amount: 1500 },
        { invoiceId: INVOICE_ID_2, amount: 1500 },
      ],
    };

    // Only 1 of 2 invoices returned — the second belongs to a different tenant
    mockSql.mockResolvedValueOnce([
      { id: INVOICE_ID, invoice_number: 'SI-001', total_amount: '1500.00', amount_paid: '0', balance: '1500.00' },
    ]);

    await expect(createSupplierPayment(COMPANY_ID, inputWithTwo, USER_ID))
      .rejects.toThrow(/not found or belong to a different company/i);
  });

  it('proceeds when all invoices belong to the correct company', async () => {
    // All requested invoices returned — company_id filter matched
    mockSql.mockResolvedValueOnce([
      { id: INVOICE_ID, invoice_number: 'SI-001', total_amount: '2500.00', amount_paid: '0', balance: '2500.00' },
    ]);

    mockWithTransaction.mockImplementation(async (fn) => {
      const fakeTx = vi.fn().mockResolvedValue([samplePaymentRow]) as unknown as typeof sql;
      return fn(fakeTx);
    });

    const payment = await createSupplierPayment(COMPANY_ID, validInput, USER_ID);

    expect(payment.id).toBe(PAYMENT_ID);
    expect(payment.totalAmount).toBe(2500);
    expect(payment.status).toBe('draft');
  });
});
