/**
 * Master plan wave 4, PR RA: a new invoice line's revenue account is the customer's default (migration 965) until the
 * user picks one. An untouched line and a new line take it, a change of customer moves only those lines, a user's pick
 * is never overwritten, and the tracking flag never reaches the API.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { typeDate } from '../helpers/dateFields';
import { ok } from '../helpers/d2CensusG4';
import { ACME, BARE, fillLine, invoiceDate, pickClient, submitAndWait } from '../helpers/invoiceDefaultsHarness';

const push = vi.hoisted(() => vi.fn());
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push, replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));

import NewPage from '../../../pages/accounting/customer-invoices/new';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); push.mockClear(); vi.mocked(apiFetch).mockReset(); });

const CHART = [
  { id: 'acc-sales', accountCode: '4000', accountName: 'Sales', accountType: 'revenue', isActive: true, parentAccountId: null },
  { id: 'acc-hosting', accountCode: '4100', accountName: 'Hosting', accountType: 'revenue', isActive: true, parentAccountId: null },
  { id: 'acc-consult', accountCode: '4200', accountName: 'Consulting', accountType: 'revenue', isActive: true, parentAccountId: null },
];
const CONTACTS: Record<string, object> = {
  'c-acme': { ...ACME, default_revenue_account_id: 'acc-hosting' },
  'c-other': { ...ACME, default_revenue_account_id: 'acc-consult' },
  'c-bare': BARE,
};

function serve() {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    const id = /customers\?id=([^&]+)/.exec(u)?.[1];
    if (id) return ok({ id, name: id, ...CONTACTS[id] });
    if (u.includes('/customers')) return ok(Object.keys(CONTACTS).map((c) => ({ id: c, name: c })));
    if (u.includes('chart-of-accounts')) return ok(CHART);
    if (u.includes('customer-invoices-create') && init?.method === 'POST') return ok({ id: 'n1' });
    return ok([]);
  });
}

/** What each line's account picker shows. */
const accounts = () => screen.getAllByRole('combobox', { name: 'Revenue account' }).map((c) => c.textContent?.trim() ?? '');
const sentItems = () => {
  const call = vi.mocked(apiFetch).mock.calls.find((c) => String(c[0]).includes('customer-invoices-create'));
  return (JSON.parse(String((call![1] as RequestInit).body)) as { items: Record<string, unknown>[] }).items;
};
/** Pick an account on line `i` (there is one picker per line, so not by label alone). */
const pickAccount = async (i: number, option: string) => {
  fireEvent.click(screen.getAllByRole('combobox', { name: 'Revenue account' })[i]!);
  fireEvent.click(await screen.findByRole('option', { name: option }));
};
const open = async () => {
  serve();
  render(<NewPage />);
  await screen.findByRole('combobox', { name: 'Client' });
  typeDate(invoiceDate(), '1 Oct 2026');
  await waitFor(() => expect(accounts()).toEqual(['Default sales']));
};

describe('the customer\'s default revenue account on a new invoice', () => {
  it('lands on an untouched line, says where it came from, and is sent without its flag', async () => {
    await open();
    fillLine(0, '100'); // typing the description and price does not make the account the user's
    await pickClient('c-acme');
    await waitFor(() => expect(accounts()).toEqual(['4100 Hosting']));
    expect(screen.getByText('from customer')).toBeTruthy();
    await submitAndWait(push);
    expect(sentItems()[0]!.glAccountId).toBe('acc-hosting');
    expect(sentItems()[0]).not.toHaveProperty('accountFromDefault');
  });

  it('a line added after the customer starts on it', async () => {
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(accounts()).toEqual(['4100 Hosting']));
    fireEvent.click(screen.getByRole('button', { name: 'Add Line' }));
    expect(accounts()).toEqual(['4100 Hosting', '4100 Hosting']);
  });

  it('a user\'s pick is never overwritten, and a change of customer moves only the untouched lines', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add Line' }));
    await pickAccount(0, '4000 Sales');
    await waitFor(() => expect(accounts()[0]).toBe('4000 Sales'));
    await pickClient('c-acme');
    await waitFor(() => expect(accounts()).toEqual(['4000 Sales', '4100 Hosting']));
    await pickClient('c-other');
    await waitFor(() => expect(accounts()).toEqual(['4000 Sales', '4200 Consulting']));
    await pickClient('c-bare'); // no default: the untouched line goes back to the company's default sales account
    await waitFor(() => expect(accounts()).toEqual(['4000 Sales', 'Default sales']));
    expect(screen.queryByText('from customer')).toBeNull();
  });

  it('picking "Default sales" is a pick too: the customer does not overwrite it', async () => {
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(accounts()).toEqual(['4100 Hosting']));
    await pickAccount(0, 'Default sales');
    await pickClient('c-other');
    await waitFor(() => expect(screen.queryByText('from customer')).toBeNull());
    expect(accounts()).toEqual(['Default sales']);
  });
});
