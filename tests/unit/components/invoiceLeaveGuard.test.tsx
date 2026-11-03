/**
 * PR S review (breaker): refusing to leave never surfaces as an error. A push or replace the guard cancels resolves
 * false (no unhandled rejection, so no Sentry event and no dev overlay). Back and forward with a change autosave will
 * send are not asked: the page goes, and the change being typed is saved as it goes. With a change autosave is HOLDING
 * (a line or date it refuses, a stale-priced draft) nothing would be sent, so Back and forward ask (merge-queue gate,
 * round eleven): Leave drops it knowingly; Stay keeps the page and goes back to its own entry with the Navigation
 * API's traverseTo (round twelve: Back, Forward and jumps keep history's order; no Navigation API, no question). And
 * the edit page
 * opened on another invoice in place starts again: no PUT for the second invoice's load.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, description, puts, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';

type PopState = (s: { url: string; as: string; options: object }) => boolean;
/** The Navigation API as the guard reads it: the entry the browser is on, and traverseTo. */
const nav = { currentEntry: { key: 'edit-entry' } as { key: string } | null, traverseTo: vi.fn() };
/** The browser has moved to the entry `key` and fires popstate: Next calls beforePopState. */
const popTo = (key: string) => { nav.currentEntry = { key }; return h.pop!({ url: '/x', as: '/x', options: {} }); };
const h = vi.hoisted(() => ({
  router: null as null | {
    query: Record<string, string>; pathname: string; asPath: string; isReady: boolean;
    events: ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents>;
    push: (url: string) => Promise<boolean>; replace: (url: string) => Promise<boolean>; beforePopState: (cb: PopState) => void;
  },
  pop: null as null | PopState,
}));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => h.router }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));

import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';
import { invoiceSavesSettled } from '@/lib/pendingInvoiceSaves';

useApiJsonOverMock();
let confirm: ReturnType<typeof vi.fn>;
const original = window.confirm;
beforeEach(() => {
  vi.useFakeTimers();
  const events = routerEvents();
  // Next's router: a navigation emits routeChangeStart inside an async change(), so a throwing listener rejects push.
  const navigate = async () => { events.emit('routeChangeStart', '/elsewhere'); return true; };
  h.router = { query: { invoiceId: 'inv-1' }, pathname: '/accounting/customer-invoices/edit/[invoiceId]', asPath: '/accounting/customer-invoices/edit/inv-1',
    isReady: true, events, push: navigate, replace: navigate, beforePopState: (cb) => { h.pop = cb; } };
  confirm = vi.fn(() => false);
  nav.currentEntry = { key: 'edit-entry' }; // this page's own entry
  nav.traverseTo = vi.fn(() => ({ committed: Promise.resolve(), finished: Promise.resolve() }));
  Object.defineProperty(window, 'navigation', { value: nav, configurable: true, writable: true });
  window.confirm = confirm as unknown as typeof window.confirm;
});
afterEach(() => { Object.defineProperty(window, 'navigation', { value: undefined, configurable: true, writable: true }); cleanup(); vi.useRealTimers(); window.confirm = original; vi.mocked(apiFetch).mockReset(); vi.restoreAllMocks(); h.pop = null; });

async function openDirty() {
  serveInvoice();
  render(<EditPage />);
  await advance(0);
  await advance(0);
  type(description(), 'Unsaved');
}

/** A change autosave holds: a line it would not store (quantity 0), so nothing is sent as the page goes. */
async function openHeld() {
  serveInvoice();
  render(<EditPage />);
  await advance(0);
  await advance(0);
  type(screen.getAllByLabelText('Quantity')[0]!, '0');
  await advance(0);
}

describe('leaving with a change unsaved', () => {
  it('a refused push resolves false instead of rejecting, and asks once', async () => {
    await openDirty();
    await expect(h.router!.push('/elsewhere')).resolves.toBe(false);
    await expect(h.router!.replace('/elsewhere')).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('back or forward with a change autosave will send is not asked (history stays intact): nothing written to history, and its route change goes through', async () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    await openDirty();
    expect(h.pop!({ url: '/x', as: '/x', options: {} })).toBe(true);
    expect(() => h.router!.events.emit('routeChangeStart', '/x')).not.toThrow();
    expect(confirm).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('the pass a back/forward gets is for its own route change only: a hash change drops it, and the next push asks', async () => {
    await openDirty();
    expect(h.pop!({ url: '/x#a', as: '/x#a', options: {} })).toBe(true);
    h.router!.events.emit('hashChangeStart', '/x#a');
    expect(() => h.router!.events.emit('routeChangeStart', '/elsewhere')).toThrow(/unsaved/i);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('the change being typed when Back is pressed is saved as the page goes (autosave keeps the work)', async () => {
    await openDirty();
    expect(h.pop!({ url: '/x', as: '/x', options: {} })).toBe(true);
    cleanup(); // Next unmounts the page
    await advance(0);
    expect(puts()).toHaveLength(1);
    expect(bodyOf(puts()[0]!).items[0]!.description).toBe('Unsaved');
  });

  it.each([
    ['Back', 'previous-entry'],
    ['Forward', 'next-entry'],
    ['a two-step jump back', 'two-back-entry'],
  ])('a change autosave is holding: %s asks; Stay goes back to this page\'s own entry with navigation.traverseTo (order kept, nothing pushed)', async (_name, to) => {
    await openHeld();
    const pushState = vi.spyOn(window.history, 'pushState');
    const go = vi.spyOn(window.history, 'go');
    expect(popTo(to)).toBe(false); // Next does not change the route
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(nav.traverseTo).toHaveBeenCalledWith('edit-entry');
    expect(pushState).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(popTo('edit-entry')).toBe(false); // Stay's own move landing back here: not asked, nothing routed
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((screen.getAllByLabelText('Quantity')[0] as HTMLInputElement).value).toBe('0'); // nothing lost
    expect(popTo('previous-entry')).toBe(false); // the next Back asks again
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(() => h.router!.events.emit('routeChangeStart', '/elsewhere')).toThrow(/unsaved/i); // no pass was left behind
  });

  it.each([
    ['no Navigation API at all', () => Object.defineProperty(window, 'navigation', { value: undefined, configurable: true, writable: true })],
    ['no traverseTo', () => { (nav as { traverseTo?: unknown }).traverseTo = undefined; }],
  ])('a change autosave is holding, but the browser has %s: not asked (the move could not be undone exactly)', async (_name, strip) => {
    await openHeld();
    strip();
    expect(h.pop!({ url: '/x', as: '/x', options: {} })).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('a change autosave is holding: Back asks; Leave goes, sends nothing, and is not asked again', async () => {
    confirm.mockReturnValue(true);
    await openHeld();
    expect(popTo('previous-entry')).toBe(true);
    expect(nav.traverseTo).not.toHaveBeenCalled();
    expect(() => h.router!.events.emit('routeChangeStart', '/x')).not.toThrow();
    expect(confirm).toHaveBeenCalledTimes(1);
    cleanup();
    await advance(0);
    expect(puts()).toHaveLength(0);
  });

  it('Leave on Back with a PUT still out for an earlier change: the question says a save is finishing; it is let finish and stays tracked', async () => {
    confirm.mockReturnValue(true);
    let land: (r: Response) => void = () => undefined;
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'PUT' ? new Promise<Response>((r) => { land = r; }) : undefined));
    render(<EditPage />);
    await advance(0);
    await advance(0);
    type(description(), 'Sent, still out');
    await advance(1_500);
    expect(puts()).toHaveLength(1);
    type(screen.getAllByLabelText('Quantity')[0]!, '0'); // held
    await advance(0);
    expect(popTo('previous-entry')).toBe(true);
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/A save is still finishing/));
    let settled = false;
    void invoiceSavesSettled('inv-1').then(() => { settled = true; });
    await advance(0);
    expect(settled).toBe(false);
    land(new Response(JSON.stringify({ success: true, data: { updated: true } }), { status: 200 })); // the server commits it
    await advance(0);
    expect(settled).toBe(true);
    cleanup();
    await advance(0);
    expect(puts()).toHaveLength(1);
  });

  it('nothing unsaved: back is allowed unasked', async () => {
    serveInvoice();
    render(<EditPage />);
    await advance(0);
    await advance(0);
    expect(h.pop!({ url: '/x', as: '/x', options: {} })).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('another invoice opened in place', () => {
  it('starts again: its load sends no PUT', async () => {
    serveInvoice();
    const { rerender } = render(<EditPage />);
    await advance(0);
    await advance(0);
    h.router = { ...h.router!, query: { invoiceId: 'inv-2' }, asPath: '/accounting/customer-invoices/edit/inv-2' };
    rerender(<EditPage />);
    await advance(0);
    await advance(0);
    await advance(5_000);
    expect(puts()).toHaveLength(0);
  });
});
