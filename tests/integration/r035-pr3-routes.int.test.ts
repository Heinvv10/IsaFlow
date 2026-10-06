/**
 * R-035 PR3: the credit-note routes other than the approve action.
 *
 *  - supplier-credit-notes POST submitAction 'post' creates the draft first:
 *    a refused post answers 409 naming the note, and the draft STAYS
 *    (withAuth commits a 4xx; the gate refuses before any approve write).
 *    PATCH action 'post' answers 409 too.
 *  - The detail GETs carry the DERIVED approval state while the note is a
 *    draft, null once posted.
 *  - The customer merge re-points a note's client — approval content — so an
 *    approval goes stale, the merging user becomes an author (refused as its
 *    approver), and putting the content back clears it again (Q9).
 *  - The enforcement switch: an unknown R-035 type is still refused, and
 *    switching a credit-note type OFF needs the rank to weaken its strictest rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import customerMerge from '../../pages/api/accounting/customer-merge';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { cleanupPr3, enforceType, noteCompany, noteRoutes, noteState, plantNote } from './r035-pr3.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', c: '', m: '' };
const r = noteRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr3(pool, companies, Object.values(u)));

/** A (admin) books; B and C (owners) approve; M is a manager. */
const company = () => noteCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.c, 'owner'], [u.m, 'manager']], companies);

async function gatedCompany(type: 'customer' | 'supplier'): Promise<string> {
  const c = await company();
  await plantRule(pool, c, 'owner', { documentType: `${type}_credit_note`, name: 'Owner signs' });
  await enforceType(pool, c, type, u.b);
  return c;
}

async function raiseAndApprove(c: string, docType: string, noteId: string, approver = u.b): Promise<string> {
  const raised = await r.raise(u.a, c, docType, noteId);
  expect(raised.state.statusCode, JSON.stringify(raised.state.body)).toBe(200);
  const requestId = dataOf<{ id: string }>(raised).id;
  const decided = await r.decide(pool, approver, c, requestId);
  expect(decided.state.statusCode, JSON.stringify(decided.state.body)).toBe(200);
  return requestId;
}

describe('supplier-credit-notes', () => {
  it('create-and-post under enforcement answers 409 naming the note, and the draft is kept', async () => {
    const c = await gatedCompany('supplier');
    const supplier = crypto.randomUUID();
    await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'R035 create-and-post')", [supplier, c]);
    const res = await r.createSupplier(u.a, c, supplier, 'post');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(messageOf(res)).toMatch(/Supplier credit note \S+ needs owner approval/);
    const details = (res.state.body as { error: { details: { creditNoteId: string; requiredRole: string } } }).error.details;
    expect(details.requiredRole).toBe('owner');
    const { rows } = await pool.query('SELECT id, status, gl_journal_entry_id FROM credit_notes WHERE company_id = $1', [c]);
    expect(rows).toEqual([{ id: details.creditNoteId, status: 'draft', gl_journal_entry_id: null }]);
  });

  it('create-and-post with enforcement off still creates and posts in one call', async () => {
    const c = await company();
    const supplier = crypto.randomUUID();
    await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'R035 ungated')", [supplier, c]);
    const res = await r.createSupplier(u.a, c, supplier, 'post');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    expect((await noteState(pool, dataOf<{ id: string }>(res).id)).journals).toBe(1);
  });

  it('PATCH post answers 409; after approval it posts', async () => {
    const c = await gatedCompany('supplier');
    const note = await plantNote(pool, c, u.a, 'supplier');
    const refused = await r.postSupplier(u.a, c, note.id);
    expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(409);
    expect(reasonOf(refused)).toBe('APPROVAL_REQUIRED');
    await raiseAndApprove(c, 'supplier_credit_note', note.id);
    expect((await r.postSupplier(u.a, c, note.id)).state.statusCode).toBe(200);
    expect((await noteState(pool, note.id)).journals).toBe(1);
  });
});

interface Approval { state: string; enforced: boolean; requiredRole: string | null; ruleName: string | null; requestId: string | null }

describe.each([
  ['customer', 'getNote'], ['supplier', 'getNote'], ['supplier', 'getSupplierNote'],
] as const)('the %s note detail GET (%s)', (type, getter) => {
  const approvalOf = async (c: string, id: string) => {
    const res = await r[getter](u.a, c, id);
    expect(res.state.statusCode).toBe(200);
    return dataOf<{ approval: Approval | null }>(res).approval;
  };

  it('not_required while enforcement is off', async () => {
    const c = await company();
    await plantRule(pool, c, 'owner', { documentType: `${type}_credit_note` });
    const note = await plantNote(pool, c, u.a, type);
    expect(await approvalOf(c, note.id)).toMatchObject({ state: 'not_required', enforced: false });
  });

  it('required → pending → approved, then null once posted', async () => {
    const c = await gatedCompany(type);
    const note = await plantNote(pool, c, u.a, type);
    expect(await approvalOf(c, note.id)).toEqual({
      state: 'required', enforced: true, requiredRole: 'owner', ruleName: 'Owner signs', requestId: null,
    });
    const requestId = dataOf<{ id: string }>(await r.raise(u.a, c, `${type}_credit_note`, note.id)).id;
    expect(await approvalOf(c, note.id)).toMatchObject({ state: 'pending', requestId });
    expect((await r.decide(pool, u.b, c, requestId)).state.statusCode).toBe(200);
    expect(await approvalOf(c, note.id)).toMatchObject({ state: 'approved', requestId });
    expect((await r.approve(u.a, c, note.id)).state.statusCode).toBe(200);
    expect(await approvalOf(c, note.id)).toBeNull();
  });
});

describe('the customer merge (Q9, Q10)', () => {
  const merge = (user: string, c: string, source: string, target: string) => callRoute(
    customerMerge, tokens[user]!, c, 'POST', { source_id: source, target_id: target }, '/api/accounting/customer-merge');

  it('makes an approved note stale and its merging user an author; restoring the content clears it', async () => {
    const c = await gatedCompany('customer');
    const note = await plantNote(pool, c, u.a, 'customer');
    await raiseAndApprove(c, 'customer_credit_note', note.id);
    const target = crypto.randomUUID();
    await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'R035 merge target')", [target, c]);

    expect((await merge(u.c, c, note.entityId, target)).state.statusCode).toBe(200);
    const { rows: [moved] } = await pool.query('SELECT client_id, content_authors::TEXT[] AS authors FROM credit_notes WHERE id = $1', [note.id]);
    expect(moved).toEqual({ client_id: target, authors: [u.c] });
    const stale = await r.approve(u.a, c, note.id);
    expect(stale.state.statusCode).toBe(409);
    expect(reasonOf(stale)).toBe('APPROVAL_STALE');

    // The merging owner authored the new content: another owner must approve it.
    const raised = await r.raise(u.a, c, 'customer_credit_note', note.id);
    const refused = await r.decide(pool, u.c, c, dataOf<{ id: string }>(raised).id);
    expect(refused.state.statusCode).toBe(403);
    expect(messageOf(refused)).toMatch(/you authored the content/);

    // Q9: the same content as was approved clears again (raw, as no route moves a note back).
    await pool.query('UPDATE credit_notes SET client_id = $2 WHERE id = $1', [note.id, note.entityId]);
    expect((await r.approve(u.a, c, note.id)).state.statusCode).toBe(200);
  });
});

describe('the enforcement switch', () => {
  const call = (user: string, c: string, documentType: string, enabled: boolean) => callRoute(
    approvalEnforcement, tokens[user]!, c, 'POST', { documentType, enabled }, '/api/accounting/approval-enforcement');

  it('still refuses an R-035 type no PR has wired (supplier_payment)', async () => {
    const c = await company();
    const res = await call(u.b, c, 'supplier_payment', true);
    expect(res.state.statusCode).toBe(400);
    expect((await pool.query('SELECT 1 FROM approval_enforcement WHERE company_id = $1', [c])).rows).toEqual([]);
  });

  it.each(['customer_credit_note', 'supplier_credit_note'])(
    'switching %s off needs the rank to weaken its strictest rule (403), and an owner may (audited)', async (documentType) => {
      const c = await company();
      await plantRule(pool, c, 'owner', { documentType });
      expect((await call(u.b, c, documentType, true)).state.statusCode).toBe(200);
      const refused = await call(u.m, c, documentType, false);
      expect(refused.state.statusCode).toBe(403);
      expect(reasonOf(refused)).toBe('RULE_AUTHORITY_REQUIRED');
      expect((await call(u.b, c, documentType, false)).state.statusCode).toBe(200);
      const { rows } = await pool.query(
        "SELECT action, entity_ref FROM audit_log WHERE company_id = $1 AND entity_type = 'approval_enforcement' ORDER BY created_at",
        [c]);
      expect(rows).toEqual([{ action: 'create', entity_ref: documentType }, { action: 'delete', entity_ref: documentType }]);
    });
});

describe('the enforcement GET previews what switching on would hold', () => {
  it('counts, per credit-note type, the drafts a rule of that type matches and nothing posted, cancelled, cleared or below it', async () => {
    const c = await company();
    for (const type of ['customer', 'supplier'] as const) {
      await plantRule(pool, c, 'owner', { documentType: `${type}_credit_note`, operator: 'greater_than', value: 1000 });
    }
    await plantNote(pool, c, u.a, 'customer');
    await plantNote(pool, c, u.a, 'customer', { subtotal: 1000, tax: 150, total: 900 }); // the larger leg matches
    await plantNote(pool, c, u.a, 'customer', { subtotal: 800, tax: 120, total: 920 }); // below the threshold
    const posted = await plantNote(pool, c, u.a, 'customer');
    await pool.query("UPDATE credit_notes SET status = 'approved' WHERE id = $1", [posted.id]);
    const cancelled = await plantNote(pool, c, u.a, 'customer');
    await pool.query("UPDATE credit_notes SET status = 'cancelled' WHERE id = $1", [cancelled.id]);
    await plantNote(pool, c, u.a, 'supplier');
    const cleared = await plantNote(pool, c, u.a, 'supplier');
    await enforceType(pool, c, 'supplier', u.b);
    await raiseAndApprove(c, 'supplier_credit_note', cleared.id);

    const res = await callRoute(approvalEnforcement, tokens[u.b]!, c, 'GET', undefined, '/api/accounting/approval-enforcement', { preview: '1' });
    expect(res.state.statusCode).toBe(200);
    expect(dataOf<{ preview: Record<string, number> }>(res).preview).toEqual({
      supplier_invoice: 0, customer_credit_note: 2, supplier_credit_note: 1, customer_invoice: 0,
    });
  });
});
