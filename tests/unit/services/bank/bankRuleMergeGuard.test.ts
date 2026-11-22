/**
 * #1656 round 7 (breaker M2): a customer merge re-points every bank rule naming the merged-away customer to the survivor. A rule that posts
 * money (its own auto_create_entry, or company auto-post being on: bank_rule_posts_money, 877) posts a journal for every line it matches, so
 * moving it changes where those journals go: the same approval act as editing its customer. moveRulesToCustomer now runs the rule-write guard
 * for each rule under the rule lock, before any write, and the two merge routes pass autoPostApprovalGuard(Banking Approve).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rules: [] as Array<{ rule_name: string; before: Record<string, unknown>; auto_posts: boolean }>, enforced: false, writes: [] as string[] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/gl/approvalEnforcement', () => ({ isEnforced: vi.fn(async () => state.enforced) }));
vi.mock('@/modules/accounting/services/bank/bankRuleAutoPostLock', () => ({ lockForRuleWrite: vi.fn(async () => undefined) }));

import { moveRulesToCustomer } from '@/modules/accounting/services/bank/bankRuleChangeControl';
import { autoPostApprovalGuard } from '@/modules/accounting/services/bank/bankRuleAutoPostApproval';
import { ApprovePermissionError } from '@/modules/accounting/services/core/approvePermission';
import { BankControlError } from '@/modules/accounting/services/bank/bankControlRefusal';

const C = '11111111-1111-4111-8111-111111111111';
const SRC = '22222222-2222-4222-8222-222222222222';
const DST = '33333333-3333-4333-8333-333333333333';

const tx = (async (strings: TemplateStringsArray) => {
  const q = strings.join('?');
  if (/^\s*SELECT r\.rule_name/.test(q)) return state.rules;
  if (/UPDATE bank_categorisation_rules/.test(q)) state.writes.push('update');
  return [];
}) as never;

const rule = (over: Record<string, unknown>, autoPosts: boolean) => ({
  rule_name: 'Fuel', auto_posts: autoPosts,
  before: { match_field: 'description', match_type: 'contains', match_pattern: 'ENGEN', client_id: SRC, auto_create_entry: false, is_active: true, priority: 100, ...over },
});

beforeEach(() => { state.rules = []; state.enforced = false; state.writes = []; });

describe('moveRulesToCustomer with the rule-write guard', () => {
  it('a posting rule, no Banking Approve: ApprovePermissionError (403) and nothing is moved', async () => {
    state.rules = [rule({ auto_create_entry: true }, true)];
    await expect(moveRulesToCustomer(tx, C, SRC, DST, autoPostApprovalGuard(false))).rejects.toBeInstanceOf(ApprovePermissionError);
    expect(state.writes).toEqual([]);
  });

  it('a rule that posts only because company auto-post is on (flag false) is refused all the same', async () => {
    state.rules = [rule({ auto_create_entry: false }, true)];
    await expect(moveRulesToCustomer(tx, C, SRC, DST, autoPostApprovalGuard(false))).rejects.toBeInstanceOf(ApprovePermissionError);
    expect(state.writes).toEqual([]);
  });

  it('with Banking Approve the posting rule is moved', async () => {
    state.rules = [rule({ auto_create_entry: true }, true)];
    await moveRulesToCustomer(tx, C, SRC, DST, autoPostApprovalGuard(true));
    expect(state.writes).toEqual(['update']);
  });

  it('a rule that posts nothing moves without Banking Approve', async () => {
    state.rules = [rule({}, false)];
    await moveRulesToCustomer(tx, C, SRC, DST, autoPostApprovalGuard(false));
    expect(state.writes).toEqual(['update']);
  });

  it('the guard sees the rule as it would stand: the customer is the survivor', async () => {
    state.rules = [rule({ auto_create_entry: true }, true)];
    const guard = vi.fn();
    await moveRulesToCustomer(tx, C, SRC, DST, guard);
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ client_id: DST }), true, expect.objectContaining({ client_id: SRC }), true);
  });

  it('one posting rule among several refuses the whole merge', async () => {
    state.rules = [rule({}, false), rule({ rule_name: 'Rent', auto_create_entry: true }, true)];
    await expect(moveRulesToCustomer(tx, C, SRC, DST, autoPostApprovalGuard(false))).rejects.toBeInstanceOf(ApprovePermissionError);
    expect(state.writes).toEqual([]);
  });

  it('an approver under bank_rule enforcement still gets the existing 409 hold (the table would refuse mid-merge)', async () => {
    state.rules = [rule({ auto_create_entry: true }, true)];
    state.enforced = true;
    await expect(moveRulesToCustomer(tx, C, SRC, DST, autoPostApprovalGuard(true))).rejects.toBeInstanceOf(BankControlError);
    expect(state.writes).toEqual([]);
  });
});
