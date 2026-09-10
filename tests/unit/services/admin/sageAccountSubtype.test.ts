/**
 * The Sage commit path dropped `account_subtype` on the floor: the insert
 * never named the column, and Sage's own category (Cost of Sales vs
 * Expenses) was not even carried on `MappedAccount`. This maps it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({
  sql: Object.assign((...a: unknown[]) => sqlMock(...a), { unsafe: (s: string) => s }),
  withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
  withTransaction: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({ createJournalEntry: vi.fn(), resolveUserUuid: vi.fn(async (u: string) => u) }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({ createSupplierInvoice: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccount: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({ assertNoInactiveAccountLines: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerPaymentAllocationService', () => ({ postCustomerInvoiceToGL: vi.fn() }));

import { sageAccountSubtype } from '@/modules/admin/services/sageAccountSubtype';
import { commitSageMigration } from '@/modules/admin/services/sageMigrationOrchestrator';

const CO = '4a159669-2f50-46b5-a7b8-2e94dab3d495';

describe('sageAccountSubtype', () => {
  it('bands expenses by Sage category', () => {
    expect(sageAccountSubtype('expense', 'Cost of Sales', 'Direct Material')).toBe('cost_of_sales');
    expect(sageAccountSubtype('expense', 'Expenses', 'Rent')).toBe('operating_expense');
  });
  it('falls back to the Sage code suffix Velocity carries in the account name', () => {
    expect(sageAccountSubtype('expense', undefined, 'COS - Direct Material - EX2001')).toBe('cost_of_sales');
    expect(sageAccountSubtype('expense', undefined, 'Salaries & Wages - EX4000')).toBe('operating_expense');
    expect(sageAccountSubtype('expense', undefined, 'Bank Charges - EX5006')).toBe('operating_expense');
  });
  it('a category the extension sends does not switch the name recovery off', () => {
    // The category is unvalidated payload; "Expenses" on every row must not
    // re-band Velocity's direct costs as operating expense.
    expect(sageAccountSubtype('expense', 'Expenses', 'COS - Sub-Contractors - EX2005')).toBe('cost_of_sales');
    expect(sageAccountSubtype('expense', 'Cost of Sale', 'Direct Material - EX2001')).toBe('cost_of_sales');
    expect(sageAccountSubtype('expense', 'Expenses', 'Cosmetic repairs')).toBe('operating_expense');
  });
  it('bands every revenue line as revenue', () => {
    expect(sageAccountSubtype('revenue', 'Sales', 'Contract Revenue - IN1008')).toBe('revenue');
    expect(sageAccountSubtype('revenue', 'Other Income', 'Interest Received')).toBe('revenue');
  });
  it('leaves balance-sheet accounts alone', () => {
    expect(sageAccountSubtype('asset', 'Bank', 'FNB Cheque')).toBeNull();
    expect(sageAccountSubtype('liability', undefined, 'VAT')).toBeNull();
  });
});

describe('commitSageMigration', () => {
  beforeEach(() => { sqlMock.mockReset(); sqlMock.mockResolvedValue([{ id: 'acc-1' }]); });

  it('writes the mapped subtype into gl_accounts', async () => {
    await commitSageMigration({
      companyId: CO, userId: 'u1',
      pulled: { accounts: { records: [
        { accountCode: 'EX2001', accountName: 'COS - Direct Material - EX2001', accountType: 'expense', normalBalance: 'debit', category: 'Cost of Sales' },
        { accountCode: 'B1', accountName: 'FNB Cheque', accountType: 'asset', normalBalance: 'debit' },
      ] } },
    });
    const inserts = sqlMock.mock.calls.filter(c => (c[0] as TemplateStringsArray).join('').includes('INSERT INTO gl_accounts'));
    expect(inserts).toHaveLength(2);
    expect((inserts[0]![0] as TemplateStringsArray).join('?')).toContain('account_subtype');
    expect(inserts[0]).toContain('cost_of_sales');
    expect(inserts[1]).toContain(null);
  });
});
