/**
 * Reactivating a deactivated system BANK account into the empty bank role decides where net pay is credited (with
 * payroll_net_pay unset): owner/admin only. Other roles, and a call with no actor (a script or test), are not gated; a
 * role that already has a holder is refused as before (two holders).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let row: Record<string, unknown> | null = null;
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => (row ? [row] : [])) }));

import { reactivationRefusal } from '@/modules/accounting/services/gl/systemRoleReactivation';

const bank = { account_code: '1199', account_type: 'asset', account_subtype: 'bank', is_system_account: true, holder_code: null, has_children: false };

beforeEach(() => { row = { ...bank }; });

describe('reactivationRefusal with an actor', () => {
  it.each(['manager', 'accountant', 'viewer', undefined, null])('refuses %s for a system bank account, naming why', async (role) => {
    expect(await reactivationRefusal('co', 'acct', { role, userId: 'u' })).toMatch(/1199.*owner or admin/);
  });

  it.each(['owner', 'admin'])('lets %s through', async (role) => {
    expect(await reactivationRefusal('co', 'acct', { role, userId: 'u' })).toBeNull();
  });

  it('does not gate a non-bank role (receivable), or a call with no actor', async () => {
    row = { ...bank, account_code: '1200', account_subtype: 'receivable' };
    expect(await reactivationRefusal('co', 'acct', { role: 'manager', userId: 'u' })).toBeNull();
    row = { ...bank };
    expect(await reactivationRefusal('co', 'acct')).toBeNull();
  });

  it('a bank role that already has a holder is refused for everyone, as before', async () => {
    row = { ...bank, holder_code: '1110' };
    expect(await reactivationRefusal('co', 'acct', { role: 'owner', userId: 'u' })).toMatch(/1110 now holds the bank role/);
  });

  it('an account that is not an inactive system account is not this guard\'s business', async () => {
    row = null;
    expect(await reactivationRefusal('co', 'acct', { role: 'manager', userId: 'u' })).toBeNull();
  });
});
