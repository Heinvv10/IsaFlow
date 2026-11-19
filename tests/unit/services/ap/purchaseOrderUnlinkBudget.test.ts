/** unlinkBudgetWarnings: an unlink's own wording, never an approval refusal; nothing when the policy is off or nothing is flagged. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const preview = vi.fn();
vi.mock('@/modules/accounting/services/ap/purchaseOrderBudget', () => ({ previewPurchaseOrderBudget: (...a: unknown[]) => preview(...a) }));

import { unlinkBudgetWarnings } from '@/modules/accounting/services/ap/purchaseOrderUnlinkBudget';

const line = (over: Record<string, unknown> = {}) => ({
  over: true, offSlice: false, remaining: 100, amount: 400, accountLabel: 'BB-6100 Opex', sliceLabel: 'FT', month: '2026-06', ...over,
});

beforeEach(() => preview.mockReset());

describe('unlinkBudgetWarnings', () => {
  it('words an over line as the unlink\'s own, with the amount over when figures are allowed', async () => {
    preview.mockResolvedValue({ checks: true, lines: [line(), line({ over: false })] });
    const w = await unlinkBudgetWarnings('c1', 'po1', 'PO7', true);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^Unlinked\. Purchase order PO7 commits spend again and is now over budget on BB-6100 Opex · FT · 2026-06 by R\s?300[.,]00\.$/);
    expect(w[0]).not.toMatch(/refused|Approve|approval/i);
    expect(preview).toHaveBeenCalledWith('c1', 'po1');
  });
  it('leaves the figures out without read:reports; an off-slice line says so', async () => {
    preview.mockResolvedValue({ checks: true, lines: [line(), line({ over: false, offSlice: true })] });
    const w = await unlinkBudgetWarnings('c1', 'po1', 'PO7', false);
    expect(w[0]).toBe('Unlinked. Purchase order PO7 commits spend again and is now over budget on BB-6100 Opex · FT · 2026-06.');
    expect(w[1]).toBe('Unlinked. Purchase order PO7 commits spend again outside the budgeted slices (BB-6100 Opex · FT · 2026-06).');
  });
  it('says nothing when the policy is off, the PO is gone, or no line is flagged', async () => {
    preview.mockResolvedValue({ checks: false, lines: [line()] });
    expect(await unlinkBudgetWarnings('c', 'p', 'N', true)).toEqual([]);
    preview.mockResolvedValue(null);
    expect(await unlinkBudgetWarnings('c', 'p', 'N', true)).toEqual([]);
    preview.mockResolvedValue({ checks: true, lines: [line({ over: false })] });
    expect(await unlinkBudgetWarnings('c', 'p', 'N', true)).toEqual([]);
  });
});
