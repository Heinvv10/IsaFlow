/**
 * Shared by the PR S autosave and Approve & email tests (master plan wave 3): a router whose `events` work, the
 * invoice the mocked API serves, what the pages sent, and a clock the test moves by hand. The test file still mocks
 * `@/lib/apiFetch`, next/router and the rest itself, so vi.mock can hoist them.
 */
import { act, fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';

type Listener = (...args: unknown[]) => void;

/** next/router's `events`: on, off and emit, with a throwing listener's error reaching the emitter as Next's does. */
export function routerEvents() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on: (name: string, fn: Listener) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
    off: (name: string, fn: Listener) => { listeners.get(name)?.delete(fn); },
    emit: (name: string, ...args: unknown[]) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(...args); },
    count: (name: string) => listeners.get(name)?.size ?? 0,
  };
}

export const DRAFT = {
  id: 'inv-1', invoice_number: 'INV-AUTO', status: 'draft', client_id: 'c-1', invoice_date: '2026-09-15', due_date: '2026-10-15',
  tax_rate: 15, total_amount: 115, notes: '', currency_code: 'ZAR', exchange_rate: 1, client_email: 'billing@client.example', approval: null,
  items: [{ description: 'Consulting', quantity: 1, unit_price: 100, amount: 100 }],
};

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
export const ok = (data: unknown) => json(200, { success: true, data });
export const refused = (status: number, message: string, details?: Record<string, unknown>) =>
  json(status, { success: false, error: { code: status === 409 ? 'CONFLICT' : 'BAD_REQUEST', message, ...(details ? { details } : {}) } });

export type Handler = (url: string, init: RequestInit | undefined) => Promise<Response> | Response | undefined;

/** Serves the draft and the lists; `handler` answers first (return undefined to fall through). */
export function serveInvoice(handler: Handler = () => undefined, invoice: object = DRAFT) {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    const own = await handler(u, init);
    if (own) return own;
    if (u.includes('customer-invoices-detail') && init?.method === 'PUT') return ok({ updated: true });
    if (u.includes('customer-invoices-detail') && init?.method === 'POST') return ok({ id: 'inv-1', status: 'approved' });
    if (u.includes('customer-invoices-create')) return json(201, { success: true, data: { id: 'inv-1', invoiceNumber: 'INV-AUTO' } });
    if (u.includes('customers?id=')) return ok({ id: 'c-1', name: 'Client' });
    if (u.includes('customers')) return ok([{ id: 'c-1', name: 'Client' }]);
    if (u.includes('customer-invoices-detail')) return ok(invoice);
    return ok([]);
  });
}

export const calls = (pattern: string, method?: string) => vi.mocked(apiFetch).mock.calls.filter(([u, init]) =>
  String(u).includes(pattern) && (method === undefined || (init?.method ?? 'GET') === method));
export const puts = () => calls('customer-invoices-detail', 'PUT');
export const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown> & { items: { description: string; unitPrice: number }[]; taxRate: number };

/** Moves the faked clock and lets every promise it releases settle. */
export const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

export const description = (i = 0) => screen.getAllByPlaceholderText('Item description')[i] as HTMLInputElement;
export const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
/** A kit Select with the clock stopped: open it, click the option. */
export async function pick(label: string, option: RegExp) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  await advance(0);
  fireEvent.click(screen.getByRole('option', { name: option }));
  await advance(0);
}
