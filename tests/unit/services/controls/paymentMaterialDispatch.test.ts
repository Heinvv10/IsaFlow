import { beforeEach, expect, it, vi } from 'vitest';
import type { ControlTx, OperationRef } from '@/modules/accounting/services/controls/contracts';
const mocks = vi.hoisted(() => ({ batch: vi.fn(), release: vi.fn(), permit: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/paymentBatchMaterializer', () => ({ materializePaymentBatchOperation: mocks.batch }));
vi.mock('@/modules/accounting/services/ap/paymentReleaseMaterializer', () => ({ materializePaymentReleaseOperation: mocks.release }));
vi.mock('@/modules/accounting/services/controls/approvalExecutionService', () => ({ assertControlledEffectPermit: mocks.permit }));
import { canonicalOperationRef, materializeOperation } from '@/modules/accounting/services/controls/operationMaterializer';
import { registerGeneratedJournal, type ParentJournalControl } from '@/modules/accounting/services/controls/generatedJournalPermit';
beforeEach(() => { vi.clearAllMocks(); });
const id = '11111111-1111-4111-8111-111111111111';
it.each([
  ['supplier_payment_batch', 'supplier_payment_batch.process', 'batch'],
  ['payment_release_intent', 'payment_release.dispatch', 'release'],
] as const)('routes %s through the authoritative payment materializer', async (entityType, operation, target) => {
  const ref: OperationRef = { entityType, entityId: id, operation };
  expect(canonicalOperationRef(ref)).toEqual(ref);
  const ctx = {} as ControlTx; mocks[target].mockResolvedValue({ binding: { amount: '115', currency: 'ZAR' } });
  expect(await materializeOperation(ctx, ref)).toEqual({ binding: { amount: '115', currency: 'ZAR' } });
  expect(mocks[target]).toHaveBeenCalledWith(ctx, ref);
});
it('registers only a persisted owned aggregate batch journal on the approved date', async () => {
  const query = vi.fn().mockResolvedValue([{ id, entry_date: '2026-09-09' }]);
  const ctx = { principal: { companyId: id }, sql: query } as unknown as ControlTx;
  const control = { parent: { entityType: 'supplier_payment_batch', entityId: id, operation: 'supplier_payment_batch.process' },
    permit: { accountingDate: '2026-09-09' } } as ParentJournalControl;
  await expect(registerGeneratedJournal(ctx, control, id, 'journal.post')).resolves.toBeUndefined();
  expect(query.mock.calls[0][0].join(' ')).toContain("je.source='auto_batch_payment'");
  expect(query.mock.calls[0][0].join(' ')).toContain('je.source_record_id=p.id');
  query.mockResolvedValue([]);
  await expect(registerGeneratedJournal(ctx, control, id, 'journal.post')).rejects.toThrow('parent relationship');
});
