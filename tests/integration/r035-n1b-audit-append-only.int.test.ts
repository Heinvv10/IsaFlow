/**
 * R-035 N1b (A, migration 880): audit_log is append-only for the roles the
 * app and the admin platform connect as. The record that matters most — the
 * sole-approver (Q2) row 872's decide writes — is raised for real, then each
 * forgery is attempted on it as raw SQL under real claims, as app_user and as
 * platform_admin (BYPASSRLS), and the row is read back unchanged.
 *
 * Append-only is not read-only and not authenticated: INSERT and SELECT stay,
 * so a forged EXTRA row is still possible (the accepted limit, Hein
 * 2026-10-09) — pinned here so a change to it is a decision, not an accident.
 * The catalogue half (no non-owner UPDATE/DELETE/TRUNCATE/TRIGGER, by grant,
 * column, PUBLIC or membership) is r035-n1b-audit-catalog.int.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { newCompany } from './r035-approval.helpers';
import { cleanupPr2 } from './r035-pr2.helpers';
import { asRole, decideFn, n1Users, outcome, pendingBill, requestRow } from './r035-n1.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let u: Awaited<ReturnType<typeof n1Users>>;
const DENIED = '42501';

beforeAll(async () => { u = await n1Users(pool, tokens); });
afterAll(() => cleanupPr2(pool, companies, Object.values(u)));

/** A sole owner's self-approval, decided through 872's definer: the Q2 audit row exists. */
async function q2Row() {
  const f = await pendingBill(pool, tokens, u, companies,
    { members: [[u.a, 'owner'], [u.m, 'manager']], creator: u.a, requester: u.a });
  const digest = (await requestRow(pool, f.requestId))?.document_digest ?? null;
  await asRole(pool, 'app_user', f.c, { sub: u.a },
    (cl) => decideFn(cl, f.c, f.requestId, 'approved', u.a, digest), true);
  const { rows } = await pool.query(
    "SELECT * FROM audit_log WHERE entity_type = 'approval_request' AND entity_id = $1", [f.requestId]);
  expect(rows, 'the decide wrote the Q2 row').toHaveLength(1);
  return { c: f.c, requestId: f.requestId, row: rows[0] as Record<string, unknown> };
}

const rowNow = async (id: unknown) => (await pool.query('SELECT * FROM audit_log WHERE id = $1', [id])).rows[0];

describe.each(['app_user', 'platform_admin'] as const)('as %s, raw SQL cannot', (role) => {
  it('DELETE the Q2 sole-approver row', async () => {
    const q = await q2Row();
    expect(await outcome(asRole(pool, role, q.c, { sub: u.a }, (cl) => cl.query(
      'DELETE FROM audit_log WHERE id = $1', [q.row.id]), true))).toBe(DENIED);
    expect(await rowNow(q.row.id)).toEqual(q.row);
  });

  it.each([
    ['its metadata', "changes = jsonb_build_object('fields', '[]'::jsonb)"],
    ['its author', 'user_id = $2'],
    ['its action', "action = 'reject'"],
    ['its time', "created_at = now() - interval '1 year'"],
  ])('UPDATE %s', async (_label, set) => {
    const q = await q2Row();
    expect(await outcome(asRole(pool, role, q.c, { sub: u.a }, (cl) => cl.query(
      `UPDATE audit_log SET ${set} WHERE id = $1 AND $2::TEXT IS NOT NULL`, [q.row.id, u.m]), true))).toBe(DENIED);
    expect(await rowNow(q.row.id)).toEqual(q.row);
  });

  it('TRUNCATE the table', async () => {
    const q = await q2Row();
    expect(await outcome(asRole(pool, role, q.c, { sub: u.a }, (cl) => cl.query('TRUNCATE audit_log')))).toBe(DENIED);
    expect(await rowNow(q.row.id)).toEqual(q.row);
  });

  it('lock a row FOR UPDATE', async () => {
    const q = await q2Row();
    expect(await outcome(asRole(pool, role, q.c, { sub: u.a }, (cl) => cl.query(
      'SELECT id FROM audit_log WHERE id = $1 FOR UPDATE', [q.row.id])))).toBe(DENIED);
  });

  it('attach a trigger (it would run inside every later insert)', async () => {
    const q = await q2Row();
    expect(await outcome(asRole(pool, role, q.c, { sub: u.a }, (cl) => cl.query(
      `CREATE TRIGGER n1b_forged BEFORE INSERT ON audit_log
       FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`)))).toBe(DENIED);
  });
});

describe('append-only, not read-only', () => {
  it('app_user still logs (the logAuditOrThrow INSERT) and reads its own company rows', async () => {
    const c = await newCompany(pool, [[u.a, 'owner']], companies);
    const entity = crypto.randomUUID();
    const read = await asRole(pool, 'app_user', c, { sub: u.a }, async (cl) => {
      await cl.query(`INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id, changes)
        VALUES ($1, $2, 'update', 'n1b_probe', $3, '{}'::jsonb)`, [c, u.a, entity]);
      return (await cl.query('SELECT action FROM audit_log WHERE entity_id = $1', [entity])).rows;
    }, true);
    expect(read).toEqual([{ action: 'update' }]);
  });

  it('platform_admin still logs and reads', async () => {
    const c = await newCompany(pool, [[u.a, 'owner']], companies);
    const entity = crypto.randomUUID();
    expect(await outcome(asRole(pool, 'platform_admin', c, { sub: u.a }, (cl) => cl.query(
      `INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id)
       VALUES ($1, $2, 'update', 'n1b_probe', $3)`, [c, u.a, entity]), true))).toBe('ok');
    expect((await pool.query('SELECT count(*)::INT AS n FROM audit_log WHERE entity_id = $1', [entity])).rows[0].n).toBe(1);
  });

  it('ACCEPTED LIMIT: a member can still INSERT a forged extra row (append-only is not authenticated)', async () => {
    const q = await q2Row();
    expect(await outcome(asRole(pool, 'app_user', q.c, { sub: u.m }, (cl) => cl.query(
      `INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id, changes)
       VALUES ($1, $2, 'reject', 'approval_request', $3, '{}'::jsonb)`, [q.c, u.m, q.requestId]), true))).toBe('ok');
    expect(await rowNow(q.row.id), 'the Q2 row itself is untouched').toEqual(q.row);
  });

  it("a company delete still removes the company's rows (ON DELETE CASCADE runs as the table owner)", async () => {
    const c = await newCompany(pool, [], companies);
    const entity = crypto.randomUUID();
    await pool.query(`INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id)
      VALUES ($1, $2, 'create', 'n1b_probe', $3)`, [c, u.a, entity]);
    expect(await outcome(asRole(pool, 'platform_admin', c, { sub: u.a }, (cl) => cl.query(
      'DELETE FROM companies WHERE id = $1', [c]), true))).toBe('ok');
    expect((await pool.query('SELECT count(*)::INT AS n FROM audit_log WHERE entity_id = $1', [entity])).rows[0].n).toBe(0);
  });
});
