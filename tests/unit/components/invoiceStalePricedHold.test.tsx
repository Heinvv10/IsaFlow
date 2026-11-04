/**
 * PR S rounds seven to nine, the edit page:
 * - a draft whose stored total its lines no longer price to (as loaded) is never repriced by autosave (a notes typo
 *   would reprice it and stale an approval): autosave holds and says why; only Save Changes, or a change to the
 *   pricing itself, reprices it. A consistent draft is never held. WIP lines keep their time-entry links.
 * - staleness belongs to one load: a later load of the same invoice (opened again, or reloaded) decides it afresh.
 * - a STALE_VIEW refusal reaches the reloaded page in memory, not through sessionStorage.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, calls, description, DRAFT, ok, puts, refused, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ query: { invoiceId: 'inv-1' } as Record<string, string>, events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));

import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); h.query = { invoiceId: 'inv-1' }; sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.mocked(apiFetch).mockReset(); sessionStorage.clear(); });

const settle = async () => { for (let i = 0; i < 8; i++) await advance(0); };
const card = () => screen.queryByText(/Stored total/);
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

  it('a consistent WIP draft: a notes autosave sends each line\'s time-entry link back with it (the server keeps it)', async () => {
    serveInvoice(undefined, { ...WIP, total_amount: 114.99 });
    render(<EditPage />);
    await settle();
    expect(card()).toBeNull(); // consistent: no card, no hold
    type(screen.getByLabelText('Notes'), 'A notes edit');
    await advance(1_500);
    expect(puts()).toHaveLength(1);
    expect(bodyOf(puts()[0]!).items[0]).toMatchObject({ description: 'Time 1', timeEntryId: 'te-1' });
  });

  it('every line carries the timeEntryId key, null when unlinked: a WIP invoice refuses a body without it', async () => {
    serveInvoice(undefined, { ...WIP, total_amount: 114.99 });
    render(<EditPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    type(screen.getAllByPlaceholderText('Item description')[1]!, 'Travel');
    type(screen.getAllByLabelText(/^Unit price/)[1]!, '50');
    await advance(1_500);
    const items = bodyOf(puts().at(-1)!).items as unknown as Record<string, unknown>[];
    expect(items.map((i) => [i.description, i.timeEntryId])).toEqual([['Time 1', 'te-1'], ['Travel', null]]);
    expect(items.every((i) => 'timeEntryId' in i)).toBe(true);
  });

  it('a stale WIP draft: the card shows, without warning of lost links; the hold writes nothing, and Save Changes keeps the link', async () => {
    serveInvoice(undefined, WIP); // stored 115.00; 3 x 33.33 + 15% prices to 114.99
    render(<EditPage />);
    await settle();
    expect(card()!.textContent).toMatch(/Stored total R\s?115\.00; these lines price to R\s?114\.99/);
    expect(card()!.textContent).not.toMatch(/time entr|link/i);
    type(screen.getByLabelText('Notes'), 'A notes edit');
    await advance(5_000);
    expect(puts()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await settle();
    expect(puts()).toHaveLength(1);
    expect(bodyOf(puts()[0]!).items[0]).toMatchObject({ description: 'Time 1', timeEntryId: 'te-1' });
  });

  it('no WIP links: the card shows, and does not mention them', async () => {
    serveInvoice(undefined, QUOTED);
    render(<EditPage />);
    await settle();
    expect(card()!.textContent).toMatch(/Stored total R\s?1\s000\.00; these lines price to R\s?1\s150\.00/);
    expect(card()!.textContent).not.toMatch(/time entr|link/i);
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

describe('staleness belongs to one load', () => {
  it('A saved (repriced), then B (still loading), then A again in place: A is not "stale" on the return visit', async () => {
    let saved = false;
    serveInvoice((u, init) => {
      if (u.includes('customer-invoices-detail') && init?.method === 'PUT') { saved = true; return undefined; }
      if (u.includes('customer-invoices-detail?id=inv-2')) return new Promise<Response>(() => undefined); // B never lands
      if (u.includes('customer-invoices-detail?id=inv-1') && saved) return ok({ ...QUOTED, total_amount: 1150 });
      return undefined;
    }, QUOTED);
    const { rerender } = render(<EditPage />);
    await settle();
    expect(card()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await settle();
    expect(puts()).toHaveLength(1);
    for (const id of ['inv-2', 'inv-1']) { h.query = { invoiceId: id }; rerender(<EditPage />); await settle(); }
    expect(description().value).toBe('Quoted work');
    expect(card()).toBeNull();
    type(screen.getByLabelText('Notes'), 'After the reprice');
    await advance(1_500);
    expect(puts()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    expect(calls('customer-invoices-detail', 'POST')).toHaveLength(1);
  });

  it('a STALE_VIEW reload that lands a stale-priced draft holds it: a notes edit is not autosaved (not repriced)', async () => {
    let refusedOnce = false;
    serveInvoice((u, init) => {
      if (u.includes('customer-invoices-detail') && init?.method === 'POST') { refusedOnce = true; return refused(409, 'Changed elsewhere', { reason: 'STALE_VIEW' }); }
      if (u.includes('customer-invoices-detail?id=inv-1') && refusedOnce) return ok({ ...DRAFT, total_amount: 200 }); // same lines, stored 200
      return undefined;
    });
    render(<EditPage />);
    await settle();
    expect(card()).toBeNull(); // consistent as first loaded
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    expect(screen.getByText('Changed elsewhere')).toBeTruthy();
    expect(card()!.textContent).toMatch(/Stored total R\s?200\.00/);
    type(screen.getByLabelText('Notes'), 'A typo');
    await advance(5_000);
    expect(puts()).toHaveLength(0);
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
