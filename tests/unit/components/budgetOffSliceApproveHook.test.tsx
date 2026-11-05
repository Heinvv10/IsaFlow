/**
 * Budgets P5-2b: `useBudgetApprove.start` opens the approve dialog when the preview has a line the check acts on.
 * A document whose only such line is off-slice (no budget figure, `offSlice: true`) must open it too, not approve
 * at once (which would be refused 400/409 and, in block, record a refused event the user never chose to cause).
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import { useBudgetApprove } from '@/components/accounting/ap/useBudgetApprove';
import type { BudgetCheckLine } from '@/modules/accounting/services/budgets/budgetCheckTypes';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const ok = (data: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) });
const line = (o: Partial<BudgetCheckLine>): BudgetCheckLine => ({
  glAccountId: 'a', month: '2026-06', grain: 'cc1', cc1Id: null, cc2Id: null, buId: null, unassigned: true,
  budget: null, actual: 0, committed: 0, remaining: null, amount: 200, over: false, offSlice: true,
  accountLabel: '6100 Opex', sliceLabel: '', ...o,
});

const hook = () => renderHook(() => useBudgetApprove('inv-1', vi.fn(), vi.fn(), vi.fn(async () => undefined)));
const calledAction = () => fetchMock.mock.calls.some(([url]) => url === '/api/accounting/supplier-invoices-action');

describe('useBudgetApprove.start: off-slice lines', () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it('an off-slice-only preview opens the dialog and approves nothing yet', async () => {
    fetchMock.mockResolvedValueOnce(ok({ policy: 'block', checks: true, overCount: 1, lines: [line({})] }));
    const { result } = hook();
    await act(async () => { await result.current.start(); });
    expect(result.current.dialog.open).toBe(true);
    expect(calledAction()).toBe(false);
  });

  it('a preview with only "No budget" lines approves at once', async () => {
    fetchMock.mockResolvedValueOnce(ok({ policy: 'block', checks: true, overCount: 0, lines: [line({ grain: null, unassigned: false, offSlice: false })] }));
    fetchMock.mockResolvedValueOnce(ok({ id: 'inv-1', status: 'approved' }));
    const { result } = hook();
    await act(async () => { await result.current.start(); });
    expect(result.current.dialog.open).toBe(false);
    expect(calledAction()).toBe(true);
  });
});
