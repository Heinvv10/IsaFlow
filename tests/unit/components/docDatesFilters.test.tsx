/**
 * Wave 2 PR A, review round: a From / To filter whose text was refused used to keep the previous range silently.
 * Supplier ledger: Run Report is blocked (with the reason) while a filter date is refused. VAT adjustments: the
 * list is filtered live, so the page says the list still uses the previous dates until the date is fixed.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { typeDate } from '../helpers/dateFields';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(async () => true), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1', name: 'Co' } }) }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: ({ onChange }: { onChange: (id: string, name: string) => void }) => (
    <button type="button" onClick={() => onChange('sup-1', 'Acme')}>pick-supplier</button>
  ),
}));

import { apiFetch } from '@/lib/apiFetch';
import SupplierLedger from '../../../pages/accounting/reports/supplier-ledger';
import VatAdjustments from '../../../pages/accounting/vat-adjustments/index';

useApiJsonOverMock();
let respond: (url: string) => unknown = () => [];
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => ok(respond(String(url))));
});
afterEach(cleanup);

const box = (label: string): HTMLInputElement => screen.getByRole('textbox', { name: new RegExp(`^${label}$`, 'i') }) as HTMLInputElement;
const ledgerCalls = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('reports-supplier-ledger'));
const ledger = { supplier_name: 'Acme', opening_balance: 0, closing_balance: 0, transactions: [] };

describe('reports/supplier-ledger', () => {
  const setUp = (): HTMLButtonElement => {
    respond = (u) => (u.includes('reports-supplier-ledger') ? ledger : []);
    render(<SupplierLedger />);
    fireEvent.click(screen.getByText('pick-supplier'));
    return screen.getByRole('button', { name: /run report/i }) as HTMLButtonElement;
  };

  it.each(['From', 'To'])('blocks Run Report with a message while %s is refused, and runs once it is fixed', async (label) => {
    const run = setUp();
    typeDate(box(label), '5 Oct 2031');
    typeDate(box(label), 'zz');
    expect(run.disabled).toBe(true);
    expect(screen.getByText(/fix the date marked in red/i)).toBeTruthy();
    fireEvent.click(run);
    expect(ledgerCalls()).toHaveLength(0);
    typeDate(box(label), '6 Oct 2031');
    expect(run.disabled).toBe(false);
    expect(screen.queryByText(/fix the date marked in red/i)).toBeNull();
    fireEvent.click(run);
    await waitFor(() => expect(ledgerCalls()).toHaveLength(1));
    expect(String(ledgerCalls()[0]![0])).toContain(label === 'From' ? 'dateFrom=2031-10-06' : 'dateTo=2031-10-06');
  });

  it('runs normally when no date is refused', async () => {
    const run = setUp();
    expect(run.disabled).toBe(false);
    fireEvent.click(run);
    await waitFor(() => expect(ledgerCalls()).toHaveLength(1));
  });
});

describe('vat-adjustments list filter', () => {
  const items = [
    { id: 'a', adjustmentNumber: 'VA-1', adjustmentDate: '2031-10-05', adjustmentType: 'input', amount: 10, reason: 'r', status: 'draft' },
    { id: 'b', adjustmentNumber: 'VA-2', adjustmentDate: '2031-11-05', adjustmentType: 'input', amount: 20, reason: 'r', status: 'draft' },
  ];
  const setUp = async (): Promise<void> => {
    respond = (u) => (u.includes('vat-adjustments') ? { items } : []);
    render(<VatAdjustments />);
    await screen.findByText('VA-1');
  };

  it.each(['From', 'To'])('says the list still uses the previous dates while %s is refused', async (label) => {
    await setUp();
    typeDate(box(label), '1 Nov 2031');
    typeDate(box(label), 'zz');
    expect(screen.getByText(/fix the date marked in red/i)).toBeTruthy();
    typeDate(box(label), '2 Nov 2031');
    expect(screen.queryByText(/fix the date marked in red/i)).toBeNull();
  });

  it('shows no warning for a valid range', async () => {
    await setUp();
    typeDate(box('From'), '1 Nov 2031');
    expect(screen.queryByText('VA-1')).toBeNull();
    expect(screen.queryByText(/fix the date marked in red/i)).toBeNull();
  });
});
