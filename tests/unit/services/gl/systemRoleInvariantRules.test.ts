/**
 * `rolesNotKept` — the post-condition's rule, as a pure function of two
 * snapshots. The database half (`snapshotRoles`, `assertRolesKept`) is proven
 * in tests/integration/w2-28-*.int.test.ts; this pins the cases a database
 * test cannot easily stage, the holder's account TYPE above all.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { rolesNotKept, type RoleSnapshot } from '@/modules/accounting/services/gl/systemRoleInvariant';

type Holder = { id: string; type: string; contested?: boolean; header?: boolean };
const snap = (holders: Record<string, Holder>): RoleSnapshot => ({
  holders: new Map(Object.entries(holders).map(([role, h]) => [role, h.id])) as RoleSnapshot['holders'],
  types: new Map(Object.entries(holders).map(([role, h]) => [role, h.type])) as RoleSnapshot['types'],
  contested: new Set(Object.entries(holders).filter(([, h]) => h.contested).map(([role]) => role)) as RoleSnapshot['contested'],
  headers: new Set(Object.values(holders).filter((h) => h.header).map((h) => h.id)),
});
const bank = (over: Partial<Holder> = {}) => ({ bank: { id: 'B', type: 'asset', ...over } });
const moved = (id: string) => new Map([['bank', id]]) as never;

describe('rolesNotKept', () => {
  it('keeps a role that is untouched', () => {
    expect(rolesNotKept(snap(bank()), snap(bank()))).toEqual([]);
  });

  it('flags a role that lost its holder, changed holder unasked, or did not land where it was moved', () => {
    expect(rolesNotKept(snap(bank()), snap({}))).toEqual(['bank']);
    expect(rolesNotKept(snap(bank()), snap(bank({ id: 'OTHER' })))).toEqual(['bank']);
    expect(rolesNotKept(snap(bank()), snap(bank()), moved('X'))).toEqual(['bank']);
    expect(rolesNotKept(snap(bank()), snap(bank({ id: 'X' })), moved('X'))).toEqual([]);
  });

  it('flags a holder whose TYPE the role does not allow — newly, or at all for a moved role', () => {
    // The receivable/bank holder re-typed by the write.
    expect(rolesNotKept(snap(bank()), snap(bank({ type: 'expense' })))).toEqual(['bank']);
    // A role moved onto a liability (the COA import's role map over a kept system row).
    expect(rolesNotKept(snap(bank()), snap(bank({ id: 'X', type: 'liability' })), moved('X'))).toEqual(['bank']);
    // A holder that was ALREADY mistyped before this write is not this write's doing: it must not
    // block every later change to that chart.
    expect(rolesNotKept(snap(bank({ type: 'liability' })), snap(bank({ type: 'liability' })))).toEqual([]);
  });

  it('flags a holder newly contested or newly a header, but not one that already was', () => {
    expect(rolesNotKept(snap(bank()), snap(bank({ contested: true })))).toEqual(['bank']);
    expect(rolesNotKept(snap(bank({ contested: true })), snap(bank({ contested: true })))).toEqual([]);
    expect(rolesNotKept(snap(bank()), snap(bank({ header: true })))).toEqual(['bank']);
    expect(rolesNotKept(snap(bank({ header: true })), snap(bank({ header: true })))).toEqual([]);
    expect(rolesNotKept(snap(bank()), snap(bank({ id: 'X', header: true })), moved('X'))).toEqual(['bank']);
  });
});
