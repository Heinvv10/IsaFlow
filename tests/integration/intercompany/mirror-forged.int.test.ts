/**
 * Intercompany P2, the SENDER does not author the payload (migration 1013). The breaker's round-2 findings were all one thing: the sender
 * wrote the JSON the receiver builds a draft from, and the database could only check some of its fields (line VAT, due date, notes, PDF,
 * credited invoice, the group reference were free). Now the DATABASE writes a document message (`intercompany_send_for_source`) from the
 * sender's approved document, and the messages guard refuses the sender's own INSERT of one, so no field is the sender's to choose.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { runAutoAccept } from '../../../src/modules/accounting/services/intercompany/autoAcceptWorker';
import { parseMirrorPayload } from '../../../src/modules/accounting/services/intercompany/mirrorPayload';
import { enableFxDocuments } from '../r035-approval.helpers';
import { asAppUser, outcome, plantExternal } from './intercompany.helpers';
import {
  clearMirrorRows, co, connect, dataOf, inbox, mirrorCleanup, mirrorSetup, plantArCreditNote, plantArInvoice, sentInvoice, U, wipeConnections,
} from './mirror.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';
beforeAll(() => mirrorSetup(pool), 60000);
afterAll(() => mirrorCleanup(pool), 60000);
beforeEach(async () => {
  await clearMirrorRows(pool);
  await pool.query('UPDATE companies SET vat_number = NULL WHERE id = $1', [co.A]);
  conn = await connect(pool, { autoAccept: true });
});

const INSERT = `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
                VALUES ($1, $2, $3, 'invoice', 'customer_invoice', $4, $5::jsonb)`;
/** The definer, as a session of `company` (committed). */
const sendFor = (type: string, doc: string, user = U.a, company = co.A) =>
  asAppUser(pool, user, company, async (q) => (await q.query('SELECT * FROM public.intercompany_send_for_source($1, $2)', [type, doc])).rows[0] as { message_id: string | null; reason: string | null; detail: string | null }, true);
const messageOf = async (doc: string) => (await pool.query('SELECT * FROM intercompany_messages WHERE source_doc_id = $1', [doc])).rows[0];
const groupRows = async () => (await pool.query('SELECT * FROM intercompany_transactions WHERE group_id = $1 ORDER BY created_at', [co.G])).rows;
/** What the database builds for an approved invoice, as a message payload to doctor (the table owner reads it; no message is written). */
async function built(doc: string): Promise<Record<string, any>> {
  const r = await pool.query("SELECT payload FROM public.intercompany_build_payload('invoice', $1, $2)", [doc, co.A]);
  return JSON.parse(JSON.stringify(r.rows[0].payload));
}

describe('the sender cannot write a document message, whatever it says', () => {
  const forgeries: Array<[string, (p: Record<string, any>) => Record<string, any>]> = [
    ['the document\'s own payload, as built by the database', (p) => p],
    ['a different total', (p) => ({ ...p, total: 9999 })],
    ['line VAT the books do not have', (p) => ({ ...p, taxAmount: 999, lines: p.lines.map((l: any) => ({ ...l, taxAmount: 999 })) })],
    ['a due date of the sender\'s choosing', (p) => ({ ...p, dueDate: '2026-09-02' })],
    ['a note that says the bank details changed', (p) => ({ ...p, notes: 'Our bank details have changed: pay FNB 62000000000' })],
    ['a PDF the sealing never wrote', (p) => ({ ...p, pdf: { path: `${co.A}/${crypto.randomUUID()}.pdf`, sha256: 'a'.repeat(64) } })],
    ['a credited invoice number', (p) => ({ ...p, creditsInvoiceNumber: 'INV-0001' })],
    ['another row\'s group reference', (p) => ({ ...p, groupTransactionId: crypto.randomUUID() })],
    ['another company\'s name and VAT number', (p) => ({ ...p, senderName: 'Somebody Else (Pty) Ltd', senderVatNumber: '4999999999' })],
  ];
  it.each(forgeries)('%s: refused (42501), nothing sent, nothing for the worker or the receiver', async (_name, doctor) => {
    const inv = await plantArInvoice(pool, { status: 'approved' });
    const payload = doctor(await built(inv.id));
    const out = await asAppUser(pool, U.a, co.A, (q) => outcome(q, INSERT, [conn, co.A, co.B, inv.id, JSON.stringify(payload)]));
    expect(out).toMatch(/^42501: a document message is written by the database/);
    expect(await messageOf(inv.id)).toBeUndefined();
    expect(await runAutoAccept()).toMatchObject({ considered: 0 });
    expect(Number((await pool.query('SELECT count(*) AS n FROM supplier_invoices WHERE company_id = $1', [co.B])).rows[0].n)).toBe(0);
  });

  it('a credit-note message is refused the same way, by the app_service role too (it holds an INSERT policy, and the worker\'s login inherits it)', async () => {
    const cn = await plantArCreditNote(pool);
    await pool.query("UPDATE credit_notes SET status = 'approved' WHERE id = $1", [cn]);
    const insert = `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
                    VALUES ($1, $2, $3, 'credit_note', 'credit_note', $4, '{}'::jsonb)`;
    expect(await asAppUser(pool, U.a, co.A, (q) => outcome(q, insert, [conn, co.A, co.B, cn]))).toMatch(/^42501: a document message is written by the database/);
    // an EXTERNAL connection has no group rule in front of the document rule, so the refusal is the document rule's own for the service role too
    await wipeConnections(pool);
    const external = await plantExternal(pool, co.A, co.B, 'active');
    const asServiceRole = await pool.connect();
    try {
      await asServiceRole.query('BEGIN');
      await asServiceRole.query('SET LOCAL ROLE app_service');
      expect(await outcome(asServiceRole, insert, [external, co.A, co.B, cn])).toMatch(/^42501: a document message is written by the database/);
    } finally { await asServiceRole.query('ROLLBACK'); asServiceRole.release(); }
    expect(await messageOf(cn)).toBeUndefined();
  });

  it('the columns the database writes (the journal it was sent with, the cancellation stamp) are no app_user column', async () => {
    const m = await sentInvoice(pool);
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_messages SET source_journal_entry_id = NULL WHERE id = $1', [m.id])).toMatch(/^42501/);
      expect(await outcome(q, 'UPDATE intercompany_messages SET payload = payload WHERE id = $1', [m.id])).toMatch(/^42501/);
    });
  });
});

describe('the database sends the sender\'s document, and only that', () => {
  it('writes the message and the group row for an approved invoice of the session company, and a second call writes nothing', async () => {
    const inv = await plantArInvoice(pool, { status: 'approved' });
    const first = await sendFor('customer_invoice', inv.id);
    expect(first).toMatchObject({ reason: null });
    expect(first.message_id).toBeTruthy();
    expect(await sendFor('customer_invoice', inv.id)).toMatchObject({ message_id: null, reason: 'already_sent' });
    const [g] = await groupRows();
    expect((await messageOf(inv.id)).payload.groupTransactionId).toBe(g.id);
    expect(await groupRows()).toHaveLength(1);
  });

  // (U and co are filled in by the fixture's beforeAll: the table names them)
  it.each([
    ['a viewer of the sending company', 'va', 'A', 'forbidden'],
    ['the receiver (not the sender\'s document)', 'b', 'B', 'no_connection'],
    ['a stranger acting as the sender (not a user of it)', 'c', 'A', 'forbidden'],
  ] as const)('%s sends nothing: %s', async (_who, user, company, reason) => {
    const inv = await plantArInvoice(pool, { status: 'approved' });
    expect(await sendFor('customer_invoice', inv.id, U[user], co[company])).toMatchObject({ message_id: null, reason });
    expect(await messageOf(inv.id)).toBeUndefined();
    expect(await groupRows()).toHaveLength(0);
  });

  it('an unapproved document, an unknown type and a made-up id send nothing', async () => {
    const draft = await plantArInvoice(pool);
    expect(await sendFor('customer_invoice', draft.id)).toMatchObject({ message_id: null, reason: 'not_approved' });
    expect(await sendFor('journal_entry', draft.id)).toMatchObject({ message_id: null, reason: 'not_found' });
    expect(await sendFor('customer_invoice', crypto.randomUUID())).toMatchObject({ message_id: null, reason: 'no_connection' });
    expect(await groupRows()).toHaveLength(0);
  });

  it('the group row is the document\'s own: its amount and journal, never another row of the sender\'s (the breaker\'s P2)', async () => {
    const small = await sentInvoice(pool);
    const big = await sentInvoice(pool, { lines: [['Big job', 1, 5000]] });
    const rows = await groupRows();
    expect(rows).toHaveLength(2);
    const small$ = rows.find((r) => r.id === small.message.payload.groupTransactionId)!;
    const big$ = rows.find((r) => r.id === big.message.payload.groupTransactionId)!;
    expect(small.message.payload.groupTransactionId).not.toBe(big.message.payload.groupTransactionId);
    expect([Number(small$.amount), Number(big$.amount)]).toEqual([1000, 5000]);
    const journalOf = async (id: string) => (await pool.query('SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = $1', [id])).rows[0].je;
    expect(small$.source_journal_entry_id).toBe(await journalOf(small.inv.id));
    expect(big$.source_journal_entry_id).toBe(await journalOf(big.inv.id));
  });

  it('a foreign-currency document has no group row (its amount is not ZAR), but is still sent for the receiver to refuse', async () => {
    await enableFxDocuments(pool, co.A);
    const usd = await plantArInvoice(pool, { status: 'approved', currency: 'USD' });
    expect((await sendFor('customer_invoice', usd.id)).message_id).toBeTruthy();
    expect((await messageOf(usd.id)).payload).toMatchObject({ currency: 'USD', groupTransactionId: null });
    expect(await groupRows()).toHaveLength(0);
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

describe('what the old check refused although it was the sender\'s own (the breaker\'s P5) is now sent', () => {
  it('a VAT number with a trailing space goes as the trimmed number', async () => {
    await pool.query("UPDATE companies SET vat_number = '4123456789 ' WHERE id = $1", [co.A]);
    const inv = await plantArInvoice(pool, { status: 'approved' });
    expect((await sendFor('customer_invoice', inv.id)).message_id).toBeTruthy();
    expect((await messageOf(inv.id)).payload.senderVatNumber).toBe('4123456789');
  });

  it('a NULL invoice currency is ZAR, and a NULL credit-note currency too', async () => {
    const inv = await plantArInvoice(pool, { status: 'approved' });
    await pool.query('UPDATE customer_invoices SET currency_code = NULL WHERE id = $1', [inv.id]);
    expect((await sendFor('customer_invoice', inv.id)).message_id).toBeTruthy();
    expect((await messageOf(inv.id)).payload.currency).toBe('ZAR');
    const cn = await plantArCreditNote(pool);
    await pool.query("UPDATE credit_notes SET status = 'approved', currency = NULL WHERE id = $1", [cn]);
    expect((await sendFor('credit_note', cn)).message_id).toBeTruthy();
    expect((await messageOf(cn)).payload).toMatchObject({ currency: 'ZAR', kind: 'credit_note' });
  });

  it('a padded company name goes trimmed and a lower-case currency upper-cased; the receiver\'s parser reads what was sent', async () => {
    await pool.query("UPDATE companies SET name = '  ' || name || '  ' WHERE id = $1", [co.A]);
    const inv = await plantArInvoice(pool, { status: 'approved' });
    await pool.query("UPDATE customer_invoices SET currency_code = 'zar' WHERE id = $1", [inv.id]);
    try {
      expect((await sendFor('customer_invoice', inv.id)).message_id).toBeTruthy();
    } finally {
      await pool.query('UPDATE companies SET name = btrim(name) WHERE id = $1', [co.A]);
    }
    const m = await messageOf(inv.id);
    expect(m.payload.currency).toBe('ZAR');
    expect(m.payload.senderName).toBe(m.payload.senderName.trim());
    expect(parseMirrorPayload(m.payload, 'invoice', co.A).ok).toBe(true);
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
});

