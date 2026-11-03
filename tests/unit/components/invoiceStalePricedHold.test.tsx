/**
 * PR S round seven, the edit page:
 * - a draft whose stored total its lines no longer price to (as loaded) is never repriced by autosave (a notes typo
 *   would reprice it and stale an approval): autosave holds and says why; only Save Changes, or a change to the
 *   pricing itself, reprices it. A consistent draft is never held. WIP lines keep their time-entry links.
 * - a STALE_VIEW refusal reaches the reloaded page in memory, not through sessionStorage.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, calls, DRAFT, puts, refused, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));

import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.mocked(apiFetch).mockReset(); sessionStorage.clear(); });

const settle = async () => { for (let i = 0; i < 8; i++) await advance(0); };
const statusText = () => screen.getAllByRole('status').map((e) => e.textContent).join(' | ');
const QUOTED = { ...DRAFT, tax_rate: 15, total_amount: 1000, items: [{ description: 'Quoted work', quantity: 1, unit_price: 1000, amount: 1000, tax_rate: 0 }] };
const WIP = { ...DRAFT, tax_rate: 15, total_amount: 115, items: [{ description: 'Time 1', quantity: 3, unit_price: 33.33, amount: 99.99, time_entry_id: 'te-1' }] };

describe('a stale-priced draft and autosave', () => {
  it('a notes edit is held, saying why; Save Changes reprices', async () => {
    serveInvoice(undefined, QUOTED);
    render(<EditPage />);
    await settle();
    type(screen.getByLabelText('Notes'), 'A typo');
    await advance(5_000);
    expect(puts()).toHaveLength(0);
    expect(statusText()).toMatch(/Not saved: .*Save Changes reprices it/);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await settle();
    expect(puts()).toHaveLength(1);
  });

  it('a WIP draft: each line\'s time-entry link is sent back with it (the server keeps it), and the card does not warn of losing them', async () => {
    serveInvoice(undefined, { ...WIP, total_amount: 114.99 });
    render(<EditPage />);
    await settle();
    expect(screen.queryByText(/time entries/)).toBeNull();
    type(screen.getByLabelText('Notes'), 'A notes edit');
    await advance(1_500);
    expect(puts()).toHaveLength(1);
    expect(bodyOf(puts()[0]!).items[0]).toMatchObject({ description: 'Time 1', timeEntryId: 'te-1' });
  });

  it('no WIP links: the card does not mention them', async () => {
    serveInvoice(undefined, QUOTED);
    render(<EditPage />);
    await settle();
    expect(screen.getByText(/Stored total/)).toBeTruthy();
    expect(screen.queryByText(/time entries/)).toBeNull();
  });
});

describe('staleness is decided at load', () => {
  it('a consistent draft whose quantity changes is autosaved and approved: the user\'s own change is not "stale"', async () => {
    serveInvoice();
    render(<EditPage />);
    await settle();
    type(screen.getAllByLabelText('Quantity')[0]!, '2');
    await advance(1_500);
    expect(puts()).toHaveLength(1);
    expect(screen.queryByText(/Stored total/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    expect(calls('customer-invoices-detail', 'POST')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Email Invoice' })).toBeTruthy();
  });

  it('a stale-priced draft whose pricing the user changes is held no more: the change reprices it', async () => {
    serveInvoice(undefined, QUOTED);
    render(<EditPage />);
    await settle();
    type(screen.getAllByLabelText('Quantity')[0]!, '2');
    await advance(1_500);
    expect(puts()).toHaveLength(1);
  });
});

describe('a STALE_VIEW refusal', () => {
  it('reaches the reloaded page in memory; nothing is left in sessionStorage', async () => {
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'POST' ? refused(409, 'Changed elsewhere', { reason: 'STALE_VIEW' }) : undefined));
    render(<EditPage />);
    await settle();
    const setItem = vi.spyOn(sessionStorage, 'setItem');
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    expect(screen.getByText('Changed elsewhere')).toBeTruthy();
    expect(setItem).not.toHaveBeenCalled();
  });
});
