/**
 * Decision 8, cold start: in bulkCategorize the shared pool is asked only for lines the company's own
 * rules, patterns and history left unmatched, before the LLM residual pass; its suggestion is written with
 * suggested_strategy 'shared_pool' and logged in the decision log with source 'shared_pool'.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, recordSuggestionsShown, getSharedSuggestions } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  recordSuggestionsShown: vi.fn(async () => undefined),
  getSharedSuggestions: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/codingDecisionLog', () => ({ recordSuggestionsShown, recordAutoPosted: vi.fn() }));
vi.mock('@/modules/accounting/services/sharedPool/sharedSuggestionService', () => ({ getSharedSuggestions }));

import { bulkCategorize } from '@/modules/accounting/services/core/smartCategorizationService';

const CO = '00000000-0000-4000-8000-000000000001';
const RULE_GL = '00000000-0000-4000-8000-0000000000aa';
const POOL_GL = '00000000-0000-4000-8000-0000000000bb';
const POOL_RESULT = {
  glAccountId: POOL_GL, category: 'Fuel', vatCode: 'standard', confidence: 0.7, confidenceLevel: 'MEDIUM',
  matchSource: 'shared_pool', matchDetail: 'Common at other ISAFlow clients',
};

beforeEach(() => {
  sqlMock.mockReset();
  recordSuggestionsShown.mockClear();
  getSharedSuggestions.mockReset();
  sqlMock.mockImplementation(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.join('?');
    if (/SELECT id, description, amount, reference/.test(text)) {
      return [
        { id: 'ruled', description: 'TELKOM DEBIT', amount: -500, reference: '' },
        { id: 'cold', description: 'ENGEN SANDTON', amount: -300, reference: '' },
      ];
    }
    if (/FROM bank_categorisation_rules/.test(text)) {
      return [{ id: 'r1', match_type: 'contains', match_pattern: 'TELKOM', match_field: 'description', gl_account_id: RULE_GL, priority: 1, rule_name: 'Phone' }];
    }
    if (/UPDATE bank_transactions SET/.test(text)) return [{ id: vals[vals.length - 2] }];
    return [];
  });
});

describe('bulkCategorize cold start', () => {
  it('asks the pool only for the line nothing of the company matched', async () => {
    getSharedSuggestions.mockResolvedValue(new Map([['cold', POOL_RESULT]]));
    await bulkCategorize(CO, ['ruled', 'cold']);
    expect(getSharedSuggestions).toHaveBeenCalledTimes(1);
    expect(getSharedSuggestions).toHaveBeenCalledWith(CO, [{ txId: 'cold', description: 'ENGEN SANDTON' }]);
  });

  it('writes the pool suggestion as suggested_strategy shared_pool and logs it as source shared_pool', async () => {
    getSharedSuggestions.mockResolvedValue(new Map([['cold', POOL_RESULT]]));
    const r = await bulkCategorize(CO, ['ruled', 'cold']);
    expect(r.categorized).toBe(2);
    const update = sqlMock.mock.calls.find((c) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE bank_transactions SET') && c.includes('cold'))!;
    expect(update).toContain('shared_pool');
    expect(update).toContain(POOL_GL);
    const entries = (recordSuggestionsShown.mock.calls[0] as unknown as [string, Array<Record<string, unknown>>])[1];
    expect(entries).toEqual(expect.arrayContaining([
      { txId: 'cold', source: 'shared_pool', glAccountId: POOL_GL, category: 'Fuel', confidence: 0.7 },
      expect.objectContaining({ txId: 'ruled', source: 'rule' }),
    ]));
  });

  it('when every line matched the company\'s own coding, the pool is not asked at all', async () => {
    sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (/SELECT id, description, amount, reference/.test(text)) return [{ id: 'ruled', description: 'TELKOM DEBIT', amount: -5, reference: '' }];
      if (/FROM bank_categorisation_rules/.test(text)) {
        return [{ id: 'r1', match_type: 'contains', match_pattern: 'TELKOM', match_field: 'description', gl_account_id: RULE_GL, priority: 1, rule_name: 'Phone' }];
      }
      if (/UPDATE bank_transactions SET/.test(text)) return [{ id: 'ruled' }];
      return [];
    });
    await bulkCategorize(CO, ['ruled']);
    expect(getSharedSuggestions).not.toHaveBeenCalled();
  });
});

describe('pool before the LLM residual pass', () => {
  it('the pool floor equals the residual ceiling, so a pool suggestion is not re-selected for the LLM', async () => {
    const { RESIDUAL_CONFIDENCE_CEILING, selectResidualTxIds } = await vi.importActual<
      typeof import('@/modules/accounting/services/bank/llmCategorizationPass')>('@/modules/accounting/services/bank/llmCategorizationPass');
    const { SHARED_POOL_MIN_CONFIDENCE } = await vi.importActual<
      typeof import('@/modules/accounting/services/sharedPool/sharedSuggestionService')>('@/modules/accounting/services/sharedPool/sharedSuggestionService');
    expect(SHARED_POOL_MIN_CONFIDENCE).toBe(RESIDUAL_CONFIDENCE_CEILING);
    expect(selectResidualTxIds([
      { id: 'pooled', status: 'imported', suggestedGlAccountId: POOL_GL, suggestedConfidence: SHARED_POOL_MIN_CONFIDENCE },
      { id: 'nothing', status: 'imported', suggestedGlAccountId: null, suggestedConfidence: null },
    ], 10)).toEqual(['nothing']);
  });
});
