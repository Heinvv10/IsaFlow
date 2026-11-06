// A captured document linked to a bank line but not copied into bank_transaction_attachments (over 2 MB, or a failed
// copy) is one of that line's attachments: counted by TX_SELECT and the client-queries list, and listed by the
// attachments GET. Proven against real Postgres, as superuser and once as app_user under RLS:
//   T1 (company A) has
//     D1  linked, stored, not copied                 → counted and listed
//     D2  linked, stored, AND copied (C2 = "<D2>_…")  → counted once, as its copy; not listed again
//     D3  linked, no stored bytes                    → not counted (it cannot be opened)
//     DX  company B's document pointing at T1         → never counted or listed for A
//   so T1's count is 2 (C2 + D1), and the list holds D1 only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { listQueries } from '@/modules/accounting/services/capture/bankTxQueryService';
import { listLinkedCapturedAttachments } from '@/modules/accounting/services/capture/capturedAttachmentLinks';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url });
const uuid = () => crypto.randomUUID();
const [company, other, bank, user] = [uuid(), uuid(), uuid(), uuid()];
const [t1, d1, d2, d3, dx] = [uuid(), uuid(), uuid(), uuid(), uuid()];

async function doc(id: string, co: string, path: string | null) {
  await pool.query(
    `INSERT INTO captured_documents(id, company_id, file_name, file_type, file_size, raw_bytes_size, status,
       matched_bank_tx_id, storage_bucket, storage_path)
     VALUES($1, $2, $3, 'application/pdf', 7400000, 7400000, 'matched', $4, 'captured-documents', $5)`,
    [id, co, `scan-${id.slice(0, 4)}.pdf`, t1, path]);
}

describeIfDb('captured documents linked to a bank line count and list as its attachments', () => {
  beforeAll(async () => {
    for (const [co, name] of [[company, 'Captured links A'], [other, 'Captured links B']]) {
      await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [co, name]);
    }
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, user]);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$2,'CLB','CL Bank','asset','bank','debit')`, [bank, company]);
    await pool.query(
      `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
       VALUES($1,$2,$3,'2026-06-01',-115,'captured links fixture','imported')`, [t1, company, bank]);
    await doc(d1, company, `${company}/d1.pdf`);
    await doc(d2, company, `${company}/d2.pdf`);
    await doc(d3, company, null);
    await doc(dx, other, `${other}/dx.pdf`);
    await pool.query(
      `INSERT INTO bank_transaction_attachments(bank_transaction_id, file_url, file_name, file_size)
       VALUES($1, 'data:application/pdf;base64,JVBERi0=', $2, 5)`, [t1, `${d2}_scan.pdf`]);
    await pool.query(
      `INSERT INTO bank_tx_queries(company_id, bank_transaction_id, to_number, message_body, status)
       VALUES($1, $2, '27820000000', 'which invoice?', 'replied')`, [company, t1]);
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM bank_tx_queries WHERE company_id = ANY($1::uuid[])', [[company, other]]);
      await pool.query('DELETE FROM bank_transaction_attachments WHERE bank_transaction_id = $1', [t1]);
      await pool.query('DELETE FROM captured_documents WHERE company_id = ANY($1::uuid[])', [[company, other]]);
      await pool.query('DELETE FROM bank_transactions WHERE company_id = $1', [company]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [company]);
      await pool.query('DELETE FROM company_users WHERE company_id = $1', [company]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, other]]);
      await pool.query('DELETE FROM users WHERE id = $1', [user]);
    } finally {
      await pool.end();
    }
  });

  it('counts the copy and the uncopied stored document, on the grid and on the client-queries list', async () => {
    const page = await getBankTransactions(company, { bankAccountId: bank });
    expect(page.transactions.map((t) => [t.id, t.attachmentCount])).toEqual([[t1, 2]]);
    const queries = await listQueries(company, { bankTransactionId: t1 });
    expect(queries.map((q) => q.attachment_count)).toEqual([2]);
  });

  it('lists only the uncopied stored document, with its route and claimed type', async () => {
    const list = await listLinkedCapturedAttachments(company, t1);
    expect(list).toEqual([expect.objectContaining({
      id: `captured-${d1}`, file_url: `/api/accounting/captured-document-file?id=${d1}`,
      source: 'captured', content_type: 'application/pdf', file_size: 7400000, bank_transaction_id: t1,
    })]);
    expect(await listLinkedCapturedAttachments(other, t1)).toEqual([expect.objectContaining({ id: `captured-${dx}` })]);
  });

  it('gives the same count and list as app_user under RLS', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
      const ctx = { client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0];
      const [page, list] = await als.run(ctx, async () => [
        await getBankTransactions(company, {}), await listLinkedCapturedAttachments(company, t1)] as const);
      expect(page.transactions.map((t) => [t.id, t.attachmentCount])).toEqual([[t1, 2]]);
      expect(list.map((a) => a.id)).toEqual([`captured-${d1}`]);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
