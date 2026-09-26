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

export interface Slip { total: number; vendor?: string; confidence?: number; reference?: string }

function extracted({ total, vendor = 'Waltons Stationery', confidence = 0.95, reference }: Slip) {
  const subtotal = Math.round((total / 1.15) * 100) / 100;
  const vat = Math.round((total - subtotal) * 100) / 100;
  return {
    documentType: 'receipt', vendorName: vendor, date: today,
    referenceNumber: reference ?? null, currency: 'ZAR', subtotal, vatAmount: vat,
    vatRate: 15, totalAmount: total, lineItems: [], confidence,
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
type Route = (req: never, res: never) => Promise<unknown> | unknown;

export function call(route: Route, url: string, body: Record<string, unknown>, targetId?: string, owner = company) {
  const req = request({ 'sb-access-token': token, active_company_id: owner }, 'POST', targetId);
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
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}
