// The bank page's supplier list loads on its own and must say when it failed or
// was cut at the cap, instead of silently showing a short list (PUR-01 round 2).
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/fetchAllSuppliers', async (original) => ({ ...await original<typeof import('@/lib/fetchAllSuppliers')>(), fetchAllSuppliers: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { fetchAllSuppliers, truncatedSuppliersNotice } from '@/lib/fetchAllSuppliers';
import { useBankTxRefData } from '@/components/accounting/bank-transactions/useBankTxRefData';

const setters = () => ({
  setBankAccounts: vi.fn(), setGlAccounts: vi.fn(), setSuppliers: vi.fn(), setCustomers: vi.fn(),
  setCc1Options: vi.fn(), setCc2Options: vi.fn(), setBuOptions: vi.fn(), setSelectedBank: vi.fn(),
  setRefDataLoaded: vi.fn(), setSuppliersStatus: vi.fn(),
});
beforeEach(() => vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })));
afterEach(() => { vi.mocked(fetchAllSuppliers).mockReset(); vi.mocked(apiFetch).mockReset(); });

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
