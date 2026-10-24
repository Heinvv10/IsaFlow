/**
 * Decision 8: a shared-pool suggestion is NEVER auto-posted — not by the gate, not by a sweep, whatever the
 * company's auto-post settings or the confidence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn() }) }));
vi.mock('@/lib/neon', () => ({
  sql: sqlMock, withTransaction: vi.fn(), transaction: vi.fn(),
  withSavepoint: vi.fn(<T,>(_name: string, fn: () => Promise<T>) => fn()),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({ allocateTransaction: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/provisionalPostingService', () => ({ postProvisional: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/codingDecisionLog', () => ({ recordAutoPosted: vi.fn() }));

import { evaluate, sweep, type AutoPostSettings, type GateTx } from '@/modules/accounting/services/bank/autoPostGateService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { isSharedPoolStrategy } from '@/modules/accounting/services/core/categorizationStrategy';

const EVERYTHING_ON: AutoPostSettings = {
  enabled: true, minConfidence: 0.01, amountCap: 0, llmEnabled: true, llmMinConfidence: 0.01, llmAmountCap: 0,
};
const tx: GateTx = { status: 'imported', amount: -10, suggestedGlAccountId: 'gl-1' };

describe('evaluate — shared_pool', () => {
  it('skips a shared_pool suggestion at confidence 1 with every setting wide open', () => {
    expect(evaluate(tx, 1, EVERYTHING_ON, 'shared_pool'))
      .toEqual({ outcome: 'skip', reason: 'shared pool suggestions are never auto-posted' });
  });

  it('skips it on the provisional path too (null confidence)', () => {
    expect(evaluate(tx, null, EVERYTHING_ON, 'shared_pool').outcome).toBe('skip');
  });

  it('the same line from a pattern still posts (the guard is about the source only)', () => {
    expect(evaluate(tx, 1, EVERYTHING_ON, 'pattern')).toEqual({ outcome: 'post' });
  });

  it('isSharedPoolStrategy is exact', () => {
    expect(isSharedPoolStrategy('shared_pool')).toBe(true);
    for (const s of [null, undefined, '', 'pattern', 'llm', 'SHARED_POOL', 'shared_pool ']) expect(isSharedPoolStrategy(s)).toBe(false);
  });
});

describe('sweep — shared_pool lines', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    (allocateTransaction as ReturnType<typeof vi.fn>).mockReset();
  });

  it('never allocates a line whose suggestion came from the pool, and still posts its neighbour', async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (/FROM bank_auto_post_settings/.test(text)) {
        return Promise.resolve([{ enabled: true, min_confidence: '0.5', amount_cap: '0', llm_enabled: true, llm_min_confidence: '0.5', llm_amount_cap: '0' }]);
      }
      if (/FROM bank_transactions\s+WHERE id = ANY/.test(text)) {
        return Promise.resolve([
          { id: 'pool', status: 'imported', feed_state: 'posted', amount: -50, suggested_gl_account_id: 'gl-1', suggested_confidence: '0.80', suggested_vat_code: null, suggested_strategy: 'shared_pool', description: 'ENGEN' },
          { id: 'own', status: 'imported', feed_state: 'posted', amount: -50, suggested_gl_account_id: 'gl-1', suggested_confidence: '0.95', suggested_vat_code: null, suggested_strategy: 'pattern', description: 'ENGEN' },
        ]);
      }
      if (/INSERT INTO bank_auto_post_runs/.test(text)) return Promise.resolve([{ id: 'run-1' }]);
      return Promise.resolve([]);
    });
    (allocateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({ journalEntryId: 'je-1' });

    const r = await sweep('co-1', ['pool', 'own'], 'categorization', 'u-1');

    expect(r.posted).toBe(1);
    expect(r.skipped).toEqual([{ txId: 'pool', reason: 'shared pool suggestions are never auto-posted' }]);
    const allocated = (allocateTransaction as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(allocated).toEqual(['own']);
  });
});
