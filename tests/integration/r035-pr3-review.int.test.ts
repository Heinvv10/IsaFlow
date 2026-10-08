/**
 * R-035 PR3 review round 1, the database half:
 *
 *  - A3 / round 2 N2: app_user may INSERT a credit-note approval request only
 *    as the request requestApproval raises — pending, undecided, with no past
 *    requesters, and raised by the session's own user. A decided row is an
 *    approval nobody gave; a row naming another requester lets its real raiser
 *    decide their own request. A role that bypasses RLS (the owner a script or
 *    fixture runs as) is not held to it. Since R-035 N1 (migration 872)
 *    app_user may not INSERT the table at all — every forgery below is refused
 *    by privilege — and a legitimate raise goes through
 *    approval_request_raise; supplier-invoice requests included.
 *  - A4: the credit-note backstop applies the rank ratchet the TypeScript gate
 *    does — an approval clears only at a rank at or above the strictest active
 *    rule matching today — and refuses a row bound to no role.
 *  - B3: approval_enforcement admits only the types wired so far.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { raiseUnattendedApproval } from '../../src/modules/accounting/services/gl/approvalUnattended';
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

/** R-035 N1 (migration 872): app_user holds no INSERT on approval_requests. */
const DENIED = /permission denied for table approval_requests/;
/** The legitimate raise since N1: approval_request_raise, bound to an `admin any` rule of the note's type. */
const raisePending = async (cl: PoolClient, c: string, documentType: string, noteId: string, requestedBy: string) => {
  const rule = await plantRule(pool, c, 'admin', { documentType });
  return cl.query('SELECT * FROM approval_request_raise($1, $2, $3, $4, $5)', [c, documentType, noteId, rule, requestedBy]);
};

/** What withAuth sets up: app_user, the session's claims (a non-impersonation session) and the company. */
async function asAppUser<T>(userId: string, companyId: string, body: (c: PoolClient) => Promise<T>,
  sub: string = userId): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true), set_config('app.current_company_id', $2, true)",
      [JSON.stringify({ sub, role: 'authenticated', session_id: crypto.randomUUID() }), companyId]);
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
        .rejects.toThrow(DENIED);
    }
    await expect(asAppUser(u.a, c, async (cl) => {
      await postRaw(cl, note.id);
    })).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('app_user may still raise a pending one (through approval_request_raise), and the owner role may plant a decided one', async () => {
    const c = await company();
    const note = await plantNote(pool, c, u.a, type);
    await asAppUser(u.a, c, (cl) => raisePending(cl, c, approvalTypeOf(type), note.id, u.a));
    const other = await plantNote(pool, c, u.a, type);
    await insertRequest(pool, c, approvalTypeOf(type), other.id, 'approved');
    const { rows } = await pool.query('SELECT status FROM approval_requests WHERE document_id = ANY($1) ORDER BY status',
      [[note.id, other.id]]);
    expect(rows.map((x) => x.status)).toEqual(['approved', 'pending']);
  });
});

describe.each(['customer', 'supplier'] as const)('N2 — a pending %s credit-note request is inserted only as requestApproval writes it', (type) => {
  /** A pending row, plus one more column set to a SQL expression when asked. */
  const insertPending = (cl: PoolClient, c: string, noteId: string, requestedBy: string, extra?: [string, string]) => cl.query(
    `INSERT INTO approval_requests(company_id, document_type, document_id, requested_by, status, required_role, document_digest${extra ? `, ${extra[0]}` : ''})
     VALUES($1, $2, $3, $4, 'pending', 'owner', approval_document_digest($1, $2, $3)${extra ? `, ${extra[1]}` : ''})`,
    [c, approvalTypeOf(type), noteId, requestedBy]);
  const SOMEONE = '00000000-0000-4000-8000-000000000000';

  it('refuses a row naming another requester — its real raiser could then decide it', async () => {
    const c = await company();
    const note = await plantNote(pool, c, u.a, type);
    await expect(asAppUser(u.b, c, (cl) => insertPending(cl, c, note.id, u.a))).rejects.toThrow(DENIED);
  });

  it('compares the subject as a uuid: the same id in upper case may still raise (round 3)', async () => {
    const c = await company();
    const note = await plantNote(pool, c, u.a, type);
    await asAppUser(u.a, c, (cl) => raisePending(cl, c, approvalTypeOf(type), note.id, u.a), u.a.toUpperCase());
    const { rows } = await pool.query('SELECT requested_by FROM approval_requests WHERE document_id = $1', [note.id]);
    expect(rows).toEqual([{ requested_by: u.a }]);
  });

  it.each(['not-a-uuid', ''])(
    'refuses a subject %j that is no uuid — as a forgery, not a cast error', async (badSub) => {
      const c = await company();
      const note = await plantNote(pool, c, u.a, type);
      await expect(asAppUser(u.a, c, (cl) => insertPending(cl, c, note.id, u.a), badSub))
        .rejects.toThrow(DENIED);
    });

  it('refuses any insert from a session with no JWT subject (auth.uid() NULL), whoever it names', async () => {
    const c = await company();
    const note = await plantNote(pool, c, u.a, type);
    const cl = await pool.connect();
    try {
      await cl.query('BEGIN');
      await cl.query('SET LOCAL ROLE app_user');
      await cl.query("SELECT set_config('app.current_company_id', $1, true)", [c]);
      await expect(insertPending(cl, c, note.id, u.a)).rejects.toThrow(DENIED);
    } finally {
      await cl.query('ROLLBACK');
      cl.release();
    }
  });

  it.each([
    ['decided_by', `'${SOMEONE}'::UUID`],
    ['decided_at', 'now()'],
    ['past_requesters', `ARRAY['${SOMEONE}']::UUID[]`],
  ] as [string, string][])('refuses a pending row that already carries %s', async (column, value) => {
    const c = await company();
    const note = await plantNote(pool, c, u.a, type);
    await expect(asAppUser(u.a, c, (cl) => insertPending(cl, c, note.id, u.a, [column, value]))).rejects.toThrow(DENIED);
  });

  it('the human raise (approval-requests route, under withAuth) still writes its request', async () => {
    const c = await company();
    await plantRule(pool, c, 'owner', { documentType: approvalTypeOf(type) });
    await enforceType(pool, c, type, u.b);
    const note = await plantNote(pool, c, u.a, type);
    const raised = await r.raise(u.a, c, approvalTypeOf(type), note.id);
    expect(raised.state.statusCode, JSON.stringify(raised.state.body)).toBe(200);
    expect(dataOf<{ requestedBy: string; status: string }>(raised)).toMatchObject({ requestedBy: u.a, status: 'pending' });
  });

  it('an unattended raise as the session user (raiseUnattendedApproval) still writes its request', async () => {
    const c = await company();
    await plantRule(pool, c, 'owner', { documentType: approvalTypeOf(type) });
    await enforceType(pool, c, type, u.b);
    const note = await plantNote(pool, c, u.a, type);
    const request = await asAppUser(u.a, c, (client) => als.run({ client, userId: u.a, companyId: c, claims: { sub: u.a } } as never,
      () => raiseUnattendedApproval(c, approvalTypeOf(type), note.id, u.a)));
    expect(request).toMatchObject({ requestedBy: u.a, status: 'pending' });
  });
});

describe('A3 scope — supplier-invoice requests (closed by R-035 N1, migration 872)', () => {
  it('app_user may NOT insert a decided supplier_invoice request row', async () => {
    const c = await company();
    const id = crypto.randomUUID();
    await expect(asAppUser(u.a, c, (cl) => insertRequest(cl, c, 'supplier_invoice', id, 'approved'))).rejects.toThrow(DENIED);
    const { rows } = await pool.query('SELECT status FROM approval_requests WHERE document_id = $1', [id]);
    expect(rows).toEqual([]);
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
  // manual_journal was wired by PR6 (869); every type R-035 wires is now admitted, an unknown one still is not.
  it.each(['expense_claim', 'bank_transfer'])('refuses %s', async (documentType) => {
    const c = await company();
    await expect(pool.query('INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1,$2,$3)',
      [c, documentType, u.b])).rejects.toThrow(/approval_enforcement_document_type_check/);
  });
});
