import { expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { requireControlTx, withControlRequest } from '@/modules/accounting/services/controls/context';
import { assertControlledEffectPermit, executeControlledOperation } from '@/modules/accounting/services/controls/approvalExecutionService';
vi.mock('@/lib/auth/effectivePermissions', () => ({ assertEffectivePermission: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/controls/approvalRequestService', () => ({ initializeOperationObservations: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/controls/operationMaterializer', async importOriginal => ({
  ...await importOriginal<typeof import('@/modules/accounting/services/controls/operationMaterializer')>(),
  loadOperationMaterial: vi.fn(async () => ({ binding: { policies: [] }, bindingHash: 'material' })),
}));
it('accepts a newly issued context in the same active request but refuses a nested independent effect', async () => {
  const personId = randomUUID(), companyId = randomUUID();
  const client = { query: vi.fn(async () => ({ rows: [] })) } as unknown as PoolClient;
  await withControlRequest({ client, userId: personId, companyId, claims: {} },
    { personId, companyId, authMethod: 'cookie' }, async () => {
      const ctx = requireControlTx();
      const ref = { operation: 'supplier_payment.process', entityType: 'supplier_payment', entityId: randomUUID() } as const;
      await expect(executeControlledOperation(ctx, ref, null, async permit => {
        const child = requireControlTx(); expect(child).not.toBe(ctx);
        expect(() => assertControlledEffectPermit(child, permit, ref)).not.toThrow();
        await expect(executeControlledOperation(child, ref, null, async () => ({ invalid: true }))).rejects.toThrow('Nested');
        throw new Error('Stop after permit proof');
      })).rejects.toThrow('Stop after permit proof');
    });
});
