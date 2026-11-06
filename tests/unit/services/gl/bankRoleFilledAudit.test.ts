/** The audit row for a write that FILLS an empty bank role: only a role that had no holder and has one now. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let holders = new Map<string, string>();
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/systemRoleInvariant', () => ({ snapshotRoles: vi.fn(async () => ({ holders })) }));
const audit = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/modules/accounting/services/gl/defaultAccountsAudit', () => ({ auditDefaultAccountChanges: (...a: unknown[]) => audit(...a) }));

import { auditBankRoleFilled, bankRoleHolderId } from '@/modules/accounting/services/gl/bankRoleFilledAudit';

beforeEach(() => { holders = new Map(); audit.mockClear(); });

describe('auditBankRoleFilled', () => {
  it('no holder before, a holder now: one primary_bank row from none to the holder, authored by the user', async () => {
    holders = new Map([['bank', 'acct-1']]);
    await auditBankRoleFilled('co', 'user-1', null);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]!.slice(1)).toEqual(['co', 'user-1', [{ key: 'primary_bank', fromId: null, toId: 'acct-1' }]]);
  });

  it('a holder before (a move, recorded by the paths that make moves) writes nothing, and reads nothing', async () => {
    holders = new Map([['bank', 'acct-2']]);
    await auditBankRoleFilled('co', 'user-1', 'acct-1');
    expect(audit).not.toHaveBeenCalled();
  });

  it('still no holder after the write: nothing to record', async () => {
    await auditBankRoleFilled('co', 'user-1', null);
    expect(audit).not.toHaveBeenCalled();
    expect(await bankRoleHolderId('co')).toBeNull();
  });
});
