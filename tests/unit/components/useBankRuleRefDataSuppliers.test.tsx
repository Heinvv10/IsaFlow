// The bank-rules supplier picker must say when the supplier walk was cut at the
// cap, like the bank-transactions pages do (PUR-01 round 4).
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/fetchAllSuppliers', async (original) => ({ ...await original<typeof import('@/lib/fetchAllSuppliers')>(), fetchAllSuppliers: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { fetchAllSuppliers } from '@/lib/fetchAllSuppliers';
import { useBankRuleRefData } from '@/components/accounting/bank-rules/useBankRuleRefData';

const ok = () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
beforeEach(() => vi.mocked(apiFetch).mockImplementation(async () => ok()));
afterEach(() => { vi.mocked(fetchAllSuppliers).mockReset(); vi.mocked(apiFetch).mockReset(); });

describe('useBankRuleRefData suppliers', () => {
  it('flags a truncated supplier walk', async () => {
    vi.mocked(fetchAllSuppliers).mockResolvedValue({ suppliers: [{ id: 1, name: 'A' }], truncated: true });
    const { result } = renderHook(() => useBankRuleRefData());
    await waitFor(() => expect(result.current.suppliers).toEqual([{ id: '1', name: 'A' }]));
    expect(result.current.suppliersTruncated).toBe(true);
    await new Promise((r) => setTimeout(r, 50)); // let the other loaders settle
    expect(result.current.errors).toEqual([]);
  });
  it('does not flag a complete walk', async () => {
    vi.mocked(fetchAllSuppliers).mockResolvedValue({ suppliers: [{ id: 1, name: 'A' }], truncated: false });
    const { result } = renderHook(() => useBankRuleRefData());
    await waitFor(() => expect(result.current.suppliers).toHaveLength(1));
    expect(result.current.suppliersTruncated).toBe(false);
  });
});
