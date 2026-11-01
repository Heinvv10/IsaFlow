/**
 * The recurring-invoice edit page sends endDate in its PUT only when the user changed it (an absent key means
 * "keep" on the server, so a stale page cannot put back an end date someone else changed); clearing sends null.
 * end < next is refused client-side only when a date was changed (legacy rows stay renamable).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { typeDate } from '../helpers/dateFields';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({
  useRouter: () => ({ query: { id: 'ri-1' }, push: vi.fn(async () => true), replace: vi.fn(), pathname: '/', isReady: true }),
}));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1', name: 'Co' } }) }));
import { apiFetch } from '@/lib/apiFetch';
import RecurringInvoiceEdit from '../../../pages/accounting/recurring-invoices/[id]';

type PutBody = Record<string, unknown>;

const base = {
  id: 'ri-1', templateName: 'T', clientId: 'c1', frequency: 'monthly',
  nextRunDate: '2026-11-01', endDate: '2026-12-31',
  lineItems: [{ description: 'Fee', quantity: 1, unitPrice: 10 }],
};
let template: Record<string, unknown> = base;

useApiJsonOverMock();
beforeEach(() => {
  template = base;
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') return ok({});
    return ok(String(url).endsWith('recurring-invoices') ? { items: [template] } : []);
  });
});
afterEach(cleanup);

const puts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT');
const putBody = (): PutBody => JSON.parse(String(puts()[0]![1]!.body)) as PutBody;
const box = (name: RegExp): HTMLInputElement => screen.getByRole('textbox', { name }) as HTMLInputElement;
const endDateBox = () => box(/^end date/i);
const nextRunBox = () => box(/next run date/i);
const submit = () => fireEvent.submit(document.querySelector('form')!);

async function openLoaded(): Promise<void> {
  render(<RecurringInvoiceEdit />);
  await screen.findByDisplayValue('Fee');
}

describe('recurring invoice edit: PUT endDate', () => {
  it('omits endDate when the user does not touch it', async () => {
    await openLoaded();
    expect(endDateBox().value).toBe('31 Dec 2026');
    submit();
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = putBody();
    expect(body.id).toBe('ri-1');
    expect('nextRunDate' in body).toBe(false);
    expect('endDate' in body).toBe(false);
  });

  it('sends nextRunDate (and no endDate) when only the next run date is changed', async () => {
    await openLoaded();
    typeDate(nextRunBox(), '2026-12-01');
    await waitFor(() => expect(nextRunBox().value).toBe('01 Dec 2026'));
    submit();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(putBody().nextRunDate).toBe('2026-12-01');
    expect('endDate' in putBody()).toBe(false);
  });

  it('compares a second save against what the first save wrote', async () => {
    await openLoaded();
    typeDate(nextRunBox(), '2026-12-01');
    await waitFor(() => expect(nextRunBox().value).toBe('01 Dec 2026'));
    submit();
    await waitFor(() => expect(puts()).toHaveLength(1));
    submit();
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect('nextRunDate' in (JSON.parse(String(puts()[1]![1]!.body)) as PutBody)).toBe(false);
  });

  it('sends endDate: null (not omitted) when the user clears the field', async () => {
    await openLoaded();
    typeDate(endDateBox(), '');
    await waitFor(() => expect(endDateBox().value).toBe(''));
    submit();
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = putBody();
    expect('endDate' in body).toBe(true);
    expect(body.endDate).toBeNull();
    expect('nextRunDate' in body).toBe(false);
  });

  it('sends the new end date when the user sets one', async () => {
    await openLoaded();
    typeDate(endDateBox(), '2027-03-31');
    await waitFor(() => expect(endDateBox().value).toBe('31 Mar 2027'));
    submit();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(putBody().endDate).toBe('2027-03-31');
  });

  it('omits endDate when the template has none and the user leaves it', async () => {
    template = { ...base, endDate: null };
    await openLoaded();
    expect(endDateBox().value).toBe('');
    submit();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect('endDate' in putBody()).toBe(false);
  });
});

describe('recurring invoice edit: end before next run date', () => {
  const legacy = { ...base, nextRunDate: '2026-11-01', endDate: '2026-10-01' };

  it('saves a legacy end<next template unchanged, without a client error', async () => {
    template = legacy;
    await openLoaded();
    submit();
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = putBody();
    expect('nextRunDate' in body).toBe(false);
    expect('endDate' in body).toBe(false);
    expect(screen.queryByText(/end date cannot be before/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses client-side when the next run date is moved past the end date', async () => {
    template = legacy;
    await openLoaded();
    typeDate(nextRunBox(), '2026-12-01');
    await waitFor(() => expect(nextRunBox().value).toBe('01 Dec 2026'));
    submit();
    expect(await screen.findByText(/end date cannot be before/i)).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(puts()).toHaveLength(0);
  });
});
