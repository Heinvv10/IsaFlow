/** #1656 round 4: setMemberApproveWithheld writes ONE audit row in the same transaction as the change, naming the actor and the old and new value. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as Array<{ text: string; values: unknown[] }>);
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminTx: vi.fn(async (_n: string, fn: (c: unknown) => Promise<unknown>) => fn({
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (/SELECT role, public.company_member_role_is_owner/.test(text)) {
        return { rows: [{ role: 'manager', is_owner: false, is_target: true, is_actor: false }, { role: 'owner', is_owner: false, is_target: false, is_actor: true }] };
      }
      if (/SELECT approve_withheld/.test(text)) return { rows: [{ approve_withheld: false }] };
      return { rows: [] };
    }),
  })),
}));

import { setMemberApproveWithheld } from '@/modules/accounting/services/core/memberWrites';

const C = '11111111-1111-4111-8111-111111111111';
const T = '99999999-9999-4999-8999-999999999999';
const ACTOR = '55555555-5555-4555-8555-555555555555';
beforeEach(() => { calls.length = 0; });

describe('setMemberApproveWithheld', () => {
  it('updates only approve_withheld and writes the audit row in the same transaction', async () => {
    await setMemberApproveWithheld(C, T, true, ACTOR);
    const update = calls.find((c) => /UPDATE company_users SET approve_withheld/.test(c.text));
    expect(update?.values).toEqual([C, T, true]);
    const audit = calls.filter((c) => /INSERT INTO audit_log/.test(c.text));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.values.slice(0, 3)).toEqual([C, ACTOR, T]);
    expect(JSON.parse(String(audit[0]!.values[3]))).toMatchObject({ fields: [{ field: 'approve_withheld', old: false, new: true }] });
    expect(calls.indexOf(audit[0]!)).toBeGreaterThan(calls.indexOf(update!));
  });
});
