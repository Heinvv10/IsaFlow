import { describe, expect, it } from 'vitest';
import { pullSageCompany, MAX_CONTACTS_WITH_BALANCES, MAX_OUTSTANDING_INVOICES } from '@/modules/accounting/services/sage/sageApiPullService';
import { SageApiError, type SageApiClient, type SageCompanyClient } from '@/modules/accounting/services/sage/sageApiClient';

function fakeClient(over: Partial<Record<string, unknown>> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const data: Record<string, unknown> = {
    'Company/Get/9': { ID: 9, Name: 'Acme', CurrencySymbol: 'R' },
    'FinancialYear/GetCurrent': { ID: 1, YearStart: '2026-03-01T00:00:00', YearEnd: '2027-02-28T00:00:00', IsCurrentYear: true },
    'Account/GetWithSystemAccounts': [{ ID: -7, Name: 'Trade Receivables', Active: true, AccountType: 2 }],
    'Account/Get': [{ ID: 5, Name: 'Rent', Active: true, AccountType: 1 }, { ID: -7, Name: 'Trade Receivables', Active: true, AccountType: 2 }],
    'BankAccount/Get': [{ ID: 77, Name: 'Cheque' }],
    'TrialBalance/Export': [{ AccountId: 5, Name: 'Rent', Debit: 1, Credit: 0 }],
    'Customer/Get': [{ ID: 1, Name: 'A', Active: true, Balance: 100 }, { ID: 2, Name: 'B', Active: true, Balance: 0 }],
    'Supplier/Get': [{ ID: 3, Name: 'S', Active: true, Balance: 40 }, { ID: 4, Name: 'Overpaid', Active: true, Balance: -5 }],
    'OutstandingCustomerDocument/Get': { TotalResults: 1, ReturnedResults: 1, Results: [{ ID: 10, DocumentNumber: 'INV1', Date: '2026-09-01', Total: 100, AmountDue: 100 }] },
    'OutstandingSupplierDocument/Get': [],
    'TaxInvoice/Get': [{ ID: 10, DocumentNumber: 'INV1', AmountDue: 100, Total: 100 }],
    'SupplierInvoice/Get': [],
    ...over,
  };
  const answer = (path: string) => {
    const v = data[path];
    if (v instanceof Error) throw v;
    return v;
  };
  const company: SageCompanyClient = {
    get: async <T,>(path: string) => { calls.push({ method: 'GET', path }); return answer(path) as T; },
    post: async <T,>(path: string, body: unknown) => { calls.push({ method: 'POST', path, body }); return answer(path) as T; },
    getAll: async <T,>(path: string, query?: Record<string, string>) => { calls.push({ method: 'GETALL', path, body: query }); return answer(path) as T[]; },
  };
  const client: SageApiClient = { listCompanies: async () => [], forCompany: () => company };
  return { client, calls };
}

describe('pullSageCompany', () => {
  it('reads the trial balance from the start of the current financial year to the as-at date', async () => {
    const { client, calls } = fakeClient();
    const pull = await pullSageCompany(client, 9, '2026-10-21');
    expect(pull.financialYearStart).toBe('2026-03-01');
    expect(calls.find((c) => c.path === 'TrialBalance/Export')!.body).toEqual({
      FromDate: '2026-03-01', ToDate: '2026-10-21', ShowMovement: false, DisplayReportingGroupDetail: false, Comparative: false,
    });
    expect(pull.company).toEqual({ id: 9, name: 'Acme', currencySymbol: 'R' });
  });

  it('merges the account lists without duplicates', async () => {
    const pull = await pullSageCompany(fakeClient().client, 9, '2026-10-21');
    expect(pull.accounts.map((a) => a.ID).sort()).toEqual([-7, 5]);
  });

  it('still works when the system-account list is not available', async () => {
    const { client } = fakeClient({ 'Account/GetWithSystemAccounts': new SageApiError('bad_response', 404) });
    const pull = await pullSageCompany(client, 9, '2026-10-21');
    expect(pull.accounts.map((a) => a.ID).sort()).toEqual([-7, 5]);
  });

  it('fetches outstanding documents only for contacts owing / owed money, and accepts paged or bare answers', async () => {
    const { client, calls } = fakeClient();
    const pull = await pullSageCompany(client, 9, '2026-10-21');
    const docCalls = calls.filter((c) => c.path.startsWith('Outstanding'));
    expect(docCalls.map((c) => c.body)).toEqual([
      { CustomerId: 1, IncludePaidInvoices: false },
      { SupplierId: 3, IncludePaidInvoices: false },
    ]);
    expect(pull.customerDocuments[1]![0]!.DocumentNumber).toBe('INV1');
    expect(pull.supplierDocuments[3]).toEqual([]);
  });

  it('refuses a company with more open balances than one pull can read inside Sage\'s limits', async () => {
    const many = Array.from({ length: MAX_CONTACTS_WITH_BALANCES + 1 }, (_, i) => ({ ID: i + 1, Name: `C${i}`, Active: true, Balance: 1 }));
    const { client } = fakeClient({ 'Customer/Get': many });
    await expect(pullSageCompany(client, 9, '2026-10-21')).rejects.toThrow(/file upload/i);
  });

  it('reports progress as it goes', async () => {
    const steps: string[] = [];
    await pullSageCompany(fakeClient().client, 9, '2026-10-21', (s) => steps.push(s));
    expect(steps).toEqual(['company', 'accounts', 'trial_balance', 'customers', 'suppliers', 'documents']);
  });

  // M1: the outstanding lists carry DocumentTypeId, whose values Sage does not
  // document. Which documents are invoices is read from Sage's own invoice
  // lists instead, filtered to what is still owed.
  it('reads the outstanding tax invoices and supplier invoices, to tell invoices from other documents', async () => {
    const { client, calls } = fakeClient();
    const pull = await pullSageCompany(client, 9, '2026-10-21');
    expect(calls.filter((c) => c.path === 'TaxInvoice/Get' || c.path === 'SupplierInvoice/Get').map((c) => [c.path, c.body]))
      .toEqual([['TaxInvoice/Get', { $filter: 'AmountDue gt 0' }], ['SupplierInvoice/Get', { $filter: 'AmountDue gt 0' }]]);
    expect(pull.customerInvoices).toEqual([{ ID: 10, DocumentNumber: 'INV1' }]);
    expect(pull.supplierInvoices).toEqual([]);
  });

  it('skips the invoice lists when no contact owes or is owed anything', async () => {
    const { client, calls } = fakeClient({
      'Customer/Get': [{ ID: 1, Name: 'A', Active: true, Balance: 0 }],
      'Supplier/Get': [{ ID: 3, Name: 'S', Active: true, Balance: 0 }],
    });
    const pull = await pullSageCompany(client, 9, '2026-10-21');
    expect(calls.some((c) => c.path.endsWith('Invoice/Get'))).toBe(false);
    expect(pull.customerInvoices).toEqual([]);
  });

  it('refuses a company with more outstanding invoices than one pull can read', async () => {
    const many = Array.from({ length: MAX_OUTSTANDING_INVOICES + 1 }, (_, i) => ({ ID: i, DocumentNumber: `I${i}`, AmountDue: 1, Total: 1 }));
    await expect(pullSageCompany(fakeClient({ 'TaxInvoice/Get': many }).client, 9, '2026-10-21')).rejects.toThrow(/file upload/i);
  });
});
