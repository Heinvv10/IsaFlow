import { describe, it, expect } from 'vitest';
import {
  decideAllocationOutcome, ruleSource, sourceFromStrategy,
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
  it('maps the four persisted strategies and nothing else', () => {
    for (const s of ['rule', 'pattern', 'historical', 'llm'] as const) expect(sourceFromStrategy(s)).toBe(s);
    expect(sourceFromStrategy(null)).toBe('none');
    expect(sourceFromStrategy('shared_pool')).toBe('none');
  });
  it('a supplier-only rule is supplier_rule', () => {
    expect(ruleSource(null, S)).toBe('supplier_rule');
    expect(ruleSource(A, S)).toBe('rule');
    expect(ruleSource(A, null)).toBe('rule');
  });
});
