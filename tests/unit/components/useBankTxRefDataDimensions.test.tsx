// #1653: the bank page's CC2 list carries each CC2's FNO (the CC1 its chain reaches) so the row can filter CC2 by
// CC1, and its BU list is the company's business units (it read cost centres, as an array it never was: always empty).
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/fetchAllSuppliers', async (original) => ({
  ...await original<typeof import('@/lib/fetchAllSuppliers')>(),
  fetchAllSuppliers: vi.fn().mockResolvedValue({ suppliers: [], truncated: false }),
}));

import { apiFetch } from '@/lib/apiFetch';
import { useBankTxRefData } from '@/components/accounting/bank-transactions/useBankTxRefData';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

// The real shapes: getCostCentres / listDimensionCostCentres / getBusinessUnits, each as { items } under data.
const CC1 = [{ id: 'ho', code: 'HO', name: 'Head Office', ccType: 'cc1', isActive: true }];
const CC2_PLAIN = [{ id: 'oh', code: 'OH-BANK', name: 'Bank charges', ccType: 'cc2', isActive: true }];
const CC2_DIMENSIONS = [
  { id: 'oh', code: 'OH-BANK', name: 'Bank charges', ccType: 'cc2', isActive: true, parentId: 'ho', parentCode: 'HO', fnoCode: 'HO' },
  { id: 'orph', code: 'ORPH', name: 'No parent', ccType: 'cc2', isActive: true, parentId: null, parentCode: null, fnoCode: null },
];
const BUS = [{ id: 'bu1', code: 'ADM', name: 'Administration', isActive: true }];

function route(url: string): Response {
  if (url.startsWith('/api/accounting/cost-centres?') && url.includes('detail=dimensions')) return ok({ items: CC2_DIMENSIONS });
  if (url.startsWith('/api/accounting/cost-centres?cc_type=cc1')) return ok({ items: CC1 });
  if (url.startsWith('/api/accounting/cost-centres?cc_type=cc2')) return ok({ items: CC2_PLAIN });
  if (url.startsWith('/api/accounting/cost-centres')) return ok({ items: [...CC1, ...CC2_PLAIN] });
  if (url.startsWith('/api/accounting/business-units')) return ok({ items: BUS });
  return ok([]);
}

const setters = () => ({
  setGlAccounts: vi.fn(), setSuppliers: vi.fn(), setCustomers: vi.fn(),
  setCc1Options: vi.fn(), setCc2Options: vi.fn(), setBuOptions: vi.fn(), setSuppliersStatus: vi.fn(),
});
beforeEach(() => vi.mocked(apiFetch).mockImplementation(async (url: unknown) => route(String(url))));
afterEach(() => vi.mocked(apiFetch).mockReset());

describe('useBankTxRefData dimensions (#1653)', () => {
  it('gives every CC2 its parent and the FNO its chain reaches', async () => {
    const s = setters();
    renderHook(() => useBankTxRefData(s));
    await waitFor(() => expect(s.setCc2Options).toHaveBeenCalled());
    expect(s.setCc2Options).toHaveBeenCalledWith([
      { id: 'oh', code: 'OH-BANK', name: 'Bank charges', fnoCode: 'HO', parentId: 'ho' },
      { id: 'orph', code: 'ORPH', name: 'No parent', fnoCode: null, parentId: null },
    ]);
    expect(s.setCc1Options).toHaveBeenCalledWith([{ id: 'ho', code: 'HO', name: 'Head Office' }]);
  });

  it('lists the business units as the BU options', async () => {
    const s = setters();
    renderHook(() => useBankTxRefData(s));
    await waitFor(() => expect(s.setBuOptions).toHaveBeenCalled());
    expect(s.setBuOptions).toHaveBeenCalledWith([{ id: 'bu1', code: 'ADM', name: 'Administration' }]);
  });
});
