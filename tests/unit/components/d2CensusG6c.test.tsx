// A failed load shows the server's message (400) or a plain sentence (empty 500), never a blank table or a raw JSON error.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { MSG, bad400, empty500, okRes, rawJsonError, router } from '../helpers/d2CensusG6';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AnnouncementModal', () => ({ AnnouncementModal: () => null, EMPTY_FORM: {} }));
vi.mock('@/components/admin/ConfirmModal', () => ({ ConfirmModal: () => null }));
vi.mock('@/components/accounting/time-tracking/TimeEntryModal', () => ({ TimeEntryModal: () => null }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: ({ onChange }: { onChange: (id: string, name: string) => void }) => <button type="button" onClick={() => onChange('sup-1', 'D2 Supplier')}>pick supplier</button>,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import StatementRunPage from '../../../pages/accounting/statement-run/index';
import NewSupplierPaymentPage from '../../../pages/accounting/supplier-payments/new';
import TimesheetsPage from '../../../pages/accounting/timesheets/index';
import AdminAnnouncementsPage from '../../../pages/admin/tools/announcements';

const script = (routes: Array<[string, () => Response]>, fallback: unknown = []) => vi.mocked(apiFetch).mockReset().mockImplementation(router(routes, fallback));
const noRawJson = () => expect(document.body.textContent ?? '').not.toMatch(rawJsonError);
afterEach(() => { cleanup(); });

describe('Statement run customers', () => {
  const SITE = '/api/accounting/customer-statements';
  it('shows the server message on a 400', async () => { script([[SITE, bad400]]); render(<StatementRunPage />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    script([[SITE, empty500]]); render(<StatementRunPage />);
    expect(await screen.findByText('Could not load customers - try again')).toBeTruthy(); noRawJson();
  });
  it('lists the customers on success', async () => {
    script([[SITE, () => okRes({ customers: [{ client_id: 'k1', client_name: 'D2 Statement Customer', total_invoiced: 1, total_paid: 0, total_credits: 0, balance: 1, invoice_count: 1 }] })]]);
    render(<StatementRunPage />);
    expect(await screen.findByText('D2 Statement Customer')).toBeTruthy();
  });
});

describe('New supplier payment outstanding invoices', () => {
  const SITE = '/api/accounting/supplier-invoices';
  const pick = async () => { render(<NewSupplierPaymentPage />); fireEvent.click(screen.getByRole('button', { name: 'pick supplier' })); };
  it('shows the server message on a 400', async () => { script([[SITE, bad400]]); await pick(); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    script([[SITE, empty500]]); await pick();
    expect(await screen.findByText('Could not load outstanding invoices - try again')).toBeTruthy(); noRawJson();
  });
  it('offers the outstanding invoices on success', async () => {
    script([[SITE, () => okRes({ invoices: [{ id: 'b1', invoiceNumber: 'D2-BILL-3', totalAmount: 100, balance: 100 }] })]]);
    await pick();
    expect(await screen.findByRole('option', { name: /D2-BILL-3/ })).toBeTruthy();
  });
});

describe('Timesheets week entries', () => {
  const SITE = '/api/accounting/time-entries';
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  it('shows the server message on a 400', async () => { script([[SITE, bad400]]); render(<TimesheetsPage />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    script([[SITE, empty500]]); render(<TimesheetsPage />);
    expect(await screen.findByText('Could not load entries - try again')).toBeTruthy(); noRawJson();
  });
  it('shows the entries on success', async () => {
    script([[SITE, () => okRes({ entries: [{ id: 'e1', userId: 'u', projectName: null, taskDescription: 'D2 timesheet task', entryDate: today(), hours: 2, rate: null, billable: true, invoiced: false, customerId: null, customerName: null, status: 'draft' }] })]]);
    render(<TimesheetsPage />);
    expect(await screen.findByText('D2 timesheet task')).toBeTruthy();
  });
});

describe('Admin announcements list', () => {
  const SITE = '/api/admin/announcements';
  it('shows the server message on a 400', async () => { script([[SITE, bad400]]); render(<AdminAnnouncementsPage />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    script([[SITE, empty500]]); render(<AdminAnnouncementsPage />);
    expect(await screen.findByText('Could not load announcements - try again')).toBeTruthy(); noRawJson();
  });
  it('lists the announcements on success', async () => {
    script([[SITE, () => okRes({ items: [{ id: 'a1', title: 'D2 Announcement Title', message: 'm', type: 'info', target: 'all', target_ids: [], starts_at: null, ends_at: null, is_dismissible: true }] })]]);
    render(<AdminAnnouncementsPage />);
    expect(await screen.findByText('D2 Announcement Title')).toBeTruthy();
  });
});
