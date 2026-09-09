import { expect, it } from 'vitest';
import { matchApprovalRules } from '@/modules/accounting/services/controls/approvalRuleService';

const rule = { id: 'rule-a', document_type: 'payment', condition_field: 'amount',
  condition_operator: 'greater_than', condition_value: '10000.00', approver_role: 'admin',
  control_version: 1, is_active: true, aggregate_window_days: null, aggregate_by: null };
it('matches every applicable policy rather than first priority match', () => {
  expect(matchApprovalRules([rule, { ...rule, id: 'rule-b' }], '12000', new Map()).map(p => p.policyId))
    .toEqual(['rule-a', 'rule-b']);
});
it('compares exact decimals and makes the greater/equal boundary explicit', () => {
  expect(matchApprovalRules([rule], '10000', new Map())).toHaveLength(0);
  expect(matchApprovalRules([{ ...rule, condition_operator: 'greater_equal' }], '10000', new Map())).toHaveLength(1);
  expect(matchApprovalRules([{ ...rule, condition_value: '9007199254740993.01' }], '9007199254740993.02', new Map())).toHaveLength(1);
});
it('applies the configured daily supplier aggregate to resist split payments', () => {
  const aggregate = { ...rule, aggregate_window_days: 1, aggregate_by: 'supplier' };
  expect(matchApprovalRules([aggregate], '6000', new Map([['rule-a', '6000']]))).toHaveLength(1);
});
it('does not round away small prior exposure at a large exact threshold', () => {
  const aggregate = { ...rule, aggregate_window_days: 1, aggregate_by: 'supplier',
    condition_value: '9007199254740993.000000005' };
  expect(matchApprovalRules([aggregate], '9007199254740993', new Map([['rule-a', '0.00000001']])))
    .toHaveLength(1);
});
it.each([
  { condition_operator: 'unsupported' }, { condition_field: 'caller_amount' },
  { control_version: 0 }, { approver_role: '' }, { aggregate_window_days: 30 },
  { aggregate_window_days: 1, aggregate_by: null }, { condition_value: 'NaN' },
])('fails closed for unsupported/malformed active policy %j', patch => {
  expect(() => matchApprovalRules([{ ...rule, ...patch }], '1', new Map())).toThrow();
});
it('evaluates unconditional nonfinancial policies without inventing an amount',()=>{
  expect(matchApprovalRules([{...rule,condition_operator:'any'}],null,new Map())).toHaveLength(1);
  expect(matchApprovalRules([],null,new Map())).toEqual([]);
});
it('refuses monetary and aggregate policies for nonfinancial material',()=>{
  expect(()=>matchApprovalRules([rule],null,new Map())).toThrow();
  expect(()=>matchApprovalRules([{...rule,condition_operator:'any',aggregate_window_days:1,aggregate_by:'supplier'}],null,new Map())).toThrow();
});
