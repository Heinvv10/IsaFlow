// D2 census group 2a: a non-2xx on the main load shows the server's message (400) or a plain sentence (empty 500),
// never an empty table / raw "Unexpected end of JSON input". The REAL assertOk / apiErrorMessage run over a scripted apiFetch.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, boom, expectNoRawJsonError, ok, script } from '../helpers/d2CensusG2';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, asPath: '/', isReady: true, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
const company = vi.hoisted(() => ({ activeCompany: { id: 'c-1', name: 'Co' } }));  // stable identity: the pages key effects on it
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));
vi.mock('@/contexts/TableDensityContext', () => ({ useTableDensity: () => ({ rowClass: '', headerClass: '' }) }));
vi.mock('@/components/accounting/AgingInvoicesPanel', () => ({ AgingInvoicesPanel: () => null }));

import ArAgingPage from '../../../pages/accounting/ar-aging';
import AuditLogPage from '../../../pages/accounting/audit-log';
import BankAccountsPage from '../../../pages/accounting/bank-accounts';
import DuplicatesPage from '../../../pages/accounting/duplicates';
import ItemPricingPage from '../../../pages/accounting/item-pricing';
import RecurringInvoicesPage from '../../../pages/accounting/recurring-invoices';
import JournalEntriesReport from '../../../pages/accounting/reports/journal-entries';
import UnallocatedReceiptsReport from '../../../pages/accounting/reports/unallocated-receipts';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

interface Case { name: string; Page: () => JSX.Element; url: string; data: unknown; seen: string; sentence: RegExp; before?: () => Promise<void> }
const cases: Case[] = [
  { name: 'AR aging', Page: ArAgingPage, url: '/api/accounting/ar-aging',
    data: [{ entityId: 'e1', entityName: 'D2 Debtor Holdings', current: 1, days30: 0, days60: 0, days90: 0, days120Plus: 0, total: 1 }],
    seen: 'D2 Debtor Holdings', sentence: /Could not load AR aging/ },
  { name: 'audit log', Page: AuditLogPage, url: '/api/accounting/audit-log',
    data: { total: 1, items: [{ id: 'a1', companyId: 'c-1', userId: 'u1', userEmail: 'd2.auditor@example.com', action: 'create', entityType: 'invoice', entityId: 'i1', entityRef: 'D2-REF-77', changes: null, ipAddress: null, userAgent: null, sessionId: null, createdAt: '2026-09-01T10:00:00Z' }] },
    seen: 'D2-REF-77', sentence: /Could not load the audit trail/ },
  { name: 'bank accounts', Page: BankAccountsPage, url: '/api/accounting/bank-accounts',
    data: [{ id: 'b1', accountCode: '1100', accountName: 'D2 Cheque Account', isActive: true, txnCount: 0, totalDebits: 0, totalCredits: 0, balance: 0 }],
    seen: 'D2 Cheque Account', sentence: /Could not load bank accounts/ },
  { name: 'duplicates scan', Page: DuplicatesPage, url: '/api/accounting/duplicates',
    data: { duplicates: [{ entityType: 'customer', primary: { id: 'p1', name: 'D2 Primary Customer' }, duplicate: { id: 'p2', name: 'D2 Twin Customer' }, confidence: 90, matchReasons: ['name'] }] },
    seen: 'D2 Primary Customer', sentence: /Could not scan for duplicates/,
    before: async () => { fireEvent.click(await screen.findByRole('button', { name: /Scan for Duplicates/ })); } },
  { name: 'item pricing', Page: ItemPricingPage, url: '/api/accounting/item-pricing',
    data: [{ id: 'i1', item_code: 'D2-CODE', name: 'D2 Widget', category: 'x', uom: 'ea', selling_price: 10, cost_price: 5 }],
    seen: 'D2 Widget', sentence: /Could not load items/ },
  { name: 'recurring invoices', Page: RecurringInvoicesPage, url: '/api/accounting/recurring-invoices',
    data: { items: [{ id: 'r1', templateName: 'D2 Monthly Retainer', clientId: 'c1', frequency: 'monthly', nextRunDate: '2030-01-01', runCount: 0, status: 'active', totalAmount: 100 }] },
    seen: 'D2 Monthly Retainer', sentence: /Could not load recurring invoices/ },
  { name: 'journal entries report', Page: JournalEntriesReport, url: '/api/accounting/reports-journal-entries',
    data: { total: 1, entries: [{ id: 'j1', entryNumber: 'D2-JE-001', entryDate: '2026-09-01', description: 'x', source: 'manual', status: 'posted', totalDebits: 5, totalCredits: 5 }] },
    seen: 'D2-JE-001', sentence: /Could not load the journal report/ },
  { name: 'unallocated receipts', Page: UnallocatedReceiptsReport, url: '/api/accounting/customer-payments',
    data: [{ id: 'p1', paymentNumber: 'D2-RCPT-9', clientName: 'x', date: '2026-09-01', amount: 100, allocatedAmount: 0 }],
    seen: 'D2-RCPT-9', sentence: /Could not load unallocated receipts/ },
];

describe.each(cases)('$name', ({ Page, url, data, seen, sentence, before }) => {
  it('400: shows the server message', async () => {
    script(url, bad);
    render(<Page />);
    await before?.();
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('500 with an empty body: shows a plain sentence, not the JSON parse error', async () => {
    script(url, boom);
    render(<Page />);
    await before?.();
    expect(await screen.findByText(sentence)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('200: renders the data', async () => {
    script(url, () => ok(data));
    render(<Page />);
    await before?.();
    expect((await screen.findAllByText(new RegExp(seen))).length).toBeGreaterThan(0);
    expect(screen.queryByText(MSG)).toBeNull();
  });
});
