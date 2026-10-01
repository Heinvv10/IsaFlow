// The bank page's supplier list loads on its own and must say when it failed or
// was cut at the cap, instead of silently showing a short list (PUR-01 round 2).
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(async () => new Response('{}', { status: 200 })) }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/fetchAllSuppliers', async (original) => ({ ...await original<typeof import('@/lib/fetchAllSuppliers')>(), fetchAllSuppliers: vi.fn() }));

import { fetchAllSuppliers, truncatedSuppliersNotice } from '@/lib/fetchAllSuppliers';
import { useBankTxRefData } from '@/components/accounting/bank-transactions/useBankTxRefData';

const setters = () => ({
  setBankAccounts: vi.fn(), setGlAccounts: vi.fn(), setSuppliers: vi.fn(), setCustomers: vi.fn(),
  setCc1Options: vi.fn(), setCc2Options: vi.fn(), setBuOptions: vi.fn(), setSelectedBank: vi.fn(),
  setRefDataLoaded: vi.fn(), setSuppliersStatus: vi.fn(),
});
afterEach(() => vi.mocked(fetchAllSuppliers).mockReset());

describe('useBankTxRefData suppliers', () => {
  it('reports truncation', async () => {
    vi.mocked(fetchAllSuppliers).mockResolvedValue({ suppliers: [{ id: 1, name: 'A' }], truncated: true });
    const s = setters();
    renderHook(() => useBankTxRefData(s));
    await waitFor(() => expect(s.setSuppliersStatus).toHaveBeenCalledWith('truncated'));
    expect(s.setSuppliers).toHaveBeenCalledWith([{ id: '1', name: 'A', code: undefined }]);
  });
  it('reports a failure and does not hold back the other reference data', async () => {
    vi.mocked(fetchAllSuppliers).mockRejectedValue(new Error('HTTP 500'));
    const s = setters();
    renderHook(() => useBankTxRefData(s));
    await waitFor(() => expect(s.setSuppliersStatus).toHaveBeenCalledWith('failed'));
    await waitFor(() => expect(s.setRefDataLoaded).toHaveBeenCalledWith(true));
  });
  it('words the cap notice with the cap', () => {
    expect(truncatedSuppliersNotice()).toMatch(/first 10\s000 suppliers/);
  });
});
