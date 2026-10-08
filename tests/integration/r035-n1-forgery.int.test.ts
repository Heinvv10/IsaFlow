/**
 * R-035 N1: approval_requests refuses every direct write from the roles the
 * app and the admin platform connect as. Each forgery is attempted as raw SQL
 * against a request the real route raised, with real claims — as app_user and
 * as platform_admin (BYPASSRLS) — and the bill it would clear stays gated.
 * The catalogue half — no non-owner write grant, the writers SECURITY
 * DEFINER with an RLS-bypassing owner, search_path with pg_temp last, EXECUTE
 * for app_user only — is r035-n1-catalog.int.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupPr2, routes } from './r035-pr2.helpers';
import { asRole, n1Users, outcome, pendingBill, requestRow } from './r035-n1.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let u: Awaited<ReturnType<typeof n1Users>>;
const r = routes(tokens);
const DENIED = '42501';

beforeAll(async () => { u = await n1Users(pool, tokens); });
afterAll(() => cleanupPr2(pool, companies, Object.values(u)));

const ROLES = ['app_user', 'platform_admin'] as const;

describe.each(ROLES)('as %s, raw SQL cannot', (role) => {
  it("UPDATE a pending request to 'approved' — and the bill stays unpostable", async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(asRole(pool, role, f.c, { sub: u.a }, (cl) => cl.query(
      "UPDATE approval_requests SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1",
      [f.requestId, u.m]), true))).toBe(DENIED);
    expect((await requestRow(pool, f.requestId))?.status).toBe('pending');
    expect((await r.approveBill(u.a, f.c, f.bill.id)).state.statusCode).toBe(409);
  });

  it('INSERT a request already approved (supplier_invoice, the type 862 never guarded)', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    await pool.query('DELETE FROM approval_requests WHERE id = $1', [f.requestId]);
    expect(await outcome(asRole(pool, role, f.c, { sub: u.a }, (cl) => cl.query(
      `INSERT INTO approval_requests(company_id, document_type, document_id, status, requested_by, required_role,
         decided_by, decided_at, document_digest)
       VALUES($1,'supplier_invoice',$2,'approved',$3,'owner',$4,now(),approval_document_digest($1,'supplier_invoice',$2))`,
      [f.c, f.bill.id, u.a, u.b]), true))).toBe(DENIED);
    expect((await pool.query('SELECT count(*)::INT AS n FROM approval_requests WHERE document_id = $1', [f.bill.id]))
      .rows[0].n).toBe(0);
    expect((await r.approveBill(u.a, f.c, f.bill.id)).state.statusCode).toBe(409);
  });

  it('DELETE a request', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(asRole(pool, role, f.c, { sub: u.b }, (cl) => cl.query(
      'DELETE FROM approval_requests WHERE id = $1', [f.requestId]), true))).toBe(DENIED);
    expect((await requestRow(pool, f.requestId))?.status).toBe('pending');
  });

  it.each([
    ['required_role', "'viewer'"],
    ['rule_id', '$2::UUID'],
    ['decided_by', '$3::UUID'],
  ])('UPDATE %s on a pending request', async (column, value) => {
    const f = await pendingBill(pool, tokens, u, companies);
    const before = await requestRow(pool, f.requestId);
    expect(await outcome(asRole(pool, role, f.c, { sub: u.b }, (cl) => cl.query(
      `UPDATE approval_requests SET ${column} = ${value} WHERE id = $1 AND $2::UUID IS NOT NULL AND $3::UUID IS NOT NULL`,
      [f.requestId, f.managerRule, u.m]), true))).toBe(DENIED);
    expect(await requestRow(pool, f.requestId)).toEqual(before);
  });

  it('lock a request FOR UPDATE (the decide path does it through approval_request_lock)', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(asRole(pool, role, f.c, { sub: u.b }, (cl) => cl.query(
      'SELECT id FROM approval_requests WHERE id = $1 FOR UPDATE', [f.requestId])))).toBe(DENIED);
  });

  it('still READ the request (every gate reads it)', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(asRole(pool, role, f.c, { sub: u.b }, (cl) => cl.query(
      'SELECT id FROM approval_requests WHERE id = $1', [f.requestId])))).toBe('ok');
  });
});

// The catalogue half (grants, prosecdef, search_path, owners, EXECUTE) is
// r035-n1-catalog.int.test.ts, which runs against any DATABASE_URL.
