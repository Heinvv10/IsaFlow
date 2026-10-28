/**
 * Wave 2 PR A, browser review: the recurring-journals selects have an accessible name, and the supplier-ledger
 * Supplier field sits in the same frame as From / To (same label, kit input border, top-aligned row).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1', name: 'Co' } }) }));

import { apiFetch } from '@/lib/apiFetch';
import RecurringJournals from '../../../pages/accounting/recurring-journals/index';
import SupplierLedger from '../../../pages/accounting/reports/supplier-ledger';

useApiJsonOverMock();
let respond: (url: string) => unknown = () => [];
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => ok(respond(String(url))));
});
afterEach(cleanup);

describe('recurring-journals selects are named', () => {
  const journals = [
    { id: 'j1', templateName: 'Rent', frequency: 'monthly', nextRunDate: '2031-10-05', runCount: 0, status: 'active', totalAmount: 1, lines: [] },
    { id: 'j2', templateName: 'Fees', frequency: 'monthly', nextRunDate: '2031-10-05', runCount: 0, status: 'paused', totalAmount: 1, lines: [] },
  ];

  it('the status filter is found by name and filters the list', async () => {
    respond = (u) => (u.includes('recurring-journals') ? { items: journals } : []);
    render(<RecurringJournals />);
    await screen.findByText('Rent');
    const status = screen.getByRole('combobox', { name: /status/i });
    fireEvent.change(status, { target: { value: 'paused' } });
    expect(screen.queryByText('Rent')).toBeNull();
    expect(screen.getByText('Fees')).toBeTruthy();
  });

  it('the frequency and line-account selects of the form are named too', async () => {
    respond = (u) => (u.includes('chart-of-accounts') ? [{ id: 'a1', accountCode: '1000', accountName: 'Bank' }] : []);
    render(<RecurringJournals />);
    fireEvent.click(await screen.findByRole('button', { name: /new template/i }));
    expect(screen.getByRole('combobox', { name: /frequency/i })).toBeTruthy();
    expect(screen.getAllByRole('combobox', { name: /account/i }).length).toBeGreaterThan(0);
  });
});

describe('supplier-ledger filter row', () => {
  it('Supplier uses the From / To label style, the kit input border, a real label association and a grid row', () => {
    respond = () => [];
    render(<SupplierLedger />);
    const supplierLabel = screen.getByText('Supplier', { selector: 'label' });
    const fromLabel = screen.getByText('From', { selector: 'label' });
    expect(supplierLabel.className).toBe(fromLabel.className);
    const input = screen.getByTestId('supplier-select-input');
    expect(input.className).toContain('border-gray-300');
    expect(input.className).toContain('dark:border-gray-600');
    // The visible label names and focuses the input (not just an aria-label that happens to match).
    expect((supplierLabel as HTMLLabelElement).control).toBe(input);
    expect(screen.getByRole('textbox', { name: 'Supplier' })).toBe(input);
    // A grid, not a wrapping flex row: Run Report cannot wrap under the inputs, so its offset to the input row applies
    // only where the row is a single line (lg); below that it is a plain grid cell with no gap above it.
    const run = screen.getByRole('button', { name: /run report/i });
    const row = run.parentElement as HTMLElement;
    expect(row.className).toContain('items-start');
    expect(row.className).not.toContain('flex-wrap');
    const tokens = run.className.split(/\s+/);
    expect(tokens).toContain('lg:mt-6');
    expect(tokens).not.toContain('mt-6');
  });
});
