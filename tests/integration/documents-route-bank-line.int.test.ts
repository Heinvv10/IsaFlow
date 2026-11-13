// /api/accounting/documents is the ONE endpoint for every entity type: a bank line works through it as a
// supplier invoice does (entity_type=bank_transaction), routed internally to the bank-tx attachment storage, so a caller
// never has to know the second endpoint. The old /bank-tx-attachments endpoint keeps working on the same rows.
//   T1 (company A) holds an upload U1 and a linked captured document D1 (no copy)
//   T2 (company A) holds nothing
//   TB (company B) holds an upload — never visible to, or writable by, company A
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import documentsRoute from '../../pages/api/accounting/documents';
import attachmentsRoute from '../../pages/api/accounting/bank-tx-attachments';
import { callRoute, createUser, newCompany } from './r035-approval.helpers';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { listTransactionsWithoutDocuments } from '@/modules/accounting/services/core/documentQueryService';

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
const [bank, bankB, t1, t2, tb, u1, d1] = [uuid(), uuid(), uuid(), uuid(), uuid(), uuid(), uuid()];
const DOCS = '/api/accounting/documents';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const DOCX = Buffer.from('504b0304', 'hex');

type Result = Awaited<ReturnType<typeof callRoute>>;
const body = (r: Result) => r.state.body as { data?: unknown; error?: { message?: string } };
const get = (query: Record<string, string>, co = company) =>
  callRoute(documentsRoute as never, tokens[user]!, co, 'GET', undefined, `${DOCS}?${new URLSearchParams(query)}`, query);

/** A real multipart request: the route parses its body with formidable, which reads the stream. */
async function post(fields: Record<string, string>, file: { name: string; mime: string; bytes: Buffer }, co = company) {
  const boundary = `----fixture${uuid()}`;
  const parts = Object.entries(fields).map(([k, v]) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`),
    file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  const payload = Buffer.concat(parts);
  const base = request({ 'sb-access-token': tokens[user]!, active_company_id: co }, 'POST') as never as Record<string, unknown>;
  const req = Object.assign(Readable.from([payload]), base, {
    url: DOCS, query: {},
    headers: { ...(base.headers as Record<string, string>), 'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(payload.length) },
  });
  const result = response();
  await (documentsRoute as unknown as (rq: never, rs: never) => Promise<unknown>)(req as never, result.res as never);
  return result;
}
const attachmentCount = async (tx: string) =>
  Number((await pool.query('SELECT count(*) AS n FROM bank_transaction_attachments WHERE bank_transaction_id = $1', [tx])).rows[0].n);

describeIfDb('/documents with a bank line as the entity', () => {
  beforeAll(async () => {
    user = await createUser(pool, tokens);
    outsider = await createUser(pool, tokens);
    company = await newCompany(pool, [[user, 'owner']], companies);
    other = await newCompany(pool, [[outsider, 'owner']], companies);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$3,'DRB','DR Bank','asset','bank','debit'),($2,$4,'DRB','DR Bank B','asset','bank','debit')`,
      [bank, bankB, company, other]);
    for (const [id, co, acct, amount] of [[t1, company, bank, -12000], [t2, company, bank, -11000], [tb, other, bankB, -5]] as const) {
      await pool.query(
        `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
         VALUES($1,$2,$3,'2026-06-01',$4,'documents route fixture','imported')`, [id, co, acct, amount]);
    }
    await pool.query(
      `INSERT INTO bank_transaction_attachments(id, bank_transaction_id, file_url, file_name, file_size)
       VALUES($1, $2, 'data:image/png;base64,iVBORw0KGgo=', 'slip.png', 8), ($3, $4, 'data:image/png;base64,iVBORw0KGgo=', 'theirs.png', 8)`,
      [u1, t1, uuid(), tb]);
    await pool.query(
      `INSERT INTO captured_documents(id, company_id, file_name, file_type, file_size, status, matched_bank_tx_id, storage_bucket, storage_path)
       VALUES($1, $2, 'scan.pdf', 'application/pdf', 7400000, 'matched', $3, 'captured-documents', $4)`, [d1, company, t1, `${company}/${d1}.pdf`]);
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM bank_transaction_attachments WHERE bank_transaction_id = ANY($1)', [[t1, t2, tb]]);
      await pool.query('DELETE FROM captured_documents WHERE company_id = ANY($1)', [companies]);
      await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
      await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [companies]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [companies]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[user, outsider]]);
    } finally {
      await pool.end();
    }
  });

  it('GET lists the line\'s upload and its linked captured document, each once', async () => {
    const r = await get({ entity_type: 'bank_transaction', entity_id: t1 });
    expect(r.state.statusCode).toBe(200);
    const docs = body(r).data as { id: string; entityType: string; entityId: string; documentName: string }[];
    expect(docs.map((d) => d.documentName).sort()).toEqual(['scan.pdf', 'slip.png']);
    expect(docs.every((d) => d.entityType === 'bank_transaction' && d.entityId === t1)).toBe(true);
    expect(docs.map((d) => d.id)).toContain(u1);
  });

  it('GET of a line with no documents is an empty list, not an error', async () => {
    const r = await get({ entity_type: 'bank_transaction', entity_id: t2 });
    expect(r.state.statusCode).toBe(200);
    expect(body(r).data).toEqual([]);
  });

  it('GET of another company\'s line is refused like any foreign entity, and reads nothing', async () => {
    const r = await get({ entity_type: 'bank_transaction', entity_id: tb });
    expect(r.state.statusCode).toBe(403);
  });

  it('an unknown entity_type is still a 400, and the message now names bank_transaction', async () => {
    const r = await get({ entity_type: 'journal', entity_id: t1 });
    expect(r.state.statusCode).toBe(400);
    expect(body(r).error?.message).toContain('bank_transaction');
  });

  it('POST stores the file on the line through the same endpoint, and the old endpoint lists it', async () => {
    const before = await attachmentCount(t2);
    const r = await post({ entity_type: 'bank_transaction', entity_id: t2 }, { name: 'receipt.png', mime: 'image/png', bytes: PNG });
    expect(r.state.statusCode).toBe(201);
    expect(await attachmentCount(t2)).toBe(before + 1);
    const unsupported = await listTransactionsWithoutDocuments(company, { from: '2026-06-01', to: '2026-06-30', minAmount: 0, limit: 50 });
    expect(unsupported.rows.map((x) => x.id)).not.toContain(t2);
    const old = await callRoute(attachmentsRoute as never, tokens[user]!, company, 'GET', undefined,
      '/api/accounting/bank-tx-attachments', { bankTransactionId: t2 });
    expect((body(old).data as { file_name: string }[]).map((x) => x.file_name)).toEqual(['receipt.png']);
  });

  it('POST refuses a type a bank line cannot hold, a body that is not that type, and another company\'s line', async () => {
    const docx = await post({ entity_type: 'bank_transaction', entity_id: t2 },
      { name: 'x.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: DOCX });
    expect(docx.state.statusCode).toBe(400);
    const spoof = await post({ entity_type: 'bank_transaction', entity_id: t2 }, { name: 'x.png', mime: 'image/png', bytes: DOCX });
    expect(spoof.state.statusCode).toBe(400);
    const before = await attachmentCount(tb);
    const foreign = await post({ entity_type: 'bank_transaction', entity_id: tb }, { name: 'x.png', mime: 'image/png', bytes: PNG });
    expect(foreign.state.statusCode).toBe(403);
    expect(await attachmentCount(tb)).toBe(before);
  });
});
