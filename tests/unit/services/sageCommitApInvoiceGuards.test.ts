/**
 * Sage migration, AP invoices — the one posting path that keeps its direct
 * `UPDATE gl_journal_entries SET status = 'posted'`.
 *
 * The bypass is deliberate and pre-dates this work: "Post JE directly —
 * bypasses workflow helper that blocks backdated periods." A migrated supplier
 * invoice belongs in its ORIGINAL fiscal period, which is usually closed, so
 * postJournalEntry (the canonical path) would refuse every one of them. 955
 * such journals already sit in closed periods in production.
 *
 * The period guard therefore cannot apply here. Every OTHER guard still must,
 * and the inactive-account check is made explicitly — before the status
 * UPDATE, so a refusal rolls back the surrounding savepoint with nothing
 * half-posted.
 *
 * All DB calls are mocked — no real connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({
  sql: Object.assign((...a: unknown[]) => sqlMock(...a), { unsafe: (s: string) => s }),
  withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
  withTransaction: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const createJournalEntry = vi.fn(async () => ({ id: 'je-ap-1' }));
const createSupplierInvoice = vi.fn(async () => ({ id: 'si-1' }));
const assertNoInactiveAccountLines = vi.fn(async () => undefined);

vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  createJournalEntry: (...a: unknown[]) => createJournalEntry(...(a as [])),
  resolveUserUuid: vi.fn(async (u: string) => u),
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({
  createSupplierInvoice: (...a: unknown[]) => createSupplierInvoice(...(a as [])),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(async (role: string) => ({ id: `acct-${role}` })),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({
  assertNoInactiveAccountLines: (...a: unknown[]) => assertNoInactiveAccountLines(...(a as [])),
}));
const postCustomerInvoiceToGL = vi.fn(async () => 'je-ar-1');
vi.mock('@/modules/accounting/services/ar/customerPaymentAllocationService', () => ({
  postCustomerInvoiceToGL: (...a: unknown[]) => postCustomerInvoiceToGL(...(a as [])),
}));

import { commitAPInvoice, commitARInvoice } from '@/modules/admin/services/sageMigrationCommitService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER = 'cccccccc-0000-0000-0000-000000000001';

const AP_INVOICE = {
  supplierName: 'Acme Supplies',
  invoiceNumber: 'SI-2023-114',
  invoiceDate: '2023-11-14',
  dueDate: '2023-12-14',
  reference: 'PO-9912',
  subtotal: 1000,
  taxAmount: 150,
  totalAmount: 1150,
} as unknown as Parameters<typeof commitAPInvoice>[2];

function texts(): string[] {
  return sqlMock.mock.calls.map((c) =>
    (c[0] as readonly string[]).join(' ? ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' '),
  );
}

const statusWrites = () => texts().filter((q) => /UPDATE gl_journal_entries[^?]*status = 'posted'/i.test(q));

beforeEach(() => {
  vi.clearAllMocks();
  createJournalEntry.mockResolvedValue({ id: 'je-ap-1' });
  createSupplierInvoice.mockResolvedValue({ id: 'si-1' });
  postCustomerInvoiceToGL.mockResolvedValue('je-ar-1');
  assertNoInactiveAccountLines.mockResolvedValue(undefined);
  sqlMock.mockImplementation(async (strings: readonly string[]) => {
    const q = strings.join(' ');
    if (/FROM supplier_invoices/i.test(q)) return []; // no duplicate
    if (/FROM customer_invoices/i.test(q)) return []; // no duplicate
    if (/FROM suppliers/i.test(q)) return [{ id: 'sup-1' }];
    if (/FROM customers/i.test(q)) return [{ id: 'cus-1' }];
    if (/INSERT INTO customer_invoices/i.test(q)) return [{ id: 'ci-1' }];
    return [];
  });
});

const AR_INVOICE = {
  customerName: 'Acme Client',
  invoiceNumber: 'INV-2023-114',
  invoiceDate: '2023-11-14',
  dueDate: '2023-12-14',
  reference: 'REF-1',
  subtotal: 1000,
  taxAmount: 150,
  totalAmount: 1150,
} as unknown as Parameters<typeof commitARInvoice>[2];

describe('commitARInvoice opts into the historical path', () => {
  it('passes historicalImport so a 2023 invoice is not refused for its closed period', async () => {
    await commitARInvoice(COMPANY, USER, AR_INVOICE);

    // Dropping this flag would refuse every backdated migration invoice — 955
    // such journals already exist in production.
    expect(postCustomerInvoiceToGL).toHaveBeenCalledWith(
      COMPANY, 'ci-1', USER, { historicalImport: true },
    );
  });

  it('does not swallow a refusal from the AR posting path', async () => {
    postCustomerInvoiceToGL.mockRejectedValue(new Error('Cannot post to deactivated GL account: 1121'));

    await expect(commitARInvoice(COMPANY, USER, AR_INVOICE)).rejects.toThrow(/deactivated/i);
  });
});

describe('commitAPInvoice keeps the direct post but not the missing guard', () => {
  it('checks for deactivated accounts before posting', async () => {
    await commitAPInvoice(COMPANY, USER, AP_INVOICE);

    expect(assertNoInactiveAccountLines).toHaveBeenCalledWith(COMPANY, 'je-ap-1');
    expect(statusWrites()).toHaveLength(1);
  });

  it('refuses and writes no status when a line hits a deactivated account', async () => {
    assertNoInactiveAccountLines.mockRejectedValue(
      new Error('Cannot post to deactivated GL account: 1121 Loan Account - Blitz Fibre'),
    );

    await expect(commitAPInvoice(COMPANY, USER, AP_INVOICE)).rejects.toThrow(/deactivated/i);
    // The throw unwinds the caller's savepoint; nothing may be half-posted.
    expect(statusWrites()).toHaveLength(0);
  });

  it('runs the guard AFTER the entry exists but BEFORE it is posted', async () => {
    const order: string[] = [];
    createJournalEntry.mockImplementation(async () => { order.push('create'); return { id: 'je-ap-1' }; });
    assertNoInactiveAccountLines.mockImplementation(async () => { order.push('guard'); });
    sqlMock.mockImplementation(async (strings: readonly string[]) => {
      const q = strings.join(' ');
      if (/UPDATE gl_journal_entries/i.test(q)) order.push('post');
      if (/FROM supplier_invoices/i.test(q)) return [];
      if (/FROM suppliers/i.test(q)) return [{ id: 'sup-1' }];
      return [];
    });

    await commitAPInvoice(COMPANY, USER, AP_INVOICE);

    expect(order).toEqual(['create', 'guard', 'post']);
  });

  it('does not apply a fiscal-period check — a migrated invoice keeps its original period', async () => {
    await commitAPInvoice(COMPANY, USER, AP_INVOICE);

    // 2023-11-14 sits in a long-closed period. Refusing here would block the
    // entire migration, which is why this path diverges from postJournalEntry.
    expect(texts().some((q) => /FROM fiscal_periods/i.test(q))).toBe(false);
    expect(statusWrites()).toHaveLength(1);
  });
});
