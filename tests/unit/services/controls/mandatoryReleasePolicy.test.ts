import { beforeEach, expect, it, vi } from 'vitest';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
import { loadApprovalRules, matchApprovalRules } from '@/modules/accounting/services/controls/approvalRuleService';

vi.mock('@/modules/accounting/services/controls/context', () => ({ assertControlTx: vi.fn() }));
const query = vi.fn();
const ctx = { principal: { companyId: 'tenant-a' }, sql: query } as unknown as ControlTx;
beforeEach(() => query.mockReset());

it('requires the persisted independent release policy even with no optional rules', async () => {
  query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'policy-a', control_version: 1, approver_role: 'admin' }]);
  const rules = await loadApprovalRules(ctx, 'payment_release');
  expect(matchApprovalRules(rules, '1', new Map())).toEqual([
    { policyId: 'policy-a', policyVersion: 1, approverRole: 'admin', mandatory: true },
  ]);
  expect(query.mock.calls[1][0].join(' ')).toContain('control_mandatory_release_policies');
  expect(query.mock.calls[1]).toContain('tenant-a');
});

it('refuses release when the persisted mandatory policy is missing', async () => {
  query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  await expect(loadApprovalRules(ctx, 'payment_release')).rejects.toThrow('Mandatory release policy');
});

it('preserves optional policies alongside the mandatory policy', async () => {
  query.mockResolvedValueOnce([{ id: 'optional', document_type: 'payment_release', condition_field: 'amount',
    condition_operator: 'any', condition_value: '0', approver_role: 'manager', control_version: 2,
    is_active: true, aggregate_window_days: null, aggregate_by: null }])
    .mockResolvedValueOnce([{ id: 'mandatory', control_version: 1, approver_role: 'admin' }]);
  expect(matchApprovalRules(await loadApprovalRules(ctx, 'payment_release'), '10', new Map()))
    .toEqual(expect.arrayContaining([
      { policyId: 'optional', policyVersion: 2, approverRole: 'manager', mandatory: false },
      { policyId: 'mandatory', policyVersion: 1, approverRole: 'admin', mandatory: true },
    ]));
});

it('does not impose release policy on accounting payment posting', async () => {
  query.mockResolvedValueOnce([]);
  expect(await loadApprovalRules(ctx, 'payment')).toEqual([]);
  expect(query).toHaveBeenCalledTimes(1);
});
