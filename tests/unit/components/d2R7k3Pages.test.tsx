// D2 round 7 (k3): a refused write / failed load on these pages is SAID, never dropped (gate class g).
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoRawError, ok, refuse, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
const route = vi.hoisted(() => ({ query: {} as Record<string, string>, asPath: '/', isReady: true, push: vi.fn(), replace: vi.fn() }));
const logs = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: logs }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/RecordNavigation', () => ({ RecordNavigation: () => null }));
vi.mock('@/components/accounting/items/BundleEditor', () => ({ BundleEditor: () => null }));
vi.mock('@/components/practice/ClientRateOverrides', () => ({ ClientRateOverrides: () => null }));
vi.mock('@/components/accounting/reports/FavouriteButton', () => ({ FavouriteButton: () => null }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));
vi.mock('@/hooks/useReportFavourites', () => ({ useReportFavourites: () => ({ favourites: [] }) }));

import { apiFetch } from '@/lib/apiFetch';
import SuppliersImportPage from '../../../pages/accounting/migration/suppliers';
import OpeningBalancesPage from '../../../pages/accounting/migration/opening-balances';
import ItemDetailPage from '../../../pages/accounting/items/[itemId]';
import PracticeClientDetailPage from '../../../pages/accounting/practice/clients/[id]';
import PayPackagesPage from '../../../pages/payroll/pay-packages/index';
import ReportsHubPage from '../../../pages/accounting/reports/index';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); Object.values(logs).forEach(f => f.mockClear()); route.query = {}; });
afterEach(() => { cleanup(); });

const csv = (container: HTMLElement) => fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement,
  { target: { files: [new File(['name\nD2 Supplier\n'], 's.csv', { type: 'text/csv' })] } });
const downloads = () => {
  const create = vi.fn(() => 'blob:x'); const revoke = vi.fn();
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
  return create;
};

describe('migration/suppliers: the session route replies { session: row | null }', () => {
  const run = async (session: () => Response) => {
    script(u => (u.includes('/migration/session') ? session() : u.includes('/migration/suppliers') ? ok({ succeeded: 7, failed: 0, skipped: 0 }) : undefined));
    const { container } = render(<SuppliersImportPage />);
    csv(container);
    fireEvent.click(await screen.findByRole('button', { name: /Import 1 Suppliers/ }));
  };
  const posts = () => vi.mocked(apiFetch).mock.calls.filter(([u, i]) => String(u).includes('/migration/suppliers') && i?.method === 'POST').length;
  it('session present: the import proceeds', async () => {
    await run(() => ok({ session: { id: 's-1' } }));
    expect(await screen.findByText(/Imported 7 suppliers/)).toBeTruthy(); expect(posts()).toBe(1);
  });
  it('{ session: null }: says to start one, imports nothing', async () => {
    await run(() => ok({ session: null }));
    expect(await screen.findByText('No active migration session - start one from the migration hub')).toBeTruthy(); expect(posts()).toBe(0);
  });
  it('template download 400 shows the server message; empty 500 a sentence; 200 downloads', async () => {
    script(u => (u.includes('/templates') ? refuse() : undefined));
    const { unmount } = render(<SuppliersImportPage />);
    fireEvent.click(screen.getByRole('button', { name: /Download CSV Template/ }));
    expect(await screen.findByText(MSG)).toBeTruthy(); unmount();
    script(u => (u.includes('/templates') ? empty500() : undefined));
    render(<SuppliersImportPage />);
    fireEvent.click(screen.getByRole('button', { name: /Download CSV Template/ }));
    expect(await screen.findByText('Could not download the template - try again')).toBeTruthy(); expectNoRawError();
  });
});

describe('migration/opening-balances downloadTemplate (was a dead button)', () => {
  const click = () => fireEvent.click(screen.getByRole('button', { name: /Download CSV Template/ }));
  it('400: the server message', async () => {
    script(u => (u.includes('/templates') ? refuse() : undefined)); render(<OpeningBalancesPage />); click();
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('empty 500: a plain sentence', async () => {
    script(u => (u.includes('/templates') ? empty500() : undefined)); render(<OpeningBalancesPage />); click();
    expect(await screen.findByText('Could not download the template - try again')).toBeTruthy(); expectNoRawError();
  });
  it('200: the file is offered and no error shows', async () => {
    const create = downloads();
    script(u => (u.includes('/templates') ? new Response('a,b', { status: 200 }) : undefined)); render(<OpeningBalancesPage />); click();
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(screen.queryByText(/Could not download/)).toBeNull();
  });
});

describe('items/[itemId] bundle switch off', () => {
  const ITEM = { id: 'i1', code: 'A', description: 'Item A', is_bundle: true, is_active: true, created_at: '2026-01-01' };
  const open = async (del: () => Response) => {
    route.query = { itemId: 'i1' };
    script((u, m) => (m === 'DELETE' ? del() : u.includes('/items?id=') ? ok(ITEM) : undefined));
    render(<ItemDetailPage />);
    fireEvent.click(await screen.findByRole('switch'));
  };
  it('400: the server message shows and the item stays a bundle', async () => {
    await open(refuse);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });
  it('empty 500: a plain sentence, switch usable again', async () => {
    await open(empty500);
    expect(await screen.findByText('Could not remove the bundle components - try again')).toBeTruthy(); expectNoRawError();
    await waitFor(() => expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false));
  });
  it('200: the switch turns off with no error', async () => {
    await open(() => ok({}));
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false'));
    expect(screen.queryByText(/Could not remove/)).toBeNull();
  });
});

describe('practice/clients/[id] contacts load', () => {
  const CLIENT = { id: 'c1', legalName: 'D2 Legal', tradingName: null, registrationNo: null, taxNo: null, billingModel: 'hourly', status: 'active', clientGroupId: null };
  const open = async (contacts: () => Response) => {
    route.query = { id: 'c1' };
    script(u => (u.includes('client-contacts') ? contacts() : ok(CLIENT)));
    render(<PracticeClientDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Contacts/ }));
  };
  it('400: the server message, not "No contacts yet"', async () => {
    await open(refuse);
    expect(await screen.findByText(MSG)).toBeTruthy(); expect(screen.queryByText('No contacts yet')).toBeNull();
  });
  it('empty 500: a plain sentence, the client page still renders', async () => {
    await open(empty500);
    expect(await screen.findByText('Could not load the contacts - try again')).toBeTruthy(); expectNoRawError();
    expect(screen.getAllByText('D2 Legal').length).toBeGreaterThan(0);
  });
  it('200: the contacts are listed', async () => {
    await open(() => ok([{ id: 'k1', name: 'D2 Contact', email: null, phone: null, role: null, isPrimary: false }]));
    expect(await screen.findByText('D2 Contact')).toBeTruthy();
  });
});

describe('payroll/pay-packages', () => {
  const PKG = { id: 'p1', code: 'PK1', name: 'D2 Package', description: null, isActive: true };
  it('load 400 / empty 500: the message or a sentence, list cleared', async () => {
    script(() => refuse()); const { unmount } = render(<PayPackagesPage />);
    expect(await screen.findByText(MSG)).toBeTruthy(); unmount();
    script(() => empty500()); render(<PayPackagesPage />);
    expect(await screen.findByText('Could not load packages - try again')).toBeTruthy(); expectNoRawError();
  });
  const create = async (post: () => Response, list: () => Response) => {
    script((_u, m) => (m === 'POST' ? post() : list()));
    render(<PayPackagesPage />);
    await screen.findByText('D2 Package');
    fireEvent.change(screen.getByPlaceholderText(/code/i), { target: { value: 'PK2' } });
    fireEvent.change(screen.getByPlaceholderText(/^name/i), { target: { value: 'Two' } });
    fireEvent.click(screen.getByRole('button', { name: /Create package/ }));
  };
  it('create 400: the server message; empty 500: a sentence (was "Create failed")', async () => {
    await create(refuse, () => ok([PKG])); expect(await screen.findByText(MSG)).toBeTruthy(); cleanup();
    await create(empty500, () => ok([PKG])); expect(await screen.findByText('Could not create the package - try again')).toBeTruthy(); expectNoRawError();
  });
  it('good create whose reload fails: the failure is shown, the stale list is cleared, the button is free', async () => {
    let posted = false;
    script((_u, m) => { if (m === 'POST') { posted = true; return ok({}); } return posted ? empty500() : ok([PKG]); });
    render(<PayPackagesPage />);
    await screen.findByText('D2 Package');
    fireEvent.change(screen.getByPlaceholderText(/code/i), { target: { value: 'PK2' } });
    fireEvent.change(screen.getByPlaceholderText(/^name/i), { target: { value: 'Two' } });
    fireEvent.click(screen.getByRole('button', { name: /Create package/ }));
    expect(await screen.findByText('Could not load packages - try again')).toBeTruthy();
    expect(screen.queryByText('D2 Package')).toBeNull();
  });
});

describe('reports hub: show-descriptions preference (convenience prefill)', () => {
  it('a failing preference load is logged and the hub still renders with descriptions off', async () => {
    script(() => empty500()); render(<ReportsHubPage />);
    await waitFor(() => expect(logs.warn).toHaveBeenCalledWith('Could not load the show-descriptions pref', { status: 500 }, 'ReportsHub'));
    expect(screen.getByRole('button', { name: /Descriptions/ }).getAttribute('aria-pressed')).toBe('false');
  });
  it('a good preference load switches descriptions on, nothing logged', async () => {
    script(() => ok({ report_show_descriptions: 'true' })); render(<ReportsHubPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Descriptions/ }).getAttribute('aria-pressed')).toBe('true'));
    expect(logs.warn).not.toHaveBeenCalled();
  });
});
