// bank-transactions/new loads every supplier through fetchAllSuppliers (PUR-01).
// The supplier allocation search must reach a supplier past the 25th and must say
// when the list failed to load or was cut at the cap, not quietly show less.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';

vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, isReady: true }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/fetchAllSuppliers', async (original) => ({ ...await original<typeof import('@/lib/fetchAllSuppliers')>(), fetchAllSuppliers: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { fetchAllSuppliers } from '@/lib/fetchAllSuppliers';
import NewBankTransactionPage from '../../../pages/accounting/bank-transactions/new';

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

beforeEach(() => {
  vi.mocked(fetchAllSuppliers).mockReset();
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).includes('bank-accounts')) return json([{ id: 'b1', accountCode: '1000', accountName: 'Cheque' }]);
    return json([]);
  });
});

async function openSupplierAllocation() {
  fireEvent.click(await screen.findByRole('button', { name: 'Supplier' }, { timeout: 3000 }));
}

describe('bank-transactions/new supplier allocation', () => {
  it('finds a supplier from the full list', async () => {
    vi.mocked(fetchAllSuppliers).mockResolvedValue({
      suppliers: [{ id: 26, name: 'Supplier 26', code: 'S26' }], truncated: false,
    });
    render(<NewBankTransactionPage />);
    await openSupplierAllocation();
    fireEvent.change(screen.getByPlaceholderText('Search suppliers…'), { target: { value: 'Supplier 26' } });
    expect(await screen.findByText('Supplier 26')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says so when the supplier walk was cut at the cap', async () => {
    vi.mocked(fetchAllSuppliers).mockResolvedValue({ suppliers: [{ id: 1, name: 'A' }], truncated: true });
    render(<NewBankTransactionPage />);
    await openSupplierAllocation();
    expect((await screen.findByRole('status')).textContent).toMatch(/first 10\s000 suppliers/);
  });

  it('says so when the suppliers failed to load', async () => {
    vi.mocked(fetchAllSuppliers).mockRejectedValue(new Error('HTTP 500'));
    render(<NewBankTransactionPage />);
    await openSupplierAllocation();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Suppliers failed to load/);
  });

  it('shows no supplier notice on the account allocation', async () => {
    vi.mocked(fetchAllSuppliers).mockRejectedValue(new Error('HTTP 500'));
    render(<NewBankTransactionPage />);
    const supplierTab = await screen.findByRole('button', { name: 'Supplier' }, { timeout: 3000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); }); // let the rejection land
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(supplierTab);
    expect(screen.getByRole('alert').textContent).toMatch(/Suppliers failed to load/);
  });
});
