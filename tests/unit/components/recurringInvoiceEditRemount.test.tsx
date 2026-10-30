/**
 * The edit page remounts per template id (key={id}), so nothing from template A (a refused date, an error, an
 * in-flight save) can reach template B. Also: unchanged saves omit the date keys; a customers-load failure shows.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, boom } from '../helpers/d2CensusG4';
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

const row = (id: string) => ({
  id, templateName: `Template ${id}`, clientId: 'c1', frequency: 'monthly',
  nextRunDate: '2026-11-01', endDate: '2026-12-31',
  lineItems: [{ description: `Fee ${id}`, quantity: 1, unitPrice: 10 }],
});
let customersFail = false;
let putResolvers: Array<() => void> = [];
let deferPut = false;

useApiJsonOverMock();
beforeEach(() => {
  route.id = 'ri-A';
  customersFail = false;
  deferPut = false;
  putResolvers = [];
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      if (!deferPut) return ok({});
      return new Promise<Response>(resolve => { putResolvers.push(() => resolve(ok({}))); });
    }
    if (String(url).endsWith('customers')) return customersFail ? boom() : ok([]);
    return ok({ items: [row('ri-A'), row('ri-B')] });
  });
});
afterEach(cleanup);

const puts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT');
const putBody = (n: number) => JSON.parse(String(puts()[n]![1]!.body)) as Record<string, unknown>;
const submit = () => fireEvent.submit(document.querySelector('form')!);
const nextRun = () => screen.getByRole('textbox', { name: /next run date/i });

async function goToB(view: ReturnType<typeof render>) {
  route.id = 'ri-B';
  view.rerender(<RecurringInvoiceEdit />);
  await screen.findByDisplayValue('Fee ri-B');
}

describe('recurring invoice edit: per-template state', () => {
  it('a date refused on A does not block B: B saves with no error', async () => {
    const view = render(<RecurringInvoiceEdit />);
    await screen.findByDisplayValue('Fee ri-A');
    typeDate(nextRun(), 'zz');
    submit();
    await screen.findByText('Fix the date marked in red before saving.');
    expect(puts()).toHaveLength(0);
    await goToB(view);
    expect(screen.queryByRole('alert')).toBeNull();
    submit();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(putBody(0).id).toBe('ri-B');
  });

  it('a late PUT for A resolving after navigating to B leaves B untouched', async () => {
    deferPut = true;
    const view = render(<RecurringInvoiceEdit />);
    await screen.findByDisplayValue('Fee ri-A');
    typeDate(nextRun(), '2026-12-05');
    await waitFor(() => expect((nextRun() as HTMLInputElement).value).toBe('05 Dec 2026'));
    submit();
    await waitFor(() => expect(putResolvers).toHaveLength(1));
    await goToB(view);
    await act(async () => { putResolvers[0]!(); });
    expect(screen.getByDisplayValue('Template ri-B')).toBeTruthy();
    expect((nextRun() as HTMLInputElement).value).toBe('01 Nov 2026');
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement).disabled).toBe(false);
    deferPut = false;
    submit();
    await waitFor(() => expect(puts()).toHaveLength(2));
    const body = putBody(1);
    expect(body.id).toBe('ri-B');
    expect('nextRunDate' in body).toBe(false);
    expect('endDate' in body).toBe(false);
  });

  it('an unchanged save PUTs neither nextRunDate nor endDate', async () => {
    render(<RecurringInvoiceEdit />);
    await screen.findByDisplayValue('Fee ri-A');
    submit();
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = putBody(0);
    expect(body.id).toBe('ri-A');
    expect('nextRunDate' in body).toBe(false);
    expect('endDate' in body).toBe(false);
  });

  it('shows the banner when the customers list fails to load', async () => {
    customersFail = true;
    render(<RecurringInvoiceEdit />);
    await screen.findByDisplayValue('Fee ri-A');
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load customers');
  });
});
