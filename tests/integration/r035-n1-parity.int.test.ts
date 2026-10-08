/**
 * R-035 N1 parity: for each refusal class, the TypeScript decide checks
 * (assertDecidingSession, assertMayDecide, assertDocumentUnchanged) and
 * approval_request_decide refuse the SAME inputs, and allow the same ones —
 * each run on its own, as app_user under the same claims, against the same
 * row. A drift between the two copies of an authority rule fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import { assertDecidingSession, assertMayDecide } from '../../src/modules/accounting/services/gl/approvalAuthority';
import { assertDocumentUnchanged } from '../../src/modules/accounting/services/gl/approvalDecideDocument';
import { resolveApprovalDocument } from '../../src/modules/accounting/services/gl/approvalDocuments';
import { assertNotImpersonating } from '../../src/lib/auth/impersonationGuard';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupPr6, journalCompany, plantJournal } from './r035-pr6.helpers';
import { asRole, decideFn, n1Users, outcome, pendingBill, raiseFn, requestRow } from './r035-n1.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let u: Awaited<ReturnType<typeof n1Users>>;

beforeAll(async () => { u = await n1Users(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM impersonation_sessions WHERE actor_user_id = ANY($1)', [Object.values(u)]);
  await cleanupPr6(pool, companies, Object.values(u));
});

/** The TypeScript refusal, in the SQL function's SQLSTATE vocabulary. */
const TS_TO_SQL: Record<string, string> = {
  SELF_APPROVAL_FORBIDDEN: 'RA001', APPROVER_ROLE_REQUIRED: 'RA002', IMPERSONATION_FORBIDDEN: 'RA003',
  DOCUMENT_CHANGED: 'RA004', EXPECTED_DIGEST_REQUIRED: 'RA005', ApprovalDocumentNotFoundError: 'RA006',
};

interface Case { c: string; requestId: string; by: string; decision: 'approved' | 'rejected';
  expected?: string | null; sessionId?: string | null }

async function both(k: Case): Promise<{ ts: string; sql: string }> {
  const expected = k.expected === undefined ? (await requestRow(pool, k.requestId))?.document_digest ?? null : k.expected;
  const claims = { sub: k.by, sessionId: k.sessionId };
  const ts = await outcome(asRole(pool, 'app_user', k.c, claims, (client) =>
    als.run({ client, userId: k.by, companyId: k.c, claims: { sub: k.by } } as never, async () => {
      await assertDecidingSession();
      await assertMayDecide(k.c, k.requestId, k.by, k.decision);
      if (k.decision === 'approved') await assertDocumentUnchanged(k.c, k.requestId, expected);
      // decideRequest's write finds the row only if the caller can see it (RLS).
      const seen = await client.query('SELECT 1 FROM approval_requests WHERE id = $1 AND company_id = $2 AND status = $3',
        [k.requestId, k.c, 'pending']);
      if (seen.rowCount === 0) throw { code: 'none' };
    })).catch((e: { code?: string; name?: string }) => { throw { code: e.code ?? e.name }; }));
  const sql = await outcome(asRole(pool, 'app_user', k.c, claims, async (cl) => {
    if ((await decideFn(cl, k.c, k.requestId, k.decision, k.by, expected)).rowCount === 0) throw { code: 'none' };
  }));
  return { ts: TS_TO_SQL[ts] ?? ts, sql };
}

describe('TypeScript and SQL refuse the same decisions', () => {
  it('rank (RA002): a manager on an owner request — approve and reject', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    for (const decision of ['approved', 'rejected'] as const) {
      expect(await both({ c: f.c, requestId: f.requestId, by: u.m, decision })).toEqual({ ts: 'RA002', sql: 'RA002' });
    }
  });

  it('requester (RA001) while another owner exists; author (RA001)', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await both({ c: f.c, requestId: f.requestId, by: u.b, decision: 'approved' })).toEqual({ ts: 'RA001', sql: 'RA001' });
    expect(await both({ c: f.c, requestId: f.requestId, by: u.a, decision: 'approved' })).toEqual({ ts: 'RA001', sql: 'RA001' });
  });

  it('a non-member finds nothing to decide (RLS); a foreign rule (RA002)', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { members: [[u.a, 'owner'], [u.b, 'owner']], creator: u.a });
    expect(await both({ c: f.c, requestId: f.requestId, by: u.m, decision: 'approved' })).toEqual({ ts: 'none', sql: 'none' });
    const g = await pendingBill(pool, tokens, u, companies, { creator: u.m });
    await pool.query('UPDATE approval_requests SET rule_id = $2 WHERE id = $1', [g.requestId, f.ownerRule]);
    expect(await both({ c: g.c, requestId: g.requestId, by: u.a, decision: 'approved' })).toEqual({ ts: 'RA002', sql: 'RA002' });
  });

  it('digest: wrong (RA004), missing (RA005), content moved (RA004), document gone (RA006)', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.m });
    const k = { c: f.c, requestId: f.requestId, by: u.a, decision: 'approved' as const };
    expect(await both({ ...k, expected: 'nope' })).toEqual({ ts: 'RA004', sql: 'RA004' });
    expect(await both({ ...k, expected: null })).toEqual({ ts: 'RA005', sql: 'RA005' });
    await pool.query("UPDATE supplier_invoices SET invoice_date = DATE '2026-09-09' WHERE id = $1", [f.bill.id]);
    expect(await both(k)).toEqual({ ts: 'RA004', sql: 'RA004' });
    await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [f.bill.id]);
    expect(await both(k)).toEqual({ ts: 'RA006', sql: 'RA006' });
  });

  it('session (RA003): Login-as, and no session id', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.m });
    const sessionId = crypto.randomUUID();
    await pool.query('INSERT INTO impersonation_sessions(session_id, actor_user_id, target_user_id) VALUES($1,$2,$3)',
      [sessionId, u.v, u.a]);
    const k = { c: f.c, requestId: f.requestId, by: u.a, decision: 'approved' as const };
    expect(await both({ ...k, sessionId })).toEqual({ ts: 'RA003', sql: 'RA003' });
    expect(await both({ ...k, sessionId: null })).toEqual({ ts: 'RA003', sql: 'RA003' });
  });

  it('Q2: refused when not enforced or when the roster moved (RA001); allowed for the sole approver', async () => {
    const members: [string, string][] = [[u.a, 'owner'], [u.m, 'manager']];
    const f = await pendingBill(pool, tokens, u, companies, { members, creator: u.a, requester: u.a });
    const k = { c: f.c, requestId: f.requestId, by: u.a, decision: 'approved' as const };
    expect(await both(k)).toEqual({ ts: 'ok', sql: 'ok' });
    await pool.query("UPDATE company_users SET role = 'owner' WHERE company_id = $1 AND user_id = $2", [f.c, u.m]);
    expect(await both(k)).toEqual({ ts: 'RA001', sql: 'RA001' });
    await pool.query("UPDATE company_users SET role = 'manager' WHERE company_id = $1 AND user_id = $2", [f.c, u.m]);
    await pool.query('DELETE FROM approval_enforcement WHERE company_id = $1', [f.c]);
    expect(await both(k)).toEqual({ ts: 'RA001', sql: 'RA001' });
  });

  it('a type with no editor tracking (legacy journal_entry): a past requester is refused (RA001), others not (blind LOW 5)', async () => {
    const f = await journalCompany(pool, [[u.a, 'owner'], [u.b, 'owner'], [u.m, 'owner']], companies);
    const rule = (await pool.query(
      `INSERT INTO approval_rules(company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
       VALUES($1,'legacy journals','journal_entry','amount','any',0,'owner',true) RETURNING id`, [f.c])).rows[0].id as string;
    const je = await plantJournal(pool, f, u.m);
    const { rows: [req] } = await pool.query(
      `INSERT INTO approval_requests(company_id,rule_id,document_type,document_id,requested_by,required_role,past_requesters,document_digest)
       VALUES($1,$2,'journal_entry',$3,$4,'owner',ARRAY[$5]::UUID[],approval_document_digest($1,'journal_entry',$3)) RETURNING id`,
      [f.c, rule, je, u.b, u.a]);
    expect((await pool.query("SELECT approval_document_authors($1,'journal_entry',$2) AS a", [f.c, je])).rows[0].a).toBeNull();
    const k = { c: f.c, requestId: req.id as string, decision: 'approved' as const };
    expect(await both({ ...k, by: u.a })).toEqual({ ts: 'RA001', sql: 'RA001' });
    expect(await both({ ...k, by: u.m })).toEqual({ ts: 'ok', sql: 'ok' });
  });

  it('allowed alike: an eligible approver, and the requester withdrawing', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.m });
    expect(await both({ c: f.c, requestId: f.requestId, by: u.a, decision: 'approved' })).toEqual({ ts: 'ok', sql: 'ok' });
    expect(await both({ c: f.c, requestId: f.requestId, by: u.b, decision: 'rejected' })).toEqual({ ts: 'ok', sql: 'ok' });
  });
});

/** requestApproval's own refusals before its write, and approval_request_raise's, on the same raise. */
async function bothRaise(c: string, documentId: string, ruleId: string, by: string, sessionId?: string) {
  const claims = { sub: by, sessionId };
  const ts = await outcome(asRole(pool, 'app_user', c, claims, (client) =>
    als.run({ client, userId: by, companyId: c, claims: { sub: by } } as never, async () => {
      await assertNotImpersonating();
      await resolveApprovalDocument(c, 'supplier_invoice', documentId);
    })).catch((e: { code?: string; name?: string }) => { throw { code: e.code ?? e.name }; }));
  const sql = await outcome(asRole(pool, 'app_user', c, claims, (cl) => raiseFn(cl, c, 'supplier_invoice', documentId, ruleId, by)));
  return { ts: ({ IMPERSONATION_FORBIDDEN: 'RA003', ApprovalDocumentNotFoundError: 'RA006' } as Record<string, string>)[ts] ?? ts, sql };
}

describe('TypeScript and SQL refuse the same raises', () => {
  it("a non-member, another company's document (RA006); a Login-as session (RA003); allowed alike otherwise", async () => {
    const f = await pendingBill(pool, tokens, u, companies, { members: [[u.a, 'owner'], [u.b, 'owner']] });
    const other = await pendingBill(pool, tokens, u, companies);
    await pool.query('DELETE FROM approval_requests WHERE id = ANY($1)', [[f.requestId, other.requestId]]);
    expect(await bothRaise(f.c, f.bill.id, f.ownerRule, u.m)).toEqual({ ts: 'RA006', sql: 'RA006' });
    expect(await bothRaise(f.c, other.bill.id, f.ownerRule, u.b)).toEqual({ ts: 'RA006', sql: 'RA006' });
    const sessionId = crypto.randomUUID();
    await pool.query('INSERT INTO impersonation_sessions(session_id, actor_user_id, target_user_id) VALUES($1,$2,$3)',
      [sessionId, u.v, u.b]);
    expect(await bothRaise(f.c, f.bill.id, f.ownerRule, u.b, sessionId)).toEqual({ ts: 'RA003', sql: 'RA003' });
    expect(await bothRaise(f.c, f.bill.id, f.ownerRule, u.b)).toEqual({ ts: 'ok', sql: 'ok' });
  });
});
