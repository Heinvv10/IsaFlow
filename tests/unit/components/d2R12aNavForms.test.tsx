/**
 * D2 round 12: create forms that navigate after the write succeeded (assets, credit notes, items, products,
 * bank reconciliation). The write and the navigation are different failures: a router.push that is pending keeps the
 * button disabled; one that rejects never says the write failed (a retry would create a second record).
 * bank-reconciliation/new had no component test: success, refusal and an empty 500 are covered here too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, envelope, ok } from '../helpers/d2R3a4';
import { pendingNavigationKeepsButtonDisabled, rejectedNavigationIsNotAWriteFailure, type NavCase } from '../helpers/d2R12aNav';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), replace: vi.fn(), isReady: true, pathname: '/' }));
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn, debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1' } }) }));
vi.mock('@/components/accounting/bank/BankAccountSelector', () => ({
  BankAccountSelector: ({ onChange }: { onChange: (id: string) => void }) => <button type="button" onClick={() => onChange('ba1')}>pick account</button>,
}));

import { apiFetch } from '@/lib/apiFetch';
import AssetNewPage from '../../../pages/accounting/assets/new';
import CreditNoteNewPage from '../../../pages/accounting/credit-notes/new';
import ItemsNewPage from '../../../pages/accounting/items/new';
import ProductsNewPage from '../../../pages/accounting/products/new';
import ReconNewPage from '../../../pages/accounting/bank-reconciliation/new';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.push.mockReset(); warn.mockReset(); });
afterEach(() => { cleanup(); });

const isWrite = (init?: RequestInit) => !!init?.method && init.method !== 'GET';
const serveWrite = (data: unknown = { id: 'x1' }, reads: unknown = []) => vi.mocked(apiFetch).mockImplementation(async (_u, init) => (isWrite(init) ? ok(data) : ok(reads)));
const submit = () => fireEvent.submit(document.querySelector('form')!);
const submitButton = () => document.querySelector('button[type="submit"]') as HTMLButtonElement;

const FORMS: Array<{ label: string; Page: () => JSX.Element; failure: RegExp; reads?: unknown; fill?: () => Promise<void> }> = [
  { label: 'assets/new', Page: AssetNewPage, failure: /Could not create the asset/ },
  { label: 'credit-notes/new', Page: CreditNoteNewPage, failure: /Could not create the credit note/, reads: [{ id: 'c1', company_name: 'D2 Customer' }],
    fill: async () => { await screen.findByText('D2 Customer'); fireEvent.change(document.querySelector('select[name="clientId"]')!, { target: { value: 'c1' } }); fireEvent.change(document.querySelector('input[name="subtotal"]')!, { target: { value: '100' } }); } },
  { label: 'items/new', Page: ItemsNewPage, failure: /Could not create the item/ },
  { label: 'products/new', Page: ProductsNewPage, failure: /Could not create the product/ },
];

describe.each(FORMS)('$label navigation after a successful create', ({ Page, failure, reads, fill }) => {
  const nav = (): NavCase => ({
    push: route.push, warn,
    drive: async () => { serveWrite({ id: 'x1' }, reads); render(<Page />); await waitFor(() => expect(submitButton()).toBeTruthy()); await fill?.(); submit(); },
    button: submitButton,
    claimsFailure: () => screen.queryByText(failure) !== null,
  });
  it('a pending navigation keeps the button disabled; a cancelled one releases it', async () => {
    await pendingNavigationKeepsButtonDisabled(nav());
  });
  it('a rejected navigation is logged and does not say the create failed', async () => {
    await rejectedNavigationIsNotAWriteFailure(nav());
  });
});

describe('bank-reconciliation/new', () => {
  const start = () => {
    render(<ReconNewPage />);
    fireEvent.click(screen.getByText('pick account'));
    fireEvent.change(document.querySelector('input[name="statementBalance"]')!, { target: { value: '125' } });
  };
  const posted = () => vi.mocked(apiFetch).mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST');

  it('the button stays disabled until an account is picked', () => {
    render(<ReconNewPage />);
    expect(submitButton().disabled).toBe(true);
  });
  it('success: posts the picked account and balance, then opens the new reconciliation', async () => {
    serveWrite({ id: 'rec-7' });
    start(); submit();
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/bank-reconciliation/rec-7'));
    expect(JSON.parse(String((posted()[0]![1] as RequestInit).body))).toMatchObject({ bankAccountId: 'ba1', statementBalance: 125 });
    expect(screen.queryByText(/Could not start/)).toBeNull();
  });
  it('a refusal shows the server message, stays on the page and re-enables the button', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => envelope());
    start(); submit();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(route.push).not.toHaveBeenCalled();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
  });
  it('an empty 500 shows one plain sentence', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => empty500());
    start(); submit();
    expect(await screen.findByText('Could not start reconciliation - try again')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/JSON|Unexpected end|HTTP \d/);
  });
  const nav = (): NavCase => ({
    push: route.push, warn,
    drive: () => { serveWrite({ id: 'rec-7' }); start(); submit(); },
    button: submitButton,
    claimsFailure: () => screen.queryByText(/Could not start reconciliation/) !== null,
  });
  it('a pending navigation keeps the button disabled; a cancelled one releases it', async () => {
    await pendingNavigationKeepsButtonDisabled(nav());
  });
  it('a rejected navigation does not say the reconciliation failed to start', async () => {
    await rejectedNavigationIsNotAWriteFailure(nav());
  });
});
