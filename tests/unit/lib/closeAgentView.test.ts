/**
 * Unit tests for the Close Agent pure view-model helpers (P5.2 surface).
 * No React, no DB — just the logic the Month-End tab and bureau cockpit use to
 * resolve a period, group proposals, phrase accuracy honestly, and count
 * "closable" clients.
 */

import { describe, it, expect } from 'vitest';
import {
  resolvePeriodId,
  groupProposals,
  formatAcceptance,
  isClientClosable,
  countClosable,
} from '@/lib/closeAgentView';

describe('resolvePeriodId', () => {
  const periods = [
    { id: 'p-jul', startDate: '2026-07-01', status: 'open' },
    { id: 'p-aug', startDate: '2026-08-01', status: 'closed' },
  ];
  it('matches the period whose start date is the first of the month', () => {
    expect(resolvePeriodId(periods, '2026-07')).toEqual({ id: 'p-jul', status: 'open' });
    expect(resolvePeriodId(periods, '2026-08')).toEqual({ id: 'p-aug', status: 'closed' });
  });
  it('returns null when no period covers the month', () => {
    expect(resolvePeriodId(periods, '2026-09')).toBeNull();
  });
  it('tolerates a full ISO timestamp in startDate', () => {
    expect(resolvePeriodId([{ id: 'x', startDate: '2026-07-01T00:00:00.000Z', status: 'open' }], '2026-07'))
      .toEqual({ id: 'x', status: 'open' });
  });
});

describe('groupProposals', () => {
  const P = (over: Record<string, unknown>) => ({
    id: 'x', closeRunId: 'r', kind: 'post_draft_journal', actionType: 'auto_post',
    title: 't', reasoning: 'r', evidence: { summary: 's' }, targetEntityType: null,
    targetEntityId: null, status: 'proposed', decidedBy: null, decidedAt: null, result: null, createdAt: '',
    ...over,
  });
  it('splits auto_post from advisory', () => {
    const g = groupProposals([
      P({ id: '1', actionType: 'auto_post' }),
      P({ id: '2', actionType: 'advisory', kind: 'bank_unreconciled' }),
      P({ id: '3', actionType: 'auto_post' }),
    ] as never);
    expect(g.autoPost.map(p => p.id)).toEqual(['1', '3']);
    expect(g.advisory.map(p => p.id)).toEqual(['2']);
  });
  it('reports how many auto_post proposals still await a decision', () => {
    const g = groupProposals([
      P({ id: '1', actionType: 'auto_post', status: 'proposed' }),
      P({ id: '2', actionType: 'auto_post', status: 'posted' }),
      P({ id: '3', actionType: 'advisory', status: 'proposed' }),
    ] as never);
    expect(g.pendingCount).toBe(2); // proposals still 'proposed' (both types)
  });
});

describe('formatAcceptance (honest phrasing)', () => {
  it('says "no decisions yet" when nothing decided', () => {
    expect(formatAcceptance({ acceptanceRate: null, proposed: 3, posted: 0, rejected: 0, failed: 0, dismissed: 0, decided: 0 }))
      .toMatch(/no.*decision/i);
  });
  it('reports posted of decided with a percentage', () => {
    const s = formatAcceptance({ acceptanceRate: 0.8, proposed: 10, posted: 8, rejected: 2, failed: 0, dismissed: 0, decided: 10 });
    expect(s).toContain('8');
    expect(s).toContain('10');
    expect(s).toContain('80%');
  });
});

describe('isClientClosable / countClosable (bureau rollup)', () => {
  const row = (over: Record<string, unknown>) => ({
    companyId: 'c', companyName: 'X', isDefault: false, role: 'admin',
    trialBalanceBalanced: true, cards: [], readyCount: 8, attentionCount: 0, blockedCount: 0,
    failed: false, ...over,
  });
  it('is closable only with no attention, no blocked, TB balanced, not failed', () => {
    expect(isClientClosable(row({}) as never)).toBe(true);
    expect(isClientClosable(row({ attentionCount: 1 }) as never)).toBe(false);
    expect(isClientClosable(row({ blockedCount: 1 }) as never)).toBe(false);
    expect(isClientClosable(row({ trialBalanceBalanced: false }) as never)).toBe(false);
    expect(isClientClosable(row({ failed: true }) as never)).toBe(false);
  });
  it('counts closable clients', () => {
    const rows = [row({}), row({ attentionCount: 2 }), row({})];
    expect(countClosable(rows as never)).toBe(2);
  });
});
