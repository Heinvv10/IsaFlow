/**
 * R-035 N1: approval_requests refuses every direct write from the roles the
 * app and the admin platform connect as. Each forgery is attempted as raw SQL
 * against a request the real route raised, with real claims — as app_user and
 * as platform_admin (BYPASSRLS) — and the bill it would clear stays gated.
 * The catalogue half pins what migration 872 ships: no non-owner write grant,
 * the writers SECURITY DEFINER with an RLS-bypassing owner, search_path with
 * pg_temp last, EXECUTE for app_user only.
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

describe('the catalogue', () => {
  const WRITERS = [
    'approval_request_raise(uuid,text,uuid,uuid,text)',
    'approval_request_rebind(uuid,uuid,uuid,text)',
    'approval_request_lock(uuid,uuid)',
    'approval_request_decide(uuid,uuid,text,text,text,text)',
  ];

  it('no role but the owner holds a write, truncate or trigger privilege on approval_requests, by table or by column', async () => {
    const { rows } = await pool.query(`
      SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS who, a.privilege_type
      FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid = 'public.approval_requests'::regclass AND a.grantee <> c.relowner
        AND a.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER')
      UNION ALL
      SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type || ' ' || att.attname
      FROM pg_attribute att, aclexplode(att.attacl) a
      WHERE att.attrelid = 'public.approval_requests'::regclass AND a.privilege_type IN ('INSERT','UPDATE')`);
    expect(rows).toEqual([]);
    for (const who of ['app_user', 'platform_admin', 'migration_admin', 'public']) {
      for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER']) {
        const { rows: [p] } = await pool.query('SELECT has_table_privilege($1, $2, $3) AS ok', [who, 'public.approval_requests', priv]);
        expect(p.ok, `${who} ${priv}`).toBe(false);
      }
    }
  });

  it.each(WRITERS)('%s is SECURITY DEFINER, owned by a role that bypasses RLS, pg_temp last, app_user-only', async (fn) => {
    const { rows: [p] } = await pool.query(`
      SELECT p.prosecdef, (r.rolbypassrls OR r.rolsuper) AS bypass, p.proconfig[array_upper(p.proconfig, 1)] AS last_config,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
             has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_exec
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = $1::regprocedure`, [`public.${fn}`]);
    expect(p).toEqual({ prosecdef: true, bypass: true, last_config: expect.stringMatching(/^search_path=.*pg_temp$/),
      public_exec: false, app_exec: true });
  });

  it('the helpers are executable by nobody but the owner; the writers by app_user alone', async () => {
    const { rows } = await pool.query(`
      SELECT p.proname, r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN (SELECT rolname, oid FROM pg_roles WHERE NOT rolsuper AND rolname !~ '^pg_' UNION ALL SELECT 'public', 0) r
      WHERE n.nspname = 'public' AND r.oid <> p.proowner
        AND (p.proname LIKE 'approval\\_request\\_%' OR p.proname = 'approval_actor_rank')
        AND p.proname <> 'approval_request_insert_guard'
        AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')
      ORDER BY 1, 2`);
    expect(rows).toEqual(['decide', 'lock', 'raise', 'rebind'].map((fn) => ({ proname: `approval_request_${fn}`, rolname: 'app_user' })));
  });

  it('no other function body writes approval_requests, and every writer is a SECURITY DEFINER', async () => {
    const { rows } = await pool.query(`
      SELECT p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema')
        AND p.prosrc ~* '(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?approval_requests\\M'
      ORDER BY 1`);
    expect(rows).toEqual([
      { proname: 'approval_request_decide', prosecdef: true },
      { proname: 'approval_request_raise', prosecdef: true },
      { proname: 'approval_request_rebind', prosecdef: true },
    ]);
  });
});
