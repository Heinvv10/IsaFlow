/**
 * "Run rules" rounds: the page keeps requesting while the server defers lines
 * AND the round posted something; counters add up, reasons union, and the
 * deferred count is always the last round's.
 */
import { describe, it, expect, vi } from 'vitest';
import { applyRulesUntilSettled, MAX_APPLY_ROUNDS } from '@/components/accounting/bank-rules/applyRounds';
import { mergeApplyResults } from '@/components/accounting/bank-rules/applyToast';

describe('mergeApplyResults', () => {
  it('sums counters, unions reasons, and keeps the last round\'s deferred and skipped', () => {
    const merged = mergeApplyResults(
      { applied: 6, skipped: 9, autoPostSkippedClosedPeriod: 1, autoPostRefusalReasons: ['a'], autoPostDeferred: 3 },
      { applied: 3, skipped: 4, autoPostSkippedClosedPeriod: 2, autoPostSkippedLockdown: 1, autoPostRefusalReasons: ['a', 'b'], autoPostDeferred: 0 },
    );
    expect(merged).toEqual({ applied: 9, skipped: 4, autoPostSkippedClosedPeriod: 3, autoPostSkippedLockdown: 1,
      autoPostRefusalReasons: ['a', 'b'], autoPostDeferred: 0 });
  });
});

describe('mergeApplyResults across files', () => {
  it('sums deferred lines, since each file defers its own', () => {
    const merged = mergeApplyResults({ applied: 6, autoPostDeferred: 44 }, { applied: 6, autoPostDeferred: 10 }, { deferred: 'sum' });
    expect(merged.autoPostDeferred).toBe(54);
  });
});

describe('applyRulesUntilSettled', () => {
  it('runs again while lines are deferred and stops when none are', async () => {
    const again = vi.fn()
      .mockResolvedValueOnce({ data: { applied: 6, skipped: 2, autoPostDeferred: 2 } })
      .mockResolvedValueOnce({ data: { applied: 2, skipped: 0, autoPostDeferred: 0 } });
    const total = await applyRulesUntilSettled({ applied: 6, skipped: 8, autoPostDeferred: 8 }, again);
    expect(again).toHaveBeenCalledTimes(2);
    expect(total).toMatchObject({ applied: 14, autoPostDeferred: 0 });
  });

  it('does not request again when nothing was deferred', async () => {
    const again = vi.fn();
    await applyRulesUntilSettled({ applied: 3, skipped: 0 }, again);
    expect(again).not.toHaveBeenCalled();
  });

  it('stops after a round that posts nothing but still defers — every attempted line was refused', async () => {
    const again = vi.fn().mockResolvedValue({ data: { applied: 0, skipped: 30, autoPostSkippedClosedPeriod: 24, autoPostDeferred: 6 } });
    const total = await applyRulesUntilSettled({ applied: 0, skipped: 30, autoPostSkippedClosedPeriod: 24, autoPostDeferred: 6 }, again);
    expect(again).toHaveBeenCalledTimes(1);
    expect(total.autoPostSkippedClosedPeriod).toBe(48);
  });

  it('stops on a failed round and keeps what it has', async () => {
    const again = vi.fn().mockResolvedValue({ data: undefined });
    const total = await applyRulesUntilSettled({ applied: 6, skipped: 0, autoPostDeferred: 5 }, again);
    expect(again).toHaveBeenCalledTimes(1);
    expect(total.applied).toBe(6);
  });

  it('is bounded even if the server keeps deferring and posting', async () => {
    const again = vi.fn().mockResolvedValue({ data: { applied: 1, skipped: 0, autoPostDeferred: 1 } });
    await applyRulesUntilSettled({ applied: 1, skipped: 0, autoPostDeferred: 1 }, again);
    expect(again).toHaveBeenCalledTimes(MAX_APPLY_ROUNDS - 1);
  });
});
