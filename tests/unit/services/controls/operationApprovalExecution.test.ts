import { expect, it } from 'vitest';
import { assertApprovalExecutable } from '@/modules/accounting/services/controls/approvalExecutionService';
import type { ApprovalRow } from '@/modules/accounting/services/controls/approvalQueries';
const row = { status: 'approved', unexpired: true, binding_hash: 'current' } as ApprovalRow;
it('only accepts a currently approved, unexpired, exact material binding', () => {
  expect(() => assertApprovalExecutable(row, 'current')).not.toThrow();
  expect(() => assertApprovalExecutable(row, 'edited')).toThrow();
  expect(() => assertApprovalExecutable({ ...row, unexpired: false }, 'current')).toThrow();
});
it.each(['pending', 'rejected', 'cancelled', 'consumed'] as const)('refuses %s approval', status => {
  expect(() => assertApprovalExecutable({ ...row, status }, 'current')).toThrow();
});

it('projects persisted binding references without spreading material into source identities', async () => {
  const { canonicalOperationRef } = await import('@/modules/accounting/services/controls/operationMaterializer');
  const ref = { operation: 'supplier_payment.process', entityType: 'supplier_payment',
    entityId: '00000000-0000-4000-8000-000000000001', amount: '115', policies: [] } as const;
  expect(canonicalOperationRef(ref)).toEqual({ operation: ref.operation, entityType: ref.entityType, entityId: ref.entityId });
});
