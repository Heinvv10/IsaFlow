/** Current Sage AP adapter forwarding only. Actual inactive/closed-period accounting and
 * historical source approval are verified in apCiInvoiceCancellation/apCiHistoricalIngress PG.
 * The legacy admin ingress has no saved historical authority contract; that capability remains
 * explicit follow-up, never an unconditional raw SQL posted-status exception.
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
const approveSupplierInvoice = vi.fn(async () => ({ id: 'si-1' }));
const createSupplierInvoice = vi.fn(async () => ({ id: 'si-1' }));
const assertNoInactiveAccountLines = vi.fn(async () => undefined);

vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  createJournalEntry: (...a: unknown[]) => createJournalEntry(...(a as [])),
  resolveUserUuid: vi.fn(async (u: string) => u),
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({
  createSupplierInvoice: (...a: unknown[]) => createSupplierInvoice(...(a as [])),
  approveSupplierInvoice: (...a: unknown[]) => approveSupplierInvoice(...(a as [])),
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
  approveSupplierInvoice.mockResolvedValue({ id: 'si-1' });
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

describe('commitAPInvoice delegates to the controlled supplier invoice service', () => {
  it('preserves original dates and exact invoice/tax inputs before shared approval', async () => {
    await commitAPInvoice(COMPANY, USER, AP_INVOICE);
    expect(createSupplierInvoice).toHaveBeenCalledWith(COMPANY, expect.objectContaining({
      invoiceNumber:'SI-2023-114',invoiceDate:'2023-11-14',dueDate:'2023-12-14',taxRate:15,
      items:[{description:'PO-9912',quantity:1,unitPrice:1000,taxRate:15}],
    }), USER);
    expect(approveSupplierInvoice).toHaveBeenCalledWith(COMPANY,'si-1',USER);
    expect(statusWrites()).toHaveLength(0);
  });
  it('propagates current shared inactive-account refusal without a direct posted-status write', async () => {
    approveSupplierInvoice.mockRejectedValue(new Error('Cannot post to deactivated GL account'));
    await expect(commitAPInvoice(COMPANY,USER,AP_INVOICE)).rejects.toThrow('deactivated');
    expect(statusWrites()).toHaveLength(0);expect(createJournalEntry).not.toHaveBeenCalled();
  });
  it('creates the supplier document before requesting its real shared approval boundary', async () => {
    const order:string[]=[];
    createSupplierInvoice.mockImplementation(async()=>{order.push('document');return{id:'si-1'};});
    approveSupplierInvoice.mockImplementation(async()=>{order.push('shared-approval');return{id:'si-1'};});
    await commitAPInvoice(COMPANY,USER,AP_INVOICE);
    expect(order).toEqual(['document','shared-approval']);expect(createJournalEntry).not.toHaveBeenCalled();
    expect(statusWrites()).toHaveLength(0);
  });
  it('does not invent a closed-period exemption or swallow its shared refusal', async () => {
    approveSupplierInvoice.mockRejectedValue(new Error('Closed fiscal period'));
    await expect(commitAPInvoice(COMPANY,USER,AP_INVOICE)).rejects.toThrow('Closed fiscal period');
    expect(approveSupplierInvoice).toHaveBeenCalledWith(COMPANY,'si-1',USER);
    expect(statusWrites()).toHaveLength(0);
  });
});
