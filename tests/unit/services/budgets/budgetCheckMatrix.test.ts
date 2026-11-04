/**
 * Budgets P5-2: the budget-check policy matrix (spec §3b), one test per cell, on the pure core
 * (`decideBudgetOutcome`, `sliceLines`, `mustRetryForLock`). Mutation (§7): swapping the warn and
 * block branches turns the warn/block cells red.
 */
import { describe, expect, it } from 'vitest';
import { formatMoney as R } from '@/lib/money/formatMoney';
import {
  decideBudgetOutcome, distinctKeys, mustRetryForLock, sliceLines, type DecisionInput, type DocumentLine,
} from '@/modules/accounting/services/budgets/budgetCheckCore';
import type { BudgetChannel, BudgetCheckLine } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import type { RemainingResult } from '@/modules/accounting/services/budgets/remainingBudgetCore';

const line = (over: boolean, budget: number | null = 100): BudgetCheckLine => ({
  glAccountId: 'a', month: '2026-06', grain: budget === null ? null : 'company', cc1Id: null, cc2Id: null, buId: null,
  unassigned: false, budget, actual: 0, committed: 0, remaining: budget, amount: over ? 150 : 50, over,
  accountLabel: '6100 Opex', sliceLabel: '',
});
const OVER = [line(true), line(false)];
const UNDER = [line(false)];
const NO_BUDGET = [line(false, null)];
const ALL_CHANNELS: BudgetChannel[] = ['ui', 'bulk', 'mcp', 'system'];
const decide = (i: Partial<DecisionInput> & Pick<DecisionInput, 'policy' | 'lines' | 'channel'>) => decideBudgetOutcome(i);

describe('policy off', () => {
  for (const channel of ALL_CHANNELS) {
    it(`${channel}: passes with no event, even over budget`, () => {
      expect(decide({ policy: 'off', lines: OVER, channel })).toEqual({ kind: 'proceed', event: null, warnings: [], reason: null });
    });
  }
});

describe('policy warn, no line over', () => {
  for (const channel of ALL_CHANNELS) {
    it(`${channel}: event pass when a line was checked against a budget`, () => {
      expect(decide({ policy: 'warn', lines: UNDER, channel })).toMatchObject({ kind: 'proceed', event: 'pass', warnings: [] });
    });
    it(`${channel}: no event when no line has a budget`, () => {
      expect(decide({ policy: 'warn', lines: NO_BUDGET, channel })).toMatchObject({ kind: 'proceed', event: null });
    });
  }
});

describe('policy warn, a line over', () => {
  it('ui without a reason: BUDGET_REASON_REQUIRED (blank and whitespace count as none)', () => {
    for (const reason of [undefined, null, '', '   ']) {
      const d = decide({ policy: 'warn', lines: OVER, channel: 'ui', reason });
      expect(d.kind).toBe('reason_required');
      if (d.kind === 'reason_required') expect(d.message).toContain(`6100 Opex · 2026-06: remaining ${R(100)}, this bill ${R(150)}`);
    }
  });
  it('ui with a reason: proceeds, event warn carrying the trimmed reason', () => {
    expect(decide({ policy: 'warn', lines: OVER, channel: 'ui', reason: '  year-end stock  ' }))
      .toMatchObject({ kind: 'proceed', event: 'warn', reason: 'year-end stock', warnings: [expect.stringContaining('Over budget')] });
  });
  it('bulk: proceeds with warnings, reason null (the batch reason when given)', () => {
    expect(decide({ policy: 'warn', lines: OVER, channel: 'bulk' })).toMatchObject({ kind: 'proceed', event: 'warn', reason: null });
    expect(decide({ policy: 'warn', lines: OVER, channel: 'bulk', reason: 'batch' })).toMatchObject({ event: 'warn', reason: 'batch' });
  });
  it('mcp: proceeds with warnings, reason null', () => {
    const d = decide({ policy: 'warn', lines: OVER, channel: 'mcp', reason: 'ignored' });
    expect(d).toMatchObject({ kind: 'proceed', event: 'warn', reason: null });
    if (d.kind === 'proceed') expect(d.warnings).toHaveLength(1);
  });
  it('system: proceeds, event warn, reason null', () => {
    expect(decide({ policy: 'warn', lines: OVER, channel: 'system' })).toMatchObject({ kind: 'proceed', event: 'warn', reason: null });
  });
  it('an override flag changes nothing in warn', () => {
    expect(decide({ policy: 'warn', lines: OVER, channel: 'ui', reason: 'r', override: true, actorRole: 'owner' }))
      .toMatchObject({ kind: 'proceed', event: 'warn' });
  });
});

describe('policy block, no line over', () => {
  for (const channel of ALL_CHANNELS) {
    it(`${channel}: event pass`, () => {
      expect(decide({ policy: 'block', lines: UNDER, channel })).toMatchObject({ kind: 'proceed', event: 'pass' });
    });
  }
  it('no budget anywhere: never blocked, no event', () => {
    expect(decide({ policy: 'block', lines: NO_BUDGET, channel: 'ui' })).toMatchObject({ kind: 'proceed', event: null });
  });
});

describe('policy block, a line over', () => {
  it('ui without override: refused, naming the line and the override remedy', () => {
    const d = decide({ policy: 'block', lines: OVER, channel: 'ui', reason: 'please' });
    expect(d).toMatchObject({ kind: 'refuse', overrideRefused: false });
    if (d.kind === 'refuse') expect(d.message).toContain(`remaining ${R(100)}, this bill ${R(150)}. An owner or admin can override it`);
  });
  for (const role of ['owner', 'admin']) {
    it(`ui, ${role} override with a reason: event override`, () => {
      expect(decide({ policy: 'block', lines: OVER, channel: 'ui', override: true, actorRole: role, reason: 'signed off' }))
        .toMatchObject({ kind: 'proceed', event: 'override', reason: 'signed off' });
    });
    it(`ui, ${role} override without a reason: BUDGET_REASON_REQUIRED`, () => {
      expect(decide({ policy: 'block', lines: OVER, channel: 'ui', override: true, actorRole: role, reason: ' ' }).kind).toBe('reason_required');
    });
  }
  for (const role of ['manager', 'viewer', null]) {
    it(`ui, ${String(role)} override: refused (override not theirs)`, () => {
      expect(decide({ policy: 'block', lines: OVER, channel: 'ui', override: true, actorRole: role, reason: 'r' }))
        .toMatchObject({ kind: 'refuse', overrideRefused: true });
    });
  }
  for (const channel of ['bulk', 'mcp', 'system'] as const) {
    it(`${channel}: refused, an owner's override flag ignored`, () => {
      expect(decide({ policy: 'block', lines: OVER, channel, override: true, actorRole: 'owner', reason: 'r' }))
        .toMatchObject({ kind: 'refuse', overrideRefused: false });
    });
  }
});

describe('the lock rule (§3c)', () => {
  it('block at check time with no lock held by a locking caller: retry', () => {
    expect(mustRetryForLock('block', { policy: 'warn', locked: false, mode: 'take' })).toBe(true);
    expect(mustRetryForLock('block', { policy: 'warn', locked: false, mode: 'held' })).toBe(true);
  });
  it('lock held, or a lock-free caller, or not block: no retry', () => {
    expect(mustRetryForLock('block', { policy: 'block', locked: true, mode: 'take' })).toBe(false);
    expect(mustRetryForLock('block', { policy: null, locked: false, mode: 'none' })).toBe(false);
    expect(mustRetryForLock('warn', { policy: 'block', locked: true, mode: 'held' })).toBe(false);
  });
});

describe('sliceLines', () => {
  const res = (key: RemainingResult['key'], over: Partial<RemainingResult>): RemainingResult => ({
    key, versionId: 'v', grain: 'cc1', slice: { cc1Id: 'ft', cc2Id: null, buId: null }, unassigned: false,
    budget: 100, actual: 20, committed: 0, remaining: 80, ...over,
  });
  it('sums two lines on one slice (each fits alone, together they do not)', () => {
    const lines: DocumentLine[] = [
      { glAccountId: 'A', cc1Id: 'FT', cc2Id: 'P1', buId: null, amount: 50 },
      { glAccountId: 'A', cc1Id: 'FT', cc2Id: 'P2', buId: null, amount: 40 },
    ];
    const keys = distinctKeys(lines, '2026-06');
    expect(keys).toHaveLength(2);
    const out = sliceLines(lines, keys, keys.map((k) => res(k, {})));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ amount: 90, remaining: 80, over: true, cc1Id: 'ft', cc2Id: null });
  });
  it('a zero budget is a budget: any spend is over; no budget never is', () => {
    const lines: DocumentLine[] = [{ glAccountId: 'A', cc1Id: null, cc2Id: null, buId: null, amount: 0.01 }];
    const keys = distinctKeys(lines, '2026-06');
    expect(sliceLines(lines, keys, [res(keys[0]!, { budget: 0, actual: 0, remaining: 0 })])[0]!.over).toBe(true);
    expect(sliceLines(lines, keys, [res(keys[0]!, { budget: null, remaining: null, grain: null })])[0]!.over).toBe(false);
  });
  it('exactly the remaining is not over; a cent more is', () => {
    const at = (amount: number) => {
      const lines: DocumentLine[] = [{ glAccountId: 'A', cc1Id: 'FT', cc2Id: null, buId: null, amount }];
      const keys = distinctKeys(lines, '2026-06');
      return sliceLines(lines, keys, [res(keys[0]!, {})])[0]!.over;
    };
    expect(at(80)).toBe(false);
    expect(at(80.01)).toBe(true);
  });
});
