/**
 * Learning loop: a rule auto-post records an auto-posted decision for each line it POSTED (source rule,
 * the rule's account); a skipped line records nothing. Setup mirrors bankRulesSweepContention.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, autoPostMock, findTxsMock, recordAutoPosted } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  autoPostMock: vi.fn(),
  findTxsMock: vi.fn(),
  recordAutoPosted: vi.fn(async () => undefined),
}));

vi.mock('@/lib/neon', () => ({ sql: sqlMock, withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/codingDecisionLog', () => ({ recordAutoPosted, recordSuggestionsShown: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccountId: vi.fn(async (k: string) => `acct-${k}`) }));
vi.mock('@/modules/accounting/services/gl/inputVatDenial', () => ({ fetchVatDenialFlags: vi.fn(async () => new Map()) }));
vi.mock('@/modules/accounting/services/gl/nonSupplyVatGuard', () => ({ fetchAccountNames: vi.fn(async () => new Map()) }));
vi.mock('@/modules/accounting/services/gl/bankContraVat', () => ({ fetchBankContraFlags: vi.fn(async () => new Map()) }));
vi.mock('@/modules/accounting/services/bank/bankRulesMatchingHelpers', () => ({
  toSqlPattern: vi.fn((_m: string, p: string) => p), findMatchingTxs: findTxsMock, MAX_RULE_CANDIDATES: 500,
}));
vi.mock('@/modules/accounting/services/bank/bankRuleAutoPostLine', () => ({ autoPostRuleLine: autoPostMock }));

import { applyRules } from '@/modules/accounting/services/bank/bankRulesMatchingService';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const BANK_GL = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('FROM bank_categorisation_rules')) {
      return Promise.resolve([{
        id: 'rule-1', rule_name: 'Bank charges', priority: 1, auto_create_entry: true,
        gl_account_id: 'acct-charges', match_field: 'description', match_type: 'contains', match_pattern: 'FEE', vat_code: 'none',
      }]);
    }
    if (text.includes('FROM gl_accounts')) return Promise.resolve([{ id: BANK_GL }]);
    return Promise.resolve([]);
  }) as never);
  findTxsMock.mockResolvedValue([
    { id: 'tx-1', transaction_date: '2026-08-13', amount: -100, description: 'BANK FEE' },
    { id: 'tx-2', transaction_date: '2026-08-14', amount: -200, description: 'BANK FEE' },
  ]);
});

describe('applyRules -> decision log', () => {
  it('records only the posted line, as a rule auto-post to the rule\'s account', async () => {
    autoPostMock
      .mockResolvedValueOnce({ kind: 'closed_period' })
      .mockResolvedValueOnce({ kind: 'posted', journalEntryId: 'je-2' });

    await applyRules(COMPANY, BANK_GL, USER);

    expect(recordAutoPosted).toHaveBeenCalledTimes(1);
    expect(recordAutoPosted).toHaveBeenCalledWith(COMPANY, {
      txId: 'tx-2', source: 'rule', glAccountId: 'acct-charges', contactId: null, journalEntryId: 'je-2', target: 'own',
    });
    // The rule's free-text name is not passed on (data minimisation).
    expect(JSON.stringify(recordAutoPosted.mock.calls)).not.toContain('Bank charges');
  });
});
