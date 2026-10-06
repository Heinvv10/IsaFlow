/**
 * R-035 PR3 review round 1, the database half:
 *
 *  - A3: app_user may not INSERT a credit-note approval request that is
 *    already decided (status other than 'pending'): it would be an approval
 *    nobody gave, and the backstop reads approved rows. A role that bypasses
 *    RLS (the owner a script or fixture runs as) still may. Supplier-invoice
 *    requests are out of scope (live): unchanged.
 *  - A4: the credit-note backstop applies the rank ratchet the TypeScript gate
 *    does — an approval clears only at a rank at or above the strictest active
 *    rule matching today — and refuses a row bound to no role.
 *  - B3: approval_enforcement admits only the types wired so far.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { approvalTypeOf, cleanupPr3, enforceType, noteCompany, noteRoutes, plantNote } from './r035-pr3.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', m: '' };
const r = noteRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr3(pool, companies, Object.values(u)));

const company = () => noteCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.m, 'manager']], companies);

async function asAppUser<T>(userId: string, companyId: string, body: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true), set_config('app.current_company_id', $2, true)",
      [JSON.stringify({ sub: userId, role: 'authenticated' }), companyId]);
    const out = await body(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

const postRaw = (db: PoolClient | Pool, id: string) => db.query("UPDATE credit_notes SET status = 'approved' WHERE id = $1", [id]);

/** A request row for the note's current content, as `db` inserts it. */
const insertRequest = (db: PoolClient | Pool, c: string, documentType: string, documentId: string, status: string,
  requiredRole: string | null = 'owner') => db.query(
  `INSERT INTO approval_requests(company_id, document_type, document_id, requested_by, status, decided_by, decided_at,
     required_role, document_digest)
   VALUES($1, $2, $3, $4::UUID, $5::TEXT, CASE WHEN $5::TEXT = 'pending' THEN NULL ELSE $4::UUID END,
     CASE WHEN $5::TEXT = 'pending' THEN NULL ELSE now() END,
     $6, approval_document_digest($1, $2, $3))`, [c, documentType, documentId, u.a, status, requiredRole]);

describe.each(['customer', 'supplier'] as const)('A3 — a decided %s credit-note request cannot be forged by INSERT', (type) => {
  it('app_user INSERTing an approved row is refused, and the note stays unpostable', async () => {
    const c = await company();
    await plantRule(pool, c, 'owner', { documentType: approvalTypeOf(type) });
    await enforceType(pool, c, type, u.b);
    const note = await plantNote(pool, c, u.a, type);
    for (const status of ['approved', 'rejected', 'cancelled']) {
      await expect(asAppUser(u.a, c, (cl) => insertRequest(cl, c, approvalTypeOf(type), note.id, status)), status)
        .rejects.toThrow(/R035_APPROVAL_REQUEST_FORGED/);
    }
    await expect(asAppUser(u.a, c, async (cl) => {
      await postRaw(cl, note.id);
    })).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('app_user may still INSERT a pending one, and the owner role may plant a decided one', async () => {
    const c = await company();
    const note = await plantNote(pool, c, u.a, type);
    await asAppUser(u.a, c, (cl) => insertRequest(cl, c, approvalTypeOf(type), note.id, 'pending'));
    const other = await plantNote(pool, c, u.a, type);
    await insertRequest(pool, c, approvalTypeOf(type), other.id, 'approved');
    const { rows } = await pool.query('SELECT status FROM approval_requests WHERE document_id = ANY($1) ORDER BY status',
      [[note.id, other.id]]);
    expect(rows.map((x) => x.status)).toEqual(['approved', 'pending']);
  });
});

describe('A3 scope — supplier-invoice requests are unchanged (live enforcement, out of bounds)', () => {
  it('app_user may still INSERT a decided supplier_invoice request row', async () => {
    const c = await company();
    const id = crypto.randomUUID(); // the trigger reads no document: any id shows it is not consulted
    await asAppUser(u.a, c, (cl) => insertRequest(cl, c, 'supplier_invoice', id, 'approved'));
    const { rows } = await pool.query('SELECT status FROM approval_requests WHERE document_id = $1', [id]);
    expect(rows).toEqual([{ status: 'approved' }]);
  });
});

describe.each(['customer', 'supplier'] as const)('A4 — the %s credit-note backstop applies the rank ratchet', (type) => {
  it('a manager approval does not clear once an owner rule governs, through the route or raw SQL', async () => {
    const c = await company();
    await plantRule(pool, c, 'manager', { documentType: approvalTypeOf(type), name: 'Manager signs' });
    await enforceType(pool, c, type, u.b);
    const note = await plantNote(pool, c, u.a, type);
    const raised = await r.raise(u.a, c, approvalTypeOf(type), note.id);
    expect((await r.decide(pool, u.m, c, dataOf<{ id: string }>(raised).id)).state.statusCode).toBe(200);
    await plantRule(pool, c, 'owner', { documentType: approvalTypeOf(type), name: 'Owner signs' });
    expect((await r.approve(u.a, c, note.id)).state.statusCode).toBe(409);
    await expect(asAppUser(u.a, c, async (cl) => { await postRaw(cl, note.id); })).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('an owner approval clears the same note', async () => {
    const c = await company();
    await plantRule(pool, c, 'manager', { documentType: approvalTypeOf(type) });
    await plantRule(pool, c, 'owner', { documentType: approvalTypeOf(type) });
    await enforceType(pool, c, type, u.b);
    const note = await plantNote(pool, c, u.a, type);
    await insertRequest(pool, c, approvalTypeOf(type), note.id, 'approved', 'owner');
    await postRaw(pool, note.id);
    expect((await pool.query('SELECT status FROM credit_notes WHERE id = $1', [note.id])).rows[0].status).toBe('approved');
  });

  it('an approved row bound to no role (no required_role, no rule) clears nothing', async () => {
    const c = await company();
    await plantRule(pool, c, 'viewer', { documentType: approvalTypeOf(type) });
    await enforceType(pool, c, type, u.b);
    const note = await plantNote(pool, c, u.a, type);
    await insertRequest(pool, c, approvalTypeOf(type), note.id, 'approved', null);
    await expect(postRaw(pool, note.id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it("a rule-bound row with no snapshot is ranked by its rule's role", async () => {
    const c = await company();
    const rule = await plantRule(pool, c, 'owner', { documentType: approvalTypeOf(type) });
    await enforceType(pool, c, type, u.b);
    const note = await plantNote(pool, c, u.a, type);
    await insertRequest(pool, c, approvalTypeOf(type), note.id, 'approved', null);
    await pool.query('UPDATE approval_requests SET rule_id = $2 WHERE document_id = $1', [note.id, rule]);
    await postRaw(pool, note.id);
    expect((await pool.query('SELECT status FROM credit_notes WHERE id = $1', [note.id])).rows[0].status).toBe('approved');
  });
});

describe('B3 — approval_enforcement admits only the types wired so far', () => {
  it.each(['supplier_payment', 'payment_batch', 'manual_journal'])('refuses %s', async (documentType) => {
    const c = await company();
    await expect(pool.query('INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1,$2,$3)',
      [c, documentType, u.b])).rejects.toThrow(/approval_enforcement_document_type_check/);
  });
});
