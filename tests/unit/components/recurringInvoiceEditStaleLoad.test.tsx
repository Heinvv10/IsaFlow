/**
 * Navigating edit A -> edit B: A's slower list response must not fill B's form, and a save must PUT B's data
 * under B's id. A's "not found" error must not outlive the id change.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { typeDate } from '../helpers/dateFields';

const route = vi.hoisted(() => ({ id: 'ri-A' }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({
  useRouter: () => ({ query: { id: route.id }, push: vi.fn(async () => true), replace: vi.fn(), pathname: '/', isReady: true }),
}));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1', name: 'Co' } }) }));
import { apiFetch } from '@/lib/apiFetch';
import RecurringInvoiceEdit from '../../../pages/accounting/recurring-invoices/[id]';

type Resp = ReturnType<typeof ok>;
const row = (id: string, fee: string) => ({
  id, templateName: `Template ${id}`, clientId: 'c1', frequency: 'monthly',
  nextRunDate: '2026-11-01', endDate: '2026-12-31',
  lineItems: [{ description: fee, quantity: 1, unitPrice: 10 }],
});
let listCalls: Array<(r: Resp) => void> = [];

useApiJsonOverMock();
beforeEach(() => {
  route.id = 'ri-A';
  listCalls = [];
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') return ok({});
    if (!String(url).endsWith('recurring-invoices')) return ok([]);
    return new Promise<Resp>(resolve => { listCalls.push(resolve); });
  });
});
afterEach(cleanup);

const puts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT');

async function openAThenB() {
  const view = render(<RecurringInvoiceEdit />);
  await waitFor(() => expect(listCalls).toHaveLength(1));
  route.id = 'ri-B';
  view.rerender(<RecurringInvoiceEdit />);
  await waitFor(() => expect(listCalls).toHaveLength(2));
}

describe('recurring invoice edit: stale template response', () => {
  it('shows B and PUTs B under id B when A resolves after B', async () => {
    await openAThenB();
    await act(async () => { listCalls[1]!(ok({ items: [row('ri-A', 'Fee A'), row('ri-B', 'Fee B')] })); });
    await screen.findByDisplayValue('Fee B');
    await act(async () => { listCalls[0]!(ok({ items: [row('ri-A', 'Fee A')] })); });
    expect(screen.queryByDisplayValue('Fee A')).toBeNull();
    expect(screen.getByDisplayValue('Fee B')).toBeTruthy();
    fireEvent.submit(document.querySelector('form')!);
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = JSON.parse(String(puts()[0]![1]!.body)) as { id: string; templateName: string; lineItems: Array<{ description: string }> };
    expect(body.id).toBe('ri-B');
    expect(body.templateName).toBe('Template ri-B');
    expect(body.lineItems[0]!.description).toBe('Fee B');
  });

  it('keeps the spinner for B when A settles first', async () => {
    await openAThenB();
    await act(async () => { listCalls[0]!(ok({ items: [row('ri-A', 'Fee A')] })); });
    expect(screen.queryByDisplayValue('Fee A')).toBeNull();
    expect(document.querySelector('form')).toBeNull();
  });

  it('clears the previous template not-found error when the id changes', async () => {
    const view = render(<RecurringInvoiceEdit />);
    await waitFor(() => expect(listCalls).toHaveLength(1));
    await act(async () => { listCalls[0]!(ok({ items: [] })); });
    await screen.findByText('Recurring invoice not found');
    route.id = 'ri-B';
    view.rerender(<RecurringInvoiceEdit />);
    await waitFor(() => expect(listCalls).toHaveLength(2));
    await act(async () => { listCalls[1]!(ok({ items: [row('ri-B', 'Fee B')] })); });
    await screen.findByDisplayValue('Fee B');
    expect(screen.queryByText('Recurring invoice not found')).toBeNull();
  });

  it('B not found after A loaded: no A data, Save disabled, no PUT on submit', async () => {
    const view = render(<RecurringInvoiceEdit />);
    await waitFor(() => expect(listCalls).toHaveLength(1));
    await act(async () => { listCalls[0]!(ok({ items: [row('ri-A', 'Fee A')] })); });
    await screen.findByDisplayValue('Fee A');
    route.id = 'ri-B';
    view.rerender(<RecurringInvoiceEdit />);
    await waitFor(() => expect(listCalls).toHaveLength(2));
    await act(async () => { listCalls[1]!(ok({ items: [] })); });
    await screen.findByText('Recurring invoice not found');
    expect(screen.queryByDisplayValue('Template ri-A')).toBeNull();
    expect(screen.queryByDisplayValue('Fee A')).toBeNull();
    expect(screen.queryByText('Template ri-A')).toBeNull();
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(document.querySelector('h1 + p')?.textContent).toBe('');
    expect((screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(document.querySelector('form')!);
    await Promise.resolve();
    expect(puts()).toHaveLength(0);
  });

  it('B with no lineItems: A lines are not shown and not PUT under B', async () => {
    const view = render(<RecurringInvoiceEdit />);
    await waitFor(() => expect(listCalls).toHaveLength(1));
    await act(async () => { listCalls[0]!(ok({ items: [row('ri-A', 'Fee A')] })); });
    await screen.findByDisplayValue('Fee A');
    route.id = 'ri-B';
    view.rerender(<RecurringInvoiceEdit />);
    await waitFor(() => expect(listCalls).toHaveLength(2));
    await act(async () => { listCalls[1]!(ok({ items: [{ ...row('ri-B', ''), lineItems: [] }] })); });
    await screen.findByDisplayValue('Template ri-B');
    expect(screen.queryByDisplayValue('Fee A')).toBeNull();
    fireEvent.submit(document.querySelector('form')!);
    await Promise.resolve();
    expect(puts()).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toContain('description');
  });

  it('a not-found template cannot be saved even when the user fills the form in', async () => {
    render(<RecurringInvoiceEdit />);
    await waitFor(() => expect(listCalls).toHaveLength(1));
    await act(async () => { listCalls[0]!(ok({ items: [] })); });
    await screen.findByText('Recurring invoice not found');
    typeDate(screen.getByRole('textbox', { name: /next run date/i }), '2026-12-01');
    await waitFor(() => expect((screen.getByRole('textbox', { name: /next run date/i }) as HTMLInputElement).value).toBe('01 Dec 2026'));
    fireEvent.change(screen.getByPlaceholderText('Description *'), { target: { value: 'typed' } });
    fireEvent.submit(document.querySelector('form')!);
    await Promise.resolve();
    expect(puts()).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toContain('not found');
  });
});
