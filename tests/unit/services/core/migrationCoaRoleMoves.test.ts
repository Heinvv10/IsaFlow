/**
 * Which roles a CoA import's systemAccountMap actually MOVES (judged against the holders snapshotted inside the role
 * lock), who may move the bank role, and the audit rows it writes. A map that names the account already holding a role
 * is not a move; a contested role is (naming its winner settles it).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let accounts: Array<{ account_code: string; id: string }> = [];
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => accounts) }));
const auditDefaultAccountChanges = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/modules/accounting/services/gl/defaultAccountsAudit', () => ({ auditDefaultAccountChanges: (...a: unknown[]) => auditDefaultAccountChanges(...a) }));

import {
  CoaRoleChangeForbiddenError, assertActorMayMoveRoles, auditRoleMoves, roleMapMoves,
} from '@/modules/accounting/services/core/migrationCoaRoleMoves';
import type { RoleSnapshot } from '@/modules/accounting/services/gl/systemRoleInvariant';

const CO = 'aaaaaaaa-0000-4000-8000-000000000001';
const snap = (holders: Array<[string, string]>, contested: string[] = []): RoleSnapshot =>
  ({ holders: new Map(holders), contested: new Set(contested), headers: new Set(), types: new Map() }) as unknown as RoleSnapshot;

beforeEach(() => {
  accounts = [{ account_code: '1110', id: 'id-1110' }, { account_code: '1199', id: 'id-1199' }];
  auditDefaultAccountChanges.mockClear();
});

describe('roleMapMoves', () => {
  it('a role mapped to its current holder is not a move', async () => {
    expect(await roleMapMoves(CO, snap([['bank', 'id-1110']]), { bank: '1110' })).toEqual([]);
  });

  it('a role mapped to another account, or to a code that does not exist yet, is a move from the current holder', async () => {
    expect(await roleMapMoves(CO, snap([['bank', 'id-1110']]), { bank: '1199' })).toEqual([{ subtype: 'bank', fromId: 'id-1110', toCode: '1199' }]);
    expect(await roleMapMoves(CO, snap([['bank', 'id-1110']]), { bank: '1300' })).toEqual([{ subtype: 'bank', fromId: 'id-1110', toCode: '1300' }]);
  });

  it('a role with no holder yet is a move (from null); a contested role is a move even to its winner', async () => {
    expect(await roleMapMoves(CO, snap([]), { bank: '1110' })).toEqual([{ subtype: 'bank', fromId: null, toCode: '1110' }]);
    expect(await roleMapMoves(CO, snap([['bank', 'id-1110']], ['bank']), { bank: '1110' })).toHaveLength(1);
  });

  it('an empty or non-text entry names nothing', async () => {
    expect(await roleMapMoves(CO, snap([]), { bank: '', receivable: 5 as unknown as string })).toEqual([]);
  });
});

describe('assertActorMayMoveRoles: only the bank role is gated, only for a role that is not owner/admin', () => {
  const bank = [{ subtype: 'bank', fromId: 'id-1110', toCode: '1199' }];
  const receivable = [{ subtype: 'receivable', fromId: null, toCode: '1197' }];

  it.each(['manager', 'accountant', 'viewer', undefined, null])('%s moving the bank role is refused', (role) => {
    expect(() => assertActorMayMoveRoles({ role, userId: 'u' }, bank)).toThrow(CoaRoleChangeForbiddenError);
  });

  it.each(['owner', 'admin'])('%s may', (role) => {
    expect(() => assertActorMayMoveRoles({ role, userId: 'u' }, bank)).not.toThrow();
  });

  it('a manager moving another role, or moving nothing, is not refused; a call with no actor is not gated', () => {
    expect(() => assertActorMayMoveRoles({ role: 'manager', userId: 'u' }, receivable)).not.toThrow();
    expect(() => assertActorMayMoveRoles({ role: 'manager', userId: 'u' }, [])).not.toThrow();
    expect(() => assertActorMayMoveRoles(undefined, bank)).not.toThrow();
  });
});

describe('auditRoleMoves', () => {
  it('writes one row under the Default Accounts keys, with the user and the old and new ids', async () => {
    await auditRoleMoves(CO, { role: 'owner', userId: 'user-1' }, [
      { subtype: 'bank', fromId: 'id-1110', toCode: '1199' }, { subtype: 'vat_input', fromId: null, toCode: '1110' },
    ]);
    expect(auditDefaultAccountChanges).toHaveBeenCalledTimes(1);
    const [, company, user, changes] = auditDefaultAccountChanges.mock.calls[0]!;
    expect([company, user]).toEqual([CO, 'user-1']);
    expect(changes).toEqual([
      { key: 'primary_bank', fromId: 'id-1110', toId: 'id-1199' },
      { key: 'purchase_vat_input', fromId: null, toId: 'id-1110' },
    ]);
  });

  it('writes nothing for no moves or no actor', async () => {
    await auditRoleMoves(CO, { role: 'owner', userId: 'u' }, []);
    await auditRoleMoves(CO, undefined, [{ subtype: 'bank', fromId: null, toCode: '1110' }]);
    expect(auditDefaultAccountChanges).not.toHaveBeenCalled();
  });
});
