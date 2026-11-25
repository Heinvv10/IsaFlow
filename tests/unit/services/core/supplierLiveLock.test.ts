/**
 * core/supplierLiveLock (#1699, breaker of aad49a02, L3): the supplier live locks refuse to run outside a request transaction, where
 * FOR KEY SHARE would be released as the SELECT returns and the caller would believe it is serialised. The SQL, the wait and the
 * merged-away refusal are integration-tested (tests/integration/i1699-*.int.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

import { lockLiveSurvivor, lockPayeeOfBill, lockSupplierIfLive } from '@/modules/accounting/services/core/supplierLiveLock';

const CO = '11111111-1111-1111-1111-111111111111';
const SUP = '22222222-2222-2222-2222-222222222222';

describe('supplier live locks outside a request transaction', () => {
  it('lockSupplierIfLive throws and runs no SQL', async () => {
    await expect(lockSupplierIfLive(CO, SUP)).rejects.toThrow(/requires a request transaction/);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('lockLiveSurvivor throws and runs no SQL', async () => {
    await expect(lockLiveSurvivor(CO, SUP)).rejects.toThrow(/requires a request transaction/);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('lockPayeeOfBill reaches the same refusal once it has the bill\'s supplier', async () => {
    sqlMock.mockResolvedValueOnce([{ supplier_id: SUP }]);
    await expect(lockPayeeOfBill(CO, '33333333-3333-3333-3333-333333333333')).rejects.toThrow(/requires a request transaction/);
  });
});
