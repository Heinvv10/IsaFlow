// D2 census group 2b: a non-2xx on the main load / log fetch shows the server's message (400) or a plain sentence
// (empty 500), never an empty view / raw "Unexpected end of JSON input". REAL assertOk / apiErrorMessage over a scripted apiFetch.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, boom, expectNoRawJsonError, ok, script } from '../helpers/d2CensusG2';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null, refreshUser: vi.fn() }) }));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }) }));
vi.mock('@/components/accounting/my-account/TwoFactorSection', () => ({ TwoFactorSection: () => null }));
vi.mock('@/components/accounting/my-account/ChangeEmailSection', () => ({ ChangeEmailSection: () => null }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/suppliers/ContactsTab', () => ({ ContactsTab: () => null }));
vi.mock('@/components/accounting/suppliers/ActivityTab', () => ({ ActivityTab: () => null }));
vi.mock('@/components/accounting/suppliers/DrcFlagToggle', () => ({ DrcFlagToggle: () => null }));
vi.mock('@/components/accounting/RecordNavigation', () => ({ RecordNavigation: () => null }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/ap/ThreeWayMatchPanel', () => ({ ThreeWayMatchPanel: () => null }));
vi.mock('@/components/accounting/ap/SupplierInvoiceApprovalPanel', () => ({ SupplierInvoiceApprovalPanel: () => null }));
vi.mock('@/components/accounting/sars/MarkVatDeclaredElsewhereButton', () => ({ MarkVatDeclaredElsewhereButton: () => null }));
vi.mock('@/components/invoices/InvoiceActionBar', () => ({ InvoiceActionBar: () => null }));
vi.mock('@/components/invoices/SupplierInvoiceSummary', () => ({ SupplierInvoiceSummary: () => null }));
vi.mock('@/components/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/modules/accounting/hooks/useSupplierInvoiceActions', () => ({ useSupplierInvoiceActions: () => ({ groups: [], overflowActions: [] }) }));
vi.mock('@/components/accounting/group/GroupDetailsTab', () => ({
  GroupDetailsTab: (p: { group: { name: string } | null; members: unknown[]; userCompanies: unknown[] }) => <p>{JSON.stringify({ g: p.group?.name, m: p.members, u: p.userCompanies })}</p>,
}));
vi.mock('@/components/accounting/group/GroupCoaTab', () => ({ GroupCoaTab: (p: { groupAccounts: unknown[] }) => <p>{JSON.stringify(p.groupAccounts)}</p> }));
vi.mock('@/components/accounting/group/GroupMappingTab', () => ({
  GroupMappingTab: (p: { mappings: unknown[]; onCompanyChange: (id: string) => void }) => (
    <div><button onClick={() => p.onCompanyChange('co-1')}>pick company</button><p>{JSON.stringify(p.mappings)}</p></div>
  ),
}));

const router = vi.hoisted(() => ({ query: { invoiceId: 'inv-1', supplierId: 'sup-1' }, asPath: '/', isReady: true, push: vi.fn(), replace: vi.fn() }));

import toast from 'react-hot-toast';
import NewCustomerPaymentPage from '../../../pages/accounting/customer-payments/new';
import MirrorSettingsPage from '../../../pages/accounting/capture/settings/mirror';
import GroupSetupPage from '../../../pages/accounting/group/setup';
import MyAccountPage from '../../../pages/accounting/my-account';
import SupplierInvoiceDetailPage from '../../../pages/accounting/supplier-invoices/[invoiceId]';
import SupplierDetailPage from '../../../pages/accounting/suppliers/[supplierId]';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.mocked(toast.error).mockClear(); });

interface Case { name: string; Page: () => JSX.Element; url: string | ((u: string) => boolean); data: unknown; seen: RegExp; sentence: RegExp; before?: () => Promise<void>; base?: (u: string) => Response }
const grp = (u: string) => (u.includes('action=members') || u.includes('action=accounts') || u.includes('action=mappings') ? ok({ items: [] })
  : u.includes('action=user-companies') ? ok({ items: [] }) : ok({ items: [{ id: 'g1', name: 'D2 Holdings Group' }] }));
const tab = (name: RegExp) => async () => { fireEvent.click(await screen.findByRole('button', { name })); };
const cases: Case[] = [
  { name: 'customer payment: clients', Page: NewCustomerPaymentPage, url: '/api/accounting/customers',
    data: [{ id: 'c1', name: 'D2 Client Pty' }], seen: /D2 Client Pty/, sentence: /Could not load clients/ },
  { name: 'group: group', Page: GroupSetupPage, url: u => u.endsWith('/company-groups'), base: grp,
    data: { items: [{ id: 'g1', name: 'D2 Holdings Group' }] }, seen: /D2 Holdings Group/, sentence: /Could not load the group/ },
  { name: 'group: user companies', Page: GroupSetupPage, url: 'action=user-companies', base: grp,
    data: { items: [{ companyId: 'x1', companyName: 'D2 Subsidiary Co' }] }, seen: /D2 Subsidiary Co/, sentence: /Could not load your companies/ },
  { name: 'group: members', Page: GroupSetupPage, url: 'action=members', base: grp,
    data: { items: [{ id: 'm1', companyName: 'D2 Member Co' }] }, seen: /D2 Member Co/, sentence: /Could not load members/ },
  { name: 'group: chart of accounts', Page: GroupSetupPage, url: 'action=accounts', base: grp, before: tab(/Group Chart of Accounts/),
    data: { items: [{ id: 'a1', accountName: 'D2 Group Revenue' }] }, seen: /D2 Group Revenue/, sentence: /Could not load the group chart of accounts/ },
  { name: 'group: mappings', Page: GroupSetupPage, url: 'action=mappings', base: grp,
    before: async () => { await tab(/COA Mapping/)(); fireEvent.click(await screen.findByRole('button', { name: 'pick company' })); },
    data: { items: [{ id: 'mp1', accountName: 'D2 Mapped Account' }] }, seen: /D2 Mapped Account/, sentence: /Could not load mappings/ },
  { name: 'supplier invoice detail', Page: SupplierInvoiceDetailPage, url: 'supplier-invoices-detail',
    data: { id: 'inv-1', invoiceNumber: 'D2-SINV-42', supplierName: 'D2 Supplier', status: 'approved', items: [] }, seen: /D2-SINV-42/, sentence: /Could not load the invoice/ },
  { name: 'supplier detail', Page: SupplierDetailPage, url: 'suppliers-list',
    data: { id: 'sup-1', name: 'D2 Supplier Trading' }, seen: /D2 Supplier Trading/, sentence: /Could not load the supplier/ },
];

describe.each(cases)('$name', ({ Page, url, data, seen, sentence, before, base }) => {
  it('400: shows the server message', async () => {
    script(url, bad, base);
    render(<Page />);
    await before?.();
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('500 with an empty body: shows a plain sentence, not the JSON parse error', async () => {
    script(url, boom, base);
    render(<Page />);
    await before?.();
    expect(await screen.findByText(sentence)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('200: renders the data', async () => {
    script(url, () => ok(data), base);
    render(<Page />);
    await before?.();
    expect((await screen.findAllByText(seen)).length).toBeGreaterThan(0);
    expect(screen.queryByText(MSG)).toBeNull();
  });
});

describe('my account: profile', () => {
  const profile = (r: () => Response) => script('/api/auth/profile', r, () => ok({}));
  it('400: toasts the server message', async () => {
    profile(bad);
    render(<MyAccountPage />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MSG));
  });
  it('500 with an empty body: toasts a plain sentence, not the JSON parse error', async () => {
    profile(boom);
    render(<MyAccountPage />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not load your profile - try again'));
    expect(vi.mocked(toast.error).mock.calls.flat().join(' ')).not.toMatch(/JSON|Unexpected end/);
  });
  it('200: shows the profile', async () => {
    profile(() => ok({ firstName: 'D2Firstname', lastName: 'L', email: 'e@x.co', phone: '', mobile: '' }));
    render(<MyAccountPage />);
    expect(await screen.findByDisplayValue('D2Firstname')).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('mirror settings: scan log', () => {
  const conn = { id: 'mc1', provider: 'imap', displayName: 'D2 Mirror Inbox', accountEmail: 'm@x.co', status: 'active', folder: 'INBOX', scanIntervalMinutes: 5, allowedSenders: [], deniedSenders: [], messagesIngestedTotal: 0, lastScanAt: null, lastSuccessAt: null, lastError: null };
  const log = (r: () => Response) => script('/log?', r, () => ok({ items: [conn] }));
  const open = async () => { render(<MirrorSettingsPage />); await screen.findByText('D2 Mirror Inbox'); fireEvent.click(screen.getByTitle('Scan log')); };
  it('400: toasts the server message', async () => { log(bad); await open(); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('500 with an empty body: toasts a plain sentence, not the JSON parse error', async () => {
    log(boom); await open();
    expect(await screen.findByText(/Could not load the scan log/)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('200: lists the scan log entries', async () => {
    log(() => ok({ entries: [{ id: 'l1', imap_uid: '1', sender: 's@x.co', subject: 'D2 scanned subject', attachment_count: 1, outcome: 'ingested', error: null, scanned_at: '2026-09-01T10:00:00Z' }] }));
    await open();
    expect(await screen.findByText('D2 scanned subject')).toBeTruthy();
  });
});
