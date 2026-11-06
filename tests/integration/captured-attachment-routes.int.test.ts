// A bank line's captured documents through the real routes, with the real withAuth (signed token, app_user, RLS):
//   T1 (company A) holds
//     U1  an upload                                       → listed; Remove deletes it
//     D1  linked, stored, no copy                         → listed once, by its route; the bytes route admits it
//     D2  linked, stored, with copy C2 named UPPER-case    → listed ONCE, as C2 with document_id; deleting C2 by id is
//                                                          refused (409); Remove by document unlinks D2 and deletes C2
//     D3  linked but rejected                             → not listed, not served, not support
//     D4  linked, POSTED                                  → unlinking keeps its status ('matched')
//     D6  linked, 'reviewed' before it was linked         → unlinking keeps 'reviewed': unlink never changes status
//   T2 (company A) holds only a rejected document         → unsupported
//   DB  company B's linked document                       → never served to A
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import attachmentsRoute from '../../pages/api/accounting/bank-tx-attachments';
import fileRoute from '../../pages/api/accounting/captured-document-file';
import { callRoute, createUser, newCompany } from './r035-approval.helpers';
import { listBankAttachments, listTransactionsWithoutDocuments } from '@/modules/accounting/services/core/documentQueryService';
import { getBankTxAttachment } from '@/modules/accounting/services/bank/bankTxAttachmentService';
import { attachCapturedDocToBankTx } from '@/modules/accounting/services/capture/captureBankTxAttachService';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') && process.env.JWT_SECRET ? describe : describe.skip;
const pool = new Pool({ connectionString: url });
const uuid = () => crypto.randomUUID();
const tokens: Record<string, string> = {};
const companies: string[] = [];
let user = '';
let outsider = '';
let company = '';
let other = '';
const [bank, bankB, t1, t2, tb] = [uuid(), uuid(), uuid(), uuid(), uuid()];
// On 2026-06-02, so the cases above keep their own figures: T3 a rejected document WITH a copy, T4/T5 a relink, T6 an
// empty storage_path.
const [t3, t4, t5, t6, d7, c7, d8, c8, d9] = [uuid(), uuid(), uuid(), uuid(), uuid(), uuid(), uuid(), uuid(), uuid()];
const [u1, c2, d1, d2, d3, d4, d5, d6, db] = [uuid(), uuid(), uuid(), uuid(), uuid(), uuid(), uuid(), uuid(), uuid()];
const ATT = '/api/accounting/bank-tx-attachments';
const FILE = '/api/accounting/captured-document-file';

async function doc(id: string, co: string, tx: string, status: string, posted = false) {
  await pool.query(
    `INSERT INTO captured_documents(id, company_id, file_name, file_type, file_size, status, matched_bank_tx_id,
       storage_bucket, storage_path, posted_at, created_at)
     VALUES($1, $2, $3, 'application/pdf', 7400000, $4, $5, 'captured-documents', $6, $7, now() - interval '1 hour')`,
    [id, co, `doc-${id.slice(0, 4)}.pdf`, status, tx, `${co}/${id}.pdf`, posted ? new Date() : null]);
}
const call = (method: string, query: Record<string, string>, route = attachmentsRoute, path = ATT, who = user, co = company) =>
  callRoute(route as never, tokens[who]!, co, method, undefined, `${path}?${new URLSearchParams(query)}`, query);
const body = (r: Awaited<ReturnType<typeof call>>) => r.state.body as { data?: unknown; error?: { message?: string } };
const docState = async (id: string) =>
  (await pool.query('SELECT matched_bank_tx_id, status FROM captured_documents WHERE id = $1', [id])).rows[0];

describeIfDb('captured documents on a bank line, through the routes', () => {
  beforeAll(async () => {
    user = await createUser(pool, tokens);
    outsider = await createUser(pool, tokens);
    company = await newCompany(pool, [[user, 'owner']], companies);
    other = await newCompany(pool, [[outsider, 'owner']], companies);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$3,'CRB','CR Bank','asset','bank','debit'),($2,$4,'CRB','CR Bank B','asset','bank','debit')`,
      [bank, bankB, company, other]);
    for (const [id, co, acct, amount, date] of [[t1, company, bank, -12000, '2026-06-01'], [t2, company, bank, -11000, '2026-06-01'],
      [tb, other, bankB, -5, '2026-06-01'], [t3, company, bank, -13000, '2026-06-02'], [t4, company, bank, -14000, '2026-06-02'],
      [t5, company, bank, -15000, '2026-06-02'], [t6, company, bank, -16000, '2026-06-02']] as const) {
      await pool.query(
        `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
         VALUES($1,$2,$3,$5,$4,'captured routes fixture','imported')`, [id, co, acct, amount, date]);
    }
    await doc(d7, company, t3, 'rejected');
    await doc(d8, company, t4, 'matched');
    await doc(d9, company, t6, 'matched');
    await pool.query("UPDATE captured_documents SET storage_path = '' WHERE id = $1", [d9]);
    await pool.query(
      `INSERT INTO bank_transaction_attachments(id, bank_transaction_id, file_url, file_name, file_size)
       VALUES($1, $2, 'data:application/pdf;base64,JVBERi0=', $3, 5), ($4, $5, 'data:application/pdf;base64,JVBERi0=', $6, 5)`,
      [c7, t3, `${d7}_scan.pdf`, c8, t4, `${d8}_scan.pdf`]);
    await doc(d1, company, t1, 'matched');
    await doc(d2, company, t1, 'matched');
    await doc(d3, company, t1, 'rejected');
    await doc(d4, company, t1, 'matched', true);
    await doc(d5, company, t2, 'rejected');
    await doc(d6, company, t2, 'reviewed');
    await doc(db, other, tb, 'matched');
    await pool.query(
      `INSERT INTO bank_transaction_attachments(id, bank_transaction_id, file_url, file_name, file_size, created_at)
       VALUES($1, $3, 'data:image/png;base64,iVBORw0KGgo=', 'slip.png', 8, now()),
             ($2, $3, 'data:application/pdf;base64,JVBERi0=', $4, 5, now() - interval '2 hours')`,
      [u1, c2, t1, `${d2.toUpperCase()}_scan.pdf`]);
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM bank_transaction_attachments WHERE bank_transaction_id = ANY($1::uuid[])', [[t1, t2, tb, t3, t4, t5, t6]]);
      await pool.query('DELETE FROM captured_documents WHERE company_id = ANY($1::uuid[])', [companies]);
      await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1::uuid[])', [companies]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1::uuid[])', [companies]);
      await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [companies]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companies]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[user, outsider]]);
    } finally {
      await pool.end();
    }
  });

  it('counts each document once on the MCP list, rejected ones never', async () => {
    const page = await listBankAttachments(company, { from: '2026-06-01', to: '2026-06-01', limit: 50 });
    expect(page.rows.map((r) => [r.id, r.store]).sort()).toEqual([
      [c2, 'bank_attachment'], [d1, 'captured_document'], [d4, 'captured_document'], [d6, 'captured_document'],
      [u1, 'bank_attachment'],
    ].sort());
    expect(page.rowsTotal).toBe(5);
    const unsupported = await listTransactionsWithoutDocuments(company, { from: '2026-06-01', to: '2026-06-01', minAmount: 10000, limit: 50 });
    // T2's only documents are rejected (D5) and D6, so it is supported until D6 is unlinked (asserted below).
    expect(unsupported.rows.map((r) => r.id)).toEqual([]);
  });

  it('lists each supporting document once, newest first, marking linked ones with their document', async () => {
    const r = await call('GET', { bankTransactionId: t1 });
    expect(r.state.statusCode).toBe(200);
    const items = body(r).data as { id: string; document_id?: string; source?: string; file_url: string }[];
    // Newest first: the upload (now), D1 and D4 (an hour ago, tied), the copy C2 (two hours ago).
    const ids = items.map((i) => i.id);
    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe(u1);
    expect(ids[3]).toBe(c2);
    expect(ids.slice(1, 3).sort()).toEqual([`captured-${d1}`, `captured-${d4}`].sort());
    expect(items.find((i) => i.id === c2)).toMatchObject({ document_id: d2, source: 'captured' });
    expect(items.find((i) => i.id === `captured-${d1}`)).toMatchObject({ document_id: d1, file_url: `${FILE}?id=${d1}` });
    expect(items.find((i) => i.id === u1)?.document_id).toBeUndefined();
    expect(items.some((i) => i.id.includes(d3))).toBe(false);
  });

  it('serves bytes only for a linked, unrejected document of the caller\'s company', async () => {
    expect((await call('GET', { id: d3 }, fileRoute, FILE)).state.statusCode).toBe(404);
    expect((await call('GET', { id: db }, fileRoute, FILE)).state.statusCode).toBe(404);
    // Its own company passes the gate; the fixture has no storage object, so the read then fails past the gate.
    expect((await call('GET', { id: db }, fileRoute, FILE, outsider, other)).state.statusCode).not.toBe(404);
  });

  it('stores an upload named like a linked document\'s copy under a name that cannot pass for one', async () => {
    const r = await callRoute(attachmentsRoute as never, tokens[user]!, company, 'POST',
      { bankTransactionId: t1, fileName: `${d1}_fake.png`, fileData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' }, ATT);
    expect(r.state.statusCode).toBe(201);
    const stored = (await pool.query('SELECT id, file_name FROM bank_transaction_attachments WHERE bank_transaction_id = $1 AND file_name LIKE $2',
      [t1, `%${d1}_fake.png`])).rows;
    expect(stored.map((x) => x.file_name)).toEqual([`upload_${d1}_fake.png`]);
    const items = body(await call('GET', { bankTransactionId: t1 })).data as { id: string; document_id?: string }[];
    expect(items.find((i) => i.id === `captured-${d1}`)?.document_id).toBe(d1);
    expect(items.find((i) => i.id === stored[0]!.id)?.document_id).toBeUndefined();
    await pool.query('DELETE FROM bank_transaction_attachments WHERE id = $1', [stored[0]!.id]);
  });

  it('refuses to delete the copy of a linked document by id, and deletes a plain upload', async () => {
    const refused = await call('DELETE', { id: c2 });
    expect(refused.state.statusCode).toBe(409);
    expect((await pool.query('SELECT 1 FROM bank_transaction_attachments WHERE id = $1', [c2])).rowCount).toBe(1);
    expect((await call('DELETE', { id: u1 })).state.statusCode).toBe(200);
    expect((await pool.query('SELECT 1 FROM bank_transaction_attachments WHERE id = $1', [u1])).rowCount).toBe(0);
    expect((await call('DELETE', { id: 'captured-x' })).state.statusCode).toBe(400);
  });

  it('unlinks a document by Remove: link cleared, copy gone, and its status never changed', async () => {
    // 'matched' with nothing posted also marks a duplicate supplier invoice or a sent document; with no record of the
    // status before linking, any reset could make an invoice already booked postable again.
    expect((await call('DELETE', { documentId: d2, bankTransactionId: t1 })).state.statusCode).toBe(200);
    expect(await docState(d2)).toEqual({ matched_bank_tx_id: null, status: 'matched' });
    expect((await pool.query('SELECT 1 FROM bank_transaction_attachments WHERE id = $1', [c2])).rowCount).toBe(0);
    expect((await call('GET', { id: d2 }, fileRoute, FILE)).state.statusCode).toBe(404);

    expect((await call('DELETE', { documentId: d4, bankTransactionId: t1 })).state.statusCode).toBe(200);
    expect(await docState(d4)).toEqual({ matched_bank_tx_id: null, status: 'matched' });
    expect((await call('DELETE', { documentId: d6, bankTransactionId: t2 })).state.statusCode).toBe(200);
    expect(await docState(d6)).toEqual({ matched_bank_tx_id: null, status: 'reviewed' });

    const items = body(await call('GET', { bankTransactionId: t1 })).data as { id: string }[];
    expect(items.map((i) => i.id)).toEqual([`captured-${d1}`]);
    const unsupported = await listTransactionsWithoutDocuments(company, { from: '2026-06-01', to: '2026-06-01', minAmount: 10000, limit: 50 });
    expect(unsupported.rows.map((r) => r.id)).toEqual([t2]);
  });

  it('unlinks nothing it cannot see: twice, another line, another company', async () => {
    expect((await call('DELETE', { documentId: d2, bankTransactionId: t1 })).state.statusCode).toBe(404);
    expect((await call('DELETE', { documentId: d1, bankTransactionId: t2 })).state.statusCode).toBe(404);
    expect((await call('DELETE', { documentId: db, bankTransactionId: tb })).state.statusCode).toBe(404);
    expect(await docState(db)).toEqual({ matched_bank_tx_id: tb, status: 'matched' });
    expect((await call('DELETE', { documentId: d1 })).state.statusCode).toBe(400);
  });

  const day2Unsupported = async () => (await listTransactionsWithoutDocuments(company,
    { from: '2026-06-02', to: '2026-06-02', minAmount: 10000, limit: 50 })).rows.map((r) => r.id).sort();

  it('counts a copy only while its document is linked to the line and not rejected; an empty storage_path is not stored', async () => {
    // T3's copy belongs to a rejected document: no support, not listed. T6's document has storage_path ''.
    expect(await day2Unsupported()).toEqual([t3, t5, t6].sort());
    expect((body(await call('GET', { bankTransactionId: t3 })).data as unknown[])).toEqual([]);
    expect((body(await call('GET', { bankTransactionId: t6 })).data as unknown[])).toEqual([]);
    const items = body(await call('GET', { bankTransactionId: t4 })).data as { id: string; document_id?: string }[];
    expect(items).toEqual([expect.objectContaining({ id: c8, document_id: d8 })]);
  });

  it('a relink moves the document: its copy on the line it left is removed', async () => {
    const moved = await attachCapturedDocToBankTx(company, d8, t5, null);
    expect(moved.ok).toBe(true);
    expect((await pool.query('SELECT 1 FROM bank_transaction_attachments WHERE id = $1', [c8])).rowCount).toBe(0);
    expect(await docState(d8)).toMatchObject({ matched_bank_tx_id: t5 });
    // The fixture has no storage object, so no new copy: D8 supports T5 as an uncopied linked document.
    expect(await day2Unsupported()).toEqual([t3, t4, t6].sort());
  });

  it('get_document reads a linked captured document of the caller\'s company only', async () => {
    expect(await getBankTxAttachment(company, d1)).toMatchObject({ id: d1, store: 'captured_document', bankTransactionId: t1 });
    expect(await getBankTxAttachment(other, d1)).toBeNull();
    expect(await getBankTxAttachment(company, d3)).toBeNull();
    expect(await getBankTxAttachment(company, db)).toBeNull();
    expect(await getBankTxAttachment(company, d9)).toBeNull();
  });
});
