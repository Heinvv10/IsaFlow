/**
 * D2 round 7 (k2): capture inbox, currencies, utilisation report, customer migration template, pay package editor.
 * REAL assertOk / apiErrorMessage over the scripted apiFetch. Each case is RED on the pre-fix page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, empty500, noRawText, ok, route } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'pk-1' }, isReady: true, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/currencies/CurrencyList', () => ({ CurrencyList: () => <div>currency list</div> }));
vi.mock('@/components/accounting/currencies/ExchangeRatesPanel', () => ({ ExchangeRatesPanel: () => <div>rates panel</div> }));

import InboxPage from '../../../pages/accounting/capture/inbox';
import CurrenciesPage from '../../../pages/accounting/currencies/index';
import UtilisationPage from '../../../pages/accounting/practice/reports/utilisation';
import CustomersImportPage from '../../../pages/accounting/migration/customers';
import PackagePage from '../../../pages/payroll/pay-packages/[id]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

const EVENT = {
  eventId: 'ev-1', receivedAt: '2026-06-01T08:00:00Z', channel: 'email', sender: 'a@b.co', subject: null, status: 'extracted',
  capturedDocumentId: null, error: null, vendorName: 'D2 Vendor', documentDate: null, referenceNumber: 'REF-1', totalAmount: 100,
  documentType: null, extractedData: null,
};

describe('capture inbox', () => {
  const serve = (addr: () => Response, extra: (u: string, m: string) => Response | undefined = () => undefined) =>
    route((u, m) => extra(u, m) ?? (u.includes('inbox-address') ? addr() : ok({ events: [EVENT] })));
  it('a refused address load toasts the server message, not "Failed to load inbox address"', async () => {
    serve(() => bad(400));
    render(<InboxPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Failed to/);
  });
  it('an empty-500 address load toasts a plain sentence', async () => {
    serve(empty500);
    render(<InboxPage />);
    expect(await screen.findByText('Could not load the inbox address - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('an empty-500 events load shows a plain sentence and no rows', async () => {
    route((u) => (u.includes('inbox-address') ? ok({ inbox: null }) : empty500()));
    render(<InboxPage />);
    expect(await screen.findByText('Could not load the inbox - try again')).toBeTruthy();
    expect(screen.queryByText('D2 Vendor')).toBeNull();
  });
  it('a refused post shows the server message', async () => {
    serve(() => ok({ inbox: null }), (u, m) => (m === 'POST' ? bad(400) : undefined));
    render(<InboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Post' }));
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('a good post whose reload fails keeps the success toast and shows the reload error with no stale rows', async () => {
    let posted = false;
    serve(() => ok({ inbox: null }), (u, m) => {
      if (m === 'POST') { posted = true; return ok({ invoice: { invoiceNumber: 'INV-7' } }); }
      if (posted && u.includes('/capture/inbox?') ) return empty500();
      return undefined;
    });
    render(<InboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Post' }));
    expect(await screen.findByText('Invoice INV-7 created')).toBeTruthy();
    expect(await screen.findByText('Could not load the inbox - try again')).toBeTruthy();
    expect(screen.queryByText('D2 Vendor')).toBeNull();
  });
});

describe('currencies', () => {
  const serve = (settings: () => Response) => route((u) => {
    if (u.includes('accounting-settings')) return settings();
    return u.includes('exchange-rates') ? ok([]) : ok([{ code: 'ZAR' }]);
  });
  it('a refused settings read shows the server message instead of a made-up "Reporting: ZAR"', async () => {
    serve(() => bad(403));
    render(<CurrenciesPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText(/Reporting: ZAR/)).toBeNull();
    expect(screen.queryByText('currency list')).toBeNull();
  });
  it('an empty-500 settings read shows a plain sentence', async () => {
    serve(empty500);
    render(<CurrenciesPage />);
    expect(await screen.findByText('Could not load the reporting currency - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('a 200 shows the stored reporting currency', async () => {
    serve(() => ok({ key: 'reporting_currency', value: 'USD' }));
    render(<CurrenciesPage />);
    expect(await screen.findByText(/Reporting: USD/)).toBeTruthy();
    expect(screen.getByText('currency list')).toBeTruthy();
  });
});

describe('utilisation report staff names', () => {
  const serve = (users: () => Response) => route((u) => (u.includes('/practice/users') ? users() : ok([])));
  it('a refused staff-name load shows the server message', async () => {
    serve(() => bad(403));
    render(<UtilisationPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('an empty-500 staff-name load shows a plain sentence', async () => {
    serve(empty500);
    render(<UtilisationPage />);
    expect(await screen.findByText('Could not load the staff names - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('a 200 shows no staff-name error', async () => {
    serve(() => ok([]));
    render(<UtilisationPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelector('.animate-spin')).toBeNull());
    expect(screen.queryByText(/staff names/)).toBeNull();
  });
});

describe('customer migration template download', () => {
  const click = () => fireEvent.click(screen.getByRole('button', { name: /template/i }));
  it('a refused template download shows the server message', async () => {
    route(() => bad(400));
    render(<CustomersImportPage />);
    click();
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('an empty-500 template download shows a plain sentence, not a dead button', async () => {
    route(() => empty500());
    render(<CustomersImportPage />);
    click();
    expect(await screen.findByText('Could not download the template - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('a 200 downloads the file and shows no error', async () => {
    route(() => new Response('a,b\n', { status: 200 }));
    const url = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: url, revokeObjectURL: vi.fn() }));
    render(<CustomersImportPage />);
    click();
    await waitFor(() => expect(url).toHaveBeenCalled());
    expect(screen.queryByText(/Could not download/)).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('pay package editor', () => {
  const PKG = { id: 'pk-1', code: 'PK1', name: 'D2 Package', description: null, isActive: true, components: [] };
  const COMP = [{ id: 'c1', name: 'Basic', sarsSourceCode: '3601', componentType: 'earning', isActive: true }];
  const serve = (pkg: () => Response, comps: () => Response = () => ok(COMP), put: () => Response = () => ok({})) =>
    route((u, m) => (m === 'PUT' ? put() : u.includes('/components') ? comps() : pkg()));
  it('a refused package load shows the server message instead of an endless spinner', async () => {
    serve(() => bad(404));
    render(<PackagePage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText(/Loading package/)).toBeNull();
  });
  it('an empty-500 components load shows a plain sentence and no half-loaded editor', async () => {
    serve(() => ok(PKG), empty500);
    render(<PackagePage />);
    expect(await screen.findByText('Could not load the payroll components - try again')).toBeTruthy();
    expect(screen.queryByText('D2 Package')).toBeNull();
    expect(noRawText()).toBe(true);
  });
  it('a refused save shows the server message and keeps the editor', async () => {
    serve(() => ok(PKG), undefined, () => bad(400));
    render(<PackagePage />);
    fireEvent.click(await screen.findByRole('button', { name: /save components/i }));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByText('D2 Package')).toBeTruthy();
  });
  it('an empty-500 save shows a plain sentence, not "Save failed"', async () => {
    serve(() => ok(PKG), undefined, empty500);
    render(<PackagePage />);
    fireEvent.click(await screen.findByRole('button', { name: /save components/i }));
    expect(await screen.findByText('Could not save the components - try again')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Save failed/);
  });
  it('a good save whose reload fails says it was saved, with no stuck saving flag or unhandled rejection', async () => {
    let saved = false;
    route((u, m) => {
      if (m === 'PUT') { saved = true; return ok({}); }
      if (u.includes('/components')) return ok(COMP);
      return saved ? empty500() : ok(PKG);
    });
    render(<PackagePage />);
    fireEvent.click(await screen.findByRole('button', { name: /save components/i }));
    expect(await screen.findByText(/components were saved but the package could not be reloaded/)).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('a good save reloads and shows no error', async () => {
    serve(() => ok(PKG));
    render(<PackagePage />);
    fireEvent.click(await screen.findByRole('button', { name: /save components/i }));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([u, i]) => String(u).endsWith('/pk-1') && !i?.method).length).toBe(2));
    expect(await screen.findByRole('button', { name: /save components/i })).toBeTruthy();
    expect(screen.queryByText(/Could not|saved but/)).toBeNull();
  });
});
