/**
 * The Sage commit writes accounts flagged `is_system_account`, so it runs under the role-write lock that every other
 * writer of role flags takes, and ends on the post-condition (every role held before still has exactly one usable
 * holder). Order is what matters: lock, snapshot, the inserts, THEN the invariant. A commit with no account records takes
 * neither (nothing to protect).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    order.push(strings.join('?').includes('INSERT INTO gl_accounts') ? 'insert' : 'other');
    return [{ id: 'new' }];
  }),
  withSavepoint: vi.fn(async (_n: string, fn: () => Promise<void>) => fn()),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/admin/services/sageMigrationCommitService', () => ({
  commitARInvoice: vi.fn(), commitAPInvoice: vi.fn(), upsertCustomer: vi.fn(), upsertSupplier: vi.fn(),
}));
const assertRolesKept = vi.fn(async () => { order.push('invariant'); });
vi.mock('@/modules/accounting/services/gl/systemRoleWriteLock', () => ({ lockSystemRoleWrites: vi.fn(async () => { order.push('lock'); }) }));
vi.mock('@/modules/accounting/services/gl/systemRoleInvariant', () => ({
  snapshotRoles: vi.fn(async () => { order.push('snapshot'); return { holders: new Map() }; }),
  assertRolesKept: (...a: unknown[]) => (assertRolesKept as (...x: unknown[]) => Promise<void>)(...a),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ clearSystemAccountCacheAfterCommit: vi.fn(() => { order.push('cache'); }) }));

import { commitSageMigration } from '@/modules/admin/services/sageMigrationOrchestrator';

const account = { accountCode: '4000', accountName: 'Sales', accountType: 'revenue', normalBalance: 'credit', isSystem: true } as never;

beforeEach(() => { order.length = 0; assertRolesKept.mockClear(); });

describe('commitSageMigration and the system-role lock', () => {
  it('locks and snapshots before the first account insert, and checks the roles after the last', async () => {
    await commitSageMigration({ companyId: 'co', userId: 'u', pulled: { accounts: { records: [account, account] } } });
    expect(order).toEqual(['lock', 'snapshot', 'insert', 'insert', 'invariant', 'cache']);
  });

  it('a commit with no account records takes no lock and runs no post-condition', async () => {
    await commitSageMigration({ companyId: 'co', userId: 'u', pulled: {} });
    expect(order).toEqual([]);
    expect(assertRolesKept).not.toHaveBeenCalled();
  });

  it('a role the commit would break refuses the commit (the invariant error is not swallowed)', async () => {
    assertRolesKept.mockRejectedValueOnce(new Error('bank would have two holders'));
    await expect(commitSageMigration({ companyId: 'co', userId: 'u', pulled: { accounts: { records: [account] } } })).rejects.toThrow('two holders');
  });
});
