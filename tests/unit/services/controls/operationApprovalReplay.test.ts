import { expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { requireControlTx, withControlRequest } from '@/modules/accounting/services/controls/context';
import { executeControlledOperation } from '@/modules/accounting/services/controls/approvalExecutionService';

const permission = vi.hoisted(() => vi.fn(async (_ctx: unknown, _permission: string) => undefined));
vi.mock('@/lib/auth/effectivePermissions', () => ({ assertEffectivePermission: permission }));
vi.mock('@/modules/accounting/services/controls/operationMaterializer', async importOriginal => ({
  ...await importOriginal<typeof import('@/modules/accounting/services/controls/operationMaterializer')>(),
  loadOperationMaterial: vi.fn(async () => ({ binding: { policies: [], entityVersion: 2 }, bindingHash: 'changed-after-effect' })),
}));
it('returns the durable intent result after current authority checks without another effect', async () => {
  const companyId = randomUUID(), personId = randomUUID(), entityId = randomUUID();
  const storedResult = { sequence: 1, entityId }, callback = vi.fn(async () => ({ sequence: 2, entityId }));
  let operationId = '';
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM control_operation_effects')
    ? [{ id: randomUUID(), operation_id: operationId, result: storedResult }] : [] }));
  await withControlRequest({ client: { query } as unknown as PoolClient, userId: personId, companyId, claims: {} },
    { personId, companyId, authMethod: 'cookie' }, async () => {
      const ctx = requireControlTx(); operationId = ctx.principal.operationId;
      await expect(executeControlledOperation(ctx,
        { operation: 'supplier_payment.process', entityType: 'supplier_payment', entityId }, null, callback)).resolves.toEqual(storedResult);
    });
  expect(callback).not.toHaveBeenCalled();
  expect(permission.mock.calls.map(args => args[1])).toEqual(['write:bank-tx', 'write:post']);
});
