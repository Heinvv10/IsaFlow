/** Review r6 M3: a reopen is said even when the budget read fails; the failure is logged, never thrown (ap/purchaseOrderBillingClose). */
import { describe, expect, it, vi } from 'vitest';

const { warnMock, budgetMock } = vi.hoisted(() => ({ warnMock: vi.fn(), budgetMock: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const { savepoints } = vi.hoisted(() => ({ savepoints: [] as string[] }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => []),
  withSavepoint: vi.fn(async (name: string, fn: () => Promise<unknown>) => { savepoints.push(name); return fn(); }),
}));
vi.mock('@/modules/accounting/services/ap/purchaseOrderUnlinkBudget', () => ({ unlinkBudgetWarnings: budgetMock }));

import { reopenWarnings } from '@/modules/accounting/services/ap/purchaseOrderBillingClose';

const PO = { poId: 'p1', poNumber: 'PO-1', reopenedTo: 'approved' };

describe('reopenWarnings', () => {
  it('names each reopened PO, then its budget read', async () => {
    budgetMock.mockResolvedValueOnce(['Reopened. Purchase order PO-1 commits spend again and is now over budget on X.']);
    expect(await reopenWarnings('c1', [PO], false)).toEqual([
      'Purchase order PO-1 reopened to approved: it is no longer fully billed, so it commits spend again.',
      'Reopened. Purchase order PO-1 commits spend again and is now over budget on X.',
    ]);
  });
  it('a budget read that throws becomes "could not be checked", logged; the reopen is still named', async () => {
    budgetMock.mockRejectedValueOnce(new Error('preview failed'));
    const out = await reopenWarnings('c1', [PO], false);
    expect(out[0]).toBe('Purchase order PO-1 reopened to approved: it is no longer fully billed, so it commits spend again.');
    expect(out[1]).toContain('The budget could not be checked just now');
    expect(warnMock).toHaveBeenCalledWith('Reopen budget read failed', expect.objectContaining({ poId: 'p1' }), 'accounting');
    // Review r7 H1: the read runs in its own savepoint, so a SQL error inside it cannot abort the request's transaction.
    expect(savepoints).toContain('reopen_budget_read');
  });
});
