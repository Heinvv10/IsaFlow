/**
 * R-035 PR3: approval enforcement on CREDIT NOTES, through the real approve
 * route (credit-notes-action), for both types.
 *
 * With enforcement on for the note's type and an active rule of that type
 * matching it, approving the note (which posts its journal and applies it to
 * the counterparty's documents) is refused 409 until an APPROVED request
 * exists for the note's CURRENT content, at a rank the strictest rule today
 * demands, decided at or after enforcement was (last) switched on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import {
  approvalTypeOf, cleanupPr3, enforceType, noteCompany, noteRoutes, noteState, plantNote, type NoteType,
} from './r035-pr3.helpers';

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

/** A (admin) books and requests; B (owner) approves; M is a manager. */
const company = () => noteCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.m, 'manager']], companies);
const other = (type: NoteType): NoteType => (type === 'customer' ? 'supplier' : 'customer');

describe.each(['customer', 'supplier'] as const)('%s credit notes', (type) => {
  const docType = approvalTypeOf(type);

  async function gated(opts: { rule?: string; enforced?: boolean; linked?: boolean } = {}) {
    const c = await company();
    await plantRule(pool, c, opts.rule ?? 'owner', { documentType: docType, name: 'Owner signs' });
    if (opts.enforced !== false) await enforceType(pool, c, type, u.b);
    return { c, note: await plantNote(pool, c, u.a, type, { linked: opts.linked }) };
  }

  async function approvedBy(approver: string, c: string, noteId: string): Promise<string> {
    const raised = await r.raise(u.a, c, docType, noteId);
    expect(raised.state.statusCode, JSON.stringify(raised.state.body)).toBe(200);
    const requestId = dataOf<{ id: string }>(raised).id;
    const decided = await r.decide(pool, approver, c, requestId);
    expect(decided.state.statusCode, JSON.stringify(decided.state.body)).toBe(200);
    return requestId;
  }

  it('the enforcement API switches the type on (200) and records it', async () => {
    const c = await company();
    const res = await callRoute(approvalEnforcement, tokens[u.b]!, c, 'POST',
      { documentType: docType, enabled: true }, '/api/accounting/approval-enforcement');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const { rows } = await pool.query('SELECT document_type FROM approval_enforcement WHERE company_id = $1', [c]);
    expect(rows.map((x) => x.document_type)).toEqual([docType]);
  });

  it('refuses 409 APPROVAL_REQUIRED: still a draft, no journal, the linked invoice untouched', async () => {
    const { c, note } = await gated({ linked: true });
    const res = await r.approve(u.a, c, note.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(messageOf(res)).toMatch(new RegExp(`${type === 'customer' ? 'Customer' : 'Supplier'} credit note CN-\\S+ needs owner approval`));
    expect(await noteState(pool, note.id)).toEqual({ status: 'draft', gl_journal_entry_id: null, journals: 0, invoice_paid: 0 });
    const { rows } = await pool.query('SELECT count(*)::INT AS n FROM credit_note_allocations WHERE credit_note_id = $1', [note.id]);
    expect(rows[0].n).toBe(0);
  });

  it('refuses 409 APPROVAL_PENDING while the request awaits a decision', async () => {
    const { c, note } = await gated();
    expect((await r.raise(u.a, c, docType, note.id)).state.statusCode).toBe(200);
    const res = await r.approve(u.a, c, note.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_PENDING');
    expect((await noteState(pool, note.id)).journals).toBe(0);
  });

  it('A requests, B approves the request, A posts: 200 with the journal', async () => {
    const { c, note } = await gated();
    await approvedBy(u.b, c, note.id);
    const res = await r.approve(u.a, c, note.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const state = await noteState(pool, note.id);
    expect(state.status).not.toBe('draft');
    expect(state.gl_journal_entry_id).not.toBeNull();
    expect(state.journals).toBe(1);
  });

  it('a manager-level approval does not clear once an owner rule governs (the ratchet)', async () => {
    const { c, note } = await gated({ rule: 'manager' });
    await approvedBy(u.b, c, note.id);
    await plantRule(pool, c, 'owner', { documentType: docType, name: 'late owner rule' });
    const res = await r.approve(u.a, c, note.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect((await noteState(pool, note.id)).journals).toBe(0);
  });

  it('enforcement off: posts as it always did, rule or no rule', async () => {
    const { c, note } = await gated({ enforced: false });
    expect((await r.approve(u.a, c, note.id)).state.statusCode).toBe(200);
    expect((await noteState(pool, note.id)).journals).toBe(1);
  });

  it("enforcement on for the other type only does not gate this one", async () => {
    const { c, note } = await gated({ enforced: false });
    await plantRule(pool, c, 'owner', { documentType: approvalTypeOf(other(type)) });
    await enforceType(pool, c, other(type), u.b);
    expect((await r.approve(u.a, c, note.id)).state.statusCode).toBe(200);
  });

  it('an approved row with a NULL digest never clears', async () => {
    const { c, note } = await gated();
    await pool.query(
      `INSERT INTO approval_requests(company_id, document_type, document_id, status, requested_by, required_role, decided_by, decided_at)
       VALUES($1,$2,$3,'approved',$4,'owner',$5,now())`, [c, docType, note.id, u.a, u.b]);
    expect((await r.approve(u.a, c, note.id)).state.statusCode).toBe(409);
  });

  it('an approval decided BEFORE enforcement was (re-)enabled does not clear', async () => {
    const { c, note } = await gated({ enforced: false });
    await approvedBy(u.b, c, note.id);
    await enforceType(pool, c, type, u.b, new Date(Date.now() + 1000).toISOString());
    const res = await r.approve(u.a, c, note.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
  });

  it("a request raised as the other type names no document (refused, no digest)", async () => {
    const { c, note } = await gated();
    await plantRule(pool, c, 'manager', { documentType: approvalTypeOf(other(type)) });
    const raised = await r.raise(u.a, c, approvalTypeOf(other(type)), note.id);
    expect(raised.state.statusCode).toBe(400);
    expect(messageOf(raised)).toMatch(new RegExp(`No ${approvalTypeOf(other(type))} \\S+ exists for this company`));
    const { rows } = await pool.query('SELECT count(*)::INT AS n FROM approval_requests WHERE document_id = $1', [note.id]);
    expect(rows[0].n).toBe(0);
  });

  it('a note whose subtotal + tax exceeds its total is matched on the larger figure', async () => {
    const c = await company();
    await plantRule(pool, c, 'owner', { documentType: docType, operator: 'greater_than', value: 1000 });
    await enforceType(pool, c, type, u.b);
    const note = await plantNote(pool, c, u.a, type, { subtotal: 1000, tax: 150, total: 900 });
    const res = await r.approve(u.a, c, note.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
  });

  it('a sole owner may approve their own request (Q2), audited with the marker, then post', async () => {
    const c = await noteCompany(pool, [[u.b, 'owner'], [u.m, 'manager']], companies);
    await plantRule(pool, c, 'owner', { documentType: docType });
    await enforceType(pool, c, type, u.b);
    const note = await plantNote(pool, c, u.b, type);
    const raised = await r.raise(u.b, c, docType, note.id);
    const requestId = dataOf<{ id: string }>(raised).id;
    const decided = await r.decide(pool, u.b, c, requestId);
    expect(decided.state.statusCode, JSON.stringify(decided.state.body)).toBe(200);
    const { rows } = await pool.query(
      "SELECT changes FROM audit_log WHERE company_id = $1 AND entity_type = 'approval_request' AND entity_id = $2", [c, requestId]);
    expect(rows[0].changes.metadata).toMatchObject({ selfApproval: 'sole_approver', requiredRole: 'owner', documentType: docType });
    expect((await r.approve(u.b, c, note.id)).state.statusCode).toBe(200);
  });
});

describe('tenant isolation', () => {
  async function asAppUser<T>(userId: string, companyId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: 'authenticated' })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it.each(['customer', 'supplier'] as const)("a forged approved row in company B carrying A's %s note id does not clear it", async (type) => {
    const c = await company();
    await plantRule(pool, c, 'owner', { documentType: approvalTypeOf(type) });
    await enforceType(pool, c, type, u.b);
    const note = await plantNote(pool, c, u.a, type);
    const b = await company();
    await enforceType(pool, b, type, u.b); // B enforces too: only company_id keeps its row off A's note
    const digest = (await pool.query('SELECT approval_document_digest($1,$2,$3) AS d', [c, approvalTypeOf(type), note.id])).rows[0].d;
    await asAppUser(u.b, b, (client) => client.query(
      `INSERT INTO approval_requests(company_id, document_type, document_id, status, requested_by, required_role,
         decided_by, decided_at, document_digest)
       VALUES($1,$2,$3,'approved',$4,'owner',$5,now(),$6)`, [b, approvalTypeOf(type), note.id, u.a, u.b, digest]));
    const res = await r.approve(u.a, c, note.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
  });

  it.each(['customer', 'supplier'] as const)("company B's %s enforcement does not enforce on company A", async (type) => {
    const c = await company();
    await plantRule(pool, c, 'owner', { documentType: approvalTypeOf(type) });
    const note = await plantNote(pool, c, u.a, type);
    const b = await company();
    await enforceType(pool, b, type, u.b);
    expect((await r.approve(u.a, c, note.id)).state.statusCode).toBe(200);
  });
});
