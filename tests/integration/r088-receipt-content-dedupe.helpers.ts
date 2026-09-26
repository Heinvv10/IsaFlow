// Seeding and ledger reads for r088-receipt-content-dedupe.int.test.ts.
//
// Every captured document here is what an intake path leaves behind: a row
// carrying the SHA-256 of the uploaded bytes (`raw_bytes_sha256`, written by
// capture/upload, inbound email, WhatsApp and the IMAP mirror alike) and the
// extraction. Two uploads of the same file are two rows with one hash.
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { request, response } from './mfa-impersonation-postgres.helpers';

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const company = crypto.randomUUID();
export const otherCompany = crypto.randomUUID();
export const user = crypto.randomUUID();
export const employee = crypto.randomUUID();
export const accounts = {
  [company]: { bank: crypto.randomUUID(), vatInput: crypto.randomUUID(), expense: crypto.randomUUID(), office: crypto.randomUUID() },
  [otherCompany]: { bank: crypto.randomUUID(), vatInput: crypto.randomUUID(), expense: crypto.randomUUID(), office: crypto.randomUUID() },
};

export const today = new Date().toISOString().slice(0, 10);

/** The hash an intake path stores for these bytes. */
export const bytesHash = (bytes: string): string => createHash('sha256').update(Buffer.from(bytes)).digest('hex');

export interface Slip { total: number; vendor?: string; confidence?: number; reference?: string; invoice?: boolean }

function extracted({ total, vendor = 'Waltons Stationery', confidence = 0.95, reference, invoice }: Slip) {
  const subtotal = Math.round((total / 1.15) * 100) / 100;
  const vat = Math.round((total - subtotal) * 100) / 100;
  return {
    documentType: invoice ? 'invoice' : 'receipt', vendorName: vendor, date: today,
    referenceNumber: reference ?? null, currency: 'ZAR', subtotal, vatAmount: vat,
    vatRate: 15, totalAmount: total, confidence,
    lineItems: invoice ? [{ description: 'Copy paper', quantity: 1, unitPrice: subtotal, total: subtotal }] : [],
    rawText: `${vendor}\nTAX INVOICE\nSub Total ${subtotal.toFixed(2)}\nVAT ${vat.toFixed(2)}\nTotal ${total.toFixed(2)}`,
    warnings: [], extractionMethod: 'vlm',
  };
}

const documents: string[] = [];
const events: string[] = [];

/** One upload: a captured_documents row for `bytes` (null: a row with no stored hash), read as `slip`. */
export async function upload(bytes: string | null, slip: Slip, owner = company): Promise<string> {
  const id = crypto.randomUUID();
  documents.push(id);
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status,raw_bytes_sha256,raw_bytes_size)
     VALUES($1,$2,$3,'image/jpeg','receipt',$4::jsonb,'pending',$5,$6)`,
    [id, owner, `r088-${id.slice(0, 8)}.jpg`, JSON.stringify(extracted(slip)),
      bytes === null ? null : bytesHash(bytes), bytes?.length ?? null],
  );
  return id;
}

/** An upload through the capture inbox: the document plus its capture event. */
export async function uploadToInbox(bytes: string, slip: Slip): Promise<{ documentId: string; eventId: string }> {
  const documentId = await upload(bytes, slip);
  const eventId = crypto.randomUUID();
  events.push(eventId);
  await pool.query(
    `INSERT INTO capture_events(id,company_id,channel,status,captured_document_id)
     VALUES($1,$2,'whatsapp','extracted',$3)`,
    [eventId, company, documentId],
  );
  return { documentId, eventId };
}

let token = '';
// ai-invoice-pipeline's rate limit keys on the client IP with a persistent
// counter; one address per run keeps the counter this file's own.
const clientIp = `127.2.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
type Route = (req: never, res: never) => Promise<unknown> | unknown;

export function call(
  route: Route, url: string, body: Record<string, unknown>, targetId?: string, owner = company,
  query?: Record<string, string>,
) {
  const req = request({ 'sb-access-token': token, active_company_id: owner }, 'POST', targetId);
  if (query) req.query = query;
  (req.socket as { remoteAddress: string }).remoteAddress = clientIp;
  req.url = url;
  req.body = body;
  const result = response();
  return Promise.resolve(route(req as never, result.res as never)).then(() => result);
}

export type Result = Awaited<ReturnType<typeof call>>;
export const errorOf = (r: Result) => (r.state.body as { error: { message: string; details?: Record<string, unknown> } }).error;

export async function journalCount(documentIds: string[]): Promise<number> {
  return (await pool.query(
    'SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=ANY($1::uuid[]) AND source_document_id=ANY($2::uuid[])',
    [[company, otherCompany], documentIds],
  )).rows[0].n as number;
}

/** Every rand credited to the company's bank account, all documents. */
export async function bankCredit(owner = company): Promise<number> {
  return Number((await pool.query(
    'SELECT COALESCE(SUM(credit),0)::numeric AS cr FROM gl_journal_lines WHERE company_id=$1 AND gl_account_id=$2',
    [owner, accounts[owner]!.bank],
  )).rows[0].cr);
}

export async function claimLineCount(documentId: string): Promise<number> {
  return (await pool.query(
    'SELECT COUNT(*)::int AS n FROM expense_claim_lines WHERE company_id=$1 AND source_document_id=$2',
    [company, documentId],
  )).rows[0].n as number;
}

export async function invoiceCount(documentId: string): Promise<number> {
  return (await pool.query(
    'SELECT COUNT(*)::int AS n FROM supplier_invoices WHERE company_id=$1 AND source_document_id=$2',
    [company, documentId],
  )).rows[0].n as number;
}

/** The fingerprint columns a posting stamped (read through to_jsonb so a missing column reads as null). */
export async function stamped(documentId: string): Promise<Record<string, string | null>> {
  const row = (await pool.query(
    `SELECT to_jsonb(cd)->>'posted_content_sha256' AS content, to_jsonb(cd)->>'posted_receipt_key' AS key,
            to_jsonb(cd)->>'posted_duplicate_of' AS duplicate_of,
            to_jsonb(cd)->>'posted_duplicate_confirmed_by' AS confirmed_by
       FROM captured_documents cd WHERE id=$1`, [documentId])).rows[0];
  return row as Record<string, string | null>;
}

/** A posted provisional journal (DR expense / CR bank) awaiting evidence, and its bank line. */
export async function seedProvisional(amount: number): Promise<string> {
  const je = crypto.randomUUID();
  const a = accounts[company]!;
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,source,status,created_by,posting_agent,needs_evidence)
     VALUES($1,$2,$3,CURRENT_DATE,'R088 provisional','auto_bank_recon','draft',$4,'ai-provisional:v1',true)`,
    [je, company, `R088-${je.slice(0, 8)}`, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
     VALUES($1,$2,$3,$5,0,'R088 provisional'),($1,$2,$4,0,$5,'R088 provisional')`,
    [company, je, a.expense, a.bank, amount]);
  await pool.query(`UPDATE gl_journal_entries SET status='posted', posted_at=NOW(), posted_by=$2 WHERE id=$1`, [je, user]);
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,provisional_je_id)
     VALUES($1,$2,$3,CURRENT_DATE,$4,'WALTONS','provisional',$5)`,
    [crypto.randomUUID(), company, a.bank, -amount, je]);
  return je;
}

export async function postedAt(documentId: string): Promise<Date | null> {
  return (await pool.query('SELECT posted_at FROM captured_documents WHERE id=$1', [documentId])).rows[0]?.posted_at ?? null;
}

/** Backends waiting on a heavyweight lock — how the race test sees request B parked. */
export async function lockWaiters(): Promise<number> {
  return (await pool.query(
    `SELECT COUNT(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
  )).rows[0].n as number;
}

export async function purge(): Promise<void> {
  const owners = [company, otherCompany];
  await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id=ANY($1::uuid[]))', [owners]);
  await pool.query('DELETE FROM supplier_invoices WHERE company_id=ANY($1::uuid[])', [owners]);
  await pool.query('DELETE FROM suppliers WHERE company_id=ANY($1::uuid[])', [owners]);
  await pool.query('UPDATE bank_transactions SET provisional_je_id=NULL WHERE company_id=ANY($1::uuid[])', [owners]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id=ANY($1::uuid[])', [owners]);
  await pool.query('DELETE FROM expense_claim_lines WHERE company_id=ANY($1::uuid[])', [owners]);
  await pool.query('DELETE FROM expense_claims WHERE company_id=ANY($1::uuid[])', [owners]);
  await pool.query('DELETE FROM capture_events WHERE id=ANY($1::uuid[])', [events]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=ANY($1::uuid[])', [owners]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=ANY($1::uuid[])', [owners]);
  await pool.query('DELETE FROM captured_documents WHERE company_id=ANY($1::uuid[])', [owners]);
  const ids = owners.flatMap((o) => Object.values(accounts[o]!));
  await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])', [ids]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1::uuid[])', [owners]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=ANY($1::uuid[])', [owners]);
  await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[])', [owners]);
  await pool.query('DELETE FROM payroll_employees WHERE id=$1', [employee]);
  await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [owners]);
  await pool.query('DELETE FROM users WHERE id=$1', [user]);
}

export async function seed(): Promise<void> {
  await purge();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [company, 'R088 owner', otherCompany, 'R088 neighbour']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  // The same person administers both companies, so the neighbour's post is a
  // real request in its own tenant, not a request the membership check refuses.
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$3,'admin'),($2,$3,'admin')",
    [company, otherCompany, user]);
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,employment_type,start_date,status)
     VALUES($1,$2,'R088-01','Ria','Eightyeight','permanent',CURRENT_DATE,'active')`,
    [employee, company],
  );
  for (const owner of [company, otherCompany]) {
    const a = accounts[owner]!;
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_system_account,is_active)
       VALUES($1,$5,'R088B','R088 Bank','asset','bank','debit',true,true),
             ($2,$5,'1140','R088 VAT Input','asset','vat_input','debit',true,true),
             ($3,$5,'R088DE','R088 Default expense','expense','default_expense','debit',true,true),
             ($4,$5,'5100','R088 Office supplies','expense',NULL,'debit',false,true)`,
      [a.bank, a.vatInput, a.expense, a.office, owner],
    );
  }
  await pool.query('INSERT INTO suppliers(id,company_id,name,is_active) VALUES($1,$2,$3,true)',
    [crypto.randomUUID(), company, 'Waltons Stationery']);
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}
