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
  // The same file as `posted` (sha 'dup'): the attach refuses it as content_posted, so it is not offered.
  sameFileAsPosted: crypto.randomUUID(),
  uniqueHash: crypto.randomUUID(),
  // A posted journal still stands on it / it was reversed / a draft journal only.
  journalStands: crypto.randomUUID(),
  journalReversed: crypto.randomUUID(),
  journalDraft: crypto.randomUUID(),
  linkActive: crypto.randomUUID(),
  linkUnlinked: crypto.randomUUID(),
};
const attachable = (...keys: Array<keyof typeof ids>) => keys.map((k) => ids[k]);
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
  await pool.query('DELETE FROM gl_journal_document_links WHERE captured_document_id = ANY($1::uuid[])', [Object.values(ids)]);
  await pool.query('UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = $1', [company]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [company]);
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
  const rows: Array<[string, string, string, string, boolean, string | null, string?]> = [
    // id, company, status, read_state, posted, document_type
    [ids.pending, company, 'pending', 'done', false, null],
    [ids.reviewed, company, 'reviewed', 'done', false, 'receipt'],
    [ids.matchedUnposted, company, 'matched', 'done', false, 'invoice'],
    [ids.posted, company, 'matched', 'done', true, 'receipt', 'dup'],
    [ids.rejected, company, 'rejected', 'done', false, 'receipt'],
    [ids.reading, company, 'pending', 'reading', false, null],
    [ids.failed, company, 'pending', 'failed', false, null],
    [ids.otherCompany, other, 'pending', 'done', false, 'receipt'],
    [ids.sentInvoice, company, 'matched', 'done', false, 'sent_invoice'],
    [ids.outboundEmail, company, 'matched', 'done', false, 'outbound_email'],
    [ids.dunning, company, 'matched', 'done', false, 'dunning'],
    [ids.bankStatement, company, 'pending', 'done', false, 'statement'],
    [ids.supplierStatement, company, 'pending', 'done', false, null],
    [ids.sameFileAsPosted, company, 'pending', 'done', false, 'receipt', 'dup'],
    [ids.uniqueHash, company, 'pending', 'done', false, 'receipt', 'unique'],
    [ids.journalStands, company, 'pending', 'done', false, 'receipt'],
    [ids.journalReversed, company, 'pending', 'done', false, 'receipt'],
    [ids.journalDraft, company, 'pending', 'done', false, 'receipt'],
    [ids.linkActive, company, 'pending', 'done', false, 'receipt'],
    [ids.linkUnlinked, company, 'pending', 'done', false, 'receipt'],
  ];
  for (const [id, co, status, readState, posted, type, sha] of rows) {
    await pool.query(
      `INSERT INTO captured_documents(id, company_id, file_name, file_type, status, read_state, posted_at, document_type, raw_bytes_sha256)
       VALUES($1, $2, $3, 'pdf', $4, $5, CASE WHEN $6 THEN NOW() END, $7, $8)`,
      [id, co, `${id}.pdf`, status, readState, posted, type, sha ?? null],
    );
  }
  // reverseJournalEntry leaves the original 'posted', stamps reversed_at, and posts a contra pointing back at it.
  const journal = async (n: number, status: string, doc: string | null, reversalOf: string | null = null): Promise<string> => {
    const r = await pool.query(
      `INSERT INTO gl_journal_entries(company_id, entry_number, entry_date, description, status, created_by, source_document_id, reversal_of_id)
       VALUES($1, $2, '2026-10-01', 'attachable fixture', $3, $4, $5, $6) RETURNING id`,
      [company, `ATT-${company.slice(0, 8)}-${n}`, status, user, doc, reversalOf],
    );
    return r.rows[0].id as string;
  };
  await journal(1, 'posted', ids.journalStands);
  await journal(2, 'draft', ids.journalDraft);
  const original = await journal(3, 'posted', ids.journalReversed);
  await journal(4, 'posted', null, original);
  await pool.query('UPDATE gl_journal_entries SET reversed_at = NOW(), reversed_by = $2 WHERE id = $1', [original, user]);
  const linkTarget = await journal(5, 'posted', null);
  await pool.query(
    `INSERT INTO gl_journal_document_links(company_id, journal_entry_id, captured_document_id, linked_by, reason)
     VALUES($1, $2, $3, 'test', 'attachable fixture')`, [company, linkTarget, ids.linkActive]);
  await pool.query(
    `INSERT INTO gl_journal_document_links(company_id, journal_entry_id, captured_document_id, linked_by, reason, unlinked_at, unlinked_by, unlink_reason)
     VALUES($1, $2, $3, 'test', 'attachable fixture', NOW(), 'test', 'moved')`, [company, linkTarget, ids.linkUnlinked]);
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

const EXPECTED = [
  ...attachable('pending', 'reviewed', 'matchedUnposted', 'uniqueHash', 'journalReversed', 'journalDraft', 'linkUnlinked'),
].sort();

async function listIds() {
  const r = await list({ attachable: '1', pageSize: '50' });
  return { ids: (r.body as { data: Array<{ id: string }> }).data.map((d) => d.id) };
}

describe('document-capture ?attachable=1', () => {
  it('lists exactly the documents the attach accepts, for the active company only', async () => {
    const r = await list({ attachable: '1', pageSize: '50' });
    expect(r.statusCode).toBe(200);
    const body = r.body as { data: Array<{ id: string }>; pagination: { total: number } };
    expect(body.data.map((d) => d.id).sort()).toEqual(EXPECTED);
    expect(body.pagination.total).toBe(EXPECTED.length);
  });

  it('leaves out a document whose file is already posted from another document, keeps a unique file', async () => {
    const got = (await listIds()).ids;
    expect(got).not.toContain(ids.sameFileAsPosted);
    expect(got).toContain(ids.uniqueHash);
  });

  it('leaves out a document a standing posted journal rests on; a reversed or draft journal frees it', async () => {
    const got = (await listIds()).ids;
    expect(got).not.toContain(ids.journalStands);
    expect(got).toContain(ids.journalReversed);
    expect(got).toContain(ids.journalDraft);
  });

  it('leaves out a document with an active journal link; an unlinked one is offered again', async () => {
    const got = (await listIds()).ids;
    expect(got).not.toContain(ids.linkActive);
    expect(got).toContain(ids.linkUnlinked);
  });

  it('pages: pageSize 2 gives 2 rows and the full total, and the pages continue without repeats, newest first', async () => {
    const seen: string[] = [];
    for (let page = 1; page <= Math.ceil(EXPECTED.length / 2); page++) {
      const r = await list({ attachable: '1', pageSize: '2', page: String(page) });
      const body = r.body as { data: Array<{ id: string }>; pagination: { total: number } };
      expect(body.pagination.total).toBe(EXPECTED.length);
      expect(body.data.length).toBe(Math.min(2, EXPECTED.length - seen.length));
      seen.push(...body.data.map((d) => d.id));
    }
    expect(new Set(seen).size).toBe(EXPECTED.length);
    expect([...seen].sort()).toEqual(EXPECTED);
    const all = (await list({ attachable: '1', pageSize: '50' })).body as { data: Array<{ id: string }> };
    expect(seen).toEqual(all.data.map((d) => d.id));
    expect(seen[0]).toBe(ids.linkUnlinked); // the last one inserted: newest first
  });

  it('leaves the unfiltered list alone', async () => {
    const r = await list({ pageSize: '50' });
    const body = r.body as { data: Array<{ id: string }> };
    expect(body.data.map((d) => d.id)).toEqual(expect.arrayContaining([ids.posted, ids.rejected, ids.reading, ids.failed]));
    expect(body.data.map((d) => d.id)).not.toContain(ids.otherCompany);
  });
});
