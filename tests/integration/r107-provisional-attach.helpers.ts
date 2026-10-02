// Shared fixture for the R-107 integration tests (provisional evidence attach).
// Each test file that calls useR107Fixture() gets its own companies, user and
// token (vitest isolates modules per file) and purges them afterwards.
import { afterAll, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import attachRoute from '../../pages/api/accounting/provisional/[jeId]/attach';
import receiptRoute from '../../pages/api/accounting/receipt-to-journal';
import captureActionRoute from '../../pages/api/accounting/document-capture-action';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { als } from '@/lib/als';

assertDisposable();
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

export const company = crypto.randomUUID();
export const otherCompany = crypto.randomUUID();
export const user = crypto.randomUUID();
const bankGl = crypto.randomUUID();
const expenseGl = crypto.randomUUID();
const today = new Date().toISOString().slice(0, 10);
let token = '';

type Out = {
  statusCode: number; body: { data?: Record<string, unknown>; error?: { message?: string } };
  retryAfter: unknown;
};

async function call(
  route: (req: never, res: never) => Promise<unknown> | unknown,
  url: string,
  query: Record<string, string>,
  body: unknown,
): Promise<Out> {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.url = url;
  req.query = query;
  req.body = body;
  const out = response();
  await route(req as never, out.res as never);
  return { ...(out.state as Omit<Out, 'retryAfter'>), retryAfter: out.headers.get('retry-after') ?? null };
}
export const attach = (jeId: string, capturedDocumentId: string) =>
  call(attachRoute, `/api/accounting/provisional/${jeId}/attach`, { jeId }, { capturedDocumentId });
export const postReceipt = (documentId: string) =>
  call(receiptRoute, '/api/accounting/receipt-to-journal', {}, { documentId });
export const captureAction = (id: string, action: 'confirm' | 'reject') =>
  call(captureActionRoute, '/api/accounting/document-capture-action', {}, { id, action, data: {} });

const receipt = {
  vendorName: 'Engen Rivonia', date: today, totalAmount: 115, vatAmount: 15, subtotal: 100,
  documentType: 'receipt', confidence: 0.93, lineItems: [{ description: 'Fuel', amount: 100 }],
};

export async function seedDoc(
  owner: string,
  opts: { status?: string; posted?: boolean; confidence?: number } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status,posted_at,raw_bytes_sha256)
     VALUES($1,$2,$3,'application/pdf','receipt',$4::jsonb,$5,$6,$7)`,
    [id, owner, `r107-${id}.pdf`, JSON.stringify({ ...receipt, confidence: opts.confidence ?? receipt.confidence }), opts.status ?? 'pending',
      opts.posted ? new Date() : null, `sha-${id}`],
  );
  return id;
}

/**
 * A posted provisional journal (DR expense / CR bank) and its bank line, as postProvisional leaves them.
 * bank_transactions.bank_account_id references gl_accounts, not bank_accounts.
 */
export async function seedProvisional(
  opts: { reversed?: boolean; evidenced?: boolean; noBankLine?: boolean; amount?: number } = {},
): Promise<{ je: string; bt: string }> {
  const je = crypto.randomUUID();
  const bt = crypto.randomUUID();
  const amount = opts.amount ?? 115;
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,source,status,created_by,
                                    posting_agent,needs_evidence,reversed_at,reversed_by)
     VALUES($1,$2,$3,CURRENT_DATE,'R107 provisional','auto_bank_recon','draft',$4,'ai-provisional:v1',$5,$6,$7)`,
    [je, company, `R107-${je.slice(0, 8)}`, user, !opts.evidenced,
      opts.reversed ? new Date() : null, opts.reversed ? user : null],
  );
  await pool.query(
    `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
     VALUES($4,$1,$2,$5,0,'R107 fuel'),($4,$1,$3,0,$5,'R107 fuel')`, [je, expenseGl, bankGl, company, amount]);
  await pool.query(`UPDATE gl_journal_entries SET status='posted', posted_at=NOW(), posted_by=$2 WHERE id=$1`, [je, user]);
  if (opts.noBankLine) return { je, bt };
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,provisional_je_id)
     VALUES($1,$2,$3,CURRENT_DATE,$6,'ENGEN RIVONIA',$4,$5)`,
    [bt, company, bankGl, opts.evidenced ? 'matched' : 'provisional', je, -amount]);
  return { je, bt };
}

export async function docPostedAt(id: string): Promise<Date | null> {
  return (await pool.query('SELECT posted_at FROM captured_documents WHERE id=$1', [id])).rows[0]?.posted_at ?? null;
}
export async function jeState(id: string) {
  return (await pool.query(
    'SELECT needs_evidence, source_document_id, source_document_hash, posting_agent FROM gl_journal_entries WHERE id=$1',
    [id])).rows[0] as { needs_evidence: boolean; source_document_id: string | null; source_document_hash: string | null; posting_agent: string };
}
export async function btStatus(id: string): Promise<string> {
  return (await pool.query('SELECT status FROM bank_transactions WHERE id=$1', [id])).rows[0].status;
}
export async function journalsFor(docId: string): Promise<number> {
  return (await pool.query(
    'SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source_document_id=$2', [company, docId])).rows[0].n;
}

async function purge(): Promise<void> {
  await pool.query('UPDATE bank_transactions SET provisional_je_id=NULL WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id=$1)', [company]);
  await pool.query('UPDATE gl_journal_entries SET reversal_of_id=NULL WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM captured_documents WHERE company_id = ANY($1::uuid[])', [[company, otherCompany]]);
  await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, otherCompany]]);
  await pool.query('DELETE FROM users WHERE id=$1', [user]);
}

export function useR107Fixture(): void {
  beforeAll(async () => {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
      [company, 'R107 owner', otherCompany, 'R107 other tenant']);
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active,
                               is_system_account,account_subtype)
       VALUES($1,$3,'R107BK','R107 Bank','asset','debit',true,true,'bank'),
             ($2,$3,'R107EX','R107 Fuel','expense','debit',true,true,'default_expense'),
             ($4,$3,'R107VI','R107 VAT input','asset','debit',true,true,'vat_input')`,
      [bankGl, expenseGl, company, crypto.randomUUID()]);
    token = await new SignJWT({ sub: user, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 60_000);

  afterAll(async () => {
    try { await purge(); } finally { await pool.end(); }
  }, 60_000);
}

/** Run fn inside a request transaction on its own connection, as withAuth runs one; COMMIT on success. */
export async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await als.run({ client: c, userId: user, companyId: company, claims: {} } as never, fn);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

/** Hold a row lock on another connection while fn runs; always released. */
export async function holding<T>(lockSql: string, id: string, fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(lockSql, [id]);
    // Bounded: if the code under test waits on this lock instead of timing out (a lock
    // mutation), fail in 15s rather than hang the run with the lock held.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('code under test waited on the held lock for 15s')), 15_000);
    });
    try {
      return await Promise.race([fn(), bound]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

