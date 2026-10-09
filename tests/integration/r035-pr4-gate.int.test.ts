/**
 * R-035 PR4: approval enforcement on CUSTOMER INVOICES through the real approve
 * route (customer-invoices-detail POST { action: 'approve' }).
 *
 * With enforcement on and an active customer_invoice rule matching the
 * invoice, approving it (which posts DR receivable / CR revenue / CR VAT and
 * puts it in AR) is refused 409 until an APPROVED request exists for its
 * CURRENT content, at a rank the strictest rule today demands, decided at or
 * after enforcement was (last) switched on. The refusal precedes every write:
 * withAuth COMMITs a 4xx, so the invoice must still be the untouched draft.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, enableFxDocuments, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import {
  cleanupPr4, enforceInvoices, invoiceCompany, invoiceRoutes, invoiceState, plantInvoice,
} from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', m: '' };
const r = invoiceRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr4(pool, companies, Object.values(u)));

/** A (admin) books and requests; B (owner) approves; M is a manager. */
const company = () => invoiceCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.m, 'manager']], companies);

async function gated(opts: { rule?: string; enforced?: boolean } = {}) {
  const c = await company();
  await plantRule(pool, c, opts.rule ?? 'owner', { documentType: 'customer_invoice', name: 'Owner signs' });
  if (opts.enforced !== false) await enforceInvoices(pool, c, u.b);
  return { c, inv: await plantInvoice(pool, c, u.a) };
}

/** Everything the approve could have written: the row as it stood, and what it hangs off. */
async function footprint(c: string, id: string) {
  const { rows: [row] } = await pool.query(
    'SELECT status, updated_at, gl_journal_entry_id, rendered_pdf_storage_path FROM customer_invoices WHERE id = $1', [id]);
  const counts = (await pool.query(
    `SELECT (SELECT count(*)::INT FROM gl_journal_entries WHERE company_id = $1) AS journals,
            (SELECT count(*)::INT FROM captured_documents WHERE company_id = $1) AS documents`, [c])).rows[0];
  return { ...row, ...counts };
}

describe('the approve route', () => {
  it('the enforcement API switches customer_invoice on (200) and records it', async () => {
    const c = await company();
    const res = await callRoute(approvalEnforcement, tokens[u.b]!, c, 'POST',
      { documentType: 'customer_invoice', enabled: true }, '/api/accounting/approval-enforcement');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const { rows } = await pool.query('SELECT document_type FROM approval_enforcement WHERE company_id = $1', [c]);
    expect(rows.map((x) => x.document_type)).toEqual(['customer_invoice']);
  });

  it('refuses 409 APPROVAL_REQUIRED before any write: the draft untouched, no journal, no PDF seal', async () => {
    const { c, inv } = await gated();
    const before = await footprint(c, inv.id);
    const res = await r.approve(u.a, c, inv.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(messageOf(res)).toMatch(/^Customer invoice CI-\S+ needs owner approval before it can be posted \(rule: Owner signs\)\.$/);
    // updated_at unchanged proves the guarded status UPDATE never ran (it stamps NOW()).
    expect(await footprint(c, inv.id)).toEqual(before);
    expect(before).toMatchObject({ status: 'draft', gl_journal_entry_id: null, journals: 0 });
  });

  it('refuses 409 APPROVAL_PENDING while the request awaits a decision', async () => {
    const { c, inv } = await gated();
    expect((await r.raise(u.a, c, inv.id)).state.statusCode).toBe(200);
    const res = await r.approve(u.a, c, inv.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_PENDING');
    expect((await invoiceState(pool, inv.id)).journals).toBe(0);
  });

  it('A requests, B approves the request, A posts: 200 with the journal', async () => {
    const { c, inv } = await gated();
    await r.approvedBy(pool, u.a, u.b, c, inv.id);
    const res = await r.approve(u.a, c, inv.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const state = await invoiceState(pool, inv.id);
    expect(state.status).toBe('approved');
    expect(state.gl_journal_entry_id).not.toBeNull();
    expect(state.journals).toBe(1);
  });

  it('pending_approval is gated like a draft', async () => {
    const { c, inv } = await gated();
    await pool.query("UPDATE customer_invoices SET status = 'pending_approval' WHERE id = $1", [inv.id]);
    expect((await r.approve(u.a, c, inv.id)).state.statusCode).toBe(409);
    await r.approvedBy(pool, u.a, u.b, c, inv.id);
    expect((await r.approve(u.a, c, inv.id)).state.statusCode).toBe(200);
  });

  it('a manager-level approval does not clear once an owner rule governs (the ratchet)', async () => {
    const { c, inv } = await gated({ rule: 'manager' });
    await r.approvedBy(pool, u.a, u.b, c, inv.id);
    await plantRule(pool, c, 'owner', { documentType: 'customer_invoice', name: 'late owner rule' });
    const res = await r.approve(u.a, c, inv.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect((await invoiceState(pool, inv.id)).journals).toBe(0);
  });

  it('enforcement off: posts as it always did, rule or no rule', async () => {
    const { c, inv } = await gated({ enforced: false });
    expect((await r.approve(u.a, c, inv.id)).state.statusCode).toBe(200);
    expect((await invoiceState(pool, inv.id)).journals).toBe(1);
  });

  it('enforcement on with no rule matching: posts', async () => {
    const c = await company();
    await plantRule(pool, c, 'owner', { documentType: 'customer_invoice', operator: 'greater_than', value: 50000 });
    await enforceInvoices(pool, c, u.b);
    const inv = await plantInvoice(pool, c, u.a);
    expect((await r.approve(u.a, c, inv.id)).state.statusCode).toBe(200);
  });

  it('an approved row with a NULL digest never clears', async () => {
    const { c, inv } = await gated();
    await pool.query(
      `INSERT INTO approval_requests(company_id, document_type, document_id, status, requested_by, required_role, decided_by, decided_at)
       VALUES($1,'customer_invoice',$2,'approved',$3,'owner',$4,now())`, [c, inv.id, u.a, u.b]);
    expect((await r.approve(u.a, c, inv.id)).state.statusCode).toBe(409);
  });

  it('an approval decided BEFORE enforcement was (re-)enabled does not clear', async () => {
    const { c, inv } = await gated({ enforced: false });
    await r.approvedBy(pool, u.a, u.b, c, inv.id);
    await enforceInvoices(pool, c, u.b, new Date(Date.now() + 1000).toISOString());
    const res = await r.approve(u.a, c, inv.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
  });

  it('a USD invoice is matched on its rand value, a tiny rate on its total (both directions)', async () => {
    const c = await company();
    await enableFxDocuments(pool, c); // FX PR0
    await plantRule(pool, c, 'owner', { documentType: 'customer_invoice', operator: 'greater_than', value: 50000 });
    await enforceInvoices(pool, c, u.b);
    const usd = await plantInvoice(pool, c, u.a, {
      subtotal: 4347.83, tax: 652.17, total: 5000, functionalTotal: 92500, currencyCode: 'USD', exchangeRate: 18.5 });
    expect(reasonOf(await r.approve(u.a, c, usd.id))).toBe('APPROVAL_REQUIRED');
    const shrunk = await plantInvoice(pool, c, u.a, {
      subtotal: 434782.61, tax: 65217.39, total: 500000, functionalTotal: 50, exchangeRate: 0.0001 });
    expect(reasonOf(await r.approve(u.a, c, shrunk.id))).toBe('APPROVAL_REQUIRED');
  });

  it('a sole owner may approve their own request (Q2), audited with the marker, then post', async () => {
    const c = await invoiceCompany(pool, [[u.b, 'owner'], [u.m, 'manager']], companies);
    await plantRule(pool, c, 'owner', { documentType: 'customer_invoice' });
    await enforceInvoices(pool, c, u.b);
    const inv = await plantInvoice(pool, c, u.b);
    const raised = await r.raise(u.b, c, inv.id);
    const requestId = dataOf<{ id: string }>(raised).id;
    const decided = await r.decide(pool, u.b, c, requestId);
    expect(decided.state.statusCode, JSON.stringify(decided.state.body)).toBe(200);
    const { rows } = await pool.query(
      "SELECT changes FROM audit_log WHERE company_id = $1 AND entity_type = 'approval_request' AND entity_id = $2", [c, requestId]);
    expect(rows[0].changes.metadata).toMatchObject({ selfApproval: 'sole_approver', requiredRole: 'owner', documentType: 'customer_invoice' });
    expect((await r.approve(u.b, c, inv.id)).state.statusCode).toBe(200);
  });

  it('the creator may not approve the request for their own invoice while another approver exists', async () => {
    const c = await invoiceCompany(pool, [[u.a, 'owner'], [u.b, 'owner']], companies);
    await plantRule(pool, c, 'owner', { documentType: 'customer_invoice' });
    await enforceInvoices(pool, c, u.b);
    const inv = await plantInvoice(pool, c, u.a);
    const raised = await r.raise(u.b, c, inv.id);
    const decided = await r.decide(pool, u.a, c, dataOf<{ id: string }>(raised).id);
    expect(decided.state.statusCode).toBe(403);
    expect(messageOf(decided)).toMatch(/you authored the content/);
  });
});

describe('tenant isolation', () => {
  it("a forged approved row in company B carrying A's invoice id does not clear it", async () => {
    const { c, inv } = await gated();
    const b = await company();
    await enforceInvoices(pool, b, u.b); // B enforces too: only company_id keeps its row off A's invoice
    const digest = (await pool.query("SELECT approval_document_digest($1,'customer_invoice',$2) AS d", [c, inv.id])).rows[0].d;
    await pool.query(
      `INSERT INTO approval_requests(company_id, document_type, document_id, status, requested_by, required_role,
         decided_by, decided_at, document_digest)
       VALUES($1,'customer_invoice',$2,'approved',$3,'owner',$4,now(),$5)`, [b, inv.id, u.a, u.b, digest]);
    const res = await r.approve(u.a, c, inv.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
  });

  it("company B's enforcement does not enforce on company A", async () => {
    const { c, inv } = await gated({ enforced: false });
    const b = await company();
    await plantRule(pool, b, 'owner', { documentType: 'customer_invoice' });
    await enforceInvoices(pool, b, u.b);
    expect((await r.approve(u.a, c, inv.id)).state.statusCode).toBe(200);
  });
});
