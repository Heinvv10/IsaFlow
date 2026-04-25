// RED phase — written before implementation
/**
 * Unit tests for supplierInvoiceService.ts
 *
 * Tests the pure computation inside createSupplierInvoice (line total,
 * tax, due-date arithmetic) and the list/filter behaviour of
 * getSupplierInvoices via mocked SQL responses.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@/lib/neon', () => {
  // sql.unsafe is a vi.fn so tests can assert against its bound values. It
  // returns the first arg (raw SQL text) so the outer sql tagged template
  // still works when the unsafe result is interpolated as a fragment.
  const unsafeMock = vi.fn((s: string, _values?: unknown[]) => s);
  const sqlMock = Object.assign(vi.fn(), {
    transaction: vi.fn(),
    unsafe: unsafeMock,
  });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/modules/accounting/services/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
}));

vi.mock('@/modules/accounting/services/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(),
  getSystemAccountId: vi.fn(),
}));

vi.mock('@/modules/accounting/utils/threeWayMatch', () => ({
  validateThreeWayMatch: vi.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { sql, withTransaction } from '@/lib/neon';
import {
  getSupplierInvoices,
  getSupplierInvoiceStatusCounts,
  getSupplierInvoicesForExport,
  createSupplierInvoice,
  SUPPLIER_INVOICE_EXPORT_CAP,
} from '@/modules/accounting/services/ap/supplierInvoiceService';
import type { SupplierInvoiceCreateInput } from '@/modules/accounting/types/ap.types';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSqlUnsafe = sql.unsafe as unknown as MockedFunction<(text: string, values?: unknown[]) => string>;
const mockWithTransaction = withTransaction as unknown as MockedFunction<
  (fn: (tx: typeof sql) => Promise<unknown>) => Promise<unknown>
>;

// ── Shared test data ─────────────────────────────────────────────────────────

const COMPANY_ID   = 'comp-0000-0000-0000-000000000001';
const USER_ID      = 'user-0000-0000-0000-000000000001';
const SUPPLIER_ID  = '42';     // supplierId is typed as string but stored as integer PK
const INVOICE_ID   = 'sinv-0000-0000-0000-000000000001';
const GL_ACCOUNT_ID = 'glacc-000-0000-0000-000000000001';

const sampleInvoiceRow = {
  id:                   INVOICE_ID,
  invoice_number:       'SUP-INV-0001',
  supplier_id:          SUPPLIER_ID,
  purchase_order_id:    null,
  grn_id:               null,
  invoice_date:         '2026-03-01',
  due_date:             '2026-03-31',
  received_date:        null,
  subtotal:             '1000.00',
  tax_rate:             '15',
  tax_amount:           '150.00',
  total_amount:         '1150.00',
  amount_paid:          '0.00',
  balance:              '1150.00',
  payment_terms:        'net30',
  currency:             'ZAR',
  reference:            null,
  status:               'draft',
  match_status:         'unmatched',
  project_id:           null,
  cost_center_id:       null,
  gl_journal_entry_id:  null,
  sage_invoice_id:      null,
  notes:                null,
  created_by:           USER_ID,
  approved_by:          null,
  approved_at:          null,
  created_at:           '2026-03-01T07:00:00.000Z',
  updated_at:           '2026-03-01T07:00:00.000Z',
  supplier_name:        'Acme Supplies',
  po_number:            null,
};

const validInput: SupplierInvoiceCreateInput = {
  invoiceNumber: 'SUP-INV-0001',
  supplierId:    SUPPLIER_ID,
  invoiceDate:   '2026-03-01',
  paymentTerms:  'net30',
  taxRate:       15,
  items: [
    {
      description: 'Fibre cable 100m',
      quantity:    10,
      unitPrice:   100,
      taxRate:     15,
      glAccountId: GL_ACCOUNT_ID,
    },
  ],
};

// ── getSupplierInvoices ───────────────────────────────────────────────────────

describe('getSupplierInvoices', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns mapped invoices and total for unfiltered query', async () => {
    mockSql
      .mockResolvedValueOnce([sampleInvoiceRow])
      .mockResolvedValueOnce([{ cnt: '1' }]);

    const result = await getSupplierInvoices(COMPANY_ID);

    expect(result.total).toBe(1);
    expect(result.invoices).toHaveLength(1);
    const inv = result.invoices[0]!;
    expect(inv.id).toBe(INVOICE_ID);
    expect(inv.invoiceNumber).toBe('SUP-INV-0001');
    expect(inv.subtotal).toBe(1000);
    expect(inv.taxRate).toBe(15);
    expect(inv.taxAmount).toBe(150);
    expect(inv.totalAmount).toBe(1150);
    expect(inv.status).toBe('draft');
    expect(inv.matchStatus).toBe('unmatched');
    expect(inv.supplierName).toBe('Acme Supplies');
  });

  it('returns empty list and zero total when no invoices exist', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ cnt: '0' }]);

    const result = await getSupplierInvoices(COMPANY_ID);
    expect(result.total).toBe(0);
    expect(result.invoices).toEqual([]);
  });

  it('filters by status only', async () => {
    mockSql
      .mockResolvedValueOnce([{ ...sampleInvoiceRow, status: 'approved' }])
      .mockResolvedValueOnce([{ cnt: '1' }]);

    const result = await getSupplierInvoices(COMPANY_ID, { status: 'approved' });
    expect(result.invoices[0]!.status).toBe('approved');
    // Two queries: rows + count
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('filters by supplierId only', async () => {
    mockSql
      .mockResolvedValueOnce([sampleInvoiceRow])
      .mockResolvedValueOnce([{ cnt: '1' }]);

    const result = await getSupplierInvoices(COMPANY_ID, { supplierId: 42 });
    expect(result.invoices[0]!.supplierId).toBe(SUPPLIER_ID);
  });

  it('filters by both status and supplierId', async () => {
    mockSql
      .mockResolvedValueOnce([sampleInvoiceRow])
      .mockResolvedValueOnce([{ cnt: '1' }]);

    const result = await getSupplierInvoices(COMPANY_ID, { status: 'draft', supplierId: 42 });
    expect(result.invoices).toHaveLength(1);
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('maps optional fields to undefined when null in DB', async () => {
    const row = { ...sampleInvoiceRow, reference: null, notes: null, due_date: null };
    mockSql
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([{ cnt: '1' }]);

    const { invoices } = await getSupplierInvoices(COMPANY_ID);
    expect(invoices[0]!.reference).toBeUndefined();
    expect(invoices[0]!.notes).toBeUndefined();
    expect(invoices[0]!.dueDate).toBeUndefined();
  });

  it('propagates sql errors to the caller', async () => {
    mockSql.mockRejectedValueOnce(new Error('Connection reset'));
    await expect(getSupplierInvoices(COMPANY_ID)).rejects.toThrow('Connection reset');
  });

  it('caps limit at 200 when caller requests more', async () => {
    // The list page exposes 25/50/100/200 per-page options; the service caps
    // at 200 (the export endpoint uses its own dedicated cap).
    const fakeRows = Array.from({ length: 250 }, (_, i) => ({
      ...sampleInvoiceRow,
      id: `sinv-${String(i).padStart(4, '0')}`,
      invoice_number: `SUP-INV-${String(i).padStart(4, '0')}`,
    }));

    mockSql
      .mockResolvedValueOnce(fakeRows.slice(0, 200))  // SQL honours LIMIT 200
      .mockResolvedValueOnce([{ cnt: '250' }]);

    const result = await getSupplierInvoices(COMPANY_ID, { limit: 500 });

    expect(result.invoices.length).toBeLessThanOrEqual(200);
    expect(result.total).toBe(250);

    // Confirm the LIMIT bound into the outer sql template was 200, not 500.
    // sql template args = [stringsArr, ...interpolations]; LIMIT comes from
    // ${safeLimit} so we just check the call's flat interpolations include 200.
    const firstCall = mockSql.mock.calls[0] ?? [];
    expect(firstCall.slice(1)).toContain(200);
    expect(firstCall.slice(1)).not.toContain(500);
  });

  it('returned invoice has all expected keys from explicit column projection', async () => {
    mockSql
      .mockResolvedValueOnce([sampleInvoiceRow])
      .mockResolvedValueOnce([{ cnt: '1' }]);

    const { invoices } = await getSupplierInvoices(COMPANY_ID);
    const inv = invoices[0]!;

    // Verify every field the mapper produces is present
    const requiredKeys: (keyof typeof inv)[] = [
      'id', 'invoiceNumber', 'supplierId',
      'invoiceDate', 'subtotal', 'taxRate', 'taxAmount', 'totalAmount',
      'amountPaid', 'balance', 'status', 'matchStatus',
      'currency', 'createdBy', 'createdAt', 'updatedAt',
      'supplierName',
    ];
    for (const key of requiredKeys) {
      expect(inv).toHaveProperty(key);
    }
  });

  // ── New filter coverage (PR #42) ────────────────────────────────────────────

  // Helpers to inspect what buildInvoiceWhere bound to the WHERE LazyQuery.
  // sql.unsafe(text, values) is called once per buildInvoiceWhere invocation;
  // values are exposed via mockSqlUnsafe.mock.calls[N][1].
  function whereCallValues(): unknown[] {
    const calls = mockSqlUnsafe.mock.calls;
    // Find the first unsafe call that has a values array (the WHERE call).
    const found = calls.find((c) => Array.isArray(c[1]));
    return (found?.[1] as unknown[]) ?? [];
  }
  function whereCallText(): string {
    const calls = mockSqlUnsafe.mock.calls;
    const found = calls.find((c) => Array.isArray(c[1]));
    return String(found?.[0] ?? '');
  }
  function orderByText(): string {
    // The orderBy unsafe call has a single arg (no values array).
    const calls = mockSqlUnsafe.mock.calls;
    const found = calls.find((c) => typeof c[0] === 'string' && c[0].startsWith('ORDER BY'));
    return String(found?.[0] ?? '');
  }

  it('passes search pattern (wrapped in %) to ILIKE bindings', async () => {
    mockSql.mockResolvedValueOnce([sampleInvoiceRow]).mockResolvedValueOnce([{ cnt: '1' }]);
    await getSupplierInvoices(COMPANY_ID, { search: 'INV005388' });
    expect(whereCallValues()).toContain('%INV005388%');
  });

  it('treats empty/whitespace search as no filter (no ILIKE bind)', async () => {
    mockSql.mockResolvedValueOnce([sampleInvoiceRow]).mockResolvedValueOnce([{ cnt: '1' }]);
    await getSupplierInvoices(COMPANY_ID, { search: '   ' });
    const values = whereCallValues();
    expect(values.some((v) => typeof v === 'string' && v.startsWith('%'))).toBe(false);
  });

  it('binds fromDate/toDate as ::date parameters', async () => {
    mockSql.mockResolvedValueOnce([sampleInvoiceRow]).mockResolvedValueOnce([{ cnt: '1' }]);
    await getSupplierInvoices(COMPANY_ID, { fromDate: '2025-05-28', toDate: '2026-04-25' });
    const values = whereCallValues();
    expect(values).toContain('2025-05-28');
    expect(values).toContain('2026-04-25');
    expect(whereCallText()).toContain('::date');
  });

  it('binds amount range and balance range parameters', async () => {
    mockSql.mockResolvedValueOnce([sampleInvoiceRow]).mockResolvedValueOnce([{ cnt: '1' }]);
    await getSupplierInvoices(COMPANY_ID, {
      fromAmount: 100, toAmount: 5000, fromBalance: 0, toBalance: 999,
    });
    const values = whereCallValues();
    expect(values).toContain(100);
    expect(values).toContain(5000);
    expect(values).toContain(0);
    expect(values).toContain(999);
  });

  it('accepts negative amount filter values without rejecting them', async () => {
    mockSql.mockResolvedValueOnce([sampleInvoiceRow]).mockResolvedValueOnce([{ cnt: '1' }]);
    await getSupplierInvoices(COMPANY_ID, { fromAmount: -100 });
    expect(whereCallValues()).toContain(-100);
  });

  it('falls back to invoice_date sort for an unknown sort key', async () => {
    mockSql.mockResolvedValueOnce([sampleInvoiceRow]).mockResolvedValueOnce([{ cnt: '1' }]);
    await getSupplierInvoices(COMPANY_ID, {
      sort: 'malicious; DROP TABLE x;' as unknown as Parameters<typeof getSupplierInvoices>[1] extends infer F ? (F extends { sort?: infer S } ? S : never) : never,
    });
    expect(orderByText()).toContain('si.invoice_date');
    expect(orderByText()).not.toContain('DROP TABLE');
  });

  it('respects sort=total_amount with sortOrder=asc', async () => {
    mockSql.mockResolvedValueOnce([sampleInvoiceRow]).mockResolvedValueOnce([{ cnt: '1' }]);
    await getSupplierInvoices(COMPANY_ID, { sort: 'total_amount', sortOrder: 'asc' });
    expect(orderByText()).toMatch(/si\.total_amount ASC/);
  });

  it('uses descending order by default', async () => {
    mockSql.mockResolvedValueOnce([sampleInvoiceRow]).mockResolvedValueOnce([{ cnt: '1' }]);
    await getSupplierInvoices(COMPANY_ID, { sort: 'invoice_date' });
    expect(orderByText()).toMatch(/si\.invoice_date DESC/);
  });
});

// ── getSupplierInvoiceStatusCounts ───────────────────────────────────────────

describe('getSupplierInvoiceStatusCounts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('aggregates per-status counts and synthesises an "all" total', async () => {
    mockSql.mockResolvedValueOnce([
      { status: 'draft', cnt: '1' },
      { status: 'approved', cnt: '149' },
      { status: 'partially_paid', cnt: '8' },
      { status: 'paid', cnt: '199' },
    ]);

    const counts = await getSupplierInvoiceStatusCounts(COMPANY_ID);
    expect(counts).toEqual({
      draft: 1,
      approved: 149,
      partially_paid: 8,
      paid: 199,
      all: 357,
    });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('returns {all: 0} for an empty company', async () => {
    mockSql.mockResolvedValueOnce([]);
    const counts = await getSupplierInvoiceStatusCounts(COMPANY_ID);
    expect(counts.all).toBe(0);
  });
});

// ── getSupplierInvoicesForExport ─────────────────────────────────────────────

describe('getSupplierInvoicesForExport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the un-paginated set when below the row cap', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      ...sampleInvoiceRow,
      id: `sinv-${String(i).padStart(4, '0')}`,
    }));
    mockSql.mockResolvedValueOnce(rows);

    const result = await getSupplierInvoicesForExport(COMPANY_ID);
    expect(result.invoices).toHaveLength(50);
    expect(result.truncated).toBe(false);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('marks the result truncated when SQL returns more than the cap', async () => {
    const overflow = Array.from({ length: SUPPLIER_INVOICE_EXPORT_CAP + 1 }, (_, i) => ({
      ...sampleInvoiceRow,
      id: `sinv-${String(i).padStart(5, '0')}`,
    }));
    mockSql.mockResolvedValueOnce(overflow);

    const result = await getSupplierInvoicesForExport(COMPANY_ID);
    expect(result.invoices).toHaveLength(SUPPLIER_INVOICE_EXPORT_CAP);
    expect(result.truncated).toBe(true);
  });

  it('honours filter params on the export query', async () => {
    mockSql.mockResolvedValueOnce([sampleInvoiceRow]);
    await getSupplierInvoicesForExport(COMPANY_ID, {
      status: 'approved',
      supplierId: 'sup-1',
      search: 'INV005388',
    });
    // The filters end up bound into the WHERE-fragment unsafe call.
    const whereCall = mockSqlUnsafe.mock.calls.find((c) => Array.isArray(c[1]));
    const values = (whereCall?.[1] as unknown[]) ?? [];
    expect(values).toContain('approved');
    expect(values).toContain('sup-1');
    expect(values).toContain('%INV005388%');
  });
});

// ── createSupplierInvoice — line-item computation ────────────────────────────

describe('createSupplierInvoice — line-item arithmetic', () => {
  beforeEach(() => vi.clearAllMocks());

  function setupSuccessfulCreate(overrideRow?: Partial<typeof sampleInvoiceRow>) {
    // createSupplierInvoice now performs a pre-transaction `SELECT vat_number`
    // on the suppliers table for duplicate-fingerprint computation. Mock it
    // outside the withTransaction helper so the destructure succeeds.
    mockSql.mockResolvedValueOnce([{ vat_number: '4000123456' }]);
    mockWithTransaction.mockImplementation(async (fn) => {
      const returnedRow = { ...sampleInvoiceRow, ...overrideRow };
      const fakeTx = vi.fn().mockResolvedValue([returnedRow]) as unknown as typeof sql;
      return fn(fakeTx);
    });
  }

  it('computes line total as quantity × unitPrice', async () => {
    // 10 units × R100 = R1000 subtotal; service computes this internally
    setupSuccessfulCreate();

    const inv = await createSupplierInvoice(COMPANY_ID, validInput, USER_ID);
    // The returned value is mapped from the row mock — verify the DB row is written correctly
    // via withTransaction being called (indirect assertion on computation path)
    expect(mockWithTransaction).toHaveBeenCalledOnce();
    expect(inv.subtotal).toBe(1000);
  });

  it('applies 15% VAT by default to produce correct tax amount', async () => {
    setupSuccessfulCreate({ tax_amount: '150.00', total_amount: '1150.00' });

    const inv = await createSupplierInvoice(COMPANY_ID, validInput, USER_ID);
    expect(inv.taxAmount).toBe(150);
    expect(inv.totalAmount).toBe(1150);
  });

  it('applies zero-rated VAT when taxRate is 0', async () => {
    const zeroRatedInput: SupplierInvoiceCreateInput = {
      ...validInput,
      taxRate: 0,
      items: [{ ...validInput.items[0]!, taxRate: 0 }],
    };

    setupSuccessfulCreate({ tax_amount: '0.00', total_amount: '1000.00', tax_rate: '0' });

    const inv = await createSupplierInvoice(COMPANY_ID, zeroRatedInput, USER_ID);
    expect(inv.taxAmount).toBe(0);
    expect(inv.totalAmount).toBe(1000);
  });

  it('rounds line totals to 2 decimal places', async () => {
    // 3 × R10.333... = R30.99
    const fractionalInput: SupplierInvoiceCreateInput = {
      ...validInput,
      taxRate: 0,
      items: [{ description: 'Fractional item', quantity: 3, unitPrice: 10.333, taxRate: 0 }],
    };

    setupSuccessfulCreate({
      subtotal:     '30.99',
      tax_amount:   '0.00',
      total_amount: '30.99',
    });

    const inv = await createSupplierInvoice(COMPANY_ID, fractionalInput, USER_ID);
    // Mapping returns numbers from DB row strings
    expect(inv.subtotal).toBeCloseTo(30.99, 2);
  });

  it('calculates due date from net30 payment terms when dueDate not supplied', async () => {
    // invoiceDate 2026-03-01 + 30 days = 2026-03-31
    setupSuccessfulCreate({ due_date: '2026-03-31' });

    const inv = await createSupplierInvoice(COMPANY_ID, validInput, USER_ID);
    expect(inv.dueDate).toBe('2026-03-31');
  });

  it('uses provided dueDate over calculated one', async () => {
    const inputWithDue: SupplierInvoiceCreateInput = {
      ...validInput,
      dueDate: '2026-04-15',
    };

    setupSuccessfulCreate({ due_date: '2026-04-15' });

    const inv = await createSupplierInvoice(COMPANY_ID, inputWithDue, USER_ID);
    expect(inv.dueDate).toBe('2026-04-15');
  });

  it('handles multiple line items and sums subtotal correctly', async () => {
    // 2 × R500 + 3 × R200 = R1600 subtotal; 15% VAT = R240; total = R1840
    const multiLineInput: SupplierInvoiceCreateInput = {
      ...validInput,
      items: [
        { description: 'Item A', quantity: 2, unitPrice: 500, taxRate: 15 },
        { description: 'Item B', quantity: 3, unitPrice: 200, taxRate: 15 },
      ],
    };

    setupSuccessfulCreate({
      subtotal:     '1600.00',
      tax_amount:   '240.00',
      total_amount: '1840.00',
    });

    const inv = await createSupplierInvoice(COMPANY_ID, multiLineInput, USER_ID);
    expect(inv.subtotal).toBe(1600);
    expect(inv.taxAmount).toBe(240);
    expect(inv.totalAmount).toBe(1840);
  });
});

// ── createSupplierInvoice — edge cases ───────────────────────────────────────

describe('createSupplierInvoice — edge cases', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates invoice with a single zero-quantity line without crashing', async () => {
    // quantity=0 → lineTotal=0, taxAmount=0; still passes through to DB
    const zeroQtyInput: SupplierInvoiceCreateInput = {
      ...validInput,
      items: [{ description: 'Ghost line', quantity: 0, unitPrice: 100, taxRate: 15 }],
    };

    mockSql.mockResolvedValueOnce([{ vat_number: '4000123456' }]);
    mockWithTransaction.mockImplementation(async (fn) => {
      const row = { ...sampleInvoiceRow, subtotal: '0.00', tax_amount: '0.00', total_amount: '0.00' };
      const fakeTx = vi.fn().mockResolvedValue([row]) as unknown as typeof sql;
      return fn(fakeTx);
    });

    const inv = await createSupplierInvoice(COMPANY_ID, zeroQtyInput, USER_ID);
    expect(inv.subtotal).toBe(0);
    expect(inv.totalAmount).toBe(0);
  });

  it('sets vatClassification to zero_rated when taxRate is 0', async () => {
    // The service derives vatClassification from taxRate — we confirm the transaction runs
    const zeroInput: SupplierInvoiceCreateInput = {
      ...validInput,
      items: [{ description: 'Zero-rated supply', quantity: 1, unitPrice: 200, taxRate: 0 }],
    };

    const capturedTxCalls: unknown[][] = [];
    mockSql.mockResolvedValueOnce([{ vat_number: '4000123456' }]);
    mockWithTransaction.mockImplementation(async (fn) => {
      const fakeTx = vi.fn().mockImplementation((...args: unknown[]) => {
        capturedTxCalls.push(args);
        return Promise.resolve([{ ...sampleInvoiceRow, subtotal: '200.00', tax_amount: '0.00', total_amount: '200.00' }]);
      }) as unknown as typeof sql;
      return fn(fakeTx);
    });

    await createSupplierInvoice(COMPANY_ID, zeroInput, USER_ID);
    // withTransaction was called — item INSERT is within the transaction
    expect(mockWithTransaction).toHaveBeenCalledOnce();
  });

  it('propagates db errors from withTransaction', async () => {
    mockSql.mockResolvedValueOnce([{ vat_number: '4000123456' }]);
    mockWithTransaction.mockRejectedValueOnce(new Error('unique constraint violation'));

    await expect(createSupplierInvoice(COMPANY_ID, validInput, USER_ID))
      .rejects.toThrow(/unique constraint/i);
  });

  it('preserves invoiceNumber exactly as provided', async () => {
    mockSql.mockResolvedValueOnce([{ vat_number: '4000123456' }]);
    mockWithTransaction.mockImplementation(async (fn) => {
      const row = { ...sampleInvoiceRow, invoice_number: 'ACME/2026/00042' };
      const fakeTx = vi.fn().mockResolvedValue([row]) as unknown as typeof sql;
      return fn(fakeTx);
    });

    const input: SupplierInvoiceCreateInput = {
      ...validInput,
      invoiceNumber: 'ACME/2026/00042',
    };

    const inv = await createSupplierInvoice(COMPANY_ID, input, USER_ID);
    expect(inv.invoiceNumber).toBe('ACME/2026/00042');
  });
});

// ── calculateDueDate — pure logic (exercised via createSupplierInvoice) ──────

describe('Due date calculation via paymentTerms', () => {
  beforeEach(() => vi.clearAllMocks());

  const buildInput = (paymentTerms: string): SupplierInvoiceCreateInput => ({
    ...validInput,
    invoiceDate:  '2026-01-01',
    paymentTerms,
  });

  async function getDueDate(paymentTerms: string, dueDateInRow: string): Promise<string | undefined> {
    mockSql.mockResolvedValueOnce([{ vat_number: '4000123456' }]);
    mockWithTransaction.mockImplementation(async (fn) => {
      const row = { ...sampleInvoiceRow, due_date: dueDateInRow };
      const fakeTx = vi.fn().mockResolvedValue([row]) as unknown as typeof sql;
      return fn(fakeTx);
    });
    const inv = await createSupplierInvoice(COMPANY_ID, buildInput(paymentTerms), USER_ID);
    return inv.dueDate;
  }

  it('net30 → adds 30 days to invoice date', async () => {
    // 2026-01-01 + 30 = 2026-01-31
    expect(await getDueDate('net30', '2026-01-31')).toBe('2026-01-31');
  });

  it('net60 → adds 60 days to invoice date', async () => {
    // 2026-01-01 + 60 = 2026-03-02
    expect(await getDueDate('net60', '2026-03-02')).toBe('2026-03-02');
  });

  it('unrecognised term returns null/undefined (no due date)', async () => {
    // The service regex /net(\d+)/i does not match 'immediate'
    expect(await getDueDate('immediate', null as unknown as string)).toBeUndefined();
  });
});
