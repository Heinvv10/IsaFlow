/**
 * #1371 review LOW (WP9): noteLoginAsEnd never turns a recorded `target_session_revoked: true` into false (a retry
 * that meets an already-revoked or unreachable session must not undo the record). The rule is in the UPDATE itself,
 * so this pins the statement and its parameters with a mocked `sql`; the behaviour against Postgres is in
 * tests/integration/admin-end-impersonation-revoke.int.test.ts (re-break M2).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const sqlCalls = vi.hoisted(() => [] as { text: string; values: unknown[] }[]);
vi.mock('@/lib/neon', () => {
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join('$?'), values });
    return [];
  };
  return { sql, withTransaction: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) };
});
vi.mock('@/modules/admin/services/userImpersonationService', () => ({
  deleteEndedStashes: vi.fn(async () => 0), purgeExpiredStashes: vi.fn(async () => 0),
}));

import { noteLoginAsEnd } from '@/lib/auth/loginAsRecord';

/** What Postgres would compute for `details || $outcome || CASE ...`, read off the statement's own text. */
function applyUpdate(text: string, details: Record<string, unknown>, outcome: Record<string, unknown>) {
  const keepsTrue = /\|\|\s*CASE WHEN details->>'target_session_revoked' = 'true'\s+THEN '\{"target_session_revoked": true\}'::jsonb ELSE '\{\}'::jsonb END/
    .test(text);
  const merged = { ...details, ...outcome };
  return keepsTrue && details.target_session_revoked === true ? { ...merged, target_session_revoked: true } : merged;
}

describe('noteLoginAsEnd', () => {
  beforeEach(() => { sqlCalls.length = 0; });

  it('a later false never overwrites a recorded true', async () => {
    await noteLoginAsEnd('end-1', { target_session_revoked: false, stashes_removed: 0 });
    const [update] = sqlCalls;
    expect(update!.text).toContain('UPDATE admin_audit_log');
    expect(update!.values).toEqual([JSON.stringify({ target_session_revoked: false, stashes_removed: 0 }), 'end-1']);
    expect(applyUpdate(update!.text, { target_session_revoked: true }, { target_session_revoked: false }))
      .toMatchObject({ target_session_revoked: true });
  });

  it('an unknown (null) can still become false or true', async () => {
    await noteLoginAsEnd('end-2', { target_session_revoked: false });
    expect(applyUpdate(sqlCalls[0]!.text, { target_session_revoked: null }, { target_session_revoked: false }))
      .toMatchObject({ target_session_revoked: false });
  });
});
