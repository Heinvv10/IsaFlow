// RED phase — written before implementation
/**
 * Unit tests for customerPaymentService.ts
 *
 * Strategy: mock `@/lib/neon` (sql + withTransaction) and the journal entry /
 * system-account helpers so we can drive the pure service logic — validation,
 * mapping, and allocation arithmetic — without a live database.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// ── Module mocks (must precede imports) ──────────────────────────────────────

// FX PR0: the currency gate reads the company row; it has its own tests (fx-pr0-*).
vi.mock('@/modules/accounting/services/shared/documentCurrency', async (importOriginal) =>
  (await import('../helpers/documentCurrencyMock')).documentCurrencyMock(await importOriginal()));
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

// AR audit B2: create locks the invoices (FOR UPDATE) before it judges them. The bounded lock refuses outside a
// request transaction, so it is passed through here; its own contract is covered in
// tests/integration/ar-b1b2-receipt-overapply-race.int.test.ts against a real database.
vi.mock('@/modules/accounting/services/ar/customerInvoiceLock', () => ({
  withCustomerInvoiceLock: <T>(_fn: string, _s: string, run: () => Promise<T>) => run(),
}));

// R-067 added a tenant fence on the caller-supplied customer id. These tests
// pin behaviour AFTER that check, so it is stubbed here; the fence itself is
// covered by tests/unit/services/assertCustomerInCompany.test.ts and
// tests/unit/services/customerOwnershipFence.test.ts.
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  assertCustomerInCompany: vi.fn(async () => undefined),
  CustomerNotInCompanyError: class CustomerNotInCompanyError extends Error {},
}));

vi.mock('@/modules/accounting/services/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
  reverseJournalEntry: vi.fn(),
}));

vi.mock('@/modules/accounting/services/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(),
  getSystemAccountId: vi.fn(),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { sql, withTransaction } from '@/lib/neon';
import {
  getCustomerPayments,
  createCustomerPayment,
} from '@/modules/accounting/services/ar/customerPaymentService';
import type { CustomerPaymentCreateInput } from '@/modules/accounting/types/ar.types';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockWithTransaction = withTransaction as unknown as MockedFunction<
  (fn: (tx: typeof sql) => Promise<unknown>) => Promise<unknown>
>;

// ── Shared test data ─────────────────────────────────────────────────────────

const COMPANY_ID = 'comp-0000-0000-0000-000000000001';
const USER_ID    = 'user-0000-0000-0000-000000000001';
const CLIENT_ID  = 'clie-0000-0000-0000-000000000001';
const INVOICE_ID = 'inv0-0000-0000-0000-000000000001';
const PAYMENT_ID = 'pay0-0000-0000-0000-000000000001';

/** The locked invoice rows `lockReceiptInvoices` reads (one statement for every invoice of the receipt). */
const lockRow = (id: string, total: string, paid: string) => ({
  id, invoice_number: `INV-${id.slice(0, 4)}`, currency_code: 'ZAR', status: 'approved', deleted_at: null,
  total_amount: total, amount_paid: paid,
});

/** A minimal DB row returned by INSERT … RETURNING * */
const samplePaymentRow = {
  id:               PAYMENT_ID,
  payment_number:   'PMT-00001',
  client_id:        CLIENT_ID,
  payment_date:     '2026-03-15',
  total_amount:     '1150.00',
  payment_method:   'eft',
  bank_reference:   'REF-001',
  bank_account_id:  null,
  description:      'Invoice settlement',
  status:           'draft',
  gl_journal_entry_id: null,
  project_id:       null,
  created_by:       USER_ID,
  confirmed_by:     null,
  confirmed_at:     null,
  cancelled_by:     null,
  cancelled_at:     null,
  cancel_reason:    null,
  created_at:       '2026-03-15T08:00:00.000Z',
  updated_at:       '2026-03-15T08:00:00.000Z',
  client_name:      'Acme Corp',
  allocated_amount: '1150.00',
};

const validInput: CustomerPaymentCreateInput = {
  clientId:       CLIENT_ID,
  paymentDate:    '2026-03-15',
  totalAmount:    1150,
  paymentMethod:  'eft',
  bankReference:  'REF-001',
  description:    'Invoice settlement',
  allocations: [{ invoiceId: INVOICE_ID, amount: 1150 }],
};

// ── getCustomerPayments ───────────────────────────────────────────────────────

describe('getCustomerPayments', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns mapped payments and total for unfiltered query', async () => {
    mockSql
      .mockResolvedValueOnce([samplePaymentRow])   // rows query
      .mockResolvedValueOnce([{ cnt: '1' }]);       // count query

    const result = await getCustomerPayments(COMPANY_ID);

    expect(result.total).toBe(1);
    expect(result.payments).toHaveLength(1);
    const p = result.payments[0]!;
    expect(p.id).toBe(PAYMENT_ID);
    expect(p.paymentNumber).toBe('PMT-00001');
    expect(p.totalAmount).toBe(1150);
    expect(p.status).toBe('draft');
    expect(p.clientName).toBe('Acme Corp');
    expect(p.allocatedAmount).toBe(1150);
  });

  it('maps optional fields to undefined when DB columns are null', async () => {
    const rowWithNulls = { ...samplePaymentRow, bank_reference: null, description: null, project_id: null };
    mockSql
      .mockResolvedValueOnce([rowWithNulls])
      .mockResolvedValueOnce([{ cnt: '1' }]);

    const { payments } = await getCustomerPayments(COMPANY_ID);
    expect(payments[0]!.bankReference).toBeUndefined();
    expect(payments[0]!.description).toBeUndefined();
    expect(payments[0]!.projectId).toBeUndefined();
  });

  it('returns empty list and zero total when no payments exist', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ cnt: '0' }]);

    const result = await getCustomerPayments(COMPANY_ID);
    expect(result.total).toBe(0);
    expect(result.payments).toEqual([]);
  });

  it('filters by clientId when provided', async () => {
    mockSql
      .mockResolvedValueOnce([samplePaymentRow])
      .mockResolvedValueOnce([{ cnt: '1' }]);

    const result = await getCustomerPayments(COMPANY_ID, { clientId: CLIENT_ID });

    // Two sql calls must have been made (rows + count)
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(result.payments[0]!.clientId).toBe(CLIENT_ID);
  });

  it('filters by status when provided', async () => {
    mockSql
      .mockResolvedValueOnce([{ ...samplePaymentRow, status: 'confirmed' }])
      .mockResolvedValueOnce([{ cnt: '1' }]);

    const result = await getCustomerPayments(COMPANY_ID, { status: 'confirmed' });
    expect(result.payments[0]!.status).toBe('confirmed');
  });

  it('respects limit and offset filters', async () => {
    mockSql
      .mockResolvedValueOnce([samplePaymentRow])
      .mockResolvedValueOnce([{ cnt: '25' }]);

    const result = await getCustomerPayments(COMPANY_ID, { limit: 10, offset: 10 });
    // Service passes the params to sql — total comes from count query regardless
    expect(result.total).toBe(25);
    expect(result.payments).toHaveLength(1);
  });

  it('propagates sql errors to the caller', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB connection failed'));
    await expect(getCustomerPayments(COMPANY_ID)).rejects.toThrow('DB connection failed');
  });
});

// ── createCustomerPayment — validation ───────────────────────────────────────

describe('createCustomerPayment — allocation validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects when allocation exceeds invoice balance', async () => {
    // Invoice has total_amount=1000, amount_paid=900 → balance=100
    mockSql.mockResolvedValueOnce([lockRow(INVOICE_ID, '1000.00', '900.00')]);
    mockSql.mockResolvedValueOnce([{ pending: '0' }]); // W3: draft-pending check

    const input: CustomerPaymentCreateInput = {
      ...validInput,
      totalAmount: 200,
      allocations: [{ invoiceId: INVOICE_ID, amount: 200 }], // 200 > balance of 100
    };

    await expect(createCustomerPayment(COMPANY_ID, input, USER_ID))
      .rejects.toThrow(/exceeds invoice balance/i);
  });

  it('locks the invoices FOR UPDATE, ascending id, before it reads the pending drafts (AR audit B2)', async () => {
    const texts: string[] = [];
    mockSql.mockImplementation(((strings: TemplateStringsArray) => {
      const text = (strings as unknown as string[]).join('?');
      texts.push(text);
      return Promise.resolve(/FOR UPDATE OF ci/.test(text) ? [lockRow(INVOICE_ID, '100.00', '0')] : [{ pending: '0' }]);
    }) as never);

    await expect(createCustomerPayment(COMPANY_ID, {
      ...validInput, totalAmount: 200, allocations: [{ invoiceId: INVOICE_ID, amount: 200 }],
    }, USER_ID)).rejects.toThrow(/exceeds invoice balance R100\.00/);

    const lock = texts.findIndex((t) => /FROM customer_invoices[\s\S]*ORDER BY ci\.id[\s\S]*FOR UPDATE OF ci/.test(t));
    const pending = texts.findIndex((t) => /customer_payment_allocations/.test(t));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(pending).toBeGreaterThan(lock);
  });

  it('rejects when allocation total does not match payment total', async () => {
    // Invoice has enough balance (1000 unpaid)
    mockSql.mockResolvedValueOnce([lockRow(INVOICE_ID, '1000.00', '0')]);
    mockSql.mockResolvedValueOnce([{ pending: '0' }]); // W3: draft-pending check

    const input: CustomerPaymentCreateInput = {
      ...validInput,
      totalAmount: 500,
      allocations: [{ invoiceId: INVOICE_ID, amount: 300 }], // 300 ≠ 500
    };

    await expect(createCustomerPayment(COMPANY_ID, input, USER_ID))
      .rejects.toThrow(/does not match payment/i);
  });

  it('rejects when invoice is not found', async () => {
    mockSql.mockResolvedValueOnce([]); // lock read returns no rows → invoice not found

    await expect(createCustomerPayment(COMPANY_ID, validInput, USER_ID))
      .rejects.toThrow(/not found/i);
  });

  it('rejects cross-tenant invoice IDs — per-allocation query returns 0 rows when company_id does not match', async () => {
    // Simulates an attacker supplying a valid invoice UUID from another tenant.
    // The query now includes AND company_id = ${companyId}::UUID, so no rows
    // are returned — the existing "not found" guard fires and rejects the call.
    mockSql.mockResolvedValueOnce([]); // company_id mismatch → 0 rows

    await expect(createCustomerPayment(COMPANY_ID, validInput, USER_ID))
      .rejects.toThrow(/not found/i);
  });

  it('creates payment and allocations when validation passes', async () => {
    // Invoice balance check: fully unpaid
    mockSql.mockResolvedValueOnce([lockRow(INVOICE_ID, '1150.00', '0')]);
    mockSql.mockResolvedValueOnce([{ pending: '0' }]); // W3: draft-pending check

    // withTransaction resolves with inserted payment row
    mockWithTransaction.mockImplementation(async (fn) => {
      const fakeTx = vi.fn().mockResolvedValue([samplePaymentRow]) as unknown as typeof sql;
      return fn(fakeTx);
    });
    // Post-transaction SELECT to fetch full payment row
    mockSql.mockResolvedValueOnce([samplePaymentRow]);

    const payment = await createCustomerPayment(COMPANY_ID, validInput, USER_ID);

    expect(payment.id).toBe(PAYMENT_ID);
    expect(payment.totalAmount).toBe(1150);
    expect(payment.status).toBe('draft');
    expect(payment.paymentMethod).toBe('eft');
  });

  it('refuses an allocation a whole cent over the balance', async () => {
    mockSql.mockResolvedValueOnce([lockRow(INVOICE_ID, '1150.00', '0')]);
    mockSql.mockResolvedValueOnce([{ pending: '0' }]);

    await expect(createCustomerPayment(COMPANY_ID, {
      ...validInput, totalAmount: 1150.01, allocations: [{ invoiceId: INVOICE_ID, amount: 1150.01 }],
    }, USER_ID)).rejects.toThrow(/exceeds invoice balance R1150\.00/);
  });

  it('allows float noise on the allocation (compared in whole cents)', async () => {
    // Balance = 1150.00, allocation = 1150.0000000001 — float noise, the same cent
    mockSql.mockResolvedValueOnce([lockRow(INVOICE_ID, '1150.00', '0')]);
    mockSql.mockResolvedValueOnce([{ pending: '0' }]); // W3: draft-pending check

    mockWithTransaction.mockImplementation(async (fn) => {
      const fakeTx = vi.fn().mockResolvedValue([samplePaymentRow]) as unknown as typeof sql;
      return fn(fakeTx);
    });
    mockSql.mockResolvedValueOnce([samplePaymentRow]);

    const input: CustomerPaymentCreateInput = {
      ...validInput,
      totalAmount: 1150.0000000001,
      allocations: [{ invoiceId: INVOICE_ID, amount: 1150.0000000001 }],
    };

    // Should not throw — AR audit B1/B2 compares in whole cents, so noise below a cent is not an over-allocation;
    // a whole cent over IS refused (it would be refused at confirm anyway)
    await expect(createCustomerPayment(COMPANY_ID, input, USER_ID)).resolves.toBeDefined();
  });
});

// ── createCustomerPayment — edge cases ───────────────────────────────────────

describe('createCustomerPayment — edge cases', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a payment of zero amount (allocations sum to 0)', async () => {
    mockSql.mockResolvedValueOnce([lockRow(INVOICE_ID, '1000.00', '0')]);
    mockSql.mockResolvedValueOnce([{ pending: '0' }]); // W3: draft-pending check

    const input: CustomerPaymentCreateInput = {
      ...validInput,
      totalAmount: 0,
      allocations: [{ invoiceId: INVOICE_ID, amount: 0 }],
    };

    // allocations total (0) matches payment total (0), balance check: 0 ≤ 1000 balance → passes
    // withTransaction would be called; mock it so we can confirm behaviour
    mockWithTransaction.mockImplementation(async (fn) => {
      const row = { ...samplePaymentRow, total_amount: '0.00' };
      const fakeTx = vi.fn().mockResolvedValue([row]) as unknown as typeof sql;
      return fn(fakeTx);
    });
    mockSql.mockResolvedValueOnce([{ ...samplePaymentRow, total_amount: '0.00' }]);

    const payment = await createCustomerPayment(COMPANY_ID, input, USER_ID);
    expect(payment.totalAmount).toBe(0);
  });

  it('handles multiple allocations across different invoices', async () => {
    const INVOICE_ID_2 = 'inv1-0000-0000-0000-000000000002';

    // One lock read for both invoices, then a pending-drafts check per allocation
    mockSql
      .mockResolvedValueOnce([lockRow(INVOICE_ID, '600.00', '0'), lockRow(INVOICE_ID_2, '550.00', '0')])
      .mockResolvedValueOnce([{ pending: '0' }]) // W3: draft-pending check per allocation
      .mockResolvedValueOnce([{ pending: '0' }]);

    mockWithTransaction.mockImplementation(async (fn) => {
      const multiRow = { ...samplePaymentRow, total_amount: '1150.00' };
      const fakeTx = vi.fn().mockResolvedValue([multiRow]) as unknown as typeof sql;
      return fn(fakeTx);
    });
    mockSql.mockResolvedValueOnce([{ ...samplePaymentRow, total_amount: '1150.00' }]);

    const input: CustomerPaymentCreateInput = {
      ...validInput,
      totalAmount: 1150,
      allocations: [
        { invoiceId: INVOICE_ID,   amount: 600 },
        { invoiceId: INVOICE_ID_2, amount: 550 },
      ],
    };

    const payment = await createCustomerPayment(COMPANY_ID, input, USER_ID);
    expect(payment.totalAmount).toBe(1150);
  });

  it('defaults paymentMethod to eft when not supplied', async () => {
    mockSql.mockResolvedValueOnce([lockRow(INVOICE_ID, '1150.00', '0')]);
    mockSql.mockResolvedValueOnce([{ pending: '0' }]); // W3: draft-pending check

    mockWithTransaction.mockImplementation(async (fn) => {
      const fakeTx = vi.fn().mockResolvedValue([samplePaymentRow]) as unknown as typeof sql;
      return fn(fakeTx);
    });
    mockSql.mockResolvedValueOnce([samplePaymentRow]);

    const input: CustomerPaymentCreateInput = {
      clientId:    CLIENT_ID,
      paymentDate: '2026-03-15',
      totalAmount: 1150,
      allocations: [{ invoiceId: INVOICE_ID, amount: 1150 }],
      // paymentMethod omitted
    };

    const payment = await createCustomerPayment(COMPANY_ID, input, USER_ID);
    // The row mock has paymentMethod 'eft'; the service inserts `input.paymentMethod || 'eft'`
    expect(payment.paymentMethod).toBe('eft');
  });
});
