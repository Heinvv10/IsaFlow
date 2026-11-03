/**
 * PR S review (breaker): refusing to leave never surfaces as an error. A push or replace the guard cancels resolves
 * false (no unhandled rejection, so no Sentry event and no dev overlay). Back and forward are refused before history
 * moves when the user keeps an unsaved change. And the edit page opened on another invoice in place starts again: no
 * PUT for the second invoice's load.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, description, puts, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';

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

describe('leaving with a change unsaved', () => {
  it('a refused push resolves false instead of rejecting, and asks once', async () => {
    await openDirty();
    await expect(h.router!.push('/elsewhere')).resolves.toBe(false);
    await expect(h.router!.replace('/elsewhere')).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('a refused back or forward stays on the invoice and asks once', async () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    await openDirty();
    expect(h.pop!({ url: '/x', as: '/x', options: {} })).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('a confirmed back or forward passes its own route change without a second question', async () => {
    await openDirty();
    confirm.mockReturnValue(true);
    expect(h.pop!({ url: '/x', as: '/x', options: {} })).toBe(true);
    expect(() => h.router!.events.emit('routeChangeStart', '/x')).not.toThrow();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('held invalid input cannot be discarded by Back without confirmation', async () => {
    await openDirty();
    type(description(), ''); // priced line without a description: changed, but autosave is held
    expect(h.pop!({ url: '/x', as: '/x', options: {} })).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(puts()).toHaveLength(0);
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
