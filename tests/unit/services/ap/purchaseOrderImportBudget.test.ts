/**
 * The budget check of an imported approved PO in its three shapes (ap/purchaseOrderImportBudget): live (a block raises), dry run
 * (a block is reported) and skipped (a block is reported and marked). The check itself runs against real PostgreSQL in
 * tests/integration/mcp-po-maintenance-import.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkMock = vi.fn();
vi.mock('@/modules/accounting/services/ap/purchaseOrderBudget', () => ({ checkPurchaseOrderBudget: (...a: unknown[]) => checkMock(...a) }));

import { blockReasons, runImportBudgetCheck } from '@/modules/accounting/services/ap/purchaseOrderImportBudget';
import { BudgetExceededError, type BudgetCheckLine, type BudgetGate } from '@/modules/accounting/services/budgets/budgetCheckTypes';

const gate: BudgetGate = { policy: 'block', locked: true, mode: 'take' };
const po = { id: 'p1', poNumber: 'PO1', status: 'approved', month: '2026-06' };
const over: BudgetCheckLine = {
  glAccountId: 'a1', month: '2026-06', grain: 'cc1', cc1Id: 'c1', cc2Id: null, buId: null, unassigned: false, offSlice: false,
  budget: 1000, actual: 0, committed: 700, remaining: 300, amount: 800, over: true, accountLabel: 'BB-6100 Opex', sliceLabel: 'FT',
};
const refusal = () => new BudgetExceededError('Over budget — approval refused: …', {
  companyId: 'c', documentType: 'purchase_order', documentId: 'p1', documentRef: 'PO1', policy: 'block', lines: [over], reason: null, channel: 'mcp', actorId: 'u',
});
const run = (mode: { enforce: boolean; skipped: boolean }, figures = true) => runImportBudgetCheck('c', po, gate, figures, 'u', mode);

beforeEach(() => { checkMock.mockReset(); });

describe('runImportBudgetCheck', () => {
  it('a passing check is ok; one that warns carries its warnings; the check runs with the gate held on channel mcp', async () => {
    checkMock.mockResolvedValue({ policy: 'block', outcome: 'pass', lines: [], warnings: [] });
    expect(await run({ enforce: true, skipped: false })).toEqual({ outcome: 'ok', policy: 'block', reasons: [], skipped: false, would_have_failed: false });
    expect(checkMock.mock.calls[0]![3]).toEqual({ channel: 'mcp', lock: 'held', gate, figures: true });
    checkMock.mockResolvedValue({ policy: 'warn', outcome: 'warn', lines: [], warnings: ['Over budget: x'] });
    expect(await run({ enforce: true, skipped: false })).toMatchObject({ outcome: 'warn', policy: 'warn', reasons: ['Over budget: x'] });
  });

  it('a block raises when enforced (the live call without the flag)', async () => {
    checkMock.mockRejectedValue(refusal());
    await expect(run({ enforce: true, skipped: false })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('a block is reported, not raised, in a dry run and when skipped; skipped marks it', async () => {
    checkMock.mockRejectedValue(refusal());
    const dry = await run({ enforce: false, skipped: false });
    expect(dry).toMatchObject({ outcome: 'block', policy: 'block', skipped: false, would_have_failed: true });
    expect(dry.reasons[0]).toContain('Over budget');
    expect(await run({ enforce: false, skipped: true })).toMatchObject({ outcome: 'block', skipped: true, would_have_failed: true });
  });

  it('anything but a budget refusal propagates, enforced or not', async () => {
    checkMock.mockRejectedValue(new Error('boom'));
    await expect(run({ enforce: false, skipped: true })).rejects.toThrow('boom');
  });

  it('the reasons name the line in warn words, with figures only when the caller may see them', () => {
    expect(blockReasons(refusal(), true)[0]).toMatch(/^Over budget: .*BB-6100 Opex/);
    expect(blockReasons(refusal(), true)[0]).toMatch(/\d/);
    expect(blockReasons(refusal(), false)[0]).not.toContain('300');
  });
});
