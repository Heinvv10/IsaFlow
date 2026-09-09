import { expect, it, vi } from 'vitest';
import { matchOperationPolicies } from '@/modules/accounting/services/controls/aggregateOperationPolicy';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
import type { ApMaterial } from '@/modules/accounting/services/controls/apOperationMaterializer';
vi.mock('@/modules/accounting/services/controls/context', () => ({ assertControlTx: vi.fn() }));
const rule = { id: 'daily', document_type: 'payment', condition_field: 'amount', condition_operator: 'greater_than',
  condition_value: '10000', approver_role: 'admin', control_version: 1, is_active: true,
  aggregate_window_days: 1, aggregate_by: 'supplier' };
const material = { supplierId: '', observedSources: [], versionBasis: 'untracked_current_observation',
  binding: { companyId: 'company', entityType: 'supplier_payment_batch', entityId: 'batch', entityVersion: 1,
    operation: 'supplier_payment_batch.process', accountingDate: '2026-09-09', amount: '12000', currency: 'ZAR',
    sourceVersions: [], beneficiaries: ['a', 'b'].map(entityId => ({ entityId, entityType: 'supplier',
      beneficiaryId: entityId, version: 1, fingerprint: entityId, amount: '6000', currency: 'ZAR' })) } } as ApMaterial;
it('matches a policy once when one supplier crosses its prior-plus-current threshold', async () => {
  const query = vi.fn().mockResolvedValueOnce([{ total: '5000' }]).mockResolvedValueOnce([{ total: '0' }]);
  const result = await matchOperationPolicies({ principal: { companyId: 'company' }, sql: query } as unknown as ControlTx,
    [rule], material, '2026-09-09');
  expect(result.map(p => p.policyId)).toEqual(['daily']);
  expect(query.mock.calls[0]).toContain('a'); expect(query.mock.calls[1]).toContain('b');
});
it('does not combine unrelated suppliers to trigger a per-supplier threshold', async () => {
  const query = vi.fn().mockResolvedValue([{ total: '0' }]);
  expect(await matchOperationPolicies({ principal: { companyId: 'company' }, sql: query } as unknown as ControlTx,
    [rule], material, '2026-09-09')).toEqual([]);
});
it('still compares nonaggregate thresholds against the whole batch', async () => {
  const query = vi.fn();
  const result = await matchOperationPolicies({ principal: { companyId: 'company' }, sql: query } as unknown as ControlTx,
    [{ ...rule, aggregate_window_days: null, aggregate_by: null }], material, '2026-09-09');
  expect(result).toHaveLength(1); expect(query).not.toHaveBeenCalled();
});
