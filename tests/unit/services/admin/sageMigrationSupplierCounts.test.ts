/**
 * The supplier created / skipped counts of a Sage commit come from what upsertSupplier itself did (created a row,
 * or matched one), not from a second lookup made beforehand: that lookup could disagree with the upsert's own match.
 * findSageSupplier is mocked to say the opposite of upsertSupplier here, so a count taken from it goes red.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => []),
  withSavepoint: vi.fn(async (_n: string, fn: () => Promise<void>) => fn()),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const upsertSupplier = vi.fn();
const upsertCustomer = vi.fn();
vi.mock('@/modules/admin/services/sageMigrationCommitService', () => ({
  commitARInvoice: vi.fn(), commitAPInvoice: vi.fn(), upsertCustomer: (...a: unknown[]) => upsertCustomer(...a),
  upsertSupplier: (...a: unknown[]) => upsertSupplier(...a),
}));
const findSageSupplier = vi.fn();
vi.mock('@/modules/admin/services/sagePartyMatch', () => ({
  findSageCustomer: vi.fn(async () => null),
  findSageSupplier: (...a: unknown[]) => findSageSupplier(...a),
}));

import { commitSageMigration } from '@/modules/admin/services/sageMigrationOrchestrator';

const supplier = (name: string) => ({ name, sageId: 1 }) as never;

describe('commitSageMigration supplier counts', () => {
  it('counts from what upsertSupplier reports, whatever a separate lookup would say', async () => {
    findSageSupplier.mockResolvedValue('some-id'); // would count both as skipped
    upsertSupplier
      .mockResolvedValueOnce({ id: 'a', created: true })
      .mockResolvedValueOnce({ id: 'b', created: false });
    const out = await commitSageMigration({
      companyId: 'co', userId: 'u', pulled: { suppliers: { records: [supplier('A'), supplier('B')] } },
    });
    expect(out.suppliers).toEqual({ created: 1, skipped: 1, failed: [] });
    expect(findSageSupplier).not.toHaveBeenCalled();
  });

  it('customers are counted from what upsertCustomer reports, not from a separate lookup', async () => {
    upsertCustomer
      .mockResolvedValueOnce({ id: 'c1', created: false })
      .mockResolvedValueOnce({ id: 'c2', created: true });
    const out = await commitSageMigration({
      companyId: 'co', userId: 'u', pulled: { customers: { records: [{ name: 'A' }, { name: 'B' }] as never } },
    });
    expect(out.customers).toEqual({ created: 1, skipped: 1, failed: [] });
  });

  it('a failed upsert is recorded as failed, not counted', async () => {
    upsertSupplier.mockRejectedValueOnce(new Error('boom'));
    const out = await commitSageMigration({ companyId: 'co', userId: 'u', pulled: { suppliers: { records: [supplier('C')] } } });
    expect(out.suppliers).toEqual({ created: 0, skipped: 0, failed: ['C: boom'] });
  });
});
