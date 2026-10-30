/**
 * The recurring-invoice edit page must send endDate in its PUT: the loaded value when untouched, and an explicit
 * null when the user clears the field (omitting it made the server keep the old end date).
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

interface PutBody { id: string; endDate: string | null; nextRunDate: string }

const template = {
  id: 'ri-1', templateName: 'T', clientId: 'c1', frequency: 'monthly',
  nextRunDate: '2026-11-01', endDate: '2026-12-31',
  lineItems: [{ description: 'Fee', quantity: 1, unitPrice: 10 }],
};

useApiJsonOverMock();
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) =>
    ok(String(url).endsWith('recurring-invoices') ? { items: [template] } : []));
});
afterEach(cleanup);

const puts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT');
const endDateBox = (): HTMLInputElement =>
  screen.getByRole('textbox', { name: /^end date/i }) as HTMLInputElement;

async function openLoaded(): Promise<void> {
  render(<RecurringInvoiceEdit />);
  await screen.findByDisplayValue('Fee');
}

describe('recurring invoice edit: PUT endDate', () => {
  it('sends the loaded end date when the user does not touch it', async () => {
    await openLoaded();
    expect(endDateBox().value).toBe('31 Dec 2026');
    fireEvent.submit(document.querySelector('form')!);
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = JSON.parse(String(puts()[0]![1]!.body)) as PutBody;
    expect(body.id).toBe('ri-1');
    expect(body.endDate).toBe('2026-12-31');
  });

  it('sends endDate: null (not omitted) when the user clears the field', async () => {
    await openLoaded();
    typeDate(endDateBox(), '');
    await waitFor(() => expect(endDateBox().value).toBe(''));
    fireEvent.submit(document.querySelector('form')!);
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = JSON.parse(String(puts()[0]![1]!.body)) as Record<string, unknown>;
    expect('endDate' in body).toBe(true);
    expect(body.endDate).toBeNull();
  });
});
