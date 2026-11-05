/**
 * Budgets P5-2b review round 5 / breaker round 4: the manual attach's inheritance (`inheritOnAttach`) beside other
 * work on the same draft bill, on real concurrent request transactions (app_user):
 *   - R4-2: a requestApproval raised while the attach is in flight waits for it (the raise takes the bill FOR SHARE,
 *     `approvalDocuments.raiseOnce`) and binds the digest of the INHERITED lines, never a digest the attach then moves;
 *   - R5-3: a bill row another transaction holds (a long bulk approve) fails the WHOLE manual attach at once (the slip's
 *     bills are locked SKIP LOCKED in id order before any write: 503 + Retry-After through the real withAuth route,
 *     nothing written), so the retry attaches and inherits;
 *   - LOW 4: the attaching user becomes a content author of the bill whose lines it changed, so segregation of duties
 *     refuses them as its approver.
 * Fixture: opex BB-6100 at CC1 FT 1 000 / HT 0 a month (FY2027). Fixture route: isaflow_schema_fixture. Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { attachDocumentToProvisional } from '@/modules/accounting/services/capture/provisionalEvidenceAttach';
import { requestApproval } from '@/modules/accounting/services/gl/approvalDocuments';
import { decideRequest } from '@/modules/accounting/services/gl/approvalService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { SignJWT } from 'jose';
import attachRouteHandler from '../../pages/api/accounting/provisional/[jeId]/attach';
import actionRoute from '../../pages/api/accounting/supplier-invoices-action';
import { request, response } from './mfa-impersonation-postgres.helpers';
import {
  billState, callRoute, dropBillFixture, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';
import { billLineCc1, seedUnevidencedProvisional } from './helpers/budgetSlipFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let f: BillFixture;
const S0 = crypto.randomUUID();

beforeAll(async () => {
  f = await seedBillFixture(pool, 'off-slice-attach-race');
  await pool.query("INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, 'S0 no default', true)", [S0, f.co]);
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM approval_requests WHERE company_id = $1', [f.co]);
    await pool.query('DELETE FROM approval_rules WHERE company_id = $1', [f.co]);
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::TEXT[])', [[f.owner, f.manager].map((u) => `supplier-invoice-action:${u}`)]);
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

/** POST /api/accounting/provisional/[jeId]/attach through the real withAuth, as the owner. */
async function attachRoute(jeId: string, capturedDocumentId: string) {
  const token = await new SignJWT({ sub: f.owner, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const req = request({ 'sb-access-token': token, active_company_id: f.co }, 'POST');
  (req as unknown as { query: Record<string, string> }).query = { jeId };
  req.url = `/api/accounting/provisional/${jeId}/attach`;
  req.body = { capturedDocumentId };
  const out = response();
  await attachRouteHandler(req as never, out.res as never);
  return out;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const digest = async (bill: string) => String((await pool.query("SELECT approval_document_digest($1, 'supplier_invoice', $2) AS d", [f.co, bill])).rows[0].d);
async function slipDraft(date: string): Promise<{ bill: string; doc: string }> {
  const doc = crypto.randomUUID();
  await pool.query(`INSERT INTO captured_documents (id, company_id, file_name, file_type) VALUES ($1, $2, 'slip.pdf', 'application/pdf')`, [doc, f.co]);
  const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 800 }], { date });
  await pool.query('UPDATE supplier_invoices SET supplier_id = $2, source_document_id = $3 WHERE id = $1', [bill, S0, doc]);
  return { bill, doc };
}

describe('R4-2: a requestApproval raised while the manual attach is in flight', () => {
  it('waits for the attach and binds the digest of the inherited lines', async () => {
    await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
                      VALUES (gen_random_uuid(),$1,'r4 any','supplier_invoice','amount','any',0,'owner',true)`, [f.co]);
    const je = await seedUnevidencedProvisional(pool, f, '2026-06-10', [{ amount: 800, cc1: f.cc.FT }], S0);
    const { bill, doc } = await slipDraft('2026-06-12');
    const tAttach = await openRequest(pool, f, f.owner);
    const tReq = await openRequest(pool, f, f.manager);
    try {
      const out = await tAttach.run(() => attachDocumentToProvisional(f.co, je, doc)); // no request yet: wrote FT
      let reqDone = false;
      const requesting = tReq.run(() => requestApproval(f.co, { documentType: 'supplier_invoice', documentId: bill, requestedBy: f.manager }))
        .then((r) => { reqDone = true; return r; });
      await sleep(400);
      const finishedWhileAttachOpen = reqDone;
      await tAttach.commit();
      await requesting;
      await tReq.commit();
      const reqs = (await pool.query('SELECT status, document_digest FROM approval_requests WHERE company_id = $1 AND document_id = $2', [f.co, bill])).rows;
      const now = await digest(bill);
      expect(out).toMatchObject({ slipInheritance: [{ inheritedLines: 1 }] });
      expect({ finishedWhileAttachOpen, bound: reqs.map((r) => ({ status: r.status, current: r.document_digest === now })) })
        .toEqual({ finishedWhileAttachOpen: false, bound: [{ status: 'pending', current: true }] });
    } finally {
      await tAttach.rollback(); await tReq.rollback();
      await pool.query('DELETE FROM approval_requests WHERE company_id = $1', [f.co]);
      await pool.query('DELETE FROM approval_rules WHERE company_id = $1', [f.co]);
    }
  });
});

describe('R5-3: a held bill fails the WHOLE attach at once, nothing written, so a retry works', () => {
  it('503 + Retry-After without waiting, the bank line, journal and slip unchanged; released, the retried attach inherits', async () => {
    await setPolicy(pool, f, 'block');
    const je = await seedUnevidencedProvisional(pool, f, '2026-07-10', [{ amount: 800, cc1: f.cc.FT }], S0);
    const { bill, doc } = await slipDraft('2026-07-12');
    const holder = await pool.connect();
    let first: Awaited<ReturnType<typeof attachRoute>>;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [bill]); // a long bulk approve
      const t0 = Date.now();
      first = await attachRoute(je, doc);
      expect(Date.now() - t0).toBeLessThan(4000); // never the 5 s row-lock budget
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect({ code: first.state.statusCode, retryAfter: first.headers.get('retry-after') !== undefined }).toEqual({ code: 503, retryAfter: true });
    expect((await pool.query('SELECT needs_evidence FROM gl_journal_entries WHERE id = $1', [je])).rows[0].needs_evidence).toBe(true);
    expect((await pool.query('SELECT status FROM bank_transactions WHERE provisional_je_id = $1', [je])).rows[0].status).toBe('provisional');
    expect((await pool.query('SELECT posted_at FROM captured_documents WHERE id = $1', [doc])).rows[0].posted_at).toBeNull();
    expect(await billLineCc1(pool, bill)).toEqual([null]);
    // The retry (breaker R5-3): nothing was committed, so it attaches and inherits; block then approves the bill.
    const retry = await attachRoute(je, doc);
    expect(retry.state.statusCode, JSON.stringify(retry.state.body)).toBe(200);
    expect((retry.state.body as { data: { slipInheritance: unknown[] } }).data.slipInheritance).toEqual([{ invoiceId: bill, inheritedLines: 1 }]);
    expect(await billLineCc1(pool, bill)).toEqual([f.cc.FT]);
    const appr = await callRoute(actionRoute as never, f, f.manager, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId: bill });
    expect({ code: appr.statusCode, status: (await billState(pool, bill)).status }).toEqual({ code: 200, status: 'paid' });
  }, 30_000);
});

describe('review round 7: only DRAFT slip bills are locked by the attach', () => {
  it('a paid bill held by another transaction (a payment) does not 503 the attach', async () => {
    const je = await seedUnevidencedProvisional(pool, f, '2026-09-10', [{ amount: 800, cc1: f.cc.FT }], S0);
    const { bill, doc } = await slipDraft('2026-09-12');
    await pool.query("UPDATE supplier_invoices SET status = 'paid' WHERE id = $1", [bill]);
    const holder = await pool.connect();
    let r: Awaited<ReturnType<typeof attachRoute>>;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [bill]);
      r = await attachRoute(je, doc);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(200);
    expect((r.state.body as { data: { slipInheritance: unknown[] } }).data.slipInheritance).toEqual([]);
    expect((await pool.query('SELECT needs_evidence FROM gl_journal_entries WHERE id = $1', [je])).rows[0].needs_evidence).toBe(false);
  });
});

describe('review round 7: an attach refused anyway answers 400, not 503, even with a slip bill held', () => {
  it('the slip already backs a posted journal: 400 (document already posted), never the bill lock\'s 503', async () => {
    const je = await seedUnevidencedProvisional(pool, f, '2026-10-10', [{ amount: 800, cc1: f.cc.FT }], S0);
    const { bill, doc } = await slipDraft('2026-10-12');
    const other = crypto.randomUUID();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, status, created_by, description, source, source_document_id)
                     VALUES ($1, $2, $3, '2026-10-12', 'posted', $4, 'already posted', 'manual', $5)`, [other, f.co, `R7-${other.slice(0, 6)}`, f.owner, doc]);
      await c.query('COMMIT');
    } finally { c.release(); }
    const holder = await pool.connect();
    let r: Awaited<ReturnType<typeof attachRoute>>;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [bill]);
      r = await attachRoute(je, doc);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(400);
  });
});

describe('LOW 4: the attaching user becomes a content author of the bill it changed', () => {
  it('content_authors carries the attacher after inheritance, and SoD refuses them as the approver', async () => {
    const je = await seedUnevidencedProvisional(pool, f, '2026-08-10', [{ amount: 800, cc1: f.cc.FT }], S0);
    const { bill, doc } = await slipDraft('2026-08-12');
    const r = await openRequest(pool, f, f.manager);
    try { await r.run(() => attachDocumentToProvisional(f.co, je, doc)); await r.commit(); } finally { await r.rollback(); }
    const authors = (await pool.query('SELECT content_authors FROM supplier_invoices WHERE id = $1', [bill])).rows[0].content_authors as string[] | null;
    expect((authors ?? []).map((a) => a.toLowerCase())).toContain(f.manager.toLowerCase());
    // Segregation of duties: a request the owner raises cannot be approved by the attacher.
    await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
                      VALUES (gen_random_uuid(),$1,'low4 any','supplier_invoice','amount','any',0,'manager',true)`, [f.co]);
    try {
      const tReq = await openRequest(pool, f, f.owner);
      let requestId = '';
      try {
        requestId = (await tReq.run(() => requestApproval(f.co, { documentType: 'supplier_invoice', documentId: bill, requestedBy: f.owner }))).id;
        await tReq.commit();
      } finally { await tReq.rollback(); }
      const d = await digest(bill);
      const tDec = await openRequest(pool, f, f.manager);
      try {
        // A session that is provably not an impersonation (a session_id with no impersonation row).
        await tDec.client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: f.manager, session_id: crypto.randomUUID() })]);
        await expect(tDec.run(() => decideRequest(f.co, requestId, 'approved', f.manager, undefined, d))).rejects.toThrow(/authored the content/);
      } finally { await tDec.rollback(); }
    } finally {
      await pool.query('DELETE FROM approval_requests WHERE company_id = $1', [f.co]);
      await pool.query('DELETE FROM approval_rules WHERE company_id = $1', [f.co]);
    }
  });
});
