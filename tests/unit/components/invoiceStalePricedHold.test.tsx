/**
 * PR S round seven, the edit page:
 * - a draft whose stored total its lines no longer price to is never repriced by autosave (a notes typo would
 *   reprice it, drop WIP links and stale an approval): autosave holds and says why; only Save Changes reprices. The
 *   card says WIP links are dropped when the draft has them.
 * - a STALE_VIEW refusal reaches the reloaded page in memory, not through sessionStorage.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, DRAFT, puts, refused, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';

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

  it('the card names the WIP links a reprice drops, when the draft has them', async () => {
    serveInvoice(undefined, WIP);
    render(<EditPage />);
    await settle();
    expect(screen.getByText(/drops its links to time entries/)).toBeTruthy();
  });

  it('no WIP links: the card does not mention them', async () => {
    serveInvoice(undefined, QUOTED);
    render(<EditPage />);
    await settle();
    expect(screen.getByText(/Stored total/)).toBeTruthy();
    expect(screen.queryByText(/time entries/)).toBeNull();
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
