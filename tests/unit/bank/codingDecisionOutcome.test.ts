import { describe, it, expect } from 'vitest';
import {
  decideAllocationOutcome, isRuleSource, matchedTarget, ruleSource, sourceFromStrategy,
} from '@/modules/accounting/services/bank/codingDecisionOutcome';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const S = 'cccccccc-0000-4000-8000-000000000003';

describe('decideAllocationOutcome', () => {
  it('the suggested GL account: accepted', () => {
    expect(decideAllocationOutcome({ glAccountId: A, contactId: null }, { glAccountId: A, contactId: null })).toBe('accepted');
  });
  it('compares ids case-insensitively', () => {
    expect(decideAllocationOutcome({ glAccountId: A.toUpperCase(), contactId: null }, { glAccountId: A, contactId: null })).toBe('accepted');
  });
  it('another account: recoded', () => {
    expect(decideAllocationOutcome({ glAccountId: A, contactId: null }, { glAccountId: B, contactId: null })).toBe('recoded');
  });
  it('the supplier a rule suggested: accepted', () => {
    expect(decideAllocationOutcome({ glAccountId: null, contactId: S }, { glAccountId: null, contactId: S })).toBe('accepted');
  });
  it('a split (no single target): recoded', () => {
    expect(decideAllocationOutcome({ glAccountId: A, contactId: null }, { glAccountId: null, contactId: null })).toBe('recoded');
  });
  it('two nulls never match', () => {
    expect(decideAllocationOutcome({ glAccountId: null, contactId: null }, { glAccountId: null, contactId: null })).toBe('recoded');
  });
});

describe('sourceFromStrategy / ruleSource', () => {
  // PR 2 persists 'shared_pool' (the shared merchant pool's cold-start suggestion), so it is now a
  // strategy of its own rather than 'none'.
  it('maps the five persisted strategies and nothing else', () => {
    for (const s of ['rule', 'pattern', 'historical', 'llm', 'shared_pool'] as const) expect(sourceFromStrategy(s)).toBe(s);
    expect(sourceFromStrategy(null)).toBe('none');
    expect(sourceFromStrategy('supplier_rule')).toBe('none');
    expect(sourceFromStrategy('SHARED_POOL')).toBe('none');
  });
  it('a supplier-only rule is supplier_rule', () => {
    expect(ruleSource(null, S)).toBe('supplier_rule');
    expect(ruleSource(A, S)).toBe('rule');
    expect(ruleSource(A, null)).toBe('rule');
  });
});

describe('matchedTarget (what a match coded the line to)', () => {
  it('the journal carries the suggested account among several: that account', () => {
    expect(matchedTarget({ glAccountId: A, contactId: null }, [B, A.toUpperCase()], [])).toEqual({ glAccountId: A.toUpperCase(), contactId: null });
  });
  it('one other account: that account; several and none suggested: null', () => {
    expect(matchedTarget({ glAccountId: A, contactId: null }, [B], []).glAccountId).toBe(B);
    expect(matchedTarget({ glAccountId: A, contactId: null }, [B, S], []).glAccountId).toBeNull();
  });
  it('the supplier the rule suggested is the payment\'s supplier: accepted', () => {
    const final = matchedTarget({ glAccountId: null, contactId: S }, [B], [S]);
    expect(decideAllocationOutcome({ glAccountId: null, contactId: S }, final)).toBe('accepted');
  });
});

describe('isRuleSource', () => {
  it('rule and supplier_rule only', () => {
    expect([isRuleSource('rule'), isRuleSource('supplier_rule'), isRuleSource('pattern'), isRuleSource('llm')])
      .toEqual([true, true, false, false]);
  });
});
