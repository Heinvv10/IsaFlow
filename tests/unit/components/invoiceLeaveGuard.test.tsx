/**
 * PR S review (breaker): refusing to leave never surfaces as an error. A push or replace the guard cancels resolves
 * false (no unhandled rejection, so no Sentry event and no dev overlay). Back and forward with a change autosave will
 * send are not asked: the page goes, and the change being typed is saved as it goes. With a change autosave is HOLDING
 * (a line or date it refuses, a stale-priced draft) nothing would be sent, so Back and forward ask (merge-queue gate,
 * round eleven): Leave drops it knowingly; Stay keeps the page and puts its history entry back. And the edit page
 * opened on another invoice in place starts again: no PUT for the second invoice's load.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, description, puts, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';

type PopState = (s: { url: string; as: string; options: object }) => boolean;
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
  window.confirm = confirm as unknown as typeof window.confirm;
});
afterEach(() => { cleanup(); vi.useRealTimers(); window.confirm = original; vi.mocked(apiFetch).mockReset(); vi.restoreAllMocks(); h.pop = null; });

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

  it('a change autosave is holding: Back asks; Stay keeps the page and the change, and puts this page\'s history entry back', async () => {
    window.history.replaceState({ key: 'edit-entry', as: '/accounting/customer-invoices/edit/inv-1' }, '', '/accounting/customer-invoices/edit/inv-1');
    await openHeld();
    window.history.replaceState({ key: 'previous-entry' }, '', '/accounting/customer-invoices/inv-1'); // the browser has moved
    const pushState = vi.spyOn(window.history, 'pushState');
    expect(h.pop!({ url: '/x', as: '/x', options: {} })).toBe(false); // Next does not change the route
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(pushState).toHaveBeenCalledWith({ key: 'edit-entry', as: '/accounting/customer-invoices/edit/inv-1' }, '', 'http://localhost:3000/accounting/customer-invoices/edit/inv-1');
    expect((screen.getAllByLabelText('Quantity')[0] as HTMLInputElement).value).toBe('0'); // nothing lost
    expect(() => h.router!.events.emit('routeChangeStart', '/elsewhere')).toThrow(/unsaved/i); // no pass was left behind
  });

  it('a change autosave is holding: Back asks; Leave goes, sends nothing, and is not asked again', async () => {
    confirm.mockReturnValue(true);
    await openHeld();
    expect(h.pop!({ url: '/x', as: '/x', options: {} })).toBe(true);
    expect(() => h.router!.events.emit('routeChangeStart', '/x')).not.toThrow();
    expect(confirm).toHaveBeenCalledTimes(1);
    cleanup();
    await advance(0);
    expect(puts()).toHaveLength(0);
  });

  it('Leave on Back is "Leave without them", as on a link: a PUT still out for an earlier change is let go too', async () => {
    confirm.mockReturnValue(true);
    let signal: AbortSignal | null = null;
    serveInvoice((u, init) => {
      if (!u.includes('customer-invoices-detail') || init?.method !== 'PUT') return undefined;
      signal = init.signal as AbortSignal;
      return new Promise<Response>((_r, reject) => { signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))); });
    });
    render(<EditPage />);
    await advance(0);
    await advance(0);
    type(description(), 'Sent, still out');
    await advance(1_500);
    expect(puts()).toHaveLength(1);
    type(screen.getAllByLabelText('Quantity')[0]!, '0'); // held
    await advance(0);
    expect(h.pop!({ url: '/x', as: '/x', options: {} })).toBe(true);
    expect(signal?.aborted).toBe(true);
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
