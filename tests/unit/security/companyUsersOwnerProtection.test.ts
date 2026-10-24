/**
 * Audit 2026-10-18 S-04 — an admin could demote or remove an owner.
 *
 * PUT/DELETE /api/accounting/company-users run the REAL userAccessService here;
 * only `sql` is replaced, by a recorder that answers the target-role lookup.
 * An admin acting on an owner gets 403 and no UPDATE or DELETE is issued; an
 * owner acting on an owner, and an admin acting on a manager, still write.
 * The real-PG proof (and the two-owner race) is
 * tests/integration/s04-owner-protection.int.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({ statements: [] as string[], onSql: [] as string[], targetRole: 'owner', actorRole: 'owner', ownerCount: 2 }));

// The role change and the removal run on the migration_admin client (S-07d,
// mig 935); `sql`, the app pool, must see no member read or write (afterEach).
function answer(raw: string): Promise<unknown[]> {
  const text = raw.replace(/\s+/g, ' ').trim();
  h.statements.push(text);
  // The target's and the actor's rows, locked together (one statement, id order).
  if (/^SELECT role, public\.company_member_role_is_owner\(role\) AS is_owner, .* FROM company_users .*FOR UPDATE$/.test(text)) {
    return Promise.resolve([
      { role: h.targetRole, is_owner: h.targetRole === 'owner', is_target: true, is_actor: false },
      { role: h.actorRole, is_owner: h.actorRole === 'owner', is_target: false, is_actor: true },
    ]);
  }
  // Owners other than the target, by person: the owners that exist, less the target.
  if (/^SELECT count\(DISTINCT/.test(text)) return Promise.resolve([{ n: h.ownerCount - 1 }]);
  return Promise.resolve([]);
}

vi.mock('@/lib/neon', () => ({
  sql: vi.fn((strings: TemplateStringsArray) => {
    h.onSql.push(strings.join('?').replace(/\s+/g, ' ').trim());
    return answer(strings.join('?'));
  }),
}));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminTx: (_label: string, fn: (c: unknown) => unknown) =>
    // A tick before answering, as a real round trip: tests change h after starting a call.
    fn({ query: async (text: string) => { await Promise.resolve(); return { rows: await answer(text) }; } }),
}));
vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import handler from '../../../pages/api/accounting/company-users';
import { updateCompanyUserRole, OwnerProtectedError } from '@/modules/accounting/services/core/userAccessService';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
const COMPANY_ID = '11111111-1111-4111-9111-111111111111';
const TARGET = '44444444-4444-4444-9444-444444444444';

function call(method: 'PUT' | 'DELETE', companyRole: string, body: Record<string, string>) {
  h.actorRole = companyRole;
  const req = {
    method, query: {}, body, headers: {},
    companyId: COMPANY_ID, companyRole, user: { id: 'caller' },
  } as unknown as NextApiRequest;
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return { promise: (handler as Handler)(req, res), res };
}

const writes = () => h.statements.filter((s) => /^(UPDATE|DELETE)/.test(s));

afterEach(() => {
  expect(h.onSql.filter((s) => /company_users/.test(s) && !/company_member_directory/.test(s))).toEqual([]);
  h.onSql.length = 0;
});
const statusOf = (res: NextApiResponse) => (res.status as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];

describe('company-users S-04 — only an owner changes or removes an owner', () => {
  beforeEach(() => {
    h.statements.length = 0;
    h.targetRole = 'owner';
    h.ownerCount = 2;
  });

  it('answers 403 to an admin demoting an owner, and writes nothing', async () => {
    const { promise, res } = call('PUT', 'admin', { userId: TARGET, role: 'viewer' });
    await promise;
    expect(statusOf(res)).toBe(403);
    expect(JSON.stringify((res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]))
      .toContain('Only an owner can change or remove another owner.');
    expect(writes()).toEqual([]);
  });

  it('answers 403 to an admin removing an owner, and writes nothing', async () => {
    const { promise, res } = call('DELETE', 'admin', { userId: TARGET });
    await promise;
    expect(statusOf(res)).toBe(403);
    expect(writes()).toEqual([]);
  });

  // Breaker REPRO 1: withAuth read 'owner', but the caller was demoted since.
  it('answers 403 when the caller was an owner at sign-in but is not one now', async () => {
    const { promise, res } = call('PUT', 'owner', { userId: TARGET, role: 'viewer' });
    h.actorRole = 'admin';
    await promise;
    expect(statusOf(res)).toBe(403);
    expect(writes()).toEqual([]);
  });

  it('reads the target and the actor under row locks, in id order', async () => {
    await call('PUT', 'admin', { userId: TARGET, role: 'viewer' }).promise;
    expect(h.statements.find((s) => s.startsWith('SELECT role, public.company_member_role_is_owner(role) AS is_owner')))
      .toMatch(/ORDER BY id FOR UPDATE$/);
  });

  it('lets an owner demote another owner when two exist', async () => {
    const { promise, res } = call('PUT', 'owner', { userId: TARGET, role: 'admin' });
    await promise;
    expect(statusOf(res)).toBe(200);
    expect(writes()).toHaveLength(1);
  });

  it('lets an owner remove another owner when two exist', async () => {
    const { promise, res } = call('DELETE', 'owner', { userId: TARGET });
    await promise;
    expect(statusOf(res)).toBe(200);
    expect(writes()).toHaveLength(1);
  });

  it('still lets an admin change and remove a manager', async () => {
    h.targetRole = 'manager';
    const put = call('PUT', 'admin', { userId: TARGET, role: 'viewer' });
    await put.promise;
    expect(statusOf(put.res)).toBe(200);
    const del = call('DELETE', 'admin', { userId: TARGET });
    await del.promise;
    expect(statusOf(del.res)).toBe(200);
    expect(writes()).toHaveLength(2);
  });
});

describe('company-users service — non-owner cannot promote to owner (defence-in-depth)', () => {
  // These tests call the service directly, bypassing the API-layer check, to
  // verify that memberWrites' own check also gates promotion-to-owner.
  beforeEach(() => {
    h.statements.length = 0;
    h.targetRole = 'manager';
    h.actorRole = 'admin';
    h.ownerCount = 2;
  });

  // The rows (target and actor) are locked first, then the owner lock: the
  // guard's order, so an owner write that waits never holds the owner lock
  // while it waits for a row.
  function expectLockThenActorRead(): void {
    const rowLock = h.statements.findIndex((s) => /FOR UPDATE$/.test(s));
    const ownerLock = h.statements.findIndex((s) => s.includes('pg_advisory_xact_lock'));
    expect(rowLock).toBeGreaterThanOrEqual(0);
    expect(ownerLock).toBeGreaterThan(rowLock);
  }

  it('throws OwnerProtectedError when an admin promotes a manager to owner', async () => {
    const err = await updateCompanyUserRole(COMPANY_ID, TARGET, 'owner', 'actor-admin').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OwnerProtectedError);
    expect((err as Error).message).toBe('Only an owner can grant the owner role.');
    // No UPDATE issued
    expect(writes()).toEqual([]);
    expectLockThenActorRead();
  });

  it('answers 403 to an admin promoting a manager through the route', async () => {
    h.targetRole = 'manager';
    const { promise, res } = call('PUT', 'owner', { userId: TARGET, role: 'owner' });
    h.actorRole = 'admin'; // owner at sign-in, demoted since
    await promise;
    expect(statusOf(res)).toBe(403);
    expect(writes()).toEqual([]);
  });

  it('allows an owner to promote a manager to owner', async () => {
    h.actorRole = 'owner';
    await expect(
      updateCompanyUserRole(COMPANY_ID, TARGET, 'owner', 'actor-owner'),
    ).resolves.toBeUndefined();
    expect(writes()).toHaveLength(1);
    expectLockThenActorRead();
  });
});
