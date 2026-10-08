/**
 * R-035 N1 round 1 (adversarial REPRO 1): every route that raises, re-binds
 * or decides an approval request is wrapped in withWriteAccess with the
 * default roles (owner, admin, manager — src/lib/auth/writeRoles.ts), so the
 * definers refuse any other role the same way (RA008): an accountant cannot
 * approve, nor a viewer raise, by calling the functions directly. The SQL list
 * is bound to writeRoles.ts role by role.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { APPROVER_ROLES } from '../../src/modules/accounting/services/gl/approvalAuthority';
import { DEFAULT_WRITE_ROLES, canWrite } from '../../src/lib/auth/writeRoles';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantBill, plantRule } from './r035-approval.helpers';
import { cleanupPr2, dataOf, enforce, postableCompany, routes } from './r035-pr2.helpers';
import { asRole, decideFn, outcome, raiseFn, rebindFn, requestRow } from './r035-n1.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', m: '', acc: '', v: '' };
const r = routes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr2(pool, companies, Object.values(u)));

const digestOf = async (id: string) => (await requestRow(pool, id))?.document_digest ?? null;

/** A bill by a, under an `<role> any` rule, its request raised by b through the route. */
async function raisedUnder(role: string) {
  const c = await postableCompany(pool,
    [[u.a, 'owner'], [u.b, 'owner'], [u.m, 'manager'], [u.acc, 'accountant'], [u.v, 'viewer']], companies);
  const ruleId = await plantRule(pool, c, role, { name: `roles ${role}` });
  await enforce(pool, c, u.a);
  const bill = await plantBill(pool, c, u.a);
  const raised = await r.raise(u.b, c, bill.id);
  if (raised.state.statusCode !== 200) throw new Error(JSON.stringify(raised.state.body));
  return { c, bill, ruleId, requestId: dataOf<{ id: string }>(raised).id };
}

describe('the SQL write-role list is writeRoles.ts', () => {
  it.each([...APPROVER_ROLES, 'not-a-role', ''])('%j: approval_request_may_write = canWrite', async (role) => {
    const { rows: [row] } = await pool.query('SELECT approval_request_may_write($1) AS ok', [role]);
    expect(row.ok).toBe(canWrite(role));
  });

  it('NULL (no membership) may not write, and the list has exactly the default write roles', async () => {
    const { rows: [row] } = await pool.query('SELECT approval_request_may_write(NULL) AS ok');
    expect(row.ok).toBe(false);
    expect(APPROVER_ROLES.filter((role) => canWrite(role)).sort()).toEqual([...DEFAULT_WRITE_ROLES].sort());
  });
});

describe('a role withWriteAccess refuses is refused by the definers too (RA008)', () => {
  it('an accountant the route refuses (403) cannot approve directly; the bill stays gated', async () => {
    const f = await raisedUnder('accountant');
    expect((await r.decide(pool, u.acc, f.c, f.requestId)).state.statusCode).toBe(403);
    expect(await outcome(asRole(pool, 'app_user', f.c, { sub: u.acc },
      async (cl) => decideFn(cl, f.c, f.requestId, 'approved', u.acc, await digestOf(f.requestId)), true))).toBe('RA008');
    expect((await requestRow(pool, f.requestId))?.status).toBe('pending');
    expect((await r.approveBill(u.a, f.c, f.bill.id)).state.statusCode).toBe(409);
  });

  it('a viewer cannot raise, re-bind or lock directly', async () => {
    const f = await raisedUnder('owner');
    expect(await outcome(asRole(pool, 'app_user', f.c, { sub: u.v },
      (cl) => rebindFn(cl, f.c, f.requestId, null, u.v)))).toBe('RA008');
    expect(await outcome(asRole(pool, 'app_user', f.c, { sub: u.v },
      (cl) => cl.query('SELECT approval_request_lock($1, $2)', [f.c, f.requestId])))).toBe('RA008');
    await pool.query('DELETE FROM approval_requests WHERE id = $1', [f.requestId]);
    expect((await r.raise(u.v, f.c, f.bill.id)).state.statusCode).toBe(403);
    expect(await outcome(asRole(pool, 'app_user', f.c, { sub: u.v },
      (cl) => raiseFn(cl, f.c, 'supplier_invoice', f.bill.id, f.ruleId, u.v)))).toBe('RA008');
  });

  it('a requester outside the write roles cannot even withdraw (withWriteAccess gates reject too)', async () => {
    const f = await raisedUnder('owner');
    await pool.query("UPDATE company_users SET role = 'bookkeeper' WHERE company_id = $1 AND user_id = $2", [f.c, u.b]);
    expect(await outcome(asRole(pool, 'app_user', f.c, { sub: u.b },
      (cl) => decideFn(cl, f.c, f.requestId, 'rejected', u.b, null)))).toBe('RA008');
  });

  it('every write role the app allows still may: a manager approves a manager request directly', async () => {
    const f = await raisedUnder('manager');
    const rows = await asRole(pool, 'app_user', f.c, { sub: u.m },
      async (cl) => (await decideFn(cl, f.c, f.requestId, 'approved', u.m, await digestOf(f.requestId))).rows, true);
    expect(rows).toMatchObject([{ status: 'approved', decided_by: u.m }]);
  });
});
