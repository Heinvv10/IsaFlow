/**
 * Intercompany P2, what the database will send as the sender's document: the recorded journal must be the document's OWN approval posting,
 * the sealed PDF is the one the sealing wrote for THIS invoice or none, and a source the sender changed after the send is seen by the receiver
 * (and refused by the worker; a person decides for themselves). The sender's own INSERT of a document message is mirror-forged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { runAutoAccept } from '../../../src/modules/accounting/services/intercompany/autoAcceptWorker';
import { asAppUser } from './intercompany.helpers';
import {
  clearMirrorRows, co, connect, dataOf, errorOf, inbox, mirrorCleanup, mirrorSetup, plantArInvoice, sentInvoice, U,
} from './mirror.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
beforeAll(() => mirrorSetup(pool), 60000);
afterAll(() => mirrorCleanup(pool), 60000);
beforeEach(async () => { await clearMirrorRows(pool); await connect(pool, { autoAccept: true }); });

const sendFor = (type: string, doc: string, user = U.a, company = co.A) =>
  asAppUser(pool, user, company, async (q) => (await q.query('SELECT * FROM public.intercompany_send_for_source($1, $2)', [type, doc])).rows[0] as { message_id: string | null; reason: string | null; detail: string | null }, true);
const messageOf = async (doc: string) => (await pool.query('SELECT * FROM intercompany_messages WHERE source_doc_id = $1', [doc])).rows[0];
const groupRows = async () => (await pool.query('SELECT * FROM intercompany_transactions WHERE group_id = $1 ORDER BY created_at', [co.G])).rows;

describe('the recorded journal must be the document\'s OWN approval posting', () => {
  const journalOf = async (inv: string) => (await pool.query('SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = $1', [inv])).rows[0].je as string;
  const refused = async (inv: string, why: RegExp) => {
    const rowsBefore = (await groupRows()).length;
    const out = await sendFor('customer_invoice', inv);
    expect(out).toMatchObject({ message_id: null, reason: 'no_journal', detail: expect.stringMatching(why) });
    expect(await messageOf(inv)).toBeUndefined();
    expect(await groupRows()).toHaveLength(rowsBefore);
  };

  it('another document\'s journal (the invoice\'s link points at it) is not its posting', async () => {
    const mine = await plantArInvoice(pool, { status: 'approved' });
    const theirs = await plantArInvoice(pool, { status: 'approved' });
    await pool.query('UPDATE customer_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [mine.id, await journalOf(theirs.id)]);
    await refused(mine.id, /posting of another document|not the posting of this document/);
  });
  it('a journal whose text names the document but that another document links is refused (text is not identity)', async () => {
    const mine = await plantArInvoice(pool, { status: 'approved' });
    const other = await plantArInvoice(pool, { status: 'approved' });
    const shared = await journalOf(mine.id);                                       // `mine`'s own posting ...
    await pool.query('UPDATE customer_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [other.id, shared]);   // ... which another invoice also links
    await refused(mine.id, /posting of another document/);
  });
  it('a journal that another document\'s message already records is refused', async () => {
    const first = await sentInvoice(pool);                                         // its message records its journal J
    const second = await plantArInvoice(pool, { status: 'approved' });
    const j = await journalOf(first.inv.id);
    await pool.query('UPDATE customer_invoices SET invoice_number = invoice_number || $2, gl_journal_entry_id = NULL WHERE id = $1', [first.inv.id, '-x']);
    await pool.query('UPDATE customer_invoices SET invoice_number = $2, gl_journal_entry_id = $3 WHERE id = $1', [second.id, first.inv.number, j]);
    await refused(second.id, /recorded on another document/);
  });
  it('a reversal entry is not an approval posting', async () => {
    const inv = await plantArInvoice(pool, { status: 'approved' });
    const j = await journalOf(inv.id);
    const reversal = (await pool.query(
      `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id, reversal_of_id)
       SELECT entry_date, description, source, 'posted', created_by, company_id, id FROM gl_journal_entries WHERE id = $1 RETURNING id`, [j])).rows[0].id as string;
    await pool.query('UPDATE customer_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [inv.id, reversal]);
    await refused(inv.id, /not an original posted entry/);
  });
  it('another company\'s journal, and a journal with the wrong text, are not the posting', async () => {
    const inv = await plantArInvoice(pool, { status: 'approved' });
    const foreign = (await pool.query(
      `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES ('2026-09-01', $1, 'auto_invoice', 'posted', $2, $3) RETURNING id`,
      [`Customer invoice ${inv.number}`, U.ab, co.B])).rows[0].id as string;
    await pool.query('UPDATE customer_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [inv.id, foreign]);
    await refused(inv.id, /not this company/);
    const wrong = (await pool.query(
      `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES ('2026-09-01', 'Something else', 'manual', 'posted', $1, $2) RETURNING id`, [U.ab, co.A])).rows[0].id as string;
    await pool.query('UPDATE customer_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [inv.id, wrong]);
    await refused(inv.id, /not the posting of this document/);
  });
});


describe('the PDF reference is the one sealing wrote for THIS invoice, or none', () => {
  const HASH = 'ab'.repeat(32);
  /** An approved invoice whose seal columns say `path` / `sha`, and a captured document of A with the given storage path and hash. */
  async function sealed(over: { docPath?: (doc: string) => string; docSha?: string; path?: (doc: string) => string; sha?: string; noDoc?: boolean } = {}) {
    const inv = await plantArInvoice(pool, { status: 'approved' });
    const doc = crypto.randomUUID();
    const path = over.path ? over.path(doc) : `${co.A}/${doc}.pdf`;
    if (!over.noDoc) {
      await pool.query(
        `INSERT INTO captured_documents(id, company_id, file_name, file_type, file_size, document_type, status, raw_bytes_sha256, raw_bytes_size, storage_path)
         VALUES ($1, $2, 'seal.pdf', 'pdf', 10, 'sent_invoice', 'matched', $3, 10, $4)`, [doc, co.A, over.docSha ?? HASH, over.docPath ? over.docPath(doc) : path]);
    }
    await pool.query('UPDATE customer_invoices SET source_document_id = $2, rendered_pdf_storage_path = $3, rendered_pdf_sha256 = $4 WHERE id = $1', [inv.id, over.noDoc ? null : doc, path, over.sha ?? HASH]);
    return { inv, doc, path };
  }
  const pdfOf = async (inv: string) => { await sendFor('customer_invoice', inv); return (await messageOf(inv)).payload.pdf; };

  it('the seal as the sealing wrote it is carried', async () => {
    const { inv, path } = await sealed();
    expect(await pdfOf(inv.id)).toEqual({ path, sha256: HASH });
  });
  it.each([
    ['a path that is not <company>/<its document>.pdf, though a captured document holds it', { path: () => `${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/x.pdf`, docPath: () => `${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/x.pdf` }],
    ['a hash the captured document does not have', { docSha: 'cd'.repeat(32) }],
    ['a path of the right shape with no captured document linked to the invoice', { noDoc: true }],
    ['a malformed hash', { sha: 'not-a-hash' }],
  ])('%s: no PDF travels, and the message still does', async (_name, over) => {
    const { inv } = await sealed(over);
    expect(await pdfOf(inv.id)).toBeNull();
    expect((await messageOf(inv.id)).payload).toMatchObject({ number: inv.number });
  });
});


describe('a source that changed after the send is seen by the receiver (the breaker\'s P6, noted: editing an approved document is a wider class)', () => {
  const changed = (user: string, company: string, id: string) =>
    asAppUser(pool, user, company, async (q) => (await q.query('SELECT public.intercompany_message_source_changed($1) AS c', [id])).rows[0].c as boolean | null);

  it('false while the sender\'s document is what it sent; true once a line, the number or the date is edited; null for anyone but the receiver', async () => {
    const m = await sentInvoice(pool);
    expect(await changed(U.b, co.B, m.id)).toBe(false);
    expect(await changed(U.a, co.A, m.id)).toBeNull();
    expect(await changed(U.c, co.C, m.id)).toBeNull();
    await pool.query("UPDATE customer_invoice_items SET amount = amount + 1, unit_price = unit_price + 1 WHERE invoice_id = $1 AND description = 'Router'", [m.inv.id]);
    expect(await changed(U.b, co.B, m.id)).toBe(true);
    await pool.query("UPDATE customer_invoice_items SET amount = amount - 1, unit_price = unit_price - 1 WHERE invoice_id = $1 AND description = 'Router'", [m.inv.id]);
    expect(await changed(U.b, co.B, m.id)).toBe(false);
    await pool.query("UPDATE customer_invoices SET invoice_number = invoice_number || 'X' WHERE id = $1", [m.inv.id]);
    expect(await changed(U.b, co.B, m.id)).toBe(true);
  });

  it('the inbox shows it on the message, and the worker will not accept it: it fails with a plain sentence for a person to review', async () => {
    const m = await sentInvoice(pool);
    expect(dataOf<{ item: { sourceChanged: boolean } }>(await inbox.get(U.b, co.B, m.id)).item.sourceChanged).toBe(false);
    await pool.query("UPDATE customer_invoices SET due_date = due_date + 7 WHERE id = $1", [m.inv.id]);
    expect(dataOf<{ item: { sourceChanged: boolean } }>(await inbox.get(U.b, co.B, m.id)).item.sourceChanged).toBe(true);
    const run = await runAutoAccept();
    expect(run).toMatchObject({ considered: 1, accepted: 0, failed: 1 });
    const row = (await pool.query('SELECT status, error FROM intercompany_messages WHERE id = $1', [m.id])).rows[0];
    expect(row).toMatchObject({ status: 'failed', error: expect.stringMatching(/changed this document after sending it/) });
    expect(Number((await pool.query('SELECT count(*) AS n FROM supplier_invoices WHERE company_id = $1', [co.B])).rows[0].n)).toBe(0);
  });

  it('a PERSON can still accept a message whose source changed (they were warned in the dialog and decide for themselves); only the worker refuses', async () => {
    const m = await sentInvoice(pool);
    await pool.query('UPDATE customer_invoices SET due_date = due_date + 7 WHERE id = $1', [m.inv.id]);
    const res = await inbox.accept(U.b, co.B, m.id);
    expect(res.state.statusCode, errorOf(res)).toBe(200);
    expect((await pool.query('SELECT status FROM intercompany_messages WHERE id = $1', [m.id])).rows[0].status).toBe('accepted');
  });
});
