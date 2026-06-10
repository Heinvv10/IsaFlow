import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: () => Promise.resolve([]) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  selectResidualTxIds,
  runLlmResidualPass,
  remainingFromCount,
  DAILY_LLM_CEILING,
  type ResidualCandidate,
  type LlmCatResult,
  type LlmTxContext,
} from '@/modules/accounting/services/bank/llmCategorizationPass';

const c = (id: string, o: Partial<ResidualCandidate> = {}): ResidualCandidate => ({
  id, suggestedGlAccountId: null, suggestedConfidence: null, status: 'imported', ...o,
});

describe('selectResidualTxIds', () => {
  it('includes imported txs with no suggestion', () => {
    expect(selectResidualTxIds([c('a')], 200)).toEqual(['a']);
  });
  it('includes imported txs whose confidence is below MEDIUM (0.60)', () => {
    expect(selectResidualTxIds([c('a', { suggestedGlAccountId: 'gl', suggestedConfidence: 0.45 })], 200)).toEqual(['a']);
  });
  it('excludes confident suggestions (>= 0.60)', () => {
    expect(selectResidualTxIds([c('a', { suggestedGlAccountId: 'gl', suggestedConfidence: 0.7 })], 200)).toEqual([]);
  });
  it('excludes non-imported txs', () => {
    expect(selectResidualTxIds([c('a', { status: 'matched' })], 200)).toEqual([]);
  });
  it('caps the residual list at maxCalls', () => {
    expect(selectResidualTxIds([c('a'), c('b'), c('d')], 2)).toEqual(['a', 'b']);
  });
});

// ─── Task 8: runLlmResidualPass ───────────────────────────────────────────────

const mockResult: LlmCatResult = {
  glAccountId: 'gl-1', vatCode: 'standard', confidence: 0.97, accountCode: '5200', accountName: 'Office',
};

const makeTx = (id: string): LlmTxContext => ({
  id, status: 'imported', suggestedGlAccountId: null, suggestedConfidence: null,
  description: id === 't1' ? 'X' : 'Y', amount: -100, transactionDate: '2026-01-01',
});

// ─── Task 9: remainingFromCount (pure daily ceiling math) ─────────────────────

describe('remainingFromCount', () => {
  it('returns headroom when count is below ceiling', () => {
    expect(remainingFromCount(950)).toBe(DAILY_LLM_CEILING - 950);
  });
  it('clamps to 0 when count exceeds ceiling', () => {
    expect(remainingFromCount(1200)).toBe(0);
  });
});

describe('runLlmResidualPass', () => {
  it('calls the LLM seam once per residual id and persists strategy=llm', async () => {
    const categorizeOne = vi.fn<[LlmTxContext, unknown[]], Promise<LlmCatResult | null>>()
      .mockResolvedValue(mockResult);
    const persisted: string[] = [];

    await runLlmResidualPass('company-1', ['t1', 't2'], 'user-1', {
      maxCalls: 200,
      dailyRemaining: 100,
      loadAccounts: async () => [{ code: '5200', name: 'Office', type: 'expense' }],
      loadCandidates: async () => [makeTx('t1'), makeTx('t2')],
      persist: async (txId) => { persisted.push(txId); },
      sweep: async () => ({ runId: null, posted: 0, skipped: [] }),
      categorizeOne,
    });

    expect(categorizeOne).toHaveBeenCalledTimes(2);
    expect(persisted.sort()).toEqual(['t1', 't2']);
  });

  it('no-ops when dailyRemaining is 0', async () => {
    const categorizeOne = vi.fn();

    await runLlmResidualPass('company-1', ['t1'], 'user-1', {
      maxCalls: 200,
      dailyRemaining: 0,
      loadAccounts: async () => [],
      loadCandidates: async () => [],
      persist: async () => {},
      sweep: async () => ({ runId: null, posted: 0, skipped: [] }),
      categorizeOne,
    });

    expect(categorizeOne).not.toHaveBeenCalled();
  });
});
