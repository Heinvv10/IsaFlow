/**
 * Learning loop: every path that writes an ISAFlow suggestion onto a bank line opens a pending decision
 * with the suggestion it wrote (not whatever sits in suggested_* — save_selection puts a person's pick
 * there). The decision log is mocked to observe the calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, recordSuggestionsShown } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  recordSuggestionsShown: vi.fn(async () => undefined),
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/codingDecisionLog', () => ({ recordSuggestionsShown, recordAutoPosted: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/inputVatDenial', () => ({
  resolveVatCodeForAccount: vi.fn(async (_c: string, _g: string, vat: string | undefined) => ({ vatCode: vat ?? null })),
}));

import { applySuggestionRules } from '@/modules/accounting/services/bank/bankRulesSuggestionPass';
import { bulkCategorize } from '@/modules/accounting/services/core/smartCategorizationService';
import { persistLlmResult } from '@/modules/accounting/services/bank/llmCategorizationPass';

const CO = '00000000-0000-4000-8000-000000000001';
const GL = '00000000-0000-4000-8000-0000000000aa';
const SUP = '00000000-0000-4000-8000-0000000000bb';

beforeEach(() => {
  sqlMock.mockReset();
  recordSuggestionsShown.mockClear();
});

describe('rule suggestion pass', () => {
  it('records each changed line with the rule\'s target; a supplier-only rule is supplier_rule', async () => {
    sqlMock.mockResolvedValueOnce([
      { id: 't1', rule_name: 'Fuel', gl_account_id: GL, supplier_id: null, client_id: null },
      { id: 't2', rule_name: 'Telkom', gl_account_id: null, supplier_id: SUP, client_id: null },
    ]);
    await applySuggestionRules(CO, 'bank-1', [{ id: 'r1', match_type: 'contains', match_pattern: 'x' }]);
    // The rule's free-text name is not passed on (data minimisation).
    expect(recordSuggestionsShown).toHaveBeenCalledWith(CO, [
      { txId: 't1', source: 'rule', glAccountId: GL, contactId: null },
      { txId: 't2', source: 'supplier_rule', glAccountId: null, contactId: SUP },
    ]);
  });
});

describe('bulkCategorize', () => {
  it('records only the lines its UPDATE actually wrote', async () => {
    sqlMock.mockImplementation(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      const text = strings.join('?');
      if (/SELECT id, description, amount, reference/.test(text)) {
        return [{ id: 't1', description: 'ENGEN GARAGE', amount: -500, reference: '' }, { id: 't2', description: 'ENGEN GARAGE', amount: -300, reference: '' }];
      }
      if (/FROM bank_categorisation_rules/.test(text)) {
        return [{ id: 'r1', match_type: 'contains', match_pattern: 'ENGEN', match_field: 'description', gl_account_id: GL, gl_account_code: '4100', gl_account_name: 'Fuel', priority: 1, rule_name: 'Fuel' }];
      }
      // t2 already carried a suggested account (a person's saved pick), so the UPDATE skipped it.
      if (/UPDATE bank_transactions SET/.test(text)) return vals.includes('t1') ? [{ id: 't1' }] : [];
      return [];
    });
    const r = await bulkCategorize(CO, ['t1', 't2']);
    expect(r.categorized).toBe(2);
    expect(recordSuggestionsShown).toHaveBeenCalledTimes(1);
    const entries = (recordSuggestionsShown.mock.calls[0] as unknown as [string, Array<{ txId: string; source: string; glAccountId: string }>])[1];
    expect(entries.map((e) => e.txId)).toEqual(['t1']);
    expect(entries[0]).toMatchObject({ source: 'rule', glAccountId: GL });
  });
});

describe('LLM residual pass', () => {
  it('records the model\'s suggestion as llm with its confidence', async () => {
    sqlMock.mockResolvedValue([]);
    await persistLlmResult(CO, 't9', { glAccountId: GL, confidence: 0.81, accountCode: '4100', accountName: 'Fuel' });
    expect(recordSuggestionsShown).toHaveBeenCalledWith(CO, [{ txId: 't9', source: 'llm', glAccountId: GL, confidence: 0.81 }]);
  });
});
