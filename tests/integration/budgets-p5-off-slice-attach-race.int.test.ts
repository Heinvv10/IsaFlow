/**
 * Budgets P5-2b review round 5 / breaker round 4: the manual attach's inheritance (`inheritOnAttach`) beside other
 * work on the same draft bill, on real concurrent request transactions (app_user):
 *   - R4-2: a requestApproval raised while the attach is in flight waits for it (the raise takes the bill FOR SHARE,
 *     `approvalDocuments.raiseOnce`) and binds the digest of the INHERITED lines, never a digest the attach then moves;
 *   - LOW 2: a bill row another transaction holds (a long bulk approve) is skipped, not waited on: the attach succeeds
 *     and says 'the bill is being processed, retry';
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
import { dropBillFixture, makeBill, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
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
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

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

describe('LOW 2: the bill row held by another transaction', () => {
  it('the attach succeeds at once and skips that bill: "the bill is being processed, retry"', async () => {
    const je = await seedUnevidencedProvisional(pool, f, '2026-07-10', [{ amount: 800, cc1: f.cc.FT }], S0);
    const { bill, doc } = await slipDraft('2026-07-12');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [bill]);
      const t0 = Date.now();
      const r = await openRequest(pool, f, f.owner);
      let out: unknown;
      try { out = await r.run(() => attachDocumentToProvisional(f.co, je, doc)); await r.commit(); } finally { await r.rollback(); }
      expect(Date.now() - t0).toBeLessThan(4000); // never the 5 s row-lock budget
      expect(out).toMatchObject({ kind: 'attached', slipInheritance: [{ invoiceId: bill, skipped: 'the bill is being processed, retry' }] });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await pool.query('SELECT needs_evidence FROM gl_journal_entries WHERE id = $1', [je])).rows[0].needs_evidence).toBe(false);
    expect(await billLineCc1(pool, bill)).toEqual([null]);
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
