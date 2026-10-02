// The bank-rules supplier picker must say when the supplier walk was cut at the
// cap, like the bank-transactions pages do (PUR-01 round 4).
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...await orig<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/fetchAllSuppliers', async (original) => ({ ...await original<typeof import('@/lib/fetchAllSuppliers')>(), fetchAllSuppliers: vi.fn() }));

import { fetchAllSuppliers } from '@/lib/fetchAllSuppliers';
import { useBankRuleRefData } from '@/components/accounting/bank-rules/useBankRuleRefData';

afterEach(() => vi.mocked(fetchAllSuppliers).mockReset());

describe('useBankRuleRefData suppliers', () => {
  it('flags a truncated supplier walk', async () => {
    vi.mocked(fetchAllSuppliers).mockResolvedValue({ suppliers: [{ id: 1, name: 'A' }], truncated: true });
    const { result } = renderHook(() => useBankRuleRefData());
    await waitFor(() => expect(result.current.suppliers).toEqual([{ id: '1', name: 'A' }]));
    expect(result.current.suppliersTruncated).toBe(true);
  });
  it('does not flag a complete walk', async () => {
    vi.mocked(fetchAllSuppliers).mockResolvedValue({ suppliers: [{ id: 1, name: 'A' }], truncated: false });
    const { result } = renderHook(() => useBankRuleRefData());
    await waitFor(() => expect(result.current.suppliers).toHaveLength(1));
    expect(result.current.suppliersTruncated).toBe(false);
  });
});
