// GET /api/accounting/document-capture?attachable=1 through the real withAuth
// chain on the disposable fixture DB: the documents the provisional page may
// offer as evidence. That page asked for `?status=extracted`, a status captured
// documents never have, so its picker was always empty. "Attachable" is what
// the attach itself accepts (claimCapturedDocumentForPosting): not posted, not
// rejected, read finished — and the caller's company only. It also leaves out what is
// not supplier evidence: our own sent invoices, sent emails and dunning letters, and
// bank or supplier STATEMENTS (a supplier statement carries no document_type; it is
// known by the reconciliation that points at it).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import route from '../../pages/api/accounting/document-capture';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
const ids = {
  pending: crypto.randomUUID(),
  reviewed: crypto.randomUUID(),
  matchedUnposted: crypto.randomUUID(),
  posted: crypto.randomUUID(),
  rejected: crypto.randomUUID(),
  reading: crypto.randomUUID(),
  failed: crypto.randomUUID(),
  otherCompany: crypto.randomUUID(),
  sentInvoice: crypto.randomUUID(),
  outboundEmail: crypto.randomUUID(),
  dunning: crypto.randomUUID(),
  bankStatement: crypto.randomUUID(),
  supplierStatement: crypto.randomUUID(),
};
const supplier = crypto.randomUUID();
let token = '';

async function list(query: Record<string, string>) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'GET');
  req.url = `/api/accounting/document-capture?${new URLSearchParams(query)}`;
  req.query = query;
  const result = response();
  await route(req, result.res);
  return result.state;
}

async function purge(): Promise<void> {
  await pool.query('DELETE FROM supplier_statement_reconciliations WHERE source_document_id = $1', [ids.supplierStatement]);
  await pool.query('DELETE FROM captured_documents WHERE id = ANY($1::uuid[])', [Object.values(ids)]);
  await pool.query('DELETE FROM suppliers WHERE id = $1', [supplier]);
  await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [[company, other]]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, other]]);
  await pool.query('DELETE FROM users WHERE id = $1', [user]);
}

beforeAll(async () => {
  await purge();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$3),($2,$4)', [company, other, 'Attachable A', 'Attachable B']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin'),($3,$2,'admin')", [company, user, other]);
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const rows: Array<[string, string, string, string, boolean, string | null]> = [
    // id, company, status, read_state, posted, document_type
    [ids.pending, company, 'pending', 'done', false, null],
    [ids.reviewed, company, 'reviewed', 'done', false, 'receipt'],
    [ids.matchedUnposted, company, 'matched', 'done', false, 'invoice'],
    [ids.posted, company, 'matched', 'done', true, 'receipt'],
    [ids.rejected, company, 'rejected', 'done', false, 'receipt'],
    [ids.reading, company, 'pending', 'reading', false, null],
    [ids.failed, company, 'pending', 'failed', false, null],
    [ids.otherCompany, other, 'pending', 'done', false, 'receipt'],
    [ids.sentInvoice, company, 'matched', 'done', false, 'sent_invoice'],
    [ids.outboundEmail, company, 'matched', 'done', false, 'outbound_email'],
    [ids.dunning, company, 'matched', 'done', false, 'dunning'],
    [ids.bankStatement, company, 'pending', 'done', false, 'statement'],
    [ids.supplierStatement, company, 'pending', 'done', false, null],
  ];
  for (const [id, co, status, readState, posted, type] of rows) {
    await pool.query(
      `INSERT INTO captured_documents(id, company_id, file_name, file_type, status, read_state, posted_at, document_type)
       VALUES($1, $2, $3, 'pdf', $4, $5, CASE WHEN $6 THEN NOW() END, $7)`,
      [id, co, `${id}.pdf`, status, readState, posted, type],
    );
  }
  await pool.query('INSERT INTO suppliers(id, company_id, name) VALUES($1, $2, $3)', [supplier, company, 'Attachable Supplier']);
  await pool.query(
    `INSERT INTO supplier_statement_reconciliations
       (company_id, supplier_id, source_document_id, statement_date, supplier_balance, isaflow_balance, variance)
     VALUES($1, $2, $3, '2026-10-01', 100, 100, 0)`,
    [company, supplier, ids.supplierStatement],
  );
});

afterAll(async () => {
  try { await purge(); } finally { await pool.end(); }
}, 60_000);

describe('document-capture ?attachable=1', () => {
  it('lists exactly the documents the attach accepts, for the active company only', async () => {
    const r = await list({ attachable: '1', pageSize: '50' });
    expect(r.statusCode).toBe(200);
    const body = r.body as { data: Array<{ id: string }>; pagination: { total: number } };
    expect(body.data.map((d) => d.id).sort()).toEqual([ids.pending, ids.reviewed, ids.matchedUnposted].sort());
    expect(body.pagination.total).toBe(3);
  });

  it('leaves the unfiltered list alone', async () => {
    const r = await list({ pageSize: '50' });
    const body = r.body as { data: Array<{ id: string }> };
    expect(body.data.map((d) => d.id)).toEqual(expect.arrayContaining([ids.posted, ids.rejected, ids.reading, ids.failed]));
    expect(body.data.map((d) => d.id)).not.toContain(ids.otherCompany);
  });
});
