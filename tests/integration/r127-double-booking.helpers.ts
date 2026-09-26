// Fixture for R-127: a bank-first provisional journal (DR expense / DR VAT,
// CR bank) evidenced by the same captured slip that backs a supplier invoice.
// When the invoice posts, the provisional must BECOME its payment — expense and
// VAT once, AP settled, bank once — instead of the two journals double-booking.
// Own tables, own companies — no dependency on any other register item's fixture.
import { afterAll, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { als } from '@/lib/als';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });

export const company = crypto.randomUUID();
/** A second tenant, for the isolation case. Same account shape, its own ids. */
export const otherCompany = crypto.randomUUID();
export const user = crypto.randomUUID();
export const supplier = crypto.randomUUID();
export const bankGl = crypto.randomUUID();
export const expenseGl = crypto.randomUUID();
export const vatGl = crypto.randomUUID();
export const payableGl = crypto.randomUUID();
export const otherAccounts = { bank: crypto.randomUUID(), expense: crypto.randomUUID(), vat: crypto.randomUUID() };
export const today = new Date().toISOString().slice(0, 10);

const ACCOUNT_SQL = `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,
                                            is_active,is_system_account,account_subtype)
  VALUES ($1,$5,'R127BK','R127 Bank','asset','debit',true,true,'bank'),
         ($2,$5,'R127EX','R127 Expense','expense','debit',true,true,'default_expense'),
         ($3,$5,'R127VI','R127 VAT Input','asset','debit',true,true,'vat_input'),
         ($4,$5,'R127AP','R127 Accounts Payable','liability','credit',true,true,'payable')`;

export function useR127Fixture(): void {
  beforeAll(async () => {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [company, 'R127 owner', otherCompany, 'R127 other']);
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
    await pool.query(ACCOUNT_SQL, [bankGl, expenseGl, vatGl, payableGl, company]);
    await pool.query(ACCOUNT_SQL, [otherAccounts.bank, otherAccounts.expense, otherAccounts.vat, crypto.randomUUID(), otherCompany]);
    for (const c of [company, otherCompany]) {
      await pool.query(
        `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
         VALUES($1,'R127 year',1,2026,'2026-01-01','2026-12-31','open')`,
        [c],
      );
    }
    await pool.query(
      "INSERT INTO suppliers(id,company_id,name,vat_number,is_active) VALUES($1,$2,'R127 Supplies CC','4123456789',true)",
      [supplier, company],
    );
    clearSystemAccountCache(company);
  }, 60_000);

  afterAll(async () => {
    try {
      for (const c of [company, otherCompany]) await purgeCompany(c);
      await pool.query('DELETE FROM users WHERE id=$1', [user]);
    } finally {
      clearSystemAccountCache();
      await pool.end();
    }
  }, 60_000);
}

async function purgeCompany(c: string): Promise<void> {
  await pool.query('UPDATE bank_transactions SET provisional_je_id=NULL, matched_journal_line_id=NULL WHERE company_id=$1', [c]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [c]);
  await pool.query('DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id=$1)', [c]);
  await pool.query('DELETE FROM supplier_payments WHERE company_id=$1', [c]);
  await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id=NULL WHERE company_id=$1', [c]);
  await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id=$1)', [c]);
  await pool.query('DELETE FROM supplier_coding_history WHERE company_id=$1', [c]);
  await pool.query('UPDATE bank_transactions SET auto_post_run_id=NULL WHERE company_id=$1', [c]);
  await pool.query('DELETE FROM bank_auto_post_runs WHERE company_id=$1', [c]);
  await pool.query('DELETE FROM vat_period_locks WHERE company_id=$1', [c]);
  await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [c]);
  await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id=$1)', [c]);
  await pool.query('UPDATE gl_journal_entries SET reversal_of_id=NULL WHERE company_id=$1', [c]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [c]);
  await pool.query('DELETE FROM capture_events WHERE company_id=$1', [c]);
  await pool.query('DELETE FROM captured_documents WHERE company_id=$1', [c]);
  await pool.query('DELETE FROM suppliers WHERE company_id=$1', [c]);
  await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [c]);
  await pool.query('DELETE FROM cost_centres WHERE company_id=$1', [c]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [c]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [c]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1', [c]);
  await pool.query('DELETE FROM companies WHERE id=$1', [c]);
}

export interface ProvisionalOpts {
  totalAmount: number;
  supplierId?: string | null;
  /** Seed it already evidenced by this slip, as attachEvidenceToProvisional leaves it. */
  evidencedBy?: string;
  /** Override needs_evidence while keeping evidencedBy — the not-evidenced guard. */
  needsEvidence?: boolean;
  /** Leave the journal a draft — the posted guard. */
  draft?: boolean;
  companyId?: string;
  accounts?: { bank: string; expense: string; vat: string };
}

/**
 * A bank-first provisional journal exactly as postProvisional leaves it: DR
 * expense (net) / DR VAT input / CR bank, needs_evidence = true, and the bank
 * line at status = 'provisional' pointing at it — or, with `evidencedBy`, as the
 * evidence attach leaves it (needs_evidence = false, source_document_id set,
 * bank line 'matched').
 */
export async function seedProvisional(opts: ProvisionalOpts): Promise<{ je: string; bt: string }> {
  const c = opts.companyId ?? company;
  const acc = opts.accounts ?? { bank: bankGl, expense: expenseGl, vat: vatGl };
  const je = crypto.randomUUID();
  const bt = crypto.randomUUID();
  const net = Math.round((opts.totalAmount * 100 / 115) * 100) / 100;
  const vat = Math.round((opts.totalAmount - net) * 100) / 100;
  const evidenced = opts.evidencedBy !== undefined;
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,source,status,created_by,
                                    posting_agent,needs_evidence,source_document_id)
     VALUES($1,$2,$3,'R127 provisional bank allocation','auto_bank_recon','draft',$4,$5,$6,$7)`,
    [je, c, today, user, evidenced ? 'ai-evidenced:v1' : 'ai-provisional:v1',
      opts.needsEvidence ?? !evidenced, opts.evidencedBy ?? null],
  );
  await pool.query(
    `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description,vat_type)
     VALUES ($1,$2,$3,$4,0,'R127 provisional expense',NULL),
            ($1,$2,$5,$6,0,'R127 provisional VAT','standard'),
            ($1,$2,$7,0,$8,'R127 provisional bank allocation',NULL)`,
    [c, je, acc.expense, net, acc.vat, vat, acc.bank, opts.totalAmount],
  );
  if (!opts.draft) {
    await pool.query(`UPDATE gl_journal_entries SET status='posted', posted_at=NOW(), posted_by=$2 WHERE id=$1`, [je, user]);
  }
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,
                                   provisional_je_id,predicted_supplier_id,prediction_confidence)
     VALUES($1,$2,$3,$4,$5,'R127 SUPPLIES CC',$6,$7,$8,0.9)`,
    [bt, c, acc.bank, today, -opts.totalAmount, evidenced ? 'matched' : 'provisional', je,
      opts.supplierId === undefined ? (c === company ? supplier : null) : opts.supplierId],
  );
  return { je, bt };
}

/** A captured document already claimed by the capture posting route (posted_at set). */
export async function seedDoc(companyId: string = company): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status,posted_at,raw_bytes_sha256)
     VALUES($1,$2,$3,'application/pdf','invoice','{}'::jsonb,'posted',NOW(),$4)`,
    [id, companyId, `r127-${id}.pdf`, `sha-${id}`],
  );
  return id;
}

/**
 * A supplier invoice as ai-invoice-pipeline leaves it: source_document_id = the
 * captured slip, with a real line item (unit_price VAT-exclusive).
 * `status: 'approved'` is the pipeline's auto-approve shape (no journal);
 * `withItems: false` is capture/[id]/post's shape (no supplier_invoice_items).
 */
export async function seedInvoice(opts: {
  documentId: string; totalAmount: number; status?: 'draft' | 'approved'; withItems?: boolean;
}): Promise<string> {
  const id = crypto.randomUUID();
  const net = Math.round((opts.totalAmount * 100 / 115) * 100) / 100;
  const vat = Math.round((opts.totalAmount - net) * 100) / 100;
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,invoice_date,due_date,
                                   subtotal,tax_rate,tax_amount,total_amount,payment_terms,status,created_by,
                                   source_document_id,duplicate_fingerprint)
     VALUES($1,$2,$3,$4,$5,$5,$6,15,$7,$8,'net30',$9,$10,$11,$12)`,
    [id, company, `R127-${id.slice(0, 8)}`, supplier, today, net, vat, opts.totalAmount,
      opts.status ?? 'draft', user, opts.documentId, `r127-${id}`],
  );
  if (opts.withItems !== false) {
    await pool.query(
      `INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,tax_rate,tax_amount,line_total)
       VALUES($1,'As per invoice',1,$2,15,$3,$2)`,
      [id, net, vat],
    );
  }
  return id;
}
export const seedDraftInvoice = (o: { documentId: string; totalAmount: number }) => seedInvoice(o);

export async function jeState(id: string) {
  const { rows } = await pool.query(
    'SELECT needs_evidence, source_document_id, status, reversed_at FROM gl_journal_entries WHERE id=$1',
    [id],
  );
  return rows[0] as { needs_evidence: boolean; source_document_id: string | null; status: string; reversed_at: Date | null };
}

export async function btState(id: string) {
  const { rows } = await pool.query('SELECT status, matched_journal_line_id FROM bank_transactions WHERE id=$1', [id]);
  return rows[0] as { status: string; matched_journal_line_id: string | null };
}

export async function invoiceState(id: string) {
  const { rows } = await pool.query(
    'SELECT status, gl_journal_entry_id, total_amount::float AS total, amount_paid::float AS paid FROM supplier_invoices WHERE id=$1',
    [id],
  );
  return rows[0] as { status: string; gl_journal_entry_id: string | null; total: number; paid: number };
}

/**
 * Live (uncancelled) supplier payments tied to this bank line (reference = the
 * bank transaction id, as every bank-line payment document carries it) or
 * applied to this invoice.
 */
export async function paymentsFor(bankTxId: string, invoiceId: string) {
  const { rows } = await pool.query(
    `SELECT sp.id, sp.status, sp.total_amount::float AS total, sp.gl_journal_entry_id, sp.reference,
            COALESCE((SELECT SUM(pa.amount_allocated) FROM payment_allocations pa
                       WHERE pa.payment_id = sp.id AND pa.invoice_id = $2), 0)::float AS allocated
     FROM supplier_payments sp
     WHERE sp.status <> 'cancelled'
       AND (sp.reference = $1::text
            OR EXISTS (SELECT 1 FROM payment_allocations pa WHERE pa.payment_id = sp.id AND pa.invoice_id = $2))`,
    [bankTxId, invoiceId],
  );
  return rows as Array<{ id: string; status: string; total: number; gl_journal_entry_id: string | null;
    reference: string | null; allocated: number }>;
}

/**
 * Net (debit − credit) per account over every POSTED, unreversed journal this
 * slip produced: the provisional, the invoice's journal, and each payment journal
 * tied to the provisional's bank line or applied to the invoice.
 */
export async function slipLedger(provisionalJe: string, bankTxId: string, invoiceId: string) {
  const { rows } = await pool.query(
    `WITH jes AS (
       SELECT $1::uuid AS id
       UNION SELECT gl_journal_entry_id FROM supplier_invoices WHERE id = $2 AND gl_journal_entry_id IS NOT NULL
       UNION SELECT sp.gl_journal_entry_id FROM supplier_payments sp
             WHERE sp.gl_journal_entry_id IS NOT NULL AND (sp.reference = $3::text
               OR EXISTS (SELECT 1 FROM payment_allocations pa WHERE pa.payment_id = sp.id AND pa.invoice_id = $2)))
     SELECT l.gl_account_id, SUM(l.debit - l.credit)::float AS net
     FROM gl_journal_lines l JOIN gl_journal_entries je ON je.id = l.journal_entry_id
     WHERE je.id IN (SELECT id FROM jes) AND je.status = 'posted' AND je.reversed_at IS NULL
     GROUP BY l.gl_account_id`,
    [provisionalJe, invoiceId, bankTxId],
  );
  const net = (a: string) => Math.round(Number(rows.find((r) => r.gl_account_id === a)?.net ?? 0) * 100) / 100;
  return { expense: net(expenseGl), vat: net(vatGl), ap: net(payableGl), bank: net(bankGl) };
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

let token: string | null = null;
/** POST to a real withAuth route as the fixture user — withAuth COMMITs a 4xx, as in production. */
export async function callRoute(
  route: (req: never, res: never) => unknown, url: string, body: Record<string, unknown>,
): Promise<{ statusCode: number; body: unknown }> {
  token ??= await new SignJWT({ sub: user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
  req.url = url;
  req.body = body;
  const out = response();
  await route(req as never, out.res as never);
  return out.state;
}

/** What an approval could have written, company-wide: compared before and after a refusal. */
export async function companySnapshot(invoiceId: string) {
  const count = async (sql: string) => Number((await pool.query(sql, [company])).rows[0].n);
  return {
    invoice: await invoiceState(invoiceId),
    journals: await count('SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id=$1'),
    lines: await count('SELECT COUNT(*) AS n FROM gl_journal_lines WHERE company_id=$1'),
    payments: await count('SELECT COUNT(*) AS n FROM supplier_payments WHERE company_id=$1'),
    reversed: await count('SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id=$1 AND reversed_at IS NOT NULL'),
  };
}
